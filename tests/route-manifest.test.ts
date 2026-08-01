import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractRoutesFromSource,
  normalizePath,
  stripComments,
  validateRouteManifest,
  type RouteManifest
} from '../src/route-manifest.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(source: string): { repoRoot: string; sourceRoot: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'route-manifest-'));
  tempDirs.push(repoRoot);
  const sourceRoot = path.join(repoRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'client.ts'), source);
  return { repoRoot, sourceRoot };
}

function manifest(routes: RouteManifest['routes']): RouteManifest {
  return { schemaVersion: 1, routes };
}

describe('route extraction', () => {
  it('fails closed on unmapped hosts and reports every HTTP call site', () => {
    const { sourceRoot } = fixture(`
      export async function callVendor(fetcher: typeof fetch, vendorBaseUrl: string) {
        return fetcher(\`${'${vendorBaseUrl}'}/v1/exfiltrate\`, { method: 'POST' });
      }
    `);

    const extraction = extractRoutesFromSource({
      sourceRoot,
      serviceAliases: { apiBase: 'postman-api' }
    });

    expect(extraction.routes).toEqual([]);
    expect(extraction.callSites).toHaveLength(1);
    expect(extraction.unattributed).toEqual([
      expect.objectContaining({
        file: 'client.ts',
        reason: expect.stringContaining('vendorBaseUrl')
      })
    ]);
  });

  it('extracts a positional helper behind a multi-line generic', () => {
    const { sourceRoot } = fixture(`
      class Client {
        list() {
          return this.akitaProxyRequest<{
            services?: Array<{ id: string }>;
            total?: number;
          }>('GET', '/v2/api-catalog/services');
        }
      }
    `);

    const extraction = extractRoutesFromSource({
      sourceRoot,
      proxyHelpers: { akitaProxyRequest: 'akita' }
    });

    expect(extraction.unattributed).toEqual([]);
    expect(extraction.routes.map((route) => route.id)).toEqual([
      'akita GET /v2/api-catalog/services'
    ]);
  });

  it('extracts gateway objects, positional proxy helpers, and direct fetches', () => {
    const { sourceRoot } = fixture(`
      gateway.requestJson({
        service: 'specification',
        method: 'get',
        path: \`/specifications/\${specId}/files?cursor=\${cursor}\`
      });
      client.proxyRequest('PATCH', \`/workspaces/\${workspaceId}/roles\`);
      class Client {
        list() {
          return this.akitaProxyRequest<unknown>('GET', \`/v2/services/\${serviceId}\`);
        }
      }
      const endpoint = \`\${apiHost}/service-account-tokens\`;
      fetcher(endpoint, { method: 'POST' });
      const sessionPath = '/api/sessions/current';
      fetchImpl(\`\${baseUrl}\${sessionPath}\`, { method: 'GET' });
    `);

    const extraction = extractRoutesFromSource({
      sourceRoot,
      proxyHelpers: { proxyRequest: 'workspaces', akitaProxyRequest: 'akita' },
      serviceAliases: { apiHost: 'postman-api', baseUrl: 'iapub' }
    });

    expect(extraction.unattributed).toEqual([]);
    expect(extraction.routes.map((route) => route.id)).toEqual([
      'akita GET /v2/services/{param}',
      'iapub GET /api/sessions/current',
      'postman-api POST /service-account-tokens',
      'specification GET /specifications/{param}/files',
      'workspaces PATCH /workspaces/{param}/roles'
    ]);
    expect(extraction.callSites).toHaveLength(5);
  });

  it('extracts the dynamic catalog-admin worker route', () => {
    const { sourceRoot } = fixture(`
      class Client {
        constructor(private readonly workerBaseUrl: string) {}
        associate() {
          return this.fetchImpl(
            \`\${this.workerBaseUrl}/api/internal/system-envs/associate\`,
            { method: 'POST' }
          );
        }
      }
    `);

    const extraction = extractRoutesFromSource({
      sourceRoot,
      serviceAliases: { 'this.workerBaseUrl': 'catalog-admin' }
    });
    expect(extraction.unattributed).toEqual([]);
    expect(extraction.routes.map((route) => route.id)).toEqual([
      'catalog-admin POST /api/internal/system-envs/associate'
    ]);
  });

  it('allows only explicitly declared opaque fetch adapters', () => {
    const { sourceRoot } = fixture(
      'export const adapter = (url: string, init?: RequestInit) => fetch(url, init);'
    );

    expect(extractRoutesFromSource({ sourceRoot }).unattributed).toHaveLength(1);
    const declared = extractRoutesFromSource({
      sourceRoot,
      allowedPassthroughs: [
        { file: 'client.ts', urlExpression: 'url', reason: 'fixture transport adapter' }
      ]
    });
    expect(declared.unattributed).toEqual([]);
    expect(declared.callSites).toEqual([
      expect.objectContaining({ reason: 'allowed passthrough: fixture transport adapter' })
    ]);
  });

  it('ignores route-shaped comments and normalizes dynamic path keys', () => {
    const source = [
      '// { service: "ghost", method: "POST", path: "/ghost" }',
      '/* fetcher(`${vendorBase}/ghost`, { method: "GET" }); */',
      'const current = true;'
    ].join('\n');
    const { sourceRoot } = fixture(source);

    expect(stripComments(source)).not.toContain('/ghost');
    expect(extractRoutesFromSource({ sourceRoot })).toEqual({
      routes: [],
      callSites: [],
      unattributed: []
    });
    expect(normalizePath('/v2/workspaces/${workspaceId}/ack?cursor=${cursor}')).toBe(
      '/v2/workspaces/{param}/ack'
    );
  });

  it('extracts configurable wrappers, absolute URLs, and opaque fixed aliases', () => {
    const { sourceRoot } = fixture(`
      const routePath = \`/workspaces/\${workspaceId}\`;
      gateway.requestJson({ service: 'workspaces', method: 'GET', path: routePath });
      client.proxyRequest('ruleset', 'PATCH', '/configure/workspace-groups/group-1');
      github.request('/repos/acme/api/actions/variables', { method: 'POST' });
      fetchImpl('https://dl.pstmn.io/update/status?currentVersion=12.0.0');
      fetchImpl(this.versionUrl, { method: 'GET' });
    `);

    const extraction = extractRoutesFromSource({
      sourceRoot,
      proxyHelpers: {
        proxyRequest: { serviceArg: 0, methodArg: 1, pathArg: 2 },
        request: { service: 'api.github.com', pathArg: 0, initArg: 1 }
      },
      serviceAliases: {
        'this.versionUrl': { service: 'dl.pstmn.io', path: '/update/status?currentVersion=12.0.0' }
      }
    });

    expect(extraction.unattributed).toEqual([]);
    expect(extraction.routes.map((route) => route.id)).toEqual([
      'api.github.com POST /repos/acme/api/actions/variables',
      'dl.pstmn.io GET /update/status',
      'ruleset PATCH /configure/workspace-groups/group-1',
      'workspaces GET /workspaces/{param}'
    ]);
  });

  it('uses nearest constant bindings and function-scoped service aliases', () => {
    const { sourceRoot } = fixture(`
      async function mint(fetcher: typeof fetch, baseUrl: string) {
        const endpoint = \`\${baseUrl}/service-account-tokens\`;
        return fetcher(endpoint, { method: 'POST' });
      }
      async function session(fetcher: typeof fetch, baseUrl: string) {
        const endpoint = \`\${baseUrl}/api/sessions/current\`;
        return fetcher(endpoint);
      }
    `);

    const extraction = extractRoutesFromSource({
      sourceRoot,
      serviceAliases: {
        'mint:baseUrl': 'postman-api',
        'session:baseUrl': 'iapub'
      }
    });

    expect(extraction.unattributed).toEqual([]);
    expect(extraction.routes.map((route) => route.id)).toEqual([
      'iapub GET /api/sessions/current',
      'postman-api POST /service-account-tokens'
    ]);
  });
});

describe('route manifest validation', () => {
  it('accepts a complete manifest with an existing cassette', () => {
    const { repoRoot, sourceRoot } = fixture(
      "gateway.request({ service: 'specification', method: 'get', path: '/specifications' });"
    );
    mkdirSync(path.join(repoRoot, 'tests', 'contract', 'cassettes'), { recursive: true });
    writeFileSync(path.join(repoRoot, 'tests', 'contract', 'cassettes', 'fresh.json'), '{}\n');

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: manifest([
        {
          id: 'specification.list',
          service: 'specification',
          method: 'GET',
          path: '/specifications',
          classification: 'simulated',
          cassettes: ['tests/contract/cassettes/fresh.json']
        }
      ])
    });

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an unmanifested source route', () => {
    const { repoRoot, sourceRoot } = fixture(
      "gateway.request({ service: 'specification', method: 'get', path: '/specifications' });"
    );

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: manifest([])
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'unmanifested route specification GET /specifications (called from client.ts:1); add it to tests/contract/route-manifest.json'
    );
  });

  it('fails closed on unsupported direct-call shapes and unrecognized HTTP methods', () => {
    const { repoRoot, sourceRoot } = fixture(`
      fetcher.call(undefined, \`${'${apiHost}'}/v1/weird\`, { method: 'GET' });
      fetcher(\`${'${apiHost}'}/v1/tea\`, { method: 'BREW' });
    `);

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: manifest([]),
      serviceAliases: { apiHost: 'postman-api' }
    });

    expect(result.ok).toBe(false);
    expect(result.extractedRoutes).toEqual([]);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/unattributed HTTP call site .*unsupported (?:fetch invocation )?shape/),
        expect.stringMatching(/unattributed HTTP call site .*unrecognized HTTP method "BREW"/)
      ])
    );
  });

  it('rejects a stale manifest route', () => {
    const { repoRoot, sourceRoot } = fixture('export const noRoutes = true;');

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: manifest([
        {
          id: 'specification.stale',
          service: 'specification',
          method: 'GET',
          path: '/specifications',
          classification: 'live-only',
          reason: 'Requires a live account.'
        }
      ])
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'stale manifest entry specification GET /specifications has no matching route in src/'
    );
  });

  it('rejects a simulated route without an existing cassette', () => {
    const { repoRoot, sourceRoot } = fixture(
      "gateway.request({ service: 'specification', method: 'get', path: '/specifications' });"
    );

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: manifest([
        {
          id: 'specification.list',
          service: 'specification',
          method: 'GET',
          path: '/specifications',
          classification: 'simulated',
          cassettes: ['tests/contract/cassettes/missing.json']
        }
      ])
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      'routes[0] simulated cassette not found: tests/contract/cassettes/missing.json'
    );
  });

  it('rejects cassette paths that escape the repository', () => {
    const { repoRoot, sourceRoot } = fixture(
      "gateway.request({ service: 'specification', method: 'get', path: '/specifications' });"
    );
    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: manifest([
        {
          id: 'specification.list',
          service: 'specification',
          method: 'GET',
          path: '/specifications',
          classification: 'simulated',
          cassettes: ['../outside.json']
        }
      ])
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toContain('routes[0] simulated cassette escapes the repository: ../outside.json');
  });

  it('rejects malformed schema and route fields', () => {
    const { repoRoot, sourceRoot } = fixture('export const noRoutes = true;');

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: {
        schemaVersion: 2,
        routes: [
          {
            id: '',
            service: 'specification',
            method: 'sometimes',
            path: 'specifications',
            classification: 'live-only'
          }
        ]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        'schemaVersion must be 1, got 2',
        'routes[0].id must be a non-empty string',
        'routes[0].method must be uppercase, got sometimes',
        'routes[0].path must start with /',
        'routes[0].reason is required when classification is live-only'
      ])
    );
  });
});
