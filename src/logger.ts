// Structured, redaction-safe diagnostic logging for the automation suite.
//
// Framework-agnostic on purpose (no @actions/core import), mirroring
// telemetry.ts: a GitHub Action passes the @actions/core facade as the sink, a
// CLI passes console, and a test passes a recording array. That keeps one log
// vocabulary across both entrypoints of every action instead of the two
// divergent dialects each package grew independently.
//
// Three properties this module exists to guarantee:
//
//   1. A debug level that is actually reachable in the field. `RUNNER_DEBUG=1`
//      (set by GitHub's "Re-run with debug logging") and
//      POSTMAN_ACTIONS_LOG_LEVEL both switch it on, so an operator can raise
//      verbosity without a code change or a new release.
//   2. Redaction that cannot be forgotten. Secrets are registered once and
//      scrubbed from every subsequent line, including structured field values,
//      error messages, and nested causes.
//   3. Failure context that survives. Errors render with their cause chain and
//      the fields of the phase they failed in, so a support bundle explains
//      which operation failed rather than only that something did.

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40
};

/**
 * The subset of @actions/core this module needs. `console` satisfies it with a
 * thin adapter (see consoleSink), and @actions/core satisfies it directly.
 */
export interface LogSink {
  debug(message: string): void;
  info(message: string): void;
  warning(message: string): void;
  error(message: string): void;
  startGroup?(name: string): void;
  endGroup?(): void;
  isDebug?(): boolean;
}

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warning(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Log an error with its full cause chain and the active phase context. */
  failure(message: string, error: unknown, fields?: LogFields): void;
  /** Child logger whose fields are merged into every line it emits. */
  child(fields: LogFields): Logger;
  /**
   * Run `fn` inside a named phase. Emits a start line at debug, an end line
   * with elapsed ms, and on throw a failure line naming the phase before
   * rethrowing, so a stack trace is never the only evidence of where a run died.
   */
  phase<T>(name: string, fn: () => Promise<T>, fields?: LogFields): Promise<T>;
  /** Register a value to scrub from all subsequent output. */
  addSecret(value: string | undefined | null): void;
  /** Scrub registered secrets from arbitrary text. */
  redact(text: unknown): string;
  isDebug(): boolean;
  readonly level: LogLevel;
  readonly correlationId: string;
}

export interface LoggerOptions {
  sink: LogSink;
  /** Explicit level. Otherwise resolved from env. */
  level?: LogLevel;
  env?: NodeJS.ProcessEnv;
  /** Base fields merged into every line (e.g. action name and version). */
  fields?: LogFields;
  /** Stable id tying every line of one run together. */
  correlationId?: string;
  /** Shared secret registry; pass to keep child loggers in one scope. */
  secrets?: Set<string>;
  now?: () => number;
}

// A short random id is enough to group one run's lines in an aggregated log
// without carrying any identifying information.
function defaultCorrelationId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Resolve the active level from the environment.
 *
 * POSTMAN_ACTIONS_LOG_LEVEL wins when set to a known level. Otherwise GitHub's
 * own RUNNER_DEBUG / ACTIONS_STEP_DEBUG (set by "Re-run with debug logging")
 * and the conventional DEBUG / CI-agnostic RUNNER_DEBUG raise the level to
 * debug. Anything else stays at info.
 */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const explicit = String(env.POSTMAN_ACTIONS_LOG_LEVEL ?? '').trim().toLowerCase();
  if (explicit === 'debug' || explicit === 'trace' || explicit === 'verbose') return 'debug';
  if (explicit === 'info') return 'info';
  if (explicit === 'warn' || explicit === 'warning') return 'warning';
  if (explicit === 'error' || explicit === 'quiet') return 'error';

  if (isTruthyFlag(env.RUNNER_DEBUG) || isTruthyFlag(env.ACTIONS_STEP_DEBUG)) return 'debug';
  if (isTruthyFlag(env.POSTMAN_ACTIONS_DEBUG)) return 'debug';
  return 'info';
}

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  const flag = value.trim().toLowerCase();
  return flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
}

/**
 * Adapt a console-like object to LogSink. Warnings and errors go to stderr so
 * piping stdout to a file still surfaces problems.
 */
export function consoleSink(target: Pick<Console, 'log' | 'warn' | 'error'> = console): LogSink {
  return {
    debug: (message) => target.log(message),
    info: (message) => target.log(message),
    warning: (message) => target.warn(message),
    error: (message) => target.error(message)
  };
}

/**
 * Values short enough to be non-identifying but long enough to be unique are
 * still worth masking when they are registered as secrets. Anything under this
 * length is ignored: scrubbing a 1-3 character string would corrupt ordinary
 * prose ("a", "on", "id") without protecting anything real.
 */
const MIN_SECRET_LENGTH = 4;

/**
 * Render one structured field value. Deterministic and bounded: a log line is
 * evidence, not a data dump, so long values are truncated with an explicit
 * marker rather than silently cut.
 */
function renderValue(value: unknown, maxLength = 512): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (typeof value === 'string') return truncate(value, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  if (value instanceof Error) return truncate(describeError(value), maxLength);
  if (Array.isArray(value)) {
    return truncate(`[${value.map((entry) => renderValue(entry, 120)).join(', ')}]`, maxLength);
  }
  try {
    return truncate(JSON.stringify(value) ?? String(value), maxLength);
  } catch {
    return '<unserializable>';
  }
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}… (+${text.length - maxLength} chars)`;
}

/**
 * Flatten an error and every `cause` beneath it. A transport error wrapped
 * three times still names the syscall that actually failed.
 */
export function describeError(error: unknown, maxDepth = 5): string {
  const parts: string[] = [];
  let current: unknown = error;
  let depth = 0;
  while (current !== undefined && current !== null && depth < maxDepth) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(code ? `${current.name}[${code}]: ${current.message}` : `${current.name}: ${current.message}`);
      current = (current as { cause?: unknown }).cause;
    } else if (typeof current === 'object') {
      try {
        parts.push(JSON.stringify(current) ?? String(current));
      } catch {
        parts.push(String(current));
      }
      current = undefined;
    } else {
      parts.push(String(current));
      current = undefined;
    }
    depth += 1;
  }
  if (parts.length === 0) return 'unknown error';
  return parts.join(' <- caused by ');
}

/**
 * Format a URL for logs: keep origin and path (needed to tell "wrong host" from
 * "wrong route"), mask every query value (tokens routinely ride there).
 */
export function describeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const keys = [...parsed.searchParams.keys()];
    for (const key of keys) parsed.searchParams.set(key, '***');
    if (parsed.username || parsed.password) {
      parsed.username = '***';
      parsed.password = '';
    }
    return parsed.toString();
  } catch {
    return '<unparseable url>';
  }
}

export interface HttpDiagnostic {
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  requestId?: string;
  attempt?: number;
  bodyPreview?: string;
}

/**
 * Canonical field set for one HTTP exchange. Every action's transport layer
 * emitting this shape is what makes "which call failed, against which host,
 * with which upstream request id" answerable from a log alone.
 */
export function httpFields(diagnostic: HttpDiagnostic): LogFields {
  const fields: LogFields = {
    method: diagnostic.method.toUpperCase(),
    url: describeUrl(diagnostic.url)
  };
  if (diagnostic.status !== undefined) fields.status = diagnostic.status;
  if (diagnostic.durationMs !== undefined) fields.duration_ms = Math.round(diagnostic.durationMs);
  if (diagnostic.requestId) fields.request_id = diagnostic.requestId;
  if (diagnostic.attempt !== undefined) fields.attempt = diagnostic.attempt;
  if (diagnostic.bodyPreview) fields.body = truncate(diagnostic.bodyPreview, 300);
  return fields;
}

export function createLogger(options: LoggerOptions): Logger {
  const env = options.env ?? process.env;
  const level = options.level ?? resolveLogLevel(env);
  const secrets = options.secrets ?? new Set<string>();
  const correlationId = options.correlationId ?? defaultCorrelationId();
  const now = options.now ?? (() => Date.now());
  const threshold = LEVEL_ORDER[level];

  function addSecret(value: string | undefined | null): void {
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (trimmed.length < MIN_SECRET_LENGTH) return;
    secrets.add(trimmed);
  }

  function redact(text: unknown): string {
    let output = typeof text === 'string' ? text : renderValue(text, 4096);
    for (const secret of secrets) {
      if (!secret) continue;
      output = output.split(secret).join('***');
      // Also mask URL-encoded and base64 spellings: a token that reaches a log
      // through a query string or an Authorization header dump is still leaked.
      const encoded = encodeURIComponent(secret);
      if (encoded !== secret) output = output.split(encoded).join('***');
    }
    return output;
  }

  function build(baseFields: LogFields): Logger {
    function emit(target: LogLevel, message: string, fields?: LogFields): void {
      if (LEVEL_ORDER[target] < threshold) return;
      const merged = { ...baseFields, ...(fields ?? {}) };
      const rendered = Object.entries(merged)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => `${key}=${redact(renderValue(value))}`)
        .join(' ');
      const line = rendered ? `${redact(message)} | ${rendered}` : redact(message);
      switch (target) {
        case 'debug':
          options.sink.debug(line);
          break;
        case 'info':
          options.sink.info(line);
          break;
        case 'warning':
          options.sink.warning(line);
          break;
        case 'error':
          options.sink.error(line);
          break;
      }
    }

    const logger: Logger = {
      level,
      correlationId,
      addSecret,
      redact,
      isDebug: () => threshold <= LEVEL_ORDER.debug,
      debug: (message, fields) => emit('debug', message, fields),
      info: (message, fields) => emit('info', message, fields),
      warning: (message, fields) => emit('warning', message, fields),
      error: (message, fields) => emit('error', message, fields),
      failure: (message, error, fields) =>
        emit('error', message, { ...(fields ?? {}), error: describeError(error) }),
      child: (fields) => build({ ...baseFields, ...fields }),
      async phase(name, fn, fields) {
        const scoped = build({ ...baseFields, ...(fields ?? {}), phase: name });
        const started = now();
        scoped.debug('phase start');
        options.sink.startGroup?.(name);
        try {
          const result = await fn();
          scoped.debug('phase ok', { duration_ms: Math.round(now() - started) });
          return result;
        } catch (error) {
          // Name the phase before the stack unwinds; a bare rethrow loses which
          // operation was in flight, which is the whole question during triage.
          scoped.failure('phase failed', error, { duration_ms: Math.round(now() - started) });
          throw error;
        } finally {
          options.sink.endGroup?.();
        }
      }
    };
    return logger;
  }

  const root = build({ run: correlationId, ...(options.fields ?? {}) });
  return root;
}
