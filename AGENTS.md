# automation-telemetry-core

Shared anonymous usage telemetry for the postman-actions suite, published as `@postman-cse/automation-telemetry-core`. One source of truth for CI-system detection, repo/SCM detection, and the fire-and-forget event client. Each action depends on this package and esbuild inlines it into the action's self-contained `dist/`. This is an npm library (no GitHub Action, no `dist/cli.cjs`).

## Structure

```
src/
  index.ts          # Public exports: event client + context helpers
  telemetry.ts      # Fire-and-forget completion-event client (opt-out aware)
  ci-context.ts     # CI-system detection (provider, runner kind, run id)
  repo-context.ts   # Repo/SCM detection: git_provider, hashed repo_id + org_id
test/               # vitest unit tests
```

## Commands

```bash
npm ci
npm run build       # rm -rf dist && tsc -p tsconfig.build.json  (tsc, NOT esbuild)
npm run typecheck   # tsc --noEmit -p tsconfig.json
npm test            # vitest run
npm run lint        # eslint .
```

`prepublishOnly` runs `build`. Published `files` are `dist/`, `README.md`, `LICENSE`; `main` is `dist/index.js`.

## Wire Contract

Emits one `completion` event per action run, after `team_id` resolves. `schema_version` is `2`. Fields: `action`, `action_version`, `outcome`, `ts`, `team_id` (clear), `ci_provider`, `runner_kind`, `run_id`, `repo_id` (`sha256`), plus the schema-2 additions `git_provider`, `org_id` (`sha256(owner)`), and `account_type` (service/user/unknown). No secrets, spec content, or clear repo/org names. Opt out with `POSTMAN_ACTIONS_TELEMETRY=off` or `DO_NOT_TRACK`.

The collector is the `postman-automation-events-worker` Worker (`events.pm-cse.dev`), which accepts both `schema_version` 1 and 2.

## Gotchas

- Builds with `tsc` to emit a clean ESM library (no bundling); the consuming action's esbuild does the inlining, and `--define:__ACTION_VERSION__` in the action applies across the inlined code so `action_version` resolves automatically.
- The client is fire-and-forget: a telemetry failure must never fail or slow an action run.
- Schema changes must stay backward compatible -- the collector ingests already-released actions still on `schema_version` 1.
