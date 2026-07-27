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

function runResolverExec(
  provider: Exclude<SecretsResolverProvider, 'none'>,
  response: unknown,
  ci = false
): { responseJsonCalls: number; collectionVariables: Map<string, unknown> } {
  let responseJsonCalls = 0;
  const collectionVariables = new Map<string, unknown>();
  const pm = {
    environment: { get: (key: string) => (key === 'CI' && ci ? 'true' : undefined) },
    response: {
      json: () => {
        responseJsonCalls += 1;
        return response;
      }
    },
    collectionVariables: { set: (key: string, value: unknown) => collectionVariables.set(key, value) }
  };

  new Function('pm', 'Buffer', createSecretsResolverExec(provider).join('\n'))(pm, Buffer);
  return { responseJsonCalls, collectionVariables };
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

  it('seeds the exact ordered provider-scoped environment keys', () => {
    expect(secretsResolverEnvironmentKeys('aws').map((entry) => entry.key)).toEqual([
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_REGION',
      'AWS_SECRET_NAME'
    ]);
    expect(secretsResolverEnvironmentKeys('azure').map((entry) => entry.key)).toEqual([
      'AZURE_KEY_VAULT_NAME',
      'AZURE_SECRET_NAME',
      'AZURE_ACCESS_TOKEN'
    ]);
    expect(secretsResolverEnvironmentKeys('gcp').map((entry) => entry.key)).toEqual([
      'GCP_PROJECT_ID',
      'GCP_SECRET_NAME',
      'GCP_ACCESS_TOKEN'
    ]);
    expect(secretsResolverEnvironmentKeys('none')).toEqual([]);
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

  it('executes each provider script to extract its response bundle into collection variables', () => {
    expect(runResolverExec('aws', { SecretString: '{"awsKey":"awsValue"}' }).collectionVariables).toEqual(
      new Map([['awsKey', 'awsValue']])
    );
    expect(runResolverExec('azure', { value: '{"azureKey":"azureValue"}' }).collectionVariables).toEqual(
      new Map([['azureKey', 'azureValue']])
    );
    expect(
      runResolverExec('gcp', {
        payload: { data: Buffer.from('{"gcpKey":"gcpValue"}', 'utf8').toString('base64') }
      }).collectionVariables
    ).toEqual(new Map([['gcpKey', 'gcpValue']]));
  });

  it('returns before response parsing or writes in CI for every enabled provider', () => {
    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      const result = runResolverExec(provider, { unexpected: 'response' }, true);
      expect(result.responseJsonCalls).toBe(0);
      expect(result.collectionVariables).toEqual(new Map());
    }
  });

  it('builds exact v2 and v3 wire contracts for every provider', () => {
    const contracts = {
      aws: {
        method: 'POST',
        url: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
        headers: [
          { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
          { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
        ],
        auth: {
          type: 'awsv4',
          credentials: [
            { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
            { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
            { key: 'region', value: '{{AWS_REGION}}' },
            { key: 'service', value: 'secretsmanager' }
          ]
        },
        body: { v2: { mode: 'raw', raw: '{"SecretId": "{{AWS_SECRET_NAME}}"}' }, v3: { type: 'json', content: '{"SecretId": "{{AWS_SECRET_NAME}}"}' } }
      },
      azure: {
        method: 'GET',
        url: 'https://{{AZURE_KEY_VAULT_NAME}}.vault.azure.net/secrets/{{AZURE_SECRET_NAME}}?api-version=7.4',
        headers: [{ key: 'Accept', value: 'application/json' }],
        auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{AZURE_ACCESS_TOKEN}}' }] }
      },
      gcp: {
        method: 'GET',
        url: 'https://secretmanager.googleapis.com/v1/projects/{{GCP_PROJECT_ID}}/secrets/{{GCP_SECRET_NAME}}/versions/latest:access',
        headers: [{ key: 'Accept', value: 'application/json' }],
        auth: { type: 'bearer', credentials: [{ key: 'token', value: '{{GCP_ACCESS_TOKEN}}' }] }
      }
    } as const;

    for (const provider of ['aws', 'azure', 'gcp'] as const) {
      const contract = contracts[provider];
      const v2 = record(record(createSecretsResolverItem(provider)).request);
      const v3 = record(createSecretsResolverV3Body(provider));
      expect(v2.method).toBe(contract.method);
      expect(record(v2.url).raw).toBe(contract.url);
      expect(v2.header).toEqual(contract.headers);
      expect(record(v2.auth)).toEqual({ type: contract.auth.type, [contract.auth.type]: contract.auth.credentials });
      expect(v3).toEqual({
        $kind: 'http-request',
        name: SECRETS_RESOLVER_ITEM_NAME,
        method: contract.method,
        url: contract.url,
        headers: contract.headers,
        ...(provider === 'aws' ? { body: contracts.aws.body.v3 } : {}),
        auth: contract.auth
      });
      if (provider === 'aws') expect(v2.body).toEqual(contracts.aws.body.v2);
      else expect(v2.body).toBeUndefined();
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
