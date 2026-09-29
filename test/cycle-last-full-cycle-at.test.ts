/**
 * v0.38 — runCycle exit hook writes last_full_cycle_at on per-source
 * cycles. Closes codex round-1 P0-5 (write site for last_full_cycle_at
 * was unspecified pre-PR).
 *
 * Conditions for write:
 *   - opts.sourceId is set (legacy callers without sourceId skip the write)
 *   - engine is non-null (no-DB path skips)
 *   - status is 'ok' | 'clean' | 'partial' (failed/skipped don't mark fresh)
 *   - dryRun is false
 *
 * Best-effort in that it never throws out of runCycle. As of #3504 a write
 * failure IS surfaced: it sets `stamp_write_failed` on the report and degrades
 * a successful status to 'partial'. See test/cycle-stamp-write-failure.test.ts.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runCycle } from '../src/core/cycle.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { captureSourceIncarnation, writeSourceCycleTimestamps } from '../src/core/source-cycle-state.ts';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
let brainDir: string;
// Per-test GBRAIN_HOME isolation: cycle's PGLite path acquires a file
// lock at `~/.gbrain/cycle.lock` (no sourceId scope). Without isolating
// GBRAIN_HOME per test, parallel gbrain processes on the same machine
// (including sibling Conductor worktrees running their own tests)
// contend for the same lock file — runCycle returns 'skipped' and the
// last_full_cycle_at exit hook silently no-ops. Each test wraps its
// body in `withEnv({GBRAIN_HOME: <unique tmp>})` so the file lock path
// becomes per-test.
let gbrainHome: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-lfca-'));
  gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-cycle-lfca-home-'));
});

async function seedSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config, archived, created_at)
     VALUES ($1, $2, $3, '{}'::jsonb, false, NOW())
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, id, brainDir],
  );
}

async function readLastFullCycleAt(sourceId: string): Promise<string | null> {
  const sources = await engine.listAllSources();
  const s = sources.find(x => x.id === sourceId);
  if (!s) return null;
  const raw = s.cycle_state_exists ? s.last_full_cycle_at : s.config?.last_full_cycle_at;
  return raw instanceof Date ? raw.toISOString() : (typeof raw === 'string' ? raw : null);
}

describe('runCycle last_full_cycle_at exit hook', () => {
  test('per-source cycle with status=ok writes timestamp', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('alpha');
      const before = await readLastFullCycleAt('alpha');
      expect(before).toBeNull();

      // Run a minimal cycle: just lint (filesystem, no DB writes, always returns 'ok')
      const t0 = Date.now();
      const report = await runCycle(engine, {
        brainDir,
        sourceId: 'alpha',
        phases: ['recompute_emotional_weight'],
      });
      // Provider-free phase keeps this test focused on the completion stamp.
      expect(['ok', 'clean']).toContain(report.status);

      const after = await readLastFullCycleAt('alpha');
      expect(after).not.toBeNull();
      const writtenMs = new Date(after!).getTime();
      expect(writtenMs).toBeGreaterThanOrEqual(t0);
      expect(writtenMs).toBeLessThanOrEqual(Date.now() + 1000);
    });
  });

  test('cycle writes only separate cycle state and leaves connector config byte-stable', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('stable');
      await engine.updateSourceConfig('stable', {
        github_repo: 'owner/repo',
        cursor: { opaque: 'keep-exactly' },
        last_full_cycle_at: '2026-01-01T00:00:00.000Z',
      });
      const before = await engine.executeRaw<{ config: string }>(
        'SELECT config::text AS config FROM sources WHERE id = $1', ['stable'],
      );
      const result = await runCycle(engine, { brainDir, sourceId: 'stable', phases: ['recompute_emotional_weight'] });
      expect(['ok', 'clean']).toContain(result.status);
      const after = await engine.executeRaw<{ config: string }>(
        'SELECT config::text AS config FROM sources WHERE id = $1', ['stable'],
      );
      expect(after[0]?.config).toBe(before[0]?.config);
      const state = await engine.executeRaw<{ last_full_cycle_at: Date | string }>(
        'SELECT last_full_cycle_at FROM source_cycle_state WHERE source_id = $1', ['stable'],
      );
      expect(state).toHaveLength(1);
      expect(new Date(state[0]!.last_full_cycle_at).getTime()).toBeGreaterThan(0);
    });
  });

  test('recreated source cannot inherit state or receive the prior incarnation stamp', async () => {
    await seedSource('recreated');
    const oldIncarnation = await captureSourceIncarnation(engine, 'recreated');
    expect(oldIncarnation).not.toBeNull();
    expect(await writeSourceCycleTimestamps(engine, 'recreated', oldIncarnation!, '2026-01-01T00:00:00.000Z')).toBe(true);

    await engine.executeRaw('DELETE FROM sources WHERE id = $1', ['recreated']);
    await seedSource('recreated');
    const newIncarnation = await captureSourceIncarnation(engine, 'recreated');
    expect(newIncarnation).not.toBe(oldIncarnation);
    expect(await writeSourceCycleTimestamps(engine, 'recreated', oldIncarnation!, new Date().toISOString())).toBe(false);
    const source = (await engine.listAllSources()).find(row => row.id === 'recreated');
    expect(source?.cycle_state_exists).toBe(false);
    expect(source?.last_full_cycle_at).toBeNull();
  });

  test('archived source cannot receive a completion stamp from an older cycle', async () => {
    await seedSource('archived-during-cycle');
    const incarnation = await captureSourceIncarnation(engine, 'archived-during-cycle');
    expect(incarnation).not.toBeNull();
    await engine.executeRaw('UPDATE sources SET archived = true WHERE id = $1', ['archived-during-cycle']);
    const wrote = await writeSourceCycleTimestamps(engine, 'archived-during-cycle', incarnation!, new Date().toISOString());
    expect(wrote).toBe(false);
  });

  test('migration preserves legacy timestamps for fallback without unsafe casts or config rewrites', async () => {
    await seedSource('legacy-seed');
    await engine.updateSourceConfig('legacy-seed', {
      github_repo: 'owner/legacy',
      cursor: { opaque: 'receipt' },
      last_source_cycle_at: '2026-01-01T00:00:00.000Z',
      last_full_cycle_at: '2026-13-99T25:61:61.000Z',
    });
    const before = await engine.executeRaw<{ config: string }>(
      'SELECT config::text AS config FROM sources WHERE id = $1', ['legacy-seed'],
    );
    await engine.setConfig('version', '169');
    const result = await runMigrations(engine);
    expect(result).toEqual({ applied: 2, current: 171 });
    const after = await engine.executeRaw<{ config: string }>(
      'SELECT config::text AS config FROM sources WHERE id = $1', ['legacy-seed'],
    );
    const state = await engine.executeRaw(
      'SELECT source_id FROM source_cycle_state WHERE source_id = $1', ['legacy-seed'],
    );
    const source = (await engine.listAllSources()).find(row => row.id === 'legacy-seed');
    expect(after[0]?.config).toBe(before[0]?.config);
    expect(state).toHaveLength(0);
    expect(source?.cycle_state_exists).toBe(false);
    expect(source?.config.last_source_cycle_at).toBe('2026-01-01T00:00:00.000Z');
    expect(source?.config.last_full_cycle_at).toBe('2026-13-99T25:61:61.000Z');
  });

  test('legacy caller (no sourceId) does NOT write any source timestamp', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('default-like');
      // No sourceId passed; should remain untouched.
      await runCycle(engine, {
        brainDir,
        phases: ['recompute_emotional_weight'],
      });
      // No per-source write happens; default source's config stays empty.
      const after = await readLastFullCycleAt('default-like');
      expect(after).toBeNull();
      expect((await engine.listAllSources()).find(s => s.id === 'default-like')?.cycle_state_exists).toBe(false);
    });
  });

  test('dryRun=true skips the write', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('beta');
      await runCycle(engine, {
        brainDir,
        sourceId: 'beta',
        phases: ['recompute_emotional_weight'],
        dryRun: true,
      });
      const after = await readLastFullCycleAt('beta');
      expect(after).toBeNull();
      expect((await engine.listAllSources()).find(s => s.id === 'beta')?.cycle_state_exists).toBe(false);
    });
  });

  test('cycle that returns skipped (lock held) does NOT mark timestamp', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('gamma');
      // Inject a live lock row directly so the cycle returns 'skipped'.
      // This simulates "another cycle is already running for gamma."
      const lockId = 'gbrain-cycle:gamma';
      const pid = process.pid;
      await engine.executeRaw(
        `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
         VALUES ($1, $2, 'test', NOW(), NOW() + INTERVAL '30 minutes')`,
        [lockId, pid + 99999],
      );
      const report = await runCycle(engine, {
        brainDir,
        sourceId: 'gamma',
        phases: ['lint', 'sync'], // sync triggers lock acquisition
      });
      expect(report.status).toBe('skipped');
      expect(report.reason).toBe('cycle_already_running');
      const after = await readLastFullCycleAt('gamma');
      expect(after).toBeNull();
      expect((await engine.listAllSources()).find(s => s.id === 'gamma')?.cycle_state_exists).toBe(false);
    });
  });

  test('delayed older cycle stamps cannot move source freshness backwards', async () => {
    await seedSource('monotonic');
    const incarnation = await captureSourceIncarnation(engine, 'monotonic');
    expect(incarnation).not.toBeNull();
    await writeSourceCycleTimestamps(engine, 'monotonic', incarnation!, '2026-05-22T12:00:00.000Z');
    await writeSourceCycleTimestamps(engine, 'monotonic', incarnation!, '2026-05-22T11:00:00.000Z');
    const [row] = await engine.executeRaw<{ last_source_cycle_at: Date; last_full_cycle_at: Date; updated_at: Date }>(
      'SELECT last_source_cycle_at, last_full_cycle_at, updated_at FROM source_cycle_state WHERE source_id = $1', ['monotonic'],
    );
    expect(row.last_source_cycle_at.toISOString()).toBe('2026-05-22T12:00:00.000Z');
    expect(row.last_full_cycle_at.toISOString()).toBe('2026-05-22T12:00:00.000Z');
    expect(row.updated_at.toISOString()).toBe('2026-05-22T12:00:00.000Z');
  });

  test('composite source identity rejects another source incarnation', async () => {
    await seedSource('identity-a');
    await seedSource('identity-b');
    const incarnationB = await captureSourceIncarnation(engine, 'identity-b');
    await expect(engine.executeRaw(
      `INSERT INTO source_cycle_state (source_id, source_incarnation, updated_at)
       VALUES ('identity-a', $1::uuid, NOW())`, [incarnationB],
    )).rejects.toThrow();
  });

  test('source deletion cascades its cycle state', async () => {
    await seedSource('cascade-state');
    const incarnation = await captureSourceIncarnation(engine, 'cascade-state');
    await writeSourceCycleTimestamps(engine, 'cascade-state', incarnation!, '2026-05-22T12:00:00.000Z');
    await engine.executeRaw('DELETE FROM sources WHERE id = $1', ['cascade-state']);
    const rows = await engine.executeRaw('SELECT source_id FROM source_cycle_state WHERE source_id = $1', ['cascade-state']);
    expect(rows).toHaveLength(0);
  });

  test('two consecutive per-source cycles update the timestamp on each run', async () => {
    await withEnv({ GBRAIN_HOME: gbrainHome }, async () => {
      await seedSource('delta');
      await runCycle(engine, { brainDir, sourceId: 'delta', phases: ['recompute_emotional_weight'] });
      const first = await readLastFullCycleAt('delta');
      expect(first).not.toBeNull();
      // Wait 10ms so the timestamp can advance
      await new Promise(r => setTimeout(r, 10));
      await runCycle(engine, { brainDir, sourceId: 'delta', phases: ['recompute_emotional_weight'] });
      const second = await readLastFullCycleAt('delta');
      expect(second).not.toBeNull();
      expect(new Date(second!).getTime()).toBeGreaterThan(new Date(first!).getTime());
    });
  });
});
