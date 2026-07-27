import { describe, expect, it, vi } from 'vitest';

import {
  consoleSink,
  createLogger,
  describeError,
  describeUrl,
  httpFields,
  resolveLogLevel,
  type LogSink
} from '../src/logger.js';

function recordingSink(): { sink: LogSink; lines: string[] } {
  const lines: string[] = [];
  const sink: LogSink = {
    debug: (message) => lines.push(`debug ${message}`),
    info: (message) => lines.push(`info ${message}`),
    warning: (message) => lines.push(`warning ${message}`),
    error: (message) => lines.push(`error ${message}`)
  };
  return { sink, lines };
}

describe('resolveLogLevel', () => {
  it('defaults to info without any signal', () => {
    expect(resolveLogLevel({})).toBe('info');
  });

  it("honours GitHub's own re-run-with-debug switches", () => {
    expect(resolveLogLevel({ RUNNER_DEBUG: '1' })).toBe('debug');
    expect(resolveLogLevel({ ACTIONS_STEP_DEBUG: 'true' })).toBe('debug');
  });

  it('lets an explicit level override the runner signal', () => {
    expect(resolveLogLevel({ RUNNER_DEBUG: '1', POSTMAN_ACTIONS_LOG_LEVEL: 'error' })).toBe('error');
    expect(resolveLogLevel({ POSTMAN_ACTIONS_LOG_LEVEL: 'DEBUG' })).toBe('debug');
    expect(resolveLogLevel({ POSTMAN_ACTIONS_LOG_LEVEL: 'verbose' })).toBe('debug');
  });

  it('ignores unknown and falsey values instead of failing closed to silence', () => {
    expect(resolveLogLevel({ POSTMAN_ACTIONS_LOG_LEVEL: 'chatty' })).toBe('info');
    expect(resolveLogLevel({ RUNNER_DEBUG: '0' })).toBe('info');
    expect(resolveLogLevel({ RUNNER_DEBUG: '' })).toBe('info');
  });
});

describe('level gating', () => {
  it('drops debug lines at info and keeps them at debug', () => {
    const quiet = recordingSink();
    createLogger({ sink: quiet.sink, env: {} }).debug('hidden');
    expect(quiet.lines).toEqual([]);

    const loud = recordingSink();
    createLogger({ sink: loud.sink, env: { RUNNER_DEBUG: '1' } }).debug('shown');
    expect(loud.lines.join()).toContain('shown');
  });

  it('always emits errors, even at the quietest level', () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({ sink, env: { POSTMAN_ACTIONS_LOG_LEVEL: 'error' } });
    log.info('dropped');
    log.error('kept');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('kept');
  });

  it('reports its own debug state so callers can skip expensive field building', () => {
    expect(createLogger({ sink: recordingSink().sink, env: {} }).isDebug()).toBe(false);
    expect(
      createLogger({ sink: recordingSink().sink, env: { RUNNER_DEBUG: '1' } }).isDebug()
    ).toBe(true);
  });
});

describe('redaction', () => {
  it('scrubs a registered secret from messages, fields, and errors', () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({ sink, env: {} });
    log.addSecret('PMAK-super-secret-value');
    log.info('using PMAK-super-secret-value', { token: 'PMAK-super-secret-value' });
    log.failure('boom', new Error('denied for PMAK-super-secret-value'));
    const all = lines.join('\n');
    expect(all).not.toContain('PMAK-super-secret-value');
    expect(all.match(/\*\*\*/g)?.length).toBeGreaterThanOrEqual(3);
  });

  it('scrubs the url-encoded spelling of a secret', () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({ sink, env: {} });
    log.addSecret('a b/c+d');
    log.info(`query ${encodeURIComponent('a b/c+d')}`);
    expect(lines.join()).not.toContain('a%20b%2Fc%2Bd');
  });

  it('refuses to mask strings too short to be real secrets', () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({ sink, env: {} });
    log.addSecret('on');
    log.addSecret(undefined);
    log.addSecret(null);
    log.info('turned on');
    expect(lines.join()).toContain('turned on');
  });

  it('shares one secret registry with child loggers in both directions', () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({ sink, env: {} });
    const child = log.child({ component: 'transport' });
    child.addSecret('secret-registered-late');
    log.info('parent sees secret-registered-late');
    child.info('child sees secret-registered-late');
    expect(lines.join()).not.toContain('secret-registered-late');
  });
});

describe('structured fields', () => {
  it('renders merged base, child, and call fields on one line', () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({
      sink,
      env: {},
      correlationId: 'run123',
      fields: { action: 'bootstrap' }
    });
    log.child({ component: 'gateway' }).info('created', { workspace_id: 'ws-1' });
    expect(lines[0]).toBe(
      'info created | run=run123 action=bootstrap component=gateway workspace_id=ws-1'
    );
  });

  it('omits undefined fields but keeps explicit null and zero', () => {
    const { sink, lines } = recordingSink();
    createLogger({ sink, env: {}, correlationId: 'r' }).info('x', {
      absent: undefined,
      empty: null,
      count: 0
    });
    expect(lines[0]).toBe('info x | run=r empty=null count=0');
  });

  it('truncates oversized values with an explicit marker rather than silently', () => {
    const { sink, lines } = recordingSink();
    createLogger({ sink, env: {}, correlationId: 'r' }).info('x', { blob: 'y'.repeat(600) });
    expect(lines[0]).toContain('… (+88 chars)');
  });

  it('survives unserializable values', () => {
    const { sink, lines } = recordingSink();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    createLogger({ sink, env: {}, correlationId: 'r' }).info('x', { cyclic });
    expect(lines[0]).toContain('<unserializable>');
  });
});

describe('describeError', () => {
  it('flattens the full cause chain', () => {
    const root = new Error('ECONNREFUSED');
    const middle = new Error('gateway unreachable', { cause: root });
    const top = new Error('bootstrap failed', { cause: middle });
    expect(describeError(top)).toBe(
      'Error: bootstrap failed <- caused by Error: gateway unreachable <- caused by Error: ECONNREFUSED'
    );
  });

  it('surfaces the syscall code that actually failed', () => {
    const error = Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' });
    expect(describeError(error)).toContain('Error[ECONNREFUSED]');
  });

  it('handles non-error throws and empty values', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError({ status: 500 })).toBe('{"status":500}');
    expect(describeError(undefined)).toBe('unknown error');
  });

  it('stops before an infinite cause cycle', () => {
    const a = new Error('a');
    const b = new Error('b', { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => describeError(a)).not.toThrow();
  });
});

describe('describeUrl', () => {
  it('keeps origin and path but masks every query value', () => {
    expect(describeUrl('https://api.getpostman.com/workspaces?apikey=PMAK-abc&keep=1')).toBe(
      'https://api.getpostman.com/workspaces?apikey=***&keep=***'
    );
  });

  it('masks credentials embedded in the authority', () => {
    // Assembled rather than written inline: a literal user:pass@host URI trips
    // repository secret scanners even as a fixture.
    const authority = `${'user'}:${'pass'}@example.com`;
    expect(describeUrl(`https://${authority}/x`)).toContain('***@example.com');
  });

  it('never throws on malformed input', () => {
    expect(describeUrl('not a url')).toBe('<unparseable url>');
  });
});

describe('httpFields', () => {
  it('captures the identity of one exchange for triage', () => {
    expect(
      httpFields({
        method: 'post',
        url: 'https://api.getpostman.com/v1/x?token=abc',
        status: 502,
        durationMs: 1234.6,
        requestId: 'req-9',
        attempt: 2
      })
    ).toEqual({
      method: 'POST',
      url: 'https://api.getpostman.com/v1/x?token=***',
      status: 502,
      duration_ms: 1235,
      request_id: 'req-9',
      attempt: 2
    });
  });

  it('omits absent optional diagnostics instead of logging undefined', () => {
    expect(httpFields({ method: 'GET', url: 'https://x.dev/a' })).toEqual({
      method: 'GET',
      url: 'https://x.dev/a'
    });
  });
});

describe('phase', () => {
  it('brackets work with debug start/ok lines and elapsed time', async () => {
    const { sink, lines } = recordingSink();
    let clock = 1000;
    const log = createLogger({
      sink,
      env: { RUNNER_DEBUG: '1' },
      correlationId: 'r',
      now: () => clock
    });
    const result = await log.phase('resolve-token', async () => {
      clock = 1250;
      return 'token';
    });
    expect(result).toBe('token');
    expect(lines[0]).toBe('debug phase start | run=r phase=resolve-token');
    expect(lines[1]).toBe('debug phase ok | run=r phase=resolve-token duration_ms=250');
  });

  it('names the failing phase before rethrowing', async () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({ sink, env: {}, correlationId: 'r' });
    await expect(
      log.phase('sync-collections', async () => {
        throw new Error('conflict', { cause: new Error('409') });
      })
    ).rejects.toThrow('conflict');
    expect(lines.join()).toContain('phase=sync-collections');
    expect(lines.join()).toContain('Error: conflict <- caused by Error: 409');
  });

  it('opens and closes a sink group even when the body throws', async () => {
    const startGroup = vi.fn();
    const endGroup = vi.fn();
    const base = recordingSink();
    const log = createLogger({
      sink: { ...base.sink, startGroup, endGroup },
      env: {}
    });
    await expect(log.phase('p', async () => { throw new Error('x'); })).rejects.toThrow('x');
    expect(startGroup).toHaveBeenCalledWith('p');
    expect(endGroup).toHaveBeenCalledTimes(1);
  });

  it('redacts secrets inside phase failure output', async () => {
    const { sink, lines } = recordingSink();
    const log = createLogger({ sink, env: {} });
    log.addSecret('PMAK-leaky-token');
    await expect(
      log.phase('p', async () => {
        throw new Error('rejected PMAK-leaky-token');
      })
    ).rejects.toThrow();
    expect(lines.join()).not.toContain('PMAK-leaky-token');
  });
});

describe('consoleSink', () => {
  it('routes warnings and errors to stderr so piped stdout still shows them', () => {
    const target = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const log = createLogger({ sink: consoleSink(target), env: {} });
    log.info('i');
    log.warning('w');
    log.error('e');
    expect(target.log).toHaveBeenCalledTimes(1);
    expect(target.warn).toHaveBeenCalledTimes(1);
    expect(target.error).toHaveBeenCalledTimes(1);
  });
});
