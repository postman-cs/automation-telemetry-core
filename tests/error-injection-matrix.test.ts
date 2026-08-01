/**
 * WS6 error-injection matrix for the shared gateway client.
 *
 * Table-driven over {error class} x {retry mode} x {outer vs inner} x
 * {fallback eligible}. Every row drives the REAL AccessTokenGatewayClient
 * through the checkpoint-keyed injector and asserts the exact retry-event
 * sequence, the delay schedule handed to sleepImpl, fallback-once, the final
 * error class, and that no mutation is duplicated.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  AccessTokenGatewayClient,
  type GatewayRetryEvent,
  type GatewayTokenProvider
} from '../src/http/gateway-client.js';
import { HttpError } from '../src/http/http-error.js';
import {
  createErrorInjector,
  InjectedTransportError,
  type InjectionRule
} from '../src/http/error-injection.js';

const PRIMARY = 'https://bifrost.example';
const FALLBACK = 'https://fallback.example';

function okJson(body: unknown = { ok: true }): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}

function staticTokens(canRefresh = false): GatewayTokenProvider & { refreshes: number } {
  const state = { token: 'token-1', refreshes: 0 };
  return {
    current: () => state.token,
    canRefresh: () => canRefresh,
    refresh: async () => {
      state.refreshes += 1;
      state.token = `token-${state.refreshes + 1}`;
      return state.token;
    },
    get refreshes() {
      return state.refreshes;
    }
  };
}

interface Harness {
  client: AccessTokenGatewayClient;
  events: GatewayRetryEvent[];
  delays: number[];
  upstream: ReturnType<typeof vi.fn>;
  injector: ReturnType<typeof createErrorInjector>;
  tokens: ReturnType<typeof staticTokens>;
}

function harness(
  rules: readonly InjectionRule[],
  overrides: Partial<ConstructorParameters<typeof AccessTokenGatewayClient>[0]> = {},
  canRefresh = false
): Harness {
  const upstream = vi.fn<typeof fetch>(async () => okJson());
  const injector = createErrorInjector(upstream, rules);
  const events: GatewayRetryEvent[] = [];
  const delays: number[] = [];
  const tokens = staticTokens(canRefresh);
  const client = new AccessTokenGatewayClient({
    tokenProvider: tokens,
    bifrostBaseUrl: PRIMARY,
    fetchImpl: injector.fetch,
    maxRetries: 2,
    retryBaseDelayMs: 100,
    retryMaxDelayMs: 400,
    // random=1 makes full-jitter deterministic: delay = min(cap, base * 2^attempt)
    randomImpl: () => 1,
    jitterRounding: 'round',
    sleepImpl: async (ms) => {
      delays.push(ms);
    },
    onRetryEvent: (event) => {
      events.push(event);
    },
    ...overrides
  });
  return { client, events, delays, upstream, injector, tokens };
}

const CREATE = {
  service: 'collection',
  method: 'post' as const,
  path: '/v3/collections',
  body: { name: 'Payments' }
};
const READ = { service: 'collection', method: 'get' as const, path: '/v3/collections/abc' };

describe('WS6 matrix: outer http errors x retry mode', () => {
  it('safe GET retries 500 then 503 with the deterministic jitter schedule and succeeds', async () => {
    const h = harness([
      { name: 'first-500', checkpoint: { service: 'collection' }, kind: 'http-status', status: 500 },
      { name: 'then-503', checkpoint: { service: 'collection' }, kind: 'http-status', status: 503 }
    ]);
    const body = await h.client.requestJson({ ...READ, retry: 'safe' });
    expect(body).toEqual({ ok: true });
    expect(h.events).toEqual([
      { class: 'http', status: 500, attempt: 1, delay: 100 },
      { class: 'http', status: 503, attempt: 2, delay: 200 }
    ]);
    expect(h.delays).toEqual([100, 200]);
    expect(h.injector.unfiredRules()).toEqual([]);
    // exactly one request reached the real upstream (the success)
    expect(h.upstream).toHaveBeenCalledTimes(1);
  });

  it('safe retry exhausts the budget and surfaces the LAST HttpError', async () => {
    const h = harness([
      { name: 'always-503', checkpoint: { service: 'collection' }, kind: 'http-status', status: 503, times: 3 }
    ]);
    const thrown = await h.client.requestJson({ ...READ, retry: 'safe' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(503);
    expect(h.events.map((e) => [e.class, e.status, e.attempt])).toEqual([
      ['http', 503, 1],
      ['http', 503, 2]
    ]);
    expect(h.delays).toEqual([100, 200]);
    expect(h.upstream).toHaveBeenCalledTimes(0);
  });

  it('rate-limit mode retries ONLY 429 and honors Retry-After over jitter', async () => {
    const h = harness([
      {
        name: '429-with-retry-after',
        checkpoint: { service: 'collection' },
        kind: 'http-status',
        status: 429,
        headers: { 'Retry-After': '1' }
      }
    ]);
    const body = await h.client.requestJson({ ...CREATE, retry: 'rate-limit' });
    expect(body).toEqual({ ok: true });
    // Retry-After 1s = 1000ms, capped by retryMaxDelayMs 400
    expect(h.events).toEqual([{ class: 'http', status: 429, attempt: 1, delay: 400 }]);
    expect(h.delays).toEqual([400]);
  });

  it('rate-limit mode does NOT retry a 503', async () => {
    const h = harness([
      { name: '503', checkpoint: { service: 'collection' }, kind: 'http-status', status: 503 }
    ]);
    const thrown = await h.client.requestJson({ ...CREATE, retry: 'rate-limit' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(503);
    expect(h.events).toEqual([]);
    expect(h.delays).toEqual([]);
  });

  it('mode none never retries and never sleeps: 408 surfaces immediately (post-WS2 unified)', async () => {
    const h = harness([
      { name: '408', checkpoint: { service: 'collection' }, kind: 'http-status', status: 408 }
    ]);
    const thrown = await h.client.requestJson({ ...CREATE, retry: 'none' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(408);
    expect(h.events).toEqual([]);
    expect(h.delays).toEqual([]);
    expect(h.upstream).toHaveBeenCalledTimes(0);
  });

  it('unsafe mutation default is single-shot: transient 502 on POST does not re-send the mutation', async () => {
    const h = harness([
      { name: '502-on-create', checkpoint: { service: 'collection', method: 'post' }, kind: 'http-status', status: 502 }
    ]);
    const thrown = await h.client.requestJson(CREATE).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(502);
    // zero retries, zero duplicated mutation: only the injected request happened
    expect(h.events).toEqual([]);
    expect(h.injector.requestCount()).toBe(1);
    expect(h.upstream).toHaveBeenCalledTimes(0);
  });
});

describe('WS6 matrix: inner errors in 200 envelopes', () => {
  it('inner 502 in a 200 retries under safe mode with class inner and effective status', async () => {
    const h = harness([
      { name: 'inner-502', checkpoint: { service: 'collection' }, kind: 'inner-error', status: 502 }
    ]);
    const body = await h.client.requestJson({ ...READ, retry: 'safe' });
    expect(body).toEqual({ ok: true });
    expect(h.events).toEqual([{ class: 'inner', status: 502, attempt: 1, delay: 100 }]);
    expect(h.delays).toEqual([100]);
  });

  it('non-retryable inner 404 fails as an HttpError carrying the INNER status, no retry', async () => {
    const h = harness([
      { name: 'inner-404', checkpoint: { service: 'collection' }, kind: 'inner-error', status: 404 }
    ]);
    const thrown = await h.client.requestJson({ ...READ, retry: 'safe' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(404);
    expect(h.events).toEqual([]);
    expect(h.delays).toEqual([]);
  });

  it('inner 429 under rate-limit mode retries but never reads Retry-After from the outer 200', async () => {
    const h = harness([
      {
        name: 'inner-429',
        checkpoint: { service: 'collection' },
        kind: 'inner-error',
        status: 429,
        headers: { 'Retry-After': '9999' }
      }
    ]);
    const body = await h.client.requestJson({ ...CREATE, retry: 'rate-limit' });
    expect(body).toEqual({ ok: true });
    // inner rows must use the jitter schedule, not the header on the outer 200
    expect(h.events).toEqual([{ class: 'inner', status: 429, attempt: 1, delay: 100 }]);
    expect(h.delays).toEqual([100]);
  });
});

describe('WS6 matrix: transport errors', () => {
  it('safe mode retries a transport error with class transport and no status', async () => {
    const h = harness([
      { name: 'econnreset', checkpoint: { service: 'collection' }, kind: 'transport-error', body: 'ECONNRESET' }
    ]);
    const body = await h.client.requestJson({ ...READ, retry: 'safe' });
    expect(body).toEqual({ ok: true });
    expect(h.events).toEqual([{ class: 'transport', attempt: 1, delay: 100 }]);
    expect(h.delays).toEqual([100]);
  });

  it('ambiguous timeout on an unsafe create is NEVER blind-retried: the abort surfaces once', async () => {
    const h = harness([
      { name: 'abort-on-create', checkpoint: { service: 'collection', method: 'post' }, kind: 'timeout-abort' }
    ]);
    const thrown = await h.client.requestJson(CREATE).catch((e) => e);
    expect((thrown as Error).name).toBe('AbortError');
    expect(h.events).toEqual([]);
    expect(h.injector.requestCount()).toBe(1);
    expect(h.upstream).toHaveBeenCalledTimes(0);
  });

  it('transport retry exhaustion surfaces the transport error, not a synthetic HttpError', async () => {
    const h = harness([
      { name: 'always-reset', checkpoint: { service: 'collection' }, kind: 'transport-error', times: 3 }
    ]);
    const thrown = await h.client.requestJson({ ...READ, retry: 'safe' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(InjectedTransportError);
    expect(h.events.map((e) => e.class)).toEqual(['transport', 'transport']);
    expect(h.delays).toEqual([100, 200]);
  });
});

describe('WS6 matrix: auth refresh', () => {
  it('401 -> refresh (class auth, zero delay, no retry budget consumed) -> then 500s still get the full budget', async () => {
    const h = harness(
      [
        { name: '401-first', checkpoint: { service: 'collection' }, kind: 'http-status', status: 401, body: 'expired token' },
        { name: '500-after-refresh', checkpoint: { service: 'collection' }, kind: 'http-status', status: 500 }
      ],
      {},
      true
    );
    const body = await h.client.requestJson({ ...READ, retry: 'safe' });
    expect(body).toEqual({ ok: true });
    expect(h.tokens.refreshes).toBe(1);
    expect(h.events).toEqual([
      { class: 'auth', status: 401, attempt: 1, delay: 0 },
      { class: 'http', status: 500, attempt: 1, delay: 100 }
    ]);
    expect(h.delays).toEqual([100]);
  });

  it('401 -> refresh -> timeout exhausts as the transport error and refresh happens exactly once', async () => {
    const h = harness(
      [
        { name: '401-first', checkpoint: { service: 'collection' }, kind: 'http-status', status: 401, body: 'expired token' },
        { name: 'timeout-after-refresh', checkpoint: { service: 'collection' }, kind: 'transport-error', times: 3 }
      ],
      {},
      true
    );
    const thrown = await h.client.requestJson({ ...READ, retry: 'safe' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(InjectedTransportError);
    expect(h.tokens.refreshes).toBe(1);
    expect(h.events.map((e) => e.class)).toEqual(['auth', 'transport', 'transport']);
  });

  it('second 401 after a refresh is terminal, not an infinite refresh loop', async () => {
    const h = harness(
      [
        { name: '401-twice', checkpoint: { service: 'collection' }, kind: 'http-status', status: 401, body: 'expired token', times: 2 }
      ],
      {},
      true
    );
    const thrown = await h.client.requestJson({ ...READ, retry: 'safe' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(401);
    expect(h.tokens.refreshes).toBe(1);
    expect(h.events.map((e) => e.class)).toEqual(['auth']);
  });
});

describe('WS6 matrix: fallback', () => {
  it('fallback fires exactly once after exhaustion, emits class fallback with the triggering status, and succeeds', async () => {
    const h = harness(
      [
        { name: 'primary-always-503', checkpoint: { service: 'collection', urlIncludes: PRIMARY } as never, kind: 'http-status', status: 503, times: 3 }
      ],
      { fallbackBaseUrl: FALLBACK, maxRetries: 2 }
    );
    const body = await h.client.requestJson({ ...READ, retry: 'safe' });
    expect(body).toEqual({ ok: true });
    expect(h.events).toEqual([
      { class: 'http', status: 503, attempt: 1, delay: 100 },
      { class: 'http', status: 503, attempt: 2, delay: 200 },
      { class: 'fallback', status: 503, attempt: 1, delay: 0 }
    ]);
    // primary tried 3x (all injected), fallback reached the real upstream once
    expect(h.upstream).toHaveBeenCalledTimes(1);
    const fallbackCall = h.upstream.mock.calls[0]?.[0];
    expect(String(fallbackCall)).toContain(FALLBACK);
  });

  it('fallback is NOT eligible for an unsafe mutation without explicit auto', async () => {
    const h = harness(
      [
        { name: '503-on-create', checkpoint: { service: 'collection', method: 'post' }, kind: 'http-status', status: 503 }
      ],
      { fallbackBaseUrl: FALLBACK }
    );
    const thrown = await h.client.requestJson(CREATE).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect(h.events).toEqual([]);
    expect(h.upstream).toHaveBeenCalledTimes(0);
    expect(h.injector.requestCount()).toBe(1);
  });

  it('explicit fallback auto on a mutation fails over exactly once and does not duplicate the create on the primary', async () => {
    const h = harness(
      [
        { name: '502-on-create', checkpoint: { service: 'collection', method: 'post' }, kind: 'http-status', status: 502 }
      ],
      { fallbackBaseUrl: FALLBACK }
    );
    const body = await h.client.requestJson({ ...CREATE, fallback: 'auto' });
    expect(body).toEqual({ ok: true });
    expect(h.events).toEqual([{ class: 'fallback', status: 502, attempt: 1, delay: 0 }]);
    // exactly one primary attempt (injected 502) + one fallback attempt (upstream)
    expect(h.injector.requestCount()).toBe(2);
    expect(h.upstream).toHaveBeenCalledTimes(1);
  });

  it('a non-retryable fallback failure surfaces as the fallback HttpError, not a second failover', async () => {
    const h = harness(
      [
        { name: 'primary-503', checkpoint: { service: 'collection' }, kind: 'http-status', status: 503, times: 3 },
        { name: 'fallback-403', checkpoint: { urlIncludes: FALLBACK }, kind: 'http-status', status: 403 }
      ],
      { fallbackBaseUrl: FALLBACK, maxRetries: 2 }
    );
    const thrown = await h.client.requestJson({ ...READ, retry: 'safe' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(403);
    expect(h.events.filter((e) => e.class === 'fallback')).toHaveLength(1);
    expect(h.upstream).toHaveBeenCalledTimes(0);
  });

  it('a transient fallback failure returns null-fallback: the ORIGINAL primary error surfaces', async () => {
    const h = harness(
      [
        { name: 'primary-503', checkpoint: { service: 'collection' }, kind: 'http-status', status: 503, times: 3 },
        { name: 'fallback-502', checkpoint: { urlIncludes: FALLBACK }, kind: 'http-status', status: 502 }
      ],
      { fallbackBaseUrl: FALLBACK, maxRetries: 2 }
    );
    const thrown = await h.client.requestJson({ ...READ, retry: 'safe' }).catch((e) => e);
    expect(thrown).toBeInstanceOf(HttpError);
    expect((thrown as HttpError).status).toBe(503);
    expect(h.events.filter((e) => e.class === 'fallback')).toHaveLength(1);
  });
});

describe('WS6 matrix: injector fail-closed guarantees', () => {
  it('rejects unknown failure kinds at construction', () => {
    expect(() =>
      createErrorInjector(async () => okJson(), [
        { name: 'bad', checkpoint: {}, kind: 'explode' as never }
      ])
    ).toThrow('Unknown injection kind');
  });

  it('reports rules that never fired so a dead matrix row cannot silently pass', async () => {
    const h = harness([
      { name: 'never-matches', checkpoint: { service: 'no-such-service' }, kind: 'http-status', status: 500 }
    ]);
    await h.client.requestJson({ ...READ, retry: 'safe' });
    expect(h.injector.unfiredRules()).toEqual(['never-matches']);
  });

  it('ordinal checkpoints hit exactly the Nth matching request', async () => {
    const h = harness([
      { name: 'second-read-only', checkpoint: { service: 'collection', ordinal: 2 }, kind: 'http-status', status: 500 }
    ]);
    await h.client.requestJson({ ...READ, retry: 'safe' });
    const events1 = [...h.events];
    await h.client.requestJson({ ...READ, retry: 'safe' });
    expect(events1).toEqual([]);
    expect(h.events).toEqual([{ class: 'http', status: 500, attempt: 1, delay: 100 }]);
  });
});
