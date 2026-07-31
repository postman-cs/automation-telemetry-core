import { describe, expect, it } from 'vitest';

import { HttpError } from '../src/http/http-error.js';

describe('HttpError', () => {
  it('redacts raw and encoded secrets from messages and structured output', () => {
    const secret = 'token/with+reserved';
    const encoded = encodeURIComponent(secret);
    const error = new HttpError({
      method: 'post',
      url: `https://example.test/resource?token=${encoded}`,
      status: 503,
      statusText: 'Unavailable',
      requestHeaders: {
        Authorization: `Bearer ${secret}`,
        'x-request-note': `encoded=${encoded}`
      },
      responseBody: `failed for ${secret}`,
      secretValues: [secret]
    });

    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain(encoded);
    expect(error.toJSON()).toMatchObject({
      method: 'POST',
      status: 503,
      requestHeaders: {
        authorization: '[REDACTED]',
        'x-request-note': 'encoded=[REDACTED]'
      },
      responseBody: 'failed for [REDACTED]'
    });
  });

  it('builds from a response, bounds the body, and can collapse controls', async () => {
    const error = await HttpError.fromResponse(
      new Response('first\nsecond-too-long', { status: 429, statusText: 'Slow Down' }),
      {
        method: 'get',
        url: 'https://example.test/items',
        bodyLimit: 12,
        oneLine: true
      }
    );

    expect(error.status).toBe(429);
    expect(error.message).toContain('first second...[truncated]');
  });

  it('supports the legacy message/status constructor during consumer migration', () => {
    const error = new HttpError('GET /legacy failed with 500', 500);
    expect(error.message).toBe('GET /legacy failed with 500');
    expect(error.status).toBe(500);
    expect(error.name).toBe('HttpError');
  });
});
