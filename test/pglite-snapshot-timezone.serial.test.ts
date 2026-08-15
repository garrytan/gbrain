/**
 * Snapshot-timezone parity pin.
 *
 * dumpDataDir bakes the BUILD process's TimeZone into the snapshot tar's
 * cluster defaults. Un-pinned, a snapshot-restored engine ran sessions in the
 * build machine's zone while cold-init engines follow the runtime process
 * (bun test pins TZ=UTC) — so every naive-timestamp day-boundary comparison
 * shifted by the offset, and date-dependent tests failed only in the evening,
 * only under GBRAIN_PGLITE_SNAPSHOT. Two fixes hold the line: the build
 * script pins TZ=UTC before dumping, and the engine re-pins the session to
 * the runtime zone on snapshot restore.
 *
 * This test is the deterministic pin: at ANY wall-clock hour, a cold engine
 * and a snapshot engine created by the same process must report the same
 * session TimeZone. Serial file: it mutates GBRAIN_PGLITE_SNAPSHOT (R1).
 */
import { describe, test, expect, afterAll } from 'bun:test';
import { existsSync } from 'fs';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

const SNAPSHOT = 'test/fixtures/pglite-snapshot.tar';

async function sessionUtcOffsetSeconds(env: Record<string, string | undefined>): Promise<number> {
  const prev = process.env.GBRAIN_PGLITE_SNAPSHOT;
  if (env.GBRAIN_PGLITE_SNAPSHOT === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
  else process.env.GBRAIN_PGLITE_SNAPSHOT = env.GBRAIN_PGLITE_SNAPSHOT;
  const engine = new PGLiteEngine();
  try {
    await engine.connect({} as never);
    await engine.initSchema();
    // Compare the effective UTC OFFSET, not the zone label: cold init spells
    // the runtime zone one way (Etc/GMT0), the restore re-pin another (UTC) —
    // the invariant is identical instant arithmetic, not identical strings.
    const rows = await engine.executeRaw<{ off: string }>(
      `SELECT extract(timezone FROM now())::text AS off`,
    );
    return Number(rows[0].off);
  } finally {
    await engine.disconnect?.();
    if (prev === undefined) delete process.env.GBRAIN_PGLITE_SNAPSHOT;
    else process.env.GBRAIN_PGLITE_SNAPSHOT = prev;
  }
}

describe('PGLite snapshot timezone parity', () => {
  // Build the fixture in-test (idempotent hash short-circuit makes re-runs
  // cheap) so this pin cannot silently skip in lanes without a prebuilt tar.
  test('snapshot fixture builds', async () => {
    const proc = Bun.spawnSync(['bun', 'run', 'build:pglite-snapshot'], {
      cwd: `${import.meta.dir}/..`,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 300_000,
      killSignal: 'SIGKILL',
    });
    expect(proc.exitCode).toBe(0);
    expect(existsSync(`${import.meta.dir}/../${SNAPSHOT}`)).toBe(true);
  }, 320_000);

  test('snapshot-restored session UTC offset equals cold-init session UTC offset', async () => {
    const cold = await sessionUtcOffsetSeconds({ GBRAIN_PGLITE_SNAPSHOT: undefined });
    const snap = await sessionUtcOffsetSeconds({ GBRAIN_PGLITE_SNAPSHOT: SNAPSHOT });
    expect(snap).toBe(cold);
  }, 120_000);
});
