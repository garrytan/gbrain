/**
 * src/core/operation-manifest.generated.ts: freshness, equality with the
 * live registry, and the startup graph it exists for. `gbrain serve` and the
 * CLI dispatcher read the manifest so the ~760-module handler graph behind
 * src/core/operations.ts loads only when an op runs; a static import of
 * operations.ts on that path silently undoes the win, so it is pinned here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { OPERATION_MANIFEST_PATH, renderOperationManifest } from '../scripts/build-operation-manifest.ts';
import { OPERATION_MANIFEST } from '../src/core/operation-manifest.generated.ts';
import { operations } from '../src/core/operations.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');

describe('operation manifest', () => {
  test('committed file matches a fresh render (run `bun run build:operation-manifest`)', () => {
    expect(readFileSync(OPERATION_MANIFEST_PATH, 'utf-8')).toBe(renderOperationManifest());
  });

  test('every operation minus its handler, same order, same key order', () => {
    const live = operations.map(({ handler: _handler, ...meta }) => meta);
    expect(JSON.stringify(OPERATION_MANIFEST)).toBe(JSON.stringify(live));
  });

  test('serve and CLI dispatcher modules do not load operations.ts at import', () => {
    const probe = [
      "await import('./src/cli/main.ts');",
      "await import('./src/commands/serve.ts');",
      "await import('./src/mcp/server.ts');",
      "console.log(JSON.stringify(Object.keys(require.cache).filter(k => k.endsWith('/src/core/operations.ts') || k.endsWith('/src/mcp/dispatch.ts'))));",
    ].join('\n');
    const out = Bun.spawnSync([process.execPath, '-e', probe], { cwd: REPO_ROOT, env: { ...process.env, GBRAIN_HOME: '/nonexistent-gbrain-home' } });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout.toString().trim().split('\n').pop()!)).toEqual([]);
  });
});
