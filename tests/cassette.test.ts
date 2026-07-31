import { describe, expect, it, vi } from 'vitest';

import {
  CASSETTE_MINTED_TOKEN,
  cassetteRequest,
  createEmptyCassette,
  createRecordingFetch,
  createReplayFetch,
  interactionKey,
  type Cassette
} from '../src/cassette.js';

describe('shared cassette transport', () => {
  it('keys proxy and direct routes by canonical query plus body digest', () => {
    const proxyA = cassetteRequest(
      'https://bifrost.example/ws/proxy',
      'POST',
      JSON.stringify({
        service: 'collection',
        method: 'get',
        path: '/collection/id/sync?favorite=true&since_id=0',
        query: { workspace: 'ws-1' },
        body: { revision: 1 }
      })
    );
    const proxyB = cassetteRequest(
      'https://bifrost.example/ws/proxy',
      'POST',
      JSON.stringify({
        service: 'collection',
        method: 'get',
        path: '/collection/id/sync?since_id=0&favorite=true',
        query: { workspace: 'ws-1' },
        body: { revision: 2 }
      })
    );
    expect(proxyA.key).toContain('proxy:collection GET /collection/id/sync');
    expect(proxyA.requestQuery).toBe('favorite=true&since_id=0&workspace=ws-1');
    expect(proxyA.requestBodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(proxyB.key).not.toBe(proxyA.key);

    const directRoutes = [
      ['GET', 'https://bifrost.example/collection/id/sync?since_id=0'],
      ['POST', 'https://api.example/service-account-tokens'],
      ['GET', 'https://api.example/me'],
      ['GET', 'https://iapub.example/api/sessions/current']
    ] as const;
    for (const [method, url] of directRoutes) {
      expect(interactionKey(url, method, method === 'POST' ? '{"apiKey":"x"}' : undefined))
        .toContain(`${method} ${new URL(url).origin}${new URL(url).pathname}`);
    }
    expect(
      interactionKey('https://bifrost.example/collection/id/sync?since_id=0', 'GET')
    ).not.toBe(
      interactionKey('https://bifrost.example/collection/id/sync?since_id=1', 'GET')
    );
    expect(
      interactionKey('https://api.example/service-account-tokens', 'POST', '{"apiKey":"a"}')
    ).not.toBe(
      interactionKey('https://api.example/service-account-tokens', 'POST', '{"apiKey":"b"}')
    );
  });

  it('records query, request digest, redacted bodies, and response headers', async () => {
    const cassette = createEmptyCassette();
    const inner = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('{"access_token":"live-secret"}', {
        status: 201,
        headers: { 'content-type': 'application/json', 'x-request-id': 'req-1' }
      })
    );
    const recording = createRecordingFetch(inner, cassette, (value) =>
      value.replaceAll('live-secret', '[REDACTED]')
    );

    await recording('https://api.example/service-account-tokens?source=test', {
      method: 'POST',
      body: JSON.stringify({ apiKey: 'do-not-store' })
    });

    expect(cassette.version).toBe(2);
    expect(cassette.interactions).toHaveLength(1);
    expect(cassette.interactions[0]).toMatchObject({
      status: 201,
      body: JSON.stringify({ access_token: CASSETTE_MINTED_TOKEN }),
      requestQuery: 'source=test',
      responseHeaders: {
        'content-type': 'application/json',
        'x-request-id': 'req-1'
      }
    });
    expect(JSON.stringify(cassette)).not.toContain('do-not-store');
    expect(JSON.stringify(cassette)).not.toContain('live-secret');
  });

  it('redacts HTTP service-account token responses with the default masker', async () => {
    const cassette = createEmptyCassette();
    const liveToken = 'http-live-secret';
    const recording = createRecordingFetch(
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ access_token: liveToken }), { status: 201 })
      ),
      cassette
    );

    await recording('http://api.example/service-account-tokens', { method: 'POST' });

    expect(JSON.stringify(cassette)).not.toContain(liveToken);
    expect(cassette.interactions[0]?.body).toBe(
      JSON.stringify({ access_token: CASSETTE_MINTED_TOKEN })
    );
  });

  it('hard-fails on key mismatch and exhausted queues', async () => {
    const cassette = createEmptyCassette();
    const match = cassetteRequest('https://api.example/me', 'GET');
    cassette.interactions.push({
      ...match,
      status: 200,
      body: '{}',
      responseHeaders: { 'content-type': 'application/json' }
    });
    const replay = createReplayFetch(cassette);

    await expect(replay('https://api.example/unknown')).rejects.toThrow(/no recorded response/i);
    const response = await replay('https://api.example/me');
    expect(response).toBeInstanceOf(Response);
    expect(response.headers.get('content-type')).toBe('application/json');
    await expect(replay('https://api.example/me')).rejects.toThrow(/exhausted/i);
  });

  it('repeats only a fixture entry that explicitly declares repeat-last', async () => {
    const cassette = createEmptyCassette();
    const match = cassetteRequest('https://api.example/poll?cursor=1', 'GET');
    cassette.interactions.push({
      ...match,
      status: 200,
      body: '{"done":true}',
      responseHeaders: {},
      repeatLast: true
    });
    const replay = createReplayFetch(cassette);

    expect(await (await replay('https://api.example/poll?cursor=1')).json()).toEqual({ done: true });
    expect(await (await replay('https://api.example/poll?cursor=1')).json()).toEqual({ done: true });
  });

  it('does not retain repeat-last when a later queued response disables it', async () => {
    const cassette = createEmptyCassette();
    const match = cassetteRequest('https://api.example/poll', 'GET');
    cassette.interactions.push(
      {
        ...match,
        status: 200,
        body: '{"step":1}',
        responseHeaders: {},
        repeatLast: true
      },
      {
        ...match,
        status: 200,
        body: '{"step":2}',
        responseHeaders: {}
      }
    );
    const replay = createReplayFetch(cassette);

    await replay('https://api.example/poll');
    await replay('https://api.example/poll');
    await expect(replay('https://api.example/poll')).rejects.toThrow(/exhausted/i);
  });

  it('rejects an unsupported cassette version and a non-array interaction list', () => {
    expect(() => createReplayFetch({ version: 1, interactions: [] } as unknown as Cassette)).toThrow(
      /Unsupported cassette version 1/
    );
    expect(() => createReplayFetch({ version: 2 } as unknown as Cassette)).toThrow(
      /interactions must be an array/
    );
  });

  it('refuses a structurally incomplete interaction instead of replaying a default 200', () => {
    const match = cassetteRequest('https://api.example/me', 'GET');
    const wellFormed = {
      ...match,
      status: 200,
      body: '{}',
      responseHeaders: { 'content-type': 'application/json' }
    };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...wellFormed, status: undefined }, /\.status must be an integer HTTP status/],
      [{ ...wellFormed, status: 99 }, /\.status must be an integer HTTP status/],
      [{ ...wellFormed, body: undefined }, /\.body must be a string/],
      [{ ...wellFormed, responseHeaders: undefined }, /\.responseHeaders must be an object/],
      [{ ...wellFormed, responseHeaders: { 'x-count': 3 } }, /responseHeaders\["x-count"\]/],
      [{ ...wellFormed, key: '' }, /\.key must be a non-empty string/],
      [{ ...wellFormed, requestQuery: undefined }, /\.requestQuery must be a string/],
      [{ ...wellFormed, statusText: 7 }, /\.statusText must be a string when present/],
      [{ ...wellFormed, requestBodySha256: 'nope' }, /\.requestBodySha256 must be a sha-256/],
      [{ ...wellFormed, repeatLast: 'yes' }, /\.repeatLast must be a boolean when present/]
    ];

    for (const [interaction, expected] of cases) {
      expect(() =>
        createReplayFetch({ version: 2, interactions: [interaction] } as unknown as Cassette)
      ).toThrow(expected);
    }

    expect(() =>
      createReplayFetch({ version: 2, interactions: [null] } as unknown as Cassette)
    ).toThrow(/interactions\[0\] must be an object/);
    expect(() => createReplayFetch({ version: 2, interactions: [wellFormed] })).not.toThrow();
  });
});
