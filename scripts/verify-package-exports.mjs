import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, URL } from 'node:url';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const resolverRuntimeExports = [
  'createSecretsResolverExec',
  'createSecretsResolverItem',
  'createSecretsResolverV3Body',
  'DEFAULT_SECRETS_RESOLVER_PROVIDER',
  'isSecretsResolverEnabled',
  'isSecretsResolverItemName',
  'parseSecretsResolverProvider',
  'SECRETS_RESOLVER_ITEM_NAME',
  'SECRETS_RESOLVER_PROVIDERS',
  'secretsResolverEnvironmentKeys'
];
const httpRuntimeExports = [
  'AccessTokenGatewayClient',
  'computeBoundedRetryDelayMs',
  'DEFAULT_POSTMAN_BIFROST_BASE_URL',
  'extractHttpStatus',
  'fullJitterDelayMs',
  'HttpError',
  'isAmbiguousMutationFailure',
  'isRetryableGatewayFailure',
  'isRetryableHttpStatus',
  'isTransientHttpStatus',
  'normalizeSecretValues',
  'parseRetryAfterMs',
  'redactSecrets',
  'REDACTED',
  'retry',
  'SAFE_READ_RETRY',
  'sanitizeHeaders',
  'shouldRetryReadError',
  'sleep',
  'toOneLine'
];
const httpTypeExports = [
  'AccessTokenGatewayClientOptions',
  'BoundedRetryDelayOptions',
  'GatewayAppVersionProvider',
  'GatewayDirectRequest',
  'GatewayFallbackMode',
  'GatewayMethod',
  'GatewayRequest',
  'GatewayRequestOptions',
  'GatewayRetryEvent',
  'GatewayRetryMode',
  'GatewaySecretMasker',
  'GatewayTokenProvider',
  'HeaderBag',
  'HttpErrorInit',
  'HttpErrorResponseInit',
  'JitterRounding',
  'RetryContext',
  'RetryDecisionContext',
  'RetryOptions'
];
const cassetteRuntimeExports = [
  'cassetteRequest',
  'CASSETTE_MINTED_TOKEN',
  'createEmptyCassette',
  'createRecordingFetch',
  'createReplayFetch',
  'interactionKey'
];
const cassetteTypeExports = ['Cassette', 'CassetteInteraction', 'CassetteRequest'];
const routeManifestRuntimeExports = [
  'extractRoutesFromSource',
  'ROUTE_CLASSIFICATIONS',
  'validateRouteManifest'
];
const routeManifestTypeExports = [
  'ExtractedRoute',
  'ExtractRoutesOptions',
  'RouteClassification',
  'RouteManifest',
  'RouteManifestRoute',
  'RouteManifestValidationResult',
  'ValidateRouteManifestOptions'
];

const rootExports = await import('@postman-cse/automation-core');
for (const name of [...resolverRuntimeExports, ...httpRuntimeExports]) {
  assert.ok(name in rootExports, `dist/index.js must export ${name}`);
}

const cassetteExports = await import('@postman-cse/automation-core/cassette');
for (const name of cassetteRuntimeExports) {
  assert.ok(name in cassetteExports, `dist/cassette.js must export ${name}`);
}

const routeManifestExports = await import('@postman-cse/automation-core/route-manifest');
for (const name of routeManifestRuntimeExports) {
  assert.ok(name in routeManifestExports, `dist/route-manifest.js must export ${name}`);
}

const declarations = await import('node:fs/promises').then(({ readFile }) =>
  readFile(new URL('../dist/index.d.ts', import.meta.url), 'utf8')
);
for (const name of [
  ...resolverRuntimeExports,
  ...httpRuntimeExports,
  ...httpTypeExports,
  'SecretsResolverProvider'
]) {
  assert.match(declarations, new RegExp(`\\b${name}\\b`), `dist/index.d.ts must re-export ${name}`);
}

const cassetteDeclarations = await import('node:fs/promises').then(({ readFile }) =>
  readFile(new URL('../dist/cassette.d.ts', import.meta.url), 'utf8')
);
for (const name of [...cassetteRuntimeExports, ...cassetteTypeExports]) {
  assert.match(
    cassetteDeclarations,
    new RegExp(`\\b${name}\\b`),
    `dist/cassette.d.ts must export ${name}`
  );
}

const routeManifestDeclarations = await import('node:fs/promises').then(({ readFile }) =>
  readFile(new URL('../dist/route-manifest.d.ts', import.meta.url), 'utf8')
);
for (const name of [...routeManifestRuntimeExports, ...routeManifestTypeExports]) {
  assert.match(
    routeManifestDeclarations,
    new RegExp(`\\b${name}\\b`),
    `dist/route-manifest.d.ts must export ${name}`
  );
}

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageRoot,
  encoding: 'utf8'
});
const [pack] = JSON.parse(packOutput);
const packedFiles = new Set(pack.files.map(({ path }) => path));
for (const path of [
  'dist/secrets-resolver.js',
  'dist/secrets-resolver.d.ts',
  'dist/http/http-error.js',
  'dist/http/http-error.d.ts',
  'dist/http/retry.js',
  'dist/http/retry.d.ts',
  'dist/http/gateway-client.js',
  'dist/http/gateway-client.d.ts',
  'dist/cassette.js',
  'dist/cassette.d.ts',
  'dist/route-manifest.js',
  'dist/route-manifest.d.ts',
  'dist/index.js',
  'dist/index.d.ts'
]) {
  assert.ok(packedFiles.has(path), `npm pack manifest must include package/${path}`);
}
