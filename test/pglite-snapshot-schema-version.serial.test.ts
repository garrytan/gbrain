/**
 * A snapshot-restored PGLite engine records its schema version, like a cold init.
 *
 * initSchema() on a snapshot restore skips the migration run, which is where a cold init records the version the
 * engine saw (noteSchemaVersion). Without it, every read that picks its SQL by schema version took the unknown-version
 * form under GBRAIN_PGLITE_SNAPSHOT only. That form reads every row as owner-only for a non-owner caller once the brain
 * has held owner-only data, so a test that seeded and removed an owner-only source failed only under the snapshot
 * (the stress gate's profile). Serial file: it mutates GBRAIN_PGLITE_SNAPSHOT.
 */
import { describe, test, expect } from 'bun:test';
import { existsSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { schemaVersionSeen } from '../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';

const SNAPSHOT = 'test/fixtures/pglite-snapshot.tar';

async function versionSeen(snapshot: string | undefined): Promise<{ seen: number | undefined; restored: boolean }> {
  const prev = process.env.GBRAIN_PGLITE_SNAPSHOT;
  if (snapshot === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
  else process.env.GBRAIN_PGLITE_SNAPSHOT = snapshot;
  const engine = new PGLiteEngine();
  try {
    await engine.connect({} as never);
    await engine.initSchema();
    return { seen: schemaVersionSeen(engine), restored: (engine as unknown as { _snapshotLoaded: boolean })._snapshotLoaded };
  } finally {
    await engine.disconnect?.();
    if (prev === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    else process.env.GBRAIN_PGLITE_SNAPSHOT = prev;
  }
}

describe('PGLite snapshot schema version', () => {
  test('snapshot fixture builds', async () => {
    const proc = Bun.spawnSync(['bun', 'run', 'build:pglite-snapshot'], { cwd: `${import.meta.dir}/..`, stdout: 'pipe', stderr: 'pipe', timeout: 300_000, killSignal: 'SIGKILL' });
    expect(proc.exitCode).toBe(0);
    expect(existsSync(`${import.meta.dir}/../${SNAPSHOT}`)).toBe(true);
  }, 320_000);

  test('a snapshot-restored engine records the same schema version as a cold init', async () => {
    const cold = await versionSeen(undefined);
    const restored = await versionSeen(`${import.meta.dir}/../${SNAPSHOT}`);
    expect(cold).toEqual({ seen: LATEST_SCHEMA_VERSION, restored: false });
    expect(restored).toEqual({ seen: LATEST_SCHEMA_VERSION, restored: true });
  }, 120_000);
});
