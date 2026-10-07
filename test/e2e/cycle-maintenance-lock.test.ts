import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { runCycle } from '../../src/core/cycle.ts';
import { tryAcquireDbLock } from '../../src/core/db-lock.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';

const url = process.env.DATABASE_URL;
describe.skipIf(!url)('Postgres dream/maintenance lease coordination', () => {
  let engine: PostgresEngine;
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(url!);
    engine = new PostgresEngine();
    await engine.connect({ database_url: url, poolSize: 3 });
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });

  test('global maintenance excludes named-source mixed and global phases', async () => {
    const global = await tryAcquireDbLock(engine, 'gbrain-cycle', 5);
    expect(global).not.toBeNull();
    try {
      for (const phase of ['patterns', 'purge'] as const) {
        const report = await runCycle(engine, { brainDir: null, sourceId: 'fixture-cycle', phases: [phase] });
        expect(report.status).toBe('skipped');
        expect(report.reason).toBe('cycle_already_running');
        expect(report.lock_holder?.id).toBe('gbrain-cycle');
        expect(report.phases).toEqual([]);
        const rows = await engine.executeRaw('SELECT id FROM gbrain_cycle_locks WHERE id = $1', ['gbrain-cycle:fixture-cycle']);
        expect(rows).toEqual([]);
      }
    } finally { await global!.release(); }
  });

  test('different-source freshness remains concurrent with source and maintenance holders', async () => {
    const alpha = await tryAcquireDbLock(engine, 'gbrain-cycle:fixture-alpha', 5);
    const global = await tryAcquireDbLock(engine, 'gbrain-cycle', 5);
    expect(alpha).not.toBeNull();
    expect(global).not.toBeNull();
    let observed: string[] = [];
    try {
      const report = await runCycle(engine, {
        brainDir: null, sourceId: 'fixture-beta', phases: ['lint'],
        yieldBetweenPhases: async () => {
          const rows = await engine.executeRaw<{ id: string }>(
            "SELECT id FROM gbrain_cycle_locks WHERE id IN ('gbrain-cycle', 'gbrain-cycle:fixture-alpha', 'gbrain-cycle:fixture-beta') ORDER BY id",
          );
          observed = rows.map(row => row.id);
        },
      });
      expect(report.reason).not.toBe('cycle_already_running');
      expect(observed).toEqual(['gbrain-cycle', 'gbrain-cycle:fixture-alpha', 'gbrain-cycle:fixture-beta']);
      expect(await engine.executeRaw('SELECT id FROM gbrain_cycle_locks WHERE id = $1', ['gbrain-cycle:fixture-beta'])).toEqual([]);
    } finally { await global!.release(); await alpha!.release(); }
  });

  test('named mixed cycle owns both leases and blocks unscoped maintenance', async () => {
    let held: string[] = [];
    let competitorEntered = true;
    const report = await runCycle(engine, {
      brainDir: null, sourceId: 'fixture-cycle', phases: ['lint', 'patterns'],
      yieldBetweenPhases: async () => {
        const rows = await engine.executeRaw<{ id: string }>(
          "SELECT id FROM gbrain_cycle_locks WHERE id IN ('gbrain-cycle', 'gbrain-cycle:fixture-cycle') ORDER BY id",
        );
        held = rows.map(row => row.id);
        const competitor = await tryAcquireDbLock(engine, 'gbrain-cycle', 5);
        competitorEntered = competitor !== null;
        await competitor?.release();
      },
    });
    expect(report.reason).not.toBe('cycle_already_running');
    expect(held).toEqual(['gbrain-cycle', 'gbrain-cycle:fixture-cycle']);
    expect(competitorEntered).toBe(false);
    expect(await engine.executeRaw("SELECT id FROM gbrain_cycle_locks WHERE id IN ('gbrain-cycle', 'gbrain-cycle:fixture-cycle')")).toEqual([]);
  });
});
