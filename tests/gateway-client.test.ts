import { describe, expect, it, vi } from 'vitest';

import {
  AccessTokenGatewayClient,
  type GatewayRetryEvent,
  type GatewayTokenProvider
} from '../src/http/gateway-client.js';
import { HttpError } from '../src/http/http-error.js';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    ...init
  });
}

function tokenProvider(initial = 'stale'): GatewayTokenProvider & { refresh: ReturnType<typeof vi.fn> } {
  let token = initial;
  const refresh = vi.fn(async () => {
    token = 'fresh';
    return token;
  });
  return {
    current: () => token,
    canRefresh: () => true,
    refresh
  };
}

describe('AccessTokenGatewayClient shared core', () => {
  it('shapes proxy requests with live auth, route headers, team scope, query, and body', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ ok: true }));
    const client = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token-1'),
      bifrostBaseUrl: 'https://bifrost.example/',
      teamId: 'team-1',
      orgMode: true,
      fetchImpl,
      appVersionProvider: { resolve: async () => '12.3.4' }
    });

    await client.requestJson({
      service: 'collection',
      method: 'post',
      path: '/v3/collections',
      query: { workspace: 'ws-1' },
      body: { name: 'Payments' },
      headers: { 'X-Entity-Type': 'collection' }
    });

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://bifrost.example/ws/proxy',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-access-token': 'token-1',
          'x-entity-team-id': 'team-1',
          'x-app-version': '12.3.4',
          'X-Entity-Type': 'collection'
        }),
        body: JSON.stringify({
          service: 'collection',
          method: 'post',
          path: '/v3/collections',
          query: { workspace: 'ws-1' },
          body: { name: 'Payments' }
        })
      })
    );
  });

  it('retries the repo-sync superset, emits events, and preserves Retry-After caps', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('request timeout', { status: 408 }))
      .mockResolvedValueOnce(new Response('downstream ECONNRESET', { status: 400 }))
      .mockResolvedValueOnce(
        new Response('rate limited', { status: 429, headers: { 'Retry-After': '3600' } })
      )
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const events: GatewayRetryEvent[] = [];
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => undefined);
    const client = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl,
      maxRetries: 3,
      retryBaseDelayMs: 10,
      retryMaxDelayMs: 50,
      randomImpl: () => 1,
      sleepImpl: sleep,
      onRetryEvent: (event) => events.push(event)
    });

    await expect(
      client.requestJson({ service: 'collection', method: 'get', path: '/v3/collections/x' })
    ).resolves.toEqual({ ok: true });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([10, 20, 50]);
    expect(events.map(({ class: eventClass, status, attempt }) => ({ eventClass, status, attempt }))).toEqual([
      { eventClass: 'http', status: 408, attempt: 1 },
      { eventClass: 'http', status: 400, attempt: 2 },
      { eventClass: 'http', status: 429, attempt: 3 }
    ]);
  });

  it('exhausts retries, rejects non-retryable classes immediately, and preserves HttpError', async () => {
    const transientFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('downstream', { status: 503 })
    );
    const transientClient = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl: transientFetch,
      maxRetries: 2,
      sleepImpl: async () => undefined
    });
    await expect(
      transientClient.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).rejects.toMatchObject({ status: 503 });
    expect(transientFetch).toHaveBeenCalledTimes(3);

    const permanentFetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('missing', { status: 404 })
    );
    const permanentClient = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl: permanentFetch,
      sleepImpl: async () => undefined
    });
    await expect(
      permanentClient.requestJson({ service: 'collection', method: 'get', path: '/missing' })
    ).rejects.toBeInstanceOf(HttpError);
    expect(permanentFetch).toHaveBeenCalledOnce();
  });

  it('refreshes auth once without consuming retry budget and re-enters the retry loop', async () => {
    const provider = tokenProvider();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('UNAUTHENTICATED', { status: 401 }))
      .mockResolvedValueOnce(new Response('downstream', { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new AccessTokenGatewayClient({
      tokenProvider: provider,
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl,
      maxRetries: 1,
      sleepImpl: async () => undefined
    });

    await expect(
      client.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).resolves.toEqual({ ok: true });
    expect(provider.refresh).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);

    const secondAuthFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('UNAUTHENTICATED', { status: 401 }))
      .mockResolvedValueOnce(new Response('UNAUTHENTICATED', { status: 401 }));
    const secondProvider = tokenProvider();
    const secondClient = new AccessTokenGatewayClient({
      tokenProvider: secondProvider,
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl: secondAuthFetch
    });
    await expect(
      secondClient.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).rejects.toMatchObject({ status: 401 });
    expect(secondProvider.refresh).toHaveBeenCalledOnce();
  });

  it('keeps bootstrap/repo inner defaults while allowing smoke-flow inner auth refresh', async () => {
    const defaultClient = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        jsonResponse({ error: 'UNAUTHENTICATED' })
      ),
      maxRetries: 0
    });
    await expect(
      defaultClient.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).rejects.toMatchObject({ status: 502 });

    const provider = tokenProvider();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ error: 'UNAUTHENTICATED' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const smokeCompatibleClient = new AccessTokenGatewayClient({
      tokenProvider: provider,
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl,
      classifyInnerAuthError: true,
      refreshOnInnerAuthError: true
    });
    await expect(
      smokeCompatibleClient.requestJson({ service: 'collection', method: 'get', path: '/x' })
    ).resolves.toEqual({ ok: true });
    expect(provider.refresh).toHaveBeenCalledOnce();
  });

  it('keeps unsafe mutations single-shot unless rate-limit retry or fallback is explicit', async () => {
    const unsafeFetch = vi.fn<typeof fetch>().mockResolvedValue(new Response('downstream', { status: 503 }));
    const unsafeClient = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://primary.example',
      fallbackBaseUrl: 'https://fallback.example',
      fetchImpl: unsafeFetch,
      sleepImpl: async () => undefined
    });
    await expect(
      unsafeClient.requestJson({ service: 'collection', method: 'post', path: '/items', retry: 'none' })
    ).rejects.toMatchObject({ status: 503 });
    expect(unsafeFetch).toHaveBeenCalledOnce();

    const fallbackFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('downstream', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const fallbackClient = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://primary.example',
      fallbackBaseUrl: 'https://fallback.example',
      fetchImpl: fallbackFetch
    });
    await expect(
      fallbackClient.requestJson({
        service: 'collection',
        method: 'post',
        path: '/items',
        retry: 'none',
        fallback: 'auto'
      })
    ).resolves.toEqual({ ok: true });
    expect(String(fallbackFetch.mock.calls[1]?.[0])).toBe('https://fallback.example/ws/proxy');
  });

  it('supports repo-sync retryTransient and smoke-flow per-request maxRetries adapters', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('downstream', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const client = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl,
      maxRetries: 0,
      sleepImpl: async () => undefined
    });
    await expect(
      client.requestJson(
        { service: 'collection', method: 'post', path: '/fixed-target', maxRetries: 1 },
        { retryTransient: true }
      )
    ).resolves.toEqual({ ok: true });
  });

  it('handles inner errors, bodyless success, and direct authenticated GET routes', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ success: false, status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ identity: { team: 'team-1' } }));
    const client = new AccessTokenGatewayClient({
      tokenProvider: tokenProvider('token'),
      bifrostBaseUrl: 'https://bifrost.example',
      fetchImpl,
      maxRetries: 1,
      sleepImpl: async () => undefined
    });

    await expect(
      client.requestJson({ service: 'collection', method: 'delete', path: '/x', retry: 'safe' })
    ).resolves.toBeNull();
    await expect(client.requestDirectJson('/api/sessions/current')).resolves.toEqual({
      identity: { team: 'team-1' }
    });
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('https://bifrost.example/api/sessions/current');
  });
});
