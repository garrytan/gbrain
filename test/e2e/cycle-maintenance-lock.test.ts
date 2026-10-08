/**
 * #6242 on real Postgres: a source-scoped cycle that selects brain-wide
 * phases also takes the shared `gbrain-cycle` lease. While another cycle
 * holds it, the source phases run and each brain-wide phase reports
 * `maintenance_lock_busy`; while a bare dream holds both leases, global
 * maintenance skips and another source's freshness cycle still runs.
 *
 * Run: DATABASE_URL=... bun test test/e2e/cycle-maintenance-lock.test.ts
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { runCycle } from '../../src/core/cycle.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('E2E: shared maintenance lease for source cycles (#6242)', () => {
  let brainDir: string;
  let otherDir: string;

  const lockIds = async (): Promise<string[]> =>
    (await getConn().unsafe(`SELECT id FROM gbrain_cycle_locks ORDER BY id`) as unknown as Array<{ id: string }>).map(r => r.id);

  beforeAll(async () => {
    await setupDB();
    brainDir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-maint-lock-'));
    otherDir = mkdtempSync(join(tmpdir(), 'gbrain-e2e-maint-lock-beta-'));
    await getConn().unsafe(
      `INSERT INTO sources (id, name, local_path, config) VALUES ('beta', 'beta', $1, '{}'::jsonb) ON CONFLICT (id) DO NOTHING`,
      [otherDir],
    );
  }, 60_000);

  afterAll(async () => {
    await getConn().unsafe(`DELETE FROM sources WHERE id = 'beta'`);
    await teardownDB();
    rmSync(brainDir, { recursive: true, force: true });
    rmSync(otherDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await getConn().unsafe(`DELETE FROM gbrain_cycle_locks`);
  });

  test('held gbrain-cycle: the default-source cycle runs lint and skips patterns as maintenance_lock_busy', async () => {
    await getConn().unsafe(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ('gbrain-cycle', 99999, 'maintenance-host', NOW(), NOW() + INTERVAL '1 hour')`,
    );
    const r = await runCycle(getEngine(), { brainDir, sourceId: 'default', phases: ['lint', 'patterns'] });
    expect(['ok', 'clean']).toContain(r.status);
    expect(r.phases.find(p => p.phase === 'lint')?.status).not.toBe('skipped');
    const patterns = r.phases.find(p => p.phase === 'patterns');
    expect(patterns?.status).toBe('skipped');
    expect(patterns?.details.reason).toBe('maintenance_lock_busy');
    expect((patterns?.details.lock_holder as { holder_host: string }).holder_host).toBe('maintenance-host');
    expect(await lockIds()).toEqual(['gbrain-cycle']);
  });

  test('a running mixed default cycle holds both leases: maintenance skips, another source stays concurrent', async () => {
    let seen: string[] = [];
    let maintenance: Awaited<ReturnType<typeof runCycle>> | undefined;
    let freshness: Awaited<ReturnType<typeof runCycle>> | undefined;
    const r = await runCycle(getEngine(), {
      brainDir,
      sourceId: 'default',
      phases: ['lint', 'purge'],
      dryRun: true,
      yieldBetweenPhases: async () => {
        if (maintenance) return;
        seen = await lockIds();
        maintenance = await runCycle(getEngine(), { brainDir, phases: ['purge'], dryRun: true });
        freshness = await runCycle(getEngine(), { brainDir: otherDir, sourceId: 'beta', phases: ['lint'] });
      },
    });
    expect(seen).toEqual(['gbrain-cycle', 'gbrain-cycle:default']);
    expect(maintenance?.status).toBe('skipped');
    expect(maintenance?.reason).toBe('cycle_already_running');
    expect(maintenance?.lock_holder?.id).toBe('gbrain-cycle');
    expect(['ok', 'clean']).toContain(freshness!.status);
    expect(r.phases.map(p => p.phase)).toEqual(['lint', 'purge']);
    expect(await lockIds()).toEqual([]);
  });
});
