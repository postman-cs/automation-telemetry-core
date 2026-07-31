import { HttpError } from './http-error.js';

export interface RetryDecisionContext {
  attempt: number;
  maxAttempts: number;
}

export interface RetryContext extends RetryDecisionContext {
  delayMs: number;
  error: unknown;
}

export interface RetryOptions {
  maxAttempts?: number;
  delayMs?: number;
  backoffMultiplier?: number;
  maxDelayMs?: number;
  onRetry?: (context: RetryContext) => void | Promise<void>;
  shouldRetry?: (error: unknown, context: RetryDecisionContext) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

export function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

function normalizeRetryOptions(options: RetryOptions): Required<RetryOptions> {
  return {
    maxAttempts: Math.max(1, options.maxAttempts ?? 3),
    delayMs: Math.max(0, options.delayMs ?? 2_000),
    backoffMultiplier: Math.max(1, options.backoffMultiplier ?? 1),
    maxDelayMs:
      options.maxDelayMs === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, options.maxDelayMs),
    onRetry: options.onRetry ?? (async () => undefined),
    shouldRetry: options.shouldRetry ?? (() => true),
    sleep: options.sleep ?? sleep
  };
}

export async function retry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const normalized = normalizeRetryOptions(options);
  let nextDelayMs = normalized.delayMs;

  for (let attempt = 1; attempt <= normalized.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const shouldRetry =
        attempt < normalized.maxAttempts &&
        normalized.shouldRetry(error, {
          attempt,
          maxAttempts: normalized.maxAttempts
        });
      if (!shouldRetry) throw error;
      await normalized.onRetry({
        attempt,
        maxAttempts: normalized.maxAttempts,
        delayMs: nextDelayMs,
        error
      });
      await normalized.sleep(nextDelayMs);
      nextDelayMs = Math.min(
        normalized.maxDelayMs,
        Math.round(nextDelayMs * normalized.backoffMultiplier)
      );
    }
  }

  throw new Error('Retry exhausted without returning or throwing');
}

export type JitterRounding = 'floor' | 'round';

export function fullJitterDelayMs(
  attempt: number,
  baseMs = 400,
  capMs = 5_000,
  random: () => number = Math.random,
  rounding: JitterRounding = 'floor'
): number {
  const ceiling = Math.max(
    0,
    Math.min(Math.max(0, capMs), Math.max(0, baseMs) * 2 ** Math.max(0, attempt))
  );
  const delay = random() * ceiling;
  return rounding === 'round' ? Math.round(delay) : Math.floor(delay);
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  nowMs = Date.now()
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000;
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : Math.max(0, dateMs - nowMs);
}

export interface BoundedRetryDelayOptions {
  attempt: number;
  retryAfterHeader?: string | null;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  nowMs?: number;
  rounding?: JitterRounding;
}

export function computeBoundedRetryDelayMs(options: BoundedRetryDelayOptions): number {
  const maxDelayMs = Math.max(0, options.maxDelayMs ?? 8_000);
  const retryAfterMs = parseRetryAfterMs(options.retryAfterHeader, options.nowMs);
  if (retryAfterMs !== undefined) return Math.min(maxDelayMs, retryAfterMs);
  return fullJitterDelayMs(
    Math.max(0, options.attempt - 1),
    options.baseDelayMs ?? 500,
    maxDelayMs,
    options.random,
    options.rounding ?? 'round'
  );
}

export function isTransientHttpStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export const isRetryableHttpStatus = isTransientHttpStatus;

export function extractHttpStatus(error: unknown): number | undefined {
  if (error instanceof HttpError) return error.status;
  if (error && typeof error === 'object' && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  if (error && typeof error === 'object' && 'cause' in error) {
    return extractHttpStatus((error as { cause?: unknown }).cause);
  }
  return undefined;
}

export function shouldRetryReadError(error: unknown): boolean {
  const status = extractHttpStatus(error);
  return status === undefined || isTransientHttpStatus(status);
}

export function isAmbiguousMutationFailure(error: unknown): boolean {
  return shouldRetryReadError(error);
}

const RETRYABLE_GATEWAY_BODY =
  /ESOCKETTIMEDOUT|ETIMEDOUT|ECONNRESET|serverError|downstream/i;

export function isRetryableGatewayFailure(status: number, body = ''): boolean {
  return isTransientHttpStatus(status) || RETRYABLE_GATEWAY_BODY.test(body);
}

export const SAFE_READ_RETRY: Readonly<RetryOptions> = {
  maxAttempts: 3,
  delayMs: 2_000,
  backoffMultiplier: 2,
  shouldRetry: shouldRetryReadError
};
