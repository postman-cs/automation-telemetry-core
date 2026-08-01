import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { validateRouteManifest } from '../src/route-manifest.js';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function fixture(source: string): { repoRoot: string; sourceRoot: string } {
  const repoRoot = mkdtempSync(path.join(tmpdir(), 'route-manifest-call-shapes-'));
  tempDirs.push(repoRoot);
  const sourceRoot = path.join(repoRoot, 'src');
  mkdirSync(sourceRoot, { recursive: true });
  writeFileSync(path.join(sourceRoot, 'client.ts'), source);
  return { repoRoot, sourceRoot };
}

describe('route manifest unsupported fetch call shapes', () => {
  it('fails closed for fetcher.apply(url, init)', () => {
    const { repoRoot, sourceRoot } = fixture(`
      export async function request(fetcher: typeof fetch) {
        const url = 'https://route-manifest.test/unsupported-apply';
        const init = { method: 'GET' };
        return fetcher.apply(undefined, [url, init]);
      }
    `);

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: { schemaVersion: 1, routes: [] }
    });
    const errors = result.errors.join('\n');

    expect(result.ok).toBe(false);
    expect(result.extractedRoutes).toEqual([]);
    expect(errors).toContain('unattributed HTTP call site');
    expect(errors).toMatch(/unsupported call shape/i);
    expect(errors).toContain('fetcher.apply');
  });

  it('fails closed for optional fetcher(url, init)', () => {
    const { repoRoot, sourceRoot } = fixture(`
      export async function request(fetcher: typeof fetch) {
        const url = 'https://route-manifest.test/unsupported-optional-call';
        const init = { method: 'GET' };
        return fetcher?.(url, init);
      }
    `);

    const result = validateRouteManifest({
      repoRoot,
      sourceRoot,
      manifest: { schemaVersion: 1, routes: [] }
    });
    const errors = result.errors.join('\n');

    expect(result.ok).toBe(false);
    expect(result.extractedRoutes).toEqual([]);
    expect(errors).toContain('unattributed HTTP call site');
    expect(errors).toMatch(/unsupported call shape/i);
    expect(errors).toContain('fetcher?.(');
  });
});
