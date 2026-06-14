export { detectCiContext, detectEventTrigger, detectRunnerOs } from './ci-context.js';
export type { CiProvider, RunnerKind, CiContext, EventTrigger, RunnerOs } from './ci-context.js';

export { detectRepoContext, classifyRefKind } from './repo-context.js';
export type { GitProvider, RepoContext, RepoContextInput, RefKind } from './repo-context.js';

export {
  createTelemetryContext,
  buildTelemetryEvent,
  telemetryDisabled,
  resetTelemetryNotice,
  accountTypeFromConsumer
} from './telemetry.js';
export type {
  TelemetryContext,
  TelemetryOptions,
  TelemetryEvent,
  TelemetryLogger,
  AccountType,
  BuildTelemetryEventParams
} from './telemetry.js';
