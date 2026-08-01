/**
 * Checkpoint-keyed error-injection engine for the shared HTTP surface.
 *
 * Wraps any `fetch`-shaped transport and injects failures at named checkpoints:
 * a checkpoint is matched by request ordinal (1-based, per matcher), by URL
 * substring, or by proxy-envelope service/method/path when the request is a
 * Bifrost `/ws/proxy` POST. Each rule fires a bounded number of times
 * (default 1) and then the wrapped transport resumes, so a suite can prove
 * recovery, not just failure.
 *
 * Fail-closed: constructing an injector with an unknown failure kind throws,
 * and an armed injector whose rules never fired can be asserted against via
 * `unfiredRules()` so a matrix row that stopped matching goes red instead of
 * silently passing.
 */

export type InjectedFailureKind =
  | 'http-status'
  | 'inner-error'
  | 'transport-error'
  | 'timeout-abort'
  | 'body-text';

export interface InjectionCheckpoint {
  /** Match the Nth (1-based) request seen by this rule's matcher. */
  ordinal?: number;
  /** Substring match against the request URL. */
  urlIncludes?: string;
  /** Bifrost proxy envelope service (requires the request to be a /ws/proxy POST). */
  service?: string;
  /** Proxy envelope method (get/post/put/patch/delete). */
  method?: string;
  /** Substring match against the proxy envelope path. */
  pathIncludes?: string;
}

export interface InjectionRule {
  /** Stable rule name; surfaces in errors and in unfiredRules(). */
  name: string;
  checkpoint: InjectionCheckpoint;
  kind: InjectedFailureKind;
  /** Outer HTTP status for http-status; inner envelope status for inner-error. */
  status?: number;
  /** Literal body for http-status/body-text; message for transport-error. */
  body?: string;
  /** Extra response headers (e.g. Retry-After). */
  headers?: Record<string, string>;
  /** How many matching requests this rule consumes. Default 1. */
  times?: number;
}

export interface InjectionRecordEntry {
  rule: string;
  url: string;
  service?: string;
  method?: string;
  path?: string;
  ordinal: number;
}

const KINDS: ReadonlySet<string> = new Set([
  'http-status',
  'inner-error',
  'transport-error',
  'timeout-abort',
  'body-text'
]);

interface ParsedEnvelope {
  service?: string;
  method?: string;
  path?: string;
}

function parseEnvelope(input: RequestInfo | URL, init?: RequestInit): ParsedEnvelope {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.includes('/ws/proxy')) return {};
  const raw = typeof init?.body === 'string' ? init.body : undefined;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      service: typeof parsed.service === 'string' ? parsed.service : undefined,
      method: typeof parsed.method === 'string' ? parsed.method : undefined,
      path: typeof parsed.path === 'string' ? parsed.path : undefined
    };
  } catch {
    return {};
  }
}

export class InjectedTransportError extends Error {
  readonly rule: string;
  constructor(rule: string, message: string) {
    super(message);
    this.name = 'InjectedTransportError';
    this.rule = rule;
  }
}

export interface ErrorInjector {
  fetch: typeof fetch;
  /** Rules that never fired; a matrix row asserts this is empty. */
  unfiredRules(): string[];
  /** Every injection that fired, in order. */
  record(): readonly InjectionRecordEntry[];
  /** Total requests seen (fired or passed through). */
  requestCount(): number;
}

export function createErrorInjector(
  wrapped: typeof fetch,
  rules: readonly InjectionRule[]
): ErrorInjector {
  for (const rule of rules) {
    if (!KINDS.has(rule.kind)) {
      throw new Error(`Unknown injection kind "${rule.kind}" on rule "${rule.name}"`);
    }
    if (rule.kind === 'http-status' && typeof rule.status !== 'number') {
      throw new Error(`Rule "${rule.name}" is http-status but has no status`);
    }
    if (rule.kind === 'inner-error' && typeof rule.status !== 'number') {
      throw new Error(`Rule "${rule.name}" is inner-error but has no status`);
    }
  }

  const remaining = new Map<InjectionRule, number>(
    rules.map((rule) => [rule, Math.max(1, rule.times ?? 1)])
  );
  const matchCounts = new Map<InjectionRule, number>(rules.map((rule) => [rule, 0]));
  const fired: InjectionRecordEntry[] = [];
  let requests = 0;

  function matches(rule: InjectionRule, url: string, envelope: ParsedEnvelope): boolean {
    const cp = rule.checkpoint;
    if (cp.urlIncludes !== undefined && !url.includes(cp.urlIncludes)) return false;
    if (cp.service !== undefined && envelope.service !== cp.service) return false;
    if (cp.method !== undefined && envelope.method !== cp.method) return false;
    if (cp.pathIncludes !== undefined && !(envelope.path ?? '').includes(cp.pathIncludes)) {
      return false;
    }
    return true;
  }

  const inject: typeof fetch = async (input, init) => {
    requests += 1;
    const url = String(input instanceof Request ? input.url : input);
    const envelope = parseEnvelope(input, init);

    for (const rule of rules) {
      if ((remaining.get(rule) ?? 0) <= 0) continue;
      if (!matches(rule, url, envelope)) continue;
      const seen = (matchCounts.get(rule) ?? 0) + 1;
      matchCounts.set(rule, seen);
      if (rule.checkpoint.ordinal !== undefined && seen !== rule.checkpoint.ordinal) continue;

      remaining.set(rule, (remaining.get(rule) ?? 1) - 1);
      fired.push({
        rule: rule.name,
        url,
        ...(envelope.service !== undefined ? { service: envelope.service } : {}),
        ...(envelope.method !== undefined ? { method: envelope.method } : {}),
        ...(envelope.path !== undefined ? { path: envelope.path } : {}),
        ordinal: seen
      });

      switch (rule.kind) {
        case 'transport-error':
          throw new InjectedTransportError(rule.name, rule.body ?? 'ECONNRESET injected');
        case 'timeout-abort': {
          const abort = new Error(rule.body ?? 'The operation was aborted.');
          abort.name = 'AbortError';
          throw abort;
        }
        case 'http-status':
          return new Response(rule.body ?? '', {
            status: rule.status,
            headers: rule.headers ?? {}
          });
        case 'inner-error':
          return new Response(
            rule.body ??
              JSON.stringify({ error: { status: rule.status, message: `injected inner ${rule.status}` } }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...(rule.headers ?? {}) } }
          );
        case 'body-text':
          return new Response(rule.body ?? '', { status: 200, headers: rule.headers ?? {} });
      }
    }

    return wrapped(input, init);
  };

  return {
    fetch: inject,
    unfiredRules: () =>
      rules.filter((rule) => (remaining.get(rule) ?? 0) > 0).map((rule) => rule.name),
    record: () => fired,
    requestCount: () => requests
  };
}
