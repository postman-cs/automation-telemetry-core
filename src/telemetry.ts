// Anonymous usage telemetry. Fire-and-forget, framework-agnostic (no
// @actions/core), must never block or fail the host action. One completion
// event per run, emitted after team_id is resolved. Opt-out via
// POSTMAN_ACTIONS_TELEMETRY=off or DO_NOT_TRACK; auto-disabled when no team_id.
//
// Payload is account/CI-level only: no secrets, no spec content, no repo names
// in clear, no personal data. team_id is sent clear (legitimate-interest basis,
// see each action's README Telemetry section). repo_id and org_id are hashed;
// git_provider, account_type, event_trigger, runner_os, and ref_kind are
// low-cardinality enums. ref_kind is coarsened (default-branch/branch/tag) so
// the raw branch or tag name is never sent.

import { createHash } from 'node:crypto';

import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici';

import { detectCiContext } from './ci-context.js';
import type { EventTrigger, RunnerOs } from './ci-context.js';
import { detectRepoContext } from './repo-context.js';
import type { GitProvider, RefKind } from './repo-context.js';

// Injected at build via the consuming action's esbuild --define; the core ships
// compiled JS so this identifier is replaced when the action bundles it.
// Undefined under vitest/tsc, where the typeof guard falls back to 'unknown'.
declare const __ACTION_VERSION__: string | undefined;

const SCHEMA_VERSION = 3;
const DEFAULT_TIMEOUT_MS = 1500;
// Live collector on the Postman CSE + FDE Cloudflare account.
// Override with POSTMAN_ACTIONS_TELEMETRY_ENDPOINT.
const DEFAULT_ENDPOINT = 'https://events.pm-cse.dev/v1/events';

export type AccountType = 'service' | 'user' | 'unknown';

// Corporate-proxy support: Node's global fetch ignores HTTP(S)_PROXY, which
// silently blackholes the beacon in proxy-only enterprises (the locked-down
// cohort this metric exists to count). EnvHttpProxyAgent reads HTTPS_PROXY /
// HTTP_PROXY / NO_PROXY itself; construct it lazily on first send (memoized
// below) and pass it per-request as the dispatcher. This deliberately avoids setGlobalDispatcher so
// the action's own Postman/Bifrost HTTP clients stay on the default agent. The
// 1500 ms abort still applies through the proxy.
let proxyDispatcher: EnvHttpProxyAgent | undefined;
function getProxyDispatcher(): EnvHttpProxyAgent {
  // Lazy so importing this module never triggers undici's experimental EHPA
  // warning on the opt-out path; send() runs only when telemetry is enabled
  // with a resolved team id.
  return (proxyDispatcher ??= new EnvHttpProxyAgent());
}

export interface TelemetryLogger {
  info(message: string): void;
}

export interface TelemetryOptions {
  action: string;
  // The consuming action's version. When omitted, resolves at runtime from
  // GITHUB_ACTION_REF, then the bundled __ACTION_VERSION__ define, then
  // 'unknown'. Actions pass their package.json version here explicitly.
  actionVersion?: string;
  logger?: TelemetryLogger;
  env?: NodeJS.ProcessEnv;
  transport?: typeof fetch;
  dispatcher?: Dispatcher;
  endpoint?: string;
  timeoutMs?: number;
  now?: () => number;
}

export interface TelemetryContext {
  setTeamId(teamId: string | undefined): void;
  setAccountType(consumerType: string | undefined): void;
  emitCompletion(outcome: 'success' | 'failure'): void;
}

export interface TelemetryEvent {
  schema_version: number;
  event: 'completion';
  action: string;
  action_version: string;
  team_id: string;
  ci_provider: string;
  git_provider: GitProvider;
  run_id?: string;
  runner_kind: string;
  repo_id?: string;
  org_id?: string;
  account_type: AccountType;
  event_trigger: EventTrigger;
  runner_os: RunnerOs;
  ref_kind: RefKind;
  outcome: 'success' | 'failure';
  ts: number;
}

function resolveActionVersion(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (explicit) {
    return explicit;
  }
  // GitHub sets GITHUB_ACTION_REF to the ref the action was invoked with (e.g.
  // "v1", "v2.0.0", or a sha). Prefer it over the compile-time define so the
  // consuming action's bundle no longer needs a version baked in via
  // esbuild --define, which kept dist churning on every release bump.
  const ref = env.GITHUB_ACTION_REF?.trim();
  if (ref) {
    return ref;
  }
  return typeof __ACTION_VERSION__ !== 'undefined' && __ACTION_VERSION__
    ? __ACTION_VERSION__
    : 'unknown';
}

export function telemetryDisabled(env: NodeJS.ProcessEnv): boolean {
  const flag = String(env.POSTMAN_ACTIONS_TELEMETRY ?? '').trim().toLowerCase();
  if (flag === 'off' || flag === '0' || flag === 'false' || flag === 'no') {
    return true;
  }
  const dnt = String(env.DO_NOT_TRACK ?? '').trim().toLowerCase();
  if (dnt && dnt !== '0' && dnt !== 'false') {
    return true;
  }
  return false;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// Map the resolved session consumerType to a coarse account_type enum. No PII:
// 'service_account' -> service, any other named identity -> user, absent ->
// unknown.
export function accountTypeFromConsumer(consumerType: string | undefined): AccountType {
  const t = (consumerType ?? '').trim().toLowerCase();
  if (!t) {
    return 'unknown';
  }
  return t === 'service_account' ? 'service' : 'user';
}

let noticeShown = false;

// Exposed for tests to reset the per-process first-send notice.
export function resetTelemetryNotice(): void {
  noticeShown = false;
}

function maybeNotice(logger: TelemetryLogger | undefined): void {
  if (noticeShown || !logger) {
    return;
  }
  noticeShown = true;
  logger.info(
    'note: postman-actions sends anonymous usage data (team id, action, CI provider, account type, run trigger, runner OS). ' +
      'Disable with POSTMAN_ACTIONS_TELEMETRY=off or DO_NOT_TRACK=1.'
  );
}

export interface BuildTelemetryEventParams {
  action: string;
  actionVersion: string;
  teamId: string;
  accountType: AccountType;
  outcome: 'success' | 'failure';
  env: NodeJS.ProcessEnv;
  now: () => number;
}

export function buildTelemetryEvent(params: BuildTelemetryEventParams): TelemetryEvent {
  const { action, actionVersion, teamId, accountType, outcome, env, now } = params;
  const ci = detectCiContext(env);
  const repo = detectRepoContext({}, env);
  const repoSlug = repo.repoSlug;
  const repoSource = repoSlug ?? repo.repoUrl;
  // Owner is the first slug segment: GitHub owner, GitLab top-level group,
  // Bitbucket workspace. Hashed so the org is countable without storing it clear.
  const owner = repoSlug && repoSlug.includes('/') ? repoSlug.split('/')[0] : undefined;
  return {
    schema_version: SCHEMA_VERSION,
    event: 'completion',
    action,
    action_version: actionVersion || 'unknown',
    team_id: teamId,
    ci_provider: ci.ciProvider,
    git_provider: repo.provider,
    run_id: ci.runId,
    runner_kind: ci.runnerKind,
    repo_id: repoSource ? sha256(repoSource) : undefined,
    org_id: owner ? sha256(owner) : undefined,
    account_type: accountType,
    event_trigger: ci.eventTrigger,
    runner_os: ci.runnerOs,
    ref_kind: repo.refKind,
    outcome,
    ts: now()
  };
}

async function send(event: TelemetryEvent, options: TelemetryOptions): Promise<void> {
  const env = options.env ?? process.env;
  const endpoint =
    options.endpoint ?? env.POSTMAN_ACTIONS_TELEMETRY_ENDPOINT ?? DEFAULT_ENDPOINT;
  // Default to undici's fetch: Node's global fetch ignores the per-request
  // dispatcher option, so the EnvHttpProxyAgent would be silently bypassed and
  // proxy-only enterprises would never be counted. Tests inject their own
  // transport.
  const transport = options.transport ?? (undiciFetch as unknown as typeof fetch);
  const dispatcher = options.dispatcher ?? getProxyDispatcher();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();
  const init: RequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(event),
    signal: controller.signal
  };
  // undici's fetch reads `dispatcher` off the init; the global RequestInit's
  // Dispatcher type can skew from the undici package's own across dependency
  // trees, so attach it without re-asserting that type.
  (init as { dispatcher?: unknown }).dispatcher = dispatcher;
  try {
    await transport(endpoint, init);
  } finally {
    clearTimeout(timer);
  }
}

export function createTelemetryContext(options: TelemetryOptions): TelemetryContext {
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  const actionVersion = resolveActionVersion(options.actionVersion, env);
  let teamId = '';
  let accountType: AccountType = 'unknown';
  let emitted = false;

  return {
    setTeamId(value) {
      if (value) {
        teamId = String(value);
      }
    },
    setAccountType(consumerType) {
      accountType = accountTypeFromConsumer(consumerType);
    },
    emitCompletion(outcome) {
      if (emitted) {
        return;
      }
      emitted = true;
      try {
        if (telemetryDisabled(env) || !teamId) {
          return;
        }
        const event = buildTelemetryEvent({
          action: options.action,
          actionVersion,
          teamId,
          accountType,
          outcome,
          env,
          now
        });
        maybeNotice(options.logger);
        void send(event, options).catch(() => {});
      } catch {
        // Telemetry must never surface an error into the host action.
      }
    }
  };
}
