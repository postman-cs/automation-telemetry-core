import { describe, expect, it } from 'vitest';

import {
  createSecretsResolverExec,
  createSecretsResolverItem,
  createSecretsResolverV3Body,
  DEFAULT_SECRETS_RESOLVER_PROVIDER,
  isSecretsResolverEnabled,
  isSecretsResolverItemName,
  parseSecretsResolverProvider,
  SECRETS_RESOLVER_ITEM_NAME,
  SECRETS_RESOLVER_PROVIDERS,
  secretsResolverEnvironmentKeys,
  type SecretsResolverProvider
} from '../src/secrets-resolver.js';

function record(value: unknown): Record<string, unknown> {
  expect(value && typeof value === 'object' && !Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>;
}

describe('secrets resolver provider contract', () => {
  it('defaults to off so no consumer ships a doomed request', () => {
    expect(DEFAULT_SECRETS_RESOLVER_PROVIDER).toBe('none');
    expect(isSecretsResolverEnabled('none')).toBe(false);
    expect(parseSecretsResolverProvider(undefined)).toBe('none');
    expect(parseSecretsResolverProvider('')).toBe('none');
  });

  it('enumerates exactly the supported providers', () => {
    expect([...SECRETS_RESOLVER_PROVIDERS]).toEqual(['none', 'aws', 'azure', 'gcp']);
  });

  it('accepts the legacy boolean spelling so existing callers keep working', () => {
    expect(parseSecretsResolverProvider('true')).toBe('aws');
    expect(parseSecretsResolverProvider('false')).toBe('none');
    expect(parseSecretsResolverProvider('off')).toBe('none');
    // case and padding tolerant
    expect(parseSecretsResolverProvider('  AWS  ')).toBe('aws');
    expect(parseSecretsResolverProvider('Azure')).toBe('azure');
  });

  it('honours an explicit fallback only when the value is absent', () => {
    expect(parseSecretsResolverProvider(undefined, 'aws')).toBe('aws');
    expect(parseSecretsResolverProvider('gcp', 'aws')).toBe('gcp');
    expect(parseSecretsResolverProvider('false', 'aws')).toBe('none');
  });

  it('rejects an unknown provider with an actionable message', () => {
    expect(() => parseSecretsResolverProvider('vault')).toThrow(/SECRETS_RESOLVER_PROVIDER_INVALID/);
    expect(() => parseSecretsResolverProvider('vault')).toThrow(/none, aws, azure, gcp/);
  });

  it('treats every enabled provider as enabled', () => {
    for (const provider of SECRETS_RESOLVER_PROVIDERS) {
      expect(isSecretsResolverEnabled(provider)).toBe(provider !== 'none');
    }
  });

  it('keeps one canonical helper name across providers so dedupe keeps working', () => {
    expect(SECRETS_RESOLVER_ITEM_NAME).toBe('00 - Resolve Secrets');
    expect(isSecretsResolverItemName(SECRETS_RESOLVER_ITEM_NAME)).toBe(true);
    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      expect(record(createSecretsResolverItem(provider)).name).toBe(SECRETS_RESOLVER_ITEM_NAME);
      expect(record(createSecretsResolverV3Body(provider)).name).toBe(SECRETS_RESOLVER_ITEM_NAME);
    }
  });

  it('seeds no environment keys when the resolver is off', () => {
    expect(secretsResolverEnvironmentKeys('none')).toEqual([]);
  });

  it('seeds provider-scoped environment keys and never leaks another cloud', () => {
    const aws = secretsResolverEnvironmentKeys('aws').map((entry) => entry.key);
    const azure = secretsResolverEnvironmentKeys('azure').map((entry) => entry.key);
    const gcp = secretsResolverEnvironmentKeys('gcp').map((entry) => entry.key);

    expect(aws).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION', 'AWS_SECRET_NAME']);
    expect(azure.every((key) => key.startsWith('AZURE_'))).toBe(true);
    expect(gcp.every((key) => key.startsWith('GCP_'))).toBe(true);
    // the historical bug: AWS vars seeded for non-AWS consumers
    expect(azure.some((key) => key.startsWith('AWS_'))).toBe(false);
    expect(gcp.some((key) => key.startsWith('AWS_'))).toBe(false);
  });

  it('marks exactly the credential-bearing keys secret', () => {
    const secretKeys = (provider: SecretsResolverProvider) =>
      secretsResolverEnvironmentKeys(provider)
        .filter((entry) => entry.secret)
        .map((entry) => entry.key);
    expect(secretKeys('aws')).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
    expect(secretKeys('azure')).toEqual(['AZURE_ACCESS_TOKEN']);
    expect(secretKeys('gcp')).toEqual(['GCP_ACCESS_TOKEN']);
  });

  it('skips in CI for every provider so the helper contributes no CI assertions', () => {
    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      expect(createSecretsResolverExec(provider)[0]).toContain('pm.environment.get("CI") === "true"');
    }
  });

  it('extracts the secret bundle from each provider response shape', () => {
    expect(createSecretsResolverExec('aws').join('\n')).toContain('body.SecretString');
    expect(createSecretsResolverExec('azure').join('\n')).toContain('body.value');
    const gcp = createSecretsResolverExec('gcp').join('\n');
    expect(gcp).toContain('body.payload && body.payload.data');
    expect(gcp).toContain('base64');
  });

  it('fans every provider bundle out into collection variables', () => {
    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      expect(createSecretsResolverExec(provider).join('\n')).toContain('pm.collectionVariables.set');
    }
  });

  it('builds the AWS item with sigv4 auth and the GetSecretValue target', () => {
    const item = record(createSecretsResolverItem('aws'));
    const request = record(item.request);
    expect(record(request.auth).type).toBe('awsv4');
    expect(request.method).toBe('POST');
    const headers = request.header as Array<{ key: string; value: string }>;
    expect(headers.find((h) => h.key === 'X-Amz-Target')?.value).toBe('secretsmanager.GetSecretValue');
  });

  it('builds the Azure item as a bearer GET against Key Vault', () => {
    const request = record(record(createSecretsResolverItem('azure')).request);
    expect(request.method).toBe('GET');
    expect(record(request.auth).type).toBe('bearer');
    expect(String(record(request.url).raw)).toContain('vault.azure.net/secrets/');
    expect(String(record(request.url).raw)).toContain('api-version=7.4');
  });

  it('builds the GCP item as a bearer GET against the access endpoint', () => {
    const request = record(record(createSecretsResolverItem('gcp')).request);
    expect(request.method).toBe('GET');
    expect(record(request.auth).type).toBe('bearer');
    expect(String(record(request.url).raw)).toContain('secretmanager.googleapis.com');
    expect(String(record(request.url).raw)).toContain('versions/latest:access');
  });

  it('carries v3 request internals at the item root, never under a payload wrapper', () => {
    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      const body = record(createSecretsResolverV3Body(provider));
      expect(body.$kind).toBe('http-request');
      expect(body.payload).toBeUndefined();
      expect(typeof body.url).toBe('string');
      expect(body.method).toBeTruthy();
      expect(record(body.auth).credentials).toBeDefined();
    }
  });

  it('references only its own provider variables in the item wire shape', () => {
    const prefixes = { aws: 'AWS_', azure: 'AZURE_', gcp: 'GCP_' } as const;
    for (const [provider, own] of Object.entries(prefixes) as Array<[keyof typeof prefixes, string]>) {
      const wire = JSON.stringify([
        createSecretsResolverItem(provider),
        createSecretsResolverV3Body(provider)
      ]);
      for (const foreign of Object.values(prefixes).filter((p) => p !== own)) {
        expect(wire).not.toContain(`{{${foreign}`);
      }
    }
  });
});
