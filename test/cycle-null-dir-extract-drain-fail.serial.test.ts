/**
 * With NO checkout the stale drain is the extract phase's only work, so a
 * drain exception FAILS the phase (status fail, error carried) instead of
 * degrading to details the way the checkout branch does after its targeted
 * pass succeeded. Serial: mock.module leaks across files in a shared shard.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const realExtract = await import('../src/commands/extract.ts');
mock.module('../src/commands/extract.ts', () => ({
  ...realExtract,
  extractStaleFromDB: async () => { throw new Error('boom: stale drain exploded'); },
}));

// Import AFTER the mock so cycle.ts's dynamic import('../commands/extract.ts')
// inside drainStaleLinks resolves to the throwing stub.
const { runCycle } = await import('../src/core/cycle.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { resetPgliteState } = await import('./helpers/reset-pglite.ts');
const { withEnv } = await import('./helpers/with-env.ts');

let engine: InstanceType<typeof PGLiteEngine>;
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await resetPgliteState(engine);
  await engine.executeRaw(`INSERT INTO sources (id, name, local_path) VALUES ('wiki', 'wiki', NULL)`);
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-null-dir-drain-fail-'));
}, 30_000);
afterAll(async () => {
  await engine.disconnect();
  rmSync(gbrainHome, { recursive: true, force: true });
});

describe('extract phase with brainDir null: drain exception', () => {
  test('fails the phase with the error and fs_walk no_brain_dir; the cycle derives failed', async () => {
    const report = await withEnv({ GBRAIN_HOME: gbrainHome }, () =>
      runCycle(engine, { brainDir: null, sourceId: 'wiki', phases: ['extract'] }));
    const extract = report.phases.find((p) => p.phase === 'extract');
    expect(extract?.status).toBe('fail');
    expect(extract?.details?.fs_walk).toBe('no_brain_dir');
    expect(extract?.error?.message ?? '').toContain('stale drain exploded');
    expect(report.status).toBe('failed');
  });
});
