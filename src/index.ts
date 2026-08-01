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

export {
  createLogger,
  consoleSink,
  actionSink,
  resolveLogLevel,
  describeError,
  describeUrl,
  httpFields
} from './logger.js';
export type {
  Logger,
  LoggerOptions,
  LogSink,
  ActionCoreLike,
  LogLevel,
  LogFields,
  HttpDiagnostic
} from './logger.js';

export {
  createSecretsResolverExec,
  createSecretsResolverItem,
  createSecretsResolverV3Body,
  DEFAULT_SECRETS_RESOLVER_PROVIDER,
  isSecretsResolverEnabled,
  isSecretsResolverItemName,
  parseSecretsResolverProvider,
  SECRETS_RESOLVER_ITEM_NAME,
  SECRETS_RESOLVER_PROVIDERS,
  secretsResolverEnvironmentKeys
} from './secrets-resolver.js';
export type { SecretsResolverProvider } from './secrets-resolver.js';

export {
  HttpError,
  REDACTED,
  normalizeSecretValues,
  redactSecrets,
  sanitizeHeaders,
  toOneLine
} from './http/http-error.js';
export type {
  HeaderBag,
  HttpErrorInit,
  HttpErrorResponseInit
} from './http/http-error.js';

export {
  computeBoundedRetryDelayMs,
  extractHttpStatus,
  fullJitterDelayMs,
  isAmbiguousMutationFailure,
  isRetryableGatewayFailure,
  isRetryableHttpStatus,
  isTransientHttpStatus,
  parseRetryAfterMs,
  retry,
  SAFE_READ_RETRY,
  shouldRetryReadError,
  sleep
} from './http/retry.js';
export type {
  BoundedRetryDelayOptions,
  JitterRounding,
  RetryContext,
  RetryDecisionContext,
  RetryOptions
} from './http/retry.js';

export {
  AccessTokenGatewayClient,
  DEFAULT_POSTMAN_BIFROST_BASE_URL
} from './http/gateway-client.js';
export type {
  AccessTokenGatewayClientOptions,
  GatewayAppVersionProvider,
  GatewayDirectRequest,
  GatewayFallbackMode,
  GatewayMethod,
  GatewayRequest,
  GatewayRequestOptions,
  GatewayRetryEvent,
  GatewayRetryMode,
  GatewaySecretMasker,
  GatewayTokenProvider
} from './http/gateway-client.js';

export { createErrorInjector, InjectedTransportError } from './http/error-injection.js';
export type {
  ErrorInjector,
  InjectedFailureKind,
  InjectionCheckpoint,
  InjectionRecordEntry,
  InjectionRule
} from './http/error-injection.js';
