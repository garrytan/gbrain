import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
let root = '';
let snapshotPath = '';
let metadataPath = '';
let previousSnapshot: string | undefined;

async function vectorType(engine: PGLiteEngine): Promise<string> {
  const result = await engine.db.query<{ formatted: string }>(`
    SELECT format_type(a.atttypid, a.atttypmod) AS formatted
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'content_chunks' AND a.attname = 'embedding'
  `);
  return result.rows[0]?.formatted ?? '';
}

describe('PGLite snapshot restore contract', () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gbrain-pglite-snapshot-'));
    snapshotPath = join(root, 'fixture.tar');
    metadataPath = join(root, 'fixture.metadata.json');
    previousSnapshot = process.env.GBRAIN_PGLITE_SNAPSHOT;

    const result = spawnSync('bun', ['run', 'scripts/build-pglite-snapshot.ts'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: { ...process.env, GBRAIN_PGLITE_SNAPSHOT_PATH: snapshotPath },
    });
    if (result.status !== 0) {
      throw new Error(`snapshot builder failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
    }
    process.env.GBRAIN_PGLITE_SNAPSHOT = snapshotPath;
  });

  afterAll(() => {
    if (previousSnapshot === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    else process.env.GBRAIN_PGLITE_SNAPSHOT = previousSnapshot;
    rmSync(root, { recursive: true, force: true });
  });

  it('loads the test-profile snapshot with a 1536-dimensional schema', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      expect((engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded).toBe(true);
      await engine.initSchema();
      expect(await vectorType(engine)).toBe('vector(1536)');
    } finally {
      await engine.disconnect();
    }
  });

  it('resets the snapshot marker on a later cold connect', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    expect((engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded).toBe(true);
    await engine.disconnect();

    delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    try {
      await engine.connect({});
      expect((engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded).toBe(false);
    } finally {
      await engine.disconnect();
      process.env.GBRAIN_PGLITE_SNAPSHOT = snapshotPath;
    }
  });

  it('cold-initializes when metadata is stale', async () => {
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as { compatibilityHash: string };
    metadata.compatibilityHash = '0'.repeat(64);
    writeFileSync(metadataPath, JSON.stringify(metadata));

    const engine = new PGLiteEngine();
    await engine.connect({});
    try {
      expect((engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded).toBe(false);
      await engine.initSchema();
      expect(await vectorType(engine)).toBe('vector(1536)');
    } finally {
      await engine.disconnect();
    }
  });
});
