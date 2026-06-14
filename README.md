# @postman-cse/automation-telemetry-core

Shared anonymous usage telemetry for the postman-actions suite. One source of
truth for CI-system detection, repo/SCM detection, and the fire-and-forget event
client; each action depends on this package and esbuild inlines it into the
action's self-contained `dist/`.

## What it sends

A single `completion` event per action run, after `team_id` resolves. Payload is
account/CI-level only — no secrets, no spec content, no repo or org names in
clear, no personal data:

| Field | Notes |
| --- | --- |
| `schema_version` | wire contract version (currently 2) |
| `action`, `action_version`, `outcome`, `ts` | which action ran and how it finished |
| `team_id` | Postman team id, sent clear (legitimate-interest basis) |
| `ci_provider` | detected CI system (11 named + other/unknown) |
| `git_provider` | github / gitlab / bitbucket / azure-devops / unknown |
| `runner_kind` | hosted / self-hosted / unknown (where contractually known) |
| `run_id` | CI run identifier |
| `repo_id` | `sha256(repo slug or url)` — hashed, never clear |
| `org_id` | `sha256(owner)` — hashed VCS org/group/workspace |
| `account_type` | service / user / unknown (from session consumerType) |

## Usage

```ts
import { createTelemetryContext } from '@postman-cse/automation-telemetry-core';

const telemetry = createTelemetryContext({ action: 'postman-bootstrap-action' });
telemetry.setTeamId(teamId);
telemetry.setAccountType(sessionIdentity?.consumerType); // service/user/unknown
telemetry.emitCompletion('success');
```

`action_version` resolves from the consuming action's esbuild
`--define:__ACTION_VERSION__` automatically (override via the `actionVersion`
option). Opt out with `POSTMAN_ACTIONS_TELEMETRY=off` or `DO_NOT_TRACK=1`.
Corporate proxies are honored via `HTTPS_PROXY`/`HTTP_PROXY`/`NO_PROXY`.

## Develop

```sh
npm test        # vitest
npm run typecheck
npm run lint
npm run build    # tsc -> dist (JS + .d.ts)
```
