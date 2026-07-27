import { describe, expect, it } from 'vitest';

import {
  createSecretsResolverExec,
  createSecretsResolverItem,
  createSecretsResolverV3Body
} from '../src/secrets-resolver.js';

describe('secrets resolver safety', () => {
  it('rejects the disabled provider in every public resolver builder', () => {
    for (const builder of [
      createSecretsResolverExec,
      createSecretsResolverItem,
      createSecretsResolverV3Body
    ]) {
      expect(() => builder('none')).toThrow(/SECRETS_RESOLVER_DISABLED/);
    }
  });

  it('preserves historical AWS resolver markers when explicitly selected', () => {
    expect(createSecretsResolverExec('aws').join('\n')).toContain('body.SecretString');

    const item = createSecretsResolverItem('aws') as {
      request: { method: string; header: Array<{ key: string; value: string }> };
    };
    expect(item.request.method).toBe('POST');
    expect(item.request.header).toContainEqual({
      key: 'X-Amz-Target',
      value: 'secretsmanager.GetSecretValue'
    });

    const body = createSecretsResolverV3Body('aws') as {
      method: string;
      headers: Array<{ key: string; value: string }>;
    };
    expect(body.method).toBe('POST');
    expect(body.headers).toContainEqual({
      key: 'X-Amz-Target',
      value: 'secretsmanager.GetSecretValue'
    });
  });
});
