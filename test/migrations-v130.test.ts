/**
 * #4145 — migration v130 (minion_jobs_lock_duration_ms).
 *
 * Pinned contracts:
 * 1. v130 exists in MIGRATIONS with the canonical name, idempotent flag, and
 *    one engine-agnostic sql block; adds the column AND the CHECK via the
 *    idempotent drop-then-add pattern (v7 precedent) so migrated brains
 *    carry the same DB bound as fresh installs.
 * 2. NO backfill: NULL lock_duration_ms means "worker default" (pre-#4145
 *    behavior); the claim-time COALESCE owns all defaulting.
 * 3. SQL-level idempotency: re-executing the v130 statements directly on an
 *    already-migrated schema changes nothing and throws nothing.
 * 4. The CHECK holds: 0 / negative direct writes are rejected; NULL and
 *    positive values pass.
 * 5. A pre-v130-shaped table (column dropped) gains the column on re-run.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MIGRATIONS, LATEST_VERSION } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

const V130_SQL = MIGRATIONS.find(m => m.version === 130)?.sql ?? '';
const V130_STATEMENTS = V130_SQL.split(';').map(s => s.trim()).filter(Boolean);

async function execV130Directly(): Promise<void> {
  for (const stmt of V130_STATEMENTS) {
    await engine.executeRaw(stmt);
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

describe('migration v130 — structure', () => {
  test('exists with canonical name, idempotent flag, engine-agnostic sql', () => {
    const v130 = MIGRATIONS.find(m => m.version === 130);
    expect(v130).toBeDefined();
    expect(v130?.name).toBe('minion_jobs_lock_duration_ms');
    expect(v130?.idempotent).toBe(true);
    expect(v130?.sqlFor).toBeUndefined();
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(130);
  });

  test('adds the column IF NOT EXISTS and the CHECK via drop-then-add (v7 precedent); NO backfill', () => {
    expect(V130_SQL).toContain('ADD COLUMN IF NOT EXISTS lock_duration_ms INTEGER');
    expect(V130_SQL).toContain('DROP CONSTRAINT IF EXISTS chk_lock_duration_positive');
    expect(V130_SQL).toContain('ADD CONSTRAINT chk_lock_duration_positive CHECK (lock_duration_ms IS NULL OR (lock_duration_ms >= 5000 AND lock_duration_ms <= 3600000))');
    // NULL = worker default = pre-#4145 behavior; a backfill would change
    // legacy rows' semantics for no benefit (claim COALESCE owns defaulting).
    expect(V130_SQL).not.toContain('UPDATE minion_jobs');
  });
});

describe('migration v130 — semantics (PGLite)', () => {
  test('SQL idempotency: direct re-run on a migrated schema is a clean no-op', async () => {
    await execV130Directly();
    await execV130Directly(); // twice — the drop-then-add pair must converge
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM information_schema.columns
        WHERE table_name = 'minion_jobs' AND column_name = 'lock_duration_ms'`,
    );
    expect(rows[0].count).toBe('1');
  });

  test('CHECK holds: out-of-range rejected, NULL + in-range pass', async () => {
    const job = await queue.add('lease-check', {});
    await engine.executeRaw(`UPDATE minion_jobs SET lock_duration_ms = 300000 WHERE id = $1`, [job.id]);
    await engine.executeRaw(`UPDATE minion_jobs SET lock_duration_ms = NULL WHERE id = $1`, [job.id]);
    // The CHECK enforces the full advertised [5s,1h] range so a bypass
    // writer can't stamp a thrash-lease or a weeks-long one (codex P2).
    for (const bad of [0, -5, 1, 4999, 3_600_001]) {
      await expect(
        engine.executeRaw(`UPDATE minion_jobs SET lock_duration_ms = ${bad} WHERE id = $1`, [job.id]),
      ).rejects.toThrow(/chk_lock_duration_positive/);
    }
  });

  test('pre-v130 shape (column dropped) gains column + CHECK on re-run', async () => {
    await engine.executeRaw(`ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_lock_duration_positive`);
    await engine.executeRaw(`ALTER TABLE minion_jobs DROP COLUMN IF EXISTS lock_duration_ms`);
    await execV130Directly();
    const job = await queue.add('lease-regain', {});
    const row = await queue.getJob(job.id);
    expect(row!.lock_duration_ms).toBeNull(); // unmapped name → no default stamped
    await expect(
      engine.executeRaw(`UPDATE minion_jobs SET lock_duration_ms = 0 WHERE id = $1`, [job.id]),
    ).rejects.toThrow(/chk_lock_duration_positive/);
  });

  test('claim SQL clamps a bypass-written lease before deriving lock_until (codex P2)', async () => {
    // Simulate foreign tooling stamping a lease outside the advertised
    // range directly (the CHECK blocks this on current schemas, so drop it
    // for the simulation — the claim clamp is the layer under test).
    await engine.executeRaw(`ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_lock_duration_positive`);
    const job = await queue.add('bypass-lease', {});
    await engine.executeRaw(`UPDATE minion_jobs SET lock_duration_ms = 2147483647 WHERE id = $1`, [job.id]);
    const before = Date.now();
    const claimed = await queue.claim('tok-bypass', 30_000, 'default', ['bypass-lease']);
    expect(claimed!.lock_duration_ms).toBe(3_600_000); // stamped clamped
    const horizon = claimed!.lock_until!.getTime() - before;
    expect(horizon).toBeLessThan(3_700_000); // lock_until bounded to ~1h, not ~24.8 days
    // Restore the range CHECK for subsequent tests.
    await engine.executeRaw(`ALTER TABLE minion_jobs ADD CONSTRAINT chk_lock_duration_positive CHECK (lock_duration_ms IS NULL OR (lock_duration_ms >= 5000 AND lock_duration_ms <= 3600000))`);
  });
});
