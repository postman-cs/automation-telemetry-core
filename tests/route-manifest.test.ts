import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  extractRoutesFromSource,
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
  it('extracts gateway objects, positional proxy helpers, fixed-service helpers, and direct fetches', () => {
    const { sourceRoot } = fixture(`
      gateway.requestJson({
        service: 'specification',
        method: 'get',
        path: \`/specifications/\${specId}/files?cursor=\${cursor}\`
      });
      proxyRequest('workspaces', 'PATCH', \`/workspaces/\${workspaceId}/roles\`);
      proxyJson('POST', '/collections/', body, 'create collection');
      async function proxyJson(method: string, path: string, body: unknown) {
        return fetch('/ws/proxy', {
          method: 'POST',
          body: JSON.stringify({ service: 'collection', method, path, body })
        });
      }
      class Client {
        private async akitaProxyRequest<T>(method: string, path: string): Promise<{ ok: boolean; data: T }> {
          return fetch('/ws/proxy', {
            method: 'POST',
            body: JSON.stringify({ service: 'akita', method, path })
          }) as Promise<{ ok: boolean; data: T }>;
        }
        list() {
          return this.akitaProxyRequest<unknown>('GET', \`/v2/services/\${serviceId}\`);
        }
      }
      const endpoint = \`\${apiHost}/service-account-tokens\`;
      fetcher(endpoint, { method: 'POST' });
      const sessionPath = '/api/sessions/current';
      fetchImpl(\`\${baseUrl}\${sessionPath}\`, { method: 'GET' });
      fetch('https://api.getpostman.com/me', { method: 'GET' });
    `);

    expect(extractRoutesFromSource({ sourceRoot })).toEqual([
      {
        service: 'akita',
        method: 'GET',
        path: '/v2/services/{param}',
        sourceFiles: ['client.ts']
      },
      {
        service: 'api.getpostman.com',
        method: 'GET',
        path: '/me',
        sourceFiles: ['client.ts']
      },
      {
        service: 'collection',
        method: 'POST',
        path: '/collections/',
        sourceFiles: ['client.ts']
      },
      {
        service: 'iapub',
        method: 'GET',
        path: '/api/sessions/current',
        sourceFiles: ['client.ts']
      },
      {
        service: 'postman-api',
        method: 'POST',
        path: '/service-account-tokens',
        sourceFiles: ['client.ts']
      },
      {
        service: 'specification',
        method: 'GET',
        path: '/specifications/{param}/files?cursor={param}',
        sourceFiles: ['client.ts']
      },
      {
        service: 'workspaces',
        method: 'PATCH',
        path: '/workspaces/{param}/roles',
        sourceFiles: ['client.ts']
      }
    ]);
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

    expect(extractRoutesFromSource({ sourceRoot })).toEqual([
      {
        service: 'catalog-admin',
        method: 'POST',
        path: '/api/internal/system-envs/associate',
        sourceFiles: ['client.ts']
      }
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
    expect(result.errors).toContain('Unmanifested route: specification GET /specifications (client.ts)');
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
      'Stale manifest route specification.stale: specification GET /specifications'
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
      'Route specification.list cassette does not exist: tests/contract/cassettes/missing.json'
    );
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
        'Manifest schemaVersion must be 1',
        'Route at index 0 must have a non-empty id',
        'Route at index 0 must have an uppercase HTTP method',
        'Route at index 0 path must start with /',
        'Route at index 0 with classification live-only must have a reason'
      ])
    );
  });
});
