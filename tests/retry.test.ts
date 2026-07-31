import { describe, expect, it, vi } from 'vitest';

import {
  computeBoundedRetryDelayMs,
  fullJitterDelayMs,
  isRetryableGatewayFailure,
  isTransientHttpStatus,
  parseRetryAfterMs,
  retry,
  shouldRetryReadError
} from '../src/http/retry.js';
import { HttpError } from '../src/http/http-error.js';

describe('shared retry foundations', () => {
  it('preserves backoff, cap, retry events, and the terminal error', async () => {
    const terminal = new Error('terminal');
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('first'))
      .mockRejectedValueOnce(new Error('second'))
      .mockRejectedValueOnce(terminal);
    const delays: number[] = [];
    const events: Array<{ attempt: number; delayMs: number }> = [];

    await expect(
      retry(operation, {
        maxAttempts: 3,
        delayMs: 100,
        backoffMultiplier: 3,
        maxDelayMs: 250,
        sleep: async (delayMs) => {
          delays.push(delayMs);
        },
        onRetry: ({ attempt, delayMs }) => {
          events.push({ attempt, delayMs });
        }
      })
    ).rejects.toBe(terminal);

    expect(operation).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([100, 250]);
    expect(events).toEqual([
      { attempt: 1, delayMs: 100 },
      { attempt: 2, delayMs: 250 }
    ]);
  });

  it('does not retry a non-retryable error class', async () => {
    const failure = new HttpError({
      method: 'GET',
      url: 'https://example.test/resource',
      status: 404,
      statusText: 'Not Found'
    });
    const operation = vi.fn<() => Promise<string>>().mockRejectedValue(failure);

    await expect(
      retry(operation, {
        maxAttempts: 4,
        shouldRetry: shouldRetryReadError,
        sleep: async () => undefined
      })
    ).rejects.toBe(failure);
    expect(operation).toHaveBeenCalledOnce();
  });

  it('uses repo-sync superset retryability for status and body signals', () => {
    for (const status of [408, 429, 500, 501, 502, 503, 504, 599]) {
      expect(isTransientHttpStatus(status), String(status)).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 409, 423]) {
      expect(isTransientHttpStatus(status), String(status)).toBe(false);
    }
    expect(isRetryableGatewayFailure(400, 'downstream ECONNRESET')).toBe(true);
    expect(isRetryableGatewayFailure(400, 'serverError: ESOCKETTIMEDOUT')).toBe(true);
    expect(isRetryableGatewayFailure(404, 'resource missing')).toBe(false);
    expect(shouldRetryReadError(new Error('socket hang up'))).toBe(true);
    expect(shouldRetryReadError({ cause: { status: 408 } })).toBe(true);
    expect(shouldRetryReadError({ status: 404 })).toBe(false);
  });

  it('preserves floor and round full-jitter variants and bounded Retry-After', () => {
    expect(fullJitterDelayMs(0, 400, 5_000, () => 0.999)).toBe(399);
    expect(fullJitterDelayMs(0, 400, 5_000, () => 0.999, 'round')).toBe(400);
    expect(parseRetryAfterMs('2', 1_000)).toBe(2_000);
    expect(parseRetryAfterMs(new Date(6_000).toUTCString(), 1_000)).toBe(5_000);
    expect(
      computeBoundedRetryDelayMs({
        attempt: 1,
        retryAfterHeader: '3600',
        maxDelayMs: 8_000
      })
    ).toBe(8_000);
  });
});
