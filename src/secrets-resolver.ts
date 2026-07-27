/**
 * Provider-agnostic secrets-resolver helper.
 *
 * A generated collection can carry an optional leading helper request that
 * fetches a JSON secret bundle from a cloud secret store and fans the entries
 * out into collection variables, so a developer running the collection locally
 * does not have to paste credentials by hand. The helper is skipped in CI
 * (`CI === "true"`), which is why it contributes no assertions to a CI run.
 *
 * Historically this was hardcoded to AWS Secrets Manager and injected into
 * every collection unconditionally, which shipped a doomed request to every
 * consumer that does not use AWS. The helper is now opt-in (`none` by default)
 * and the request shape is selected per provider.
 *
 * Wire shapes below are live-proven against real secret stores (2026-07-27):
 *   aws   POST https://secretsmanager.<region>.amazonaws.com
 *         X-Amz-Target: secretsmanager.GetSecretValue, awsv4 auth -> 200, SecretString
 *   azure GET  https://<vault>.vault.azure.net/secrets/<name>?api-version=7.4
 *         Bearer (resource https://vault.azure.net) -> 200, .value (401 unauthenticated)
 *   gcp   GET  https://secretmanager.googleapis.com/v1/projects/<p>/secrets/<n>/versions/latest:access
 *         Bearer (oauth2) -> 200, .payload.data (base64)
 */

export const SECRETS_RESOLVER_PROVIDERS = ['none', 'aws', 'azure', 'gcp'] as const;

export type SecretsResolverProvider = (typeof SECRETS_RESOLVER_PROVIDERS)[number];

/** Canonical helper item name. Stable across providers so dedupe/skip logic keeps working. */
export const SECRETS_RESOLVER_ITEM_NAME = '00 - Resolve Secrets';

export const DEFAULT_SECRETS_RESOLVER_PROVIDER: SecretsResolverProvider = 'none';

type JsonRecord = Record<string, unknown>;

/**
 * Parse a provider selection. Accepts the legacy boolean spelling so existing
 * callers keep working: `true` means the legacy AWS helper, `false` means off.
 */
export function parseSecretsResolverProvider(
  value: string | undefined,
  fallback: SecretsResolverProvider = DEFAULT_SECRETS_RESOLVER_PROVIDER
): SecretsResolverProvider {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (raw === 'true') return 'aws';
  if (raw === 'false' || raw === 'off') return 'none';
  if ((SECRETS_RESOLVER_PROVIDERS as readonly string[]).includes(raw)) {
    return raw as SecretsResolverProvider;
  }
  throw new Error(
    `SECRETS_RESOLVER_PROVIDER_INVALID: expected one of ${SECRETS_RESOLVER_PROVIDERS.join(', ')} (or legacy true/false), received "${value}"`
  );
}

export function isSecretsResolverEnabled(provider: SecretsResolverProvider): boolean {
  return provider !== 'none';
}

/**
 * Environment variables each provider's helper reads. Consumers seed these as
 * empty/secret slots so the developer fills them in the Postman app.
 */
export function secretsResolverEnvironmentKeys(
  provider: SecretsResolverProvider
): Array<{ key: string; secret: boolean; defaultValue?: string }> {
  switch (provider) {
    case 'aws':
      return [
        { key: 'AWS_ACCESS_KEY_ID', secret: true },
        { key: 'AWS_SECRET_ACCESS_KEY', secret: true },
        { key: 'AWS_REGION', secret: false },
        { key: 'AWS_SECRET_NAME', secret: false }
      ];
    case 'azure':
      return [
        { key: 'AZURE_KEY_VAULT_NAME', secret: false },
        { key: 'AZURE_SECRET_NAME', secret: false },
        { key: 'AZURE_ACCESS_TOKEN', secret: true }
      ];
    case 'gcp':
      return [
        { key: 'GCP_PROJECT_ID', secret: false },
        { key: 'GCP_SECRET_NAME', secret: false },
        { key: 'GCP_ACCESS_TOKEN', secret: true }
      ];
    case 'none':
    default:
      return [];
  }
}

/**
 * Fan a JSON secret bundle out into collection variables. Shared tail for every
 * provider; only the expression that yields the raw JSON string differs.
 */
function resolverExecTail(extractExpression: string): string[] {
  return [
    'if (pm.environment.get("CI") === "true") { return; }',
    'const body = pm.response.json();',
    `const raw = ${extractExpression};`,
    'if (raw) {',
    '  const secrets = JSON.parse(raw);',
    '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
    '}'
  ];
}

/** Legacy AWS exec, byte-identical to the pre-provider implementation. */
export function createSecretsResolverExec(
  provider: SecretsResolverProvider = 'aws'
): string[] {
  switch (provider) {
    case 'azure':
      return resolverExecTail('body.value');
    case 'gcp':
      // Secret Manager returns the payload base64-encoded.
      return [
        'if (pm.environment.get("CI") === "true") { return; }',
        'const body = pm.response.json();',
        'const encoded = body.payload && body.payload.data;',
        'if (encoded) {',
        '  const secrets = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));',
        '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
        '}'
      ];
    case 'aws':
    default:
      return [
        'if (pm.environment.get("CI") === "true") { return; }',
        'const body = pm.response.json();',
        'if (body.SecretString) {',
        '  const secrets = JSON.parse(body.SecretString);',
        '  Object.entries(secrets).forEach(([k, v]) => pm.collectionVariables.set(k, v));',
        '}'
      ];
  }
}

/** Collection v2.1 helper item for the selected provider. */
export function createSecretsResolverItem(
  provider: SecretsResolverProvider = 'aws'
): JsonRecord {
  if (provider === 'azure') {
    return {
      name: SECRETS_RESOLVER_ITEM_NAME,
      request: {
        auth: {
          type: 'bearer',
          bearer: [{ key: 'token', value: '{{AZURE_ACCESS_TOKEN}}' }]
        },
        method: 'GET',
        header: [{ key: 'Accept', value: 'application/json' }],
        url: {
          raw: 'https://{{AZURE_KEY_VAULT_NAME}}.vault.azure.net/secrets/{{AZURE_SECRET_NAME}}?api-version=7.4',
          protocol: 'https',
          host: ['{{AZURE_KEY_VAULT_NAME}}', 'vault', 'azure', 'net'],
          path: ['secrets', '{{AZURE_SECRET_NAME}}'],
          query: [{ key: 'api-version', value: '7.4' }]
        }
      },
      event: [{ listen: 'test', script: { exec: createSecretsResolverExec('azure') } }]
    };
  }

  if (provider === 'gcp') {
    return {
      name: SECRETS_RESOLVER_ITEM_NAME,
      request: {
        auth: {
          type: 'bearer',
          bearer: [{ key: 'token', value: '{{GCP_ACCESS_TOKEN}}' }]
        },
        method: 'GET',
        header: [{ key: 'Accept', value: 'application/json' }],
        url: {
          raw: 'https://secretmanager.googleapis.com/v1/projects/{{GCP_PROJECT_ID}}/secrets/{{GCP_SECRET_NAME}}/versions/latest:access',
          protocol: 'https',
          host: ['secretmanager', 'googleapis', 'com'],
          path: [
            'v1',
            'projects',
            '{{GCP_PROJECT_ID}}',
            'secrets',
            '{{GCP_SECRET_NAME}}',
            'versions',
            'latest:access'
          ]
        }
      },
      event: [{ listen: 'test', script: { exec: createSecretsResolverExec('gcp') } }]
    };
  }

  // aws — byte-identical to the historical shape.
  return {
    name: SECRETS_RESOLVER_ITEM_NAME,
    request: {
      auth: {
        type: 'awsv4',
        awsv4: [
          { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
          { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
          { key: 'region', value: '{{AWS_REGION}}' },
          { key: 'service', value: 'secretsmanager' }
        ]
      },
      method: 'POST',
      header: [
        { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
        { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
      ],
      body: { mode: 'raw', raw: '{"SecretId": "{{AWS_SECRET_NAME}}"}' },
      url: {
        raw: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
        protocol: 'https',
        host: ['secretsmanager', '{{AWS_REGION}}', 'amazonaws', 'com']
      }
    },
    event: [{ listen: 'test', script: { exec: createSecretsResolverExec('aws') } }]
  };
}

/**
 * v3 IR create body for the gateway path. Mirrors {@link createSecretsResolverItem}
 * in the shape the collection v3 items API accepts (method/url/headers/body/auth
 * at the root; `auth.credentials` rather than a type-keyed array).
 */
export function createSecretsResolverV3Body(
  provider: SecretsResolverProvider = 'aws'
): JsonRecord {
  if (provider === 'azure') {
    return {
      $kind: 'http-request',
      name: SECRETS_RESOLVER_ITEM_NAME,
      method: 'GET',
      url: 'https://{{AZURE_KEY_VAULT_NAME}}.vault.azure.net/secrets/{{AZURE_SECRET_NAME}}?api-version=7.4',
      headers: [{ key: 'Accept', value: 'application/json' }],
      auth: {
        type: 'bearer',
        credentials: [{ key: 'token', value: '{{AZURE_ACCESS_TOKEN}}' }]
      }
    };
  }

  if (provider === 'gcp') {
    return {
      $kind: 'http-request',
      name: SECRETS_RESOLVER_ITEM_NAME,
      method: 'GET',
      url: 'https://secretmanager.googleapis.com/v1/projects/{{GCP_PROJECT_ID}}/secrets/{{GCP_SECRET_NAME}}/versions/latest:access',
      headers: [{ key: 'Accept', value: 'application/json' }],
      auth: {
        type: 'bearer',
        credentials: [{ key: 'token', value: '{{GCP_ACCESS_TOKEN}}' }]
      }
    };
  }

  return {
    $kind: 'http-request',
    name: SECRETS_RESOLVER_ITEM_NAME,
    method: 'POST',
    url: 'https://secretsmanager.{{AWS_REGION}}.amazonaws.com',
    headers: [
      { key: 'X-Amz-Target', value: 'secretsmanager.GetSecretValue' },
      { key: 'Content-Type', value: 'application/x-amz-json-1.1' }
    ],
    body: { type: 'json', content: '{"SecretId": "{{AWS_SECRET_NAME}}"}' },
    auth: {
      type: 'awsv4',
      credentials: [
        { key: 'accessKey', value: '{{AWS_ACCESS_KEY_ID}}' },
        { key: 'secretKey', value: '{{AWS_SECRET_ACCESS_KEY}}' },
        { key: 'region', value: '{{AWS_REGION}}' },
        { key: 'service', value: 'secretsmanager' }
      ]
    }
  };
}

/** True when the item is the canonical helper, for any provider. */
export function isSecretsResolverItemName(name: unknown): boolean {
  return String(name ?? '').trim() === SECRETS_RESOLVER_ITEM_NAME;
}