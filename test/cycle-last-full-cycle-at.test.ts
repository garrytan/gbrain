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
 * Best-effort: a write failure does NOT change the CycleReport status.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { runCycle } from '../src/core/cycle.ts';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

let engine: PGLiteEngine;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-cycle-lfca-'));
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
  const raw = s.config?.last_full_cycle_at;
  return typeof raw === 'string' ? raw : null;
}

describe('runCycle last_full_cycle_at exit hook', () => {
  test('per-source cycle with status=ok writes timestamp', async () => {
    await seedSource('alpha');
    const before = await readLastFullCycleAt('alpha');
    expect(before).toBeNull();

    // Run a minimal cycle: just lint (filesystem, no DB writes, always returns 'ok')
    const t0 = Date.now();
    const report = await runCycle(engine, {
      brainDir,
      sourceId: 'alpha',
      phases: ['lint'],
    });
    // lint on an empty dir returns ok+clean+0 fixes
    expect(['ok', 'clean']).toContain(report.status);

    const after = await readLastFullCycleAt('alpha');
    expect(after).not.toBeNull();
    const writtenMs = new Date(after!).getTime();
    expect(writtenMs).toBeGreaterThanOrEqual(t0);
    expect(writtenMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  test('legacy caller (no sourceId) does NOT write any source timestamp', async () => {
    await seedSource('default-like');
    // No sourceId passed; should remain untouched.
    await runCycle(engine, {
      brainDir,
      phases: ['lint'],
    });
    // No per-source write happens; default source's config stays empty.
    const after = await readLastFullCycleAt('default-like');
    expect(after).toBeNull();
  });

  test('dryRun=true skips the write', async () => {
    await seedSource('beta');
    await runCycle(engine, {
      brainDir,
      sourceId: 'beta',
      phases: ['lint'],
      dryRun: true,
    });
    const after = await readLastFullCycleAt('beta');
    expect(after).toBeNull();
  });

  test('cycle that returns skipped (lock held) does NOT mark timestamp', async () => {
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
  });

  test('two consecutive per-source cycles update the timestamp on each run', async () => {
    await seedSource('delta');
    await runCycle(engine, { brainDir, sourceId: 'delta', phases: ['lint'] });
    const first = await readLastFullCycleAt('delta');
    expect(first).not.toBeNull();
    // Wait 10ms so the timestamp can advance
    await new Promise(r => setTimeout(r, 10));
    await runCycle(engine, { brainDir, sourceId: 'delta', phases: ['lint'] });
    const second = await readLastFullCycleAt('delta');
    expect(second).not.toBeNull();
    expect(new Date(second!).getTime()).toBeGreaterThan(new Date(first!).getTime());
  });
});
