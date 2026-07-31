# @postman-cse/automation-core

Shared runtime foundations for the Postman Enterprise Automation Suite. The
package owns the suite's HTTP error taxonomy, retry policy, access-token gateway
client, structured logging, CI/repo context detection, secrets-resolver helpers,
and fire-and-forget telemetry. Each action depends on this package and esbuild
inlines it into the action's self-contained `dist/`.

## Export surfaces

| Module | Surface |
| --- | --- |
| `@postman-cse/automation-core` | HTTP errors, retry helpers/predicates, gateway client, logging, context, secrets resolver, telemetry |
| `@postman-cse/automation-core/cassette` | dev/test-only fail-closed record/replay transport with query/body matching and response-header replay |

## What it sends

A single `completion` event per action run, after `team_id` resolves. Payload is
account/CI-level only — no secrets, no spec content, no repo or org names in
clear, no personal data:

| Field | Since | Notes |
| --- | --- | --- |
| `schema_version` | v1 | wire contract version (currently 3) |
| `action`, `action_version`, `outcome`, `ts` | v1 | which action ran and how it finished |
| `team_id` | v1 | Postman team id, sent clear (legitimate-interest basis) |
| `ci_provider` | v1 | detected CI system (11 named + other/unknown) |
| `runner_kind` | v1 | hosted / self-hosted / unknown (where contractually known) |
| `run_id` | v1 | CI run identifier |
| `repo_id` | v1 | `sha256(repo slug or url)` — hashed, never clear |
| `git_provider` | v2 | github / gitlab / bitbucket / azure-devops / unknown |
| `org_id` | v2 | `sha256(owner)` — hashed VCS org/group/workspace |
| `account_type` | v2 | service / user / unknown (from session consumerType) |
| `event_trigger` | v3 | push / pull_request / schedule / manual / other / unknown (what kicked off the run) |
| `runner_os` | v3 | linux / macos / windows / unknown |
| `ref_kind` | v3 | default-branch / branch / tag / unknown — coarsened; the raw branch/tag name is never sent |

The collector (`postman-automation-events-worker`, `events.pm-cse.dev`) accepts
schema versions 1, 2, and 3, so already-released actions keep ingesting; fields
a sender's schema version predates are defaulted to `unknown` (hashes to empty).

## Usage

```ts
import { createTelemetryContext } from '@postman-cse/automation-core';

const telemetry = createTelemetryContext({ action: 'postman-bootstrap-action' });
telemetry.setTeamId(teamId);
telemetry.setAccountType(sessionIdentity?.consumerType); // service/user/unknown
telemetry.emitCompletion('success');
```

`action_version` resolves from the consuming action's esbuild
`--define:__ACTION_VERSION__` automatically (override via the `actionVersion`
option). Opt out with `POSTMAN_ACTIONS_TELEMETRY=off` or `DO_NOT_TRACK=1`.
Corporate proxies are honored via `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`.

### HTTP foundations

```ts
import {
  AccessTokenGatewayClient,
  HttpError,
  isRetryableGatewayFailure,
  retry
} from '@postman-cse/automation-core';
```

Safe reads use the shared superset predicate: statusless transport failures,
HTTP `408`, `429`, every `5xx`, and the gateway timeout/downstream markers
`ESOCKETTIMEDOUT`, `ETIMEDOUT`, `ECONNRESET`, `serverError`, and `downstream`.
Mutations remain single-shot unless a caller explicitly selects `safe` or
`rate-limit` retry mode. Retry budgets, full-jitter rounding/base/cap, event
hooks, request deadlines, auth refresh, inner-error mapping, and cold fallback
are configurable on `AccessTokenGatewayClient`.

### Cassette transport

```ts
import {
  createEmptyCassette,
  createRecordingFetch,
  createReplayFetch
} from '@postman-cse/automation-core/cassette';
```

Cassette v2 keys proxy and direct routes by method/path, canonical query, and a
SHA-256 request-body digest without storing request bodies. Recording preserves
response headers and redacts mint tokens. Replay fails on unknown keys and on
exhausted response queues; a fixture must mark its final interaction
`repeatLast: true` to repeat polling responses.

## Develop

```sh
npm test        # vitest
npm run typecheck
npm run lint
npm run build    # tsc -> dist (JS + .d.ts)
npm run verify:package
```
