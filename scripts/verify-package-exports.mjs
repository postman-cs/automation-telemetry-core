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

const rootExports = await import(new URL('../dist/index.js', import.meta.url));
for (const name of resolverRuntimeExports) {
  assert.ok(name in rootExports, `dist/index.js must export ${name}`);
}

const declarations = await import('node:fs/promises').then(({ readFile }) =>
  readFile(new URL('../dist/index.d.ts', import.meta.url), 'utf8')
);
for (const name of [...resolverRuntimeExports, 'SecretsResolverProvider']) {
  assert.match(declarations, new RegExp(`\\b${name}\\b`), `dist/index.d.ts must re-export ${name}`);
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
  'dist/index.js',
  'dist/index.d.ts'
]) {
  assert.ok(packedFiles.has(path), `npm pack manifest must include package/${path}`);
}
