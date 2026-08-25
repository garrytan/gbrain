/**
 * Jobs fix wave (upstream issues #2/#3) — migration v128
 * (minion_jobs_timeout_backfill_and_duplicate_cycle_cleanup).
 *
 * Pinned contracts:
 * 1. v128 exists in MIGRATIONS with the canonical name, idempotent flag, and
 *    one engine-agnostic sql block (no sqlFor split).
 * 2. Statement 1 backfills NULL timeout_ms for the 8 long-lane handler names
 *    across ALL five non-terminal statuses — and ONLY those rows: terminal
 *    rows, unmapped names, and explicit budgets are untouched. Active rows
 *    get timeout_ms only (never a timeout_at stamp — that would arm the
 *    tighter 1x handleTimeouts kill mid-flight; the 2x wall-clock bound is
 *    the intended repair).
 * 3. Statement 2 cancels all-but-newest ticker-keyed waiting autopilot
 *    cycles per (name, queue, source scope). Manual submissions (no ticker
 *    idempotency-key prefix) and parented rows are never touched; distinct
 *    sources each keep their newest row; cancelled rows carry error_text.
 * 4. Ledger round-trip: rewind to 127 → runMigrations applies v128; re-run
 *    is 0 applied. AND (Codex C9) SQL-level idempotency: re-executing the
 *    v128 SQL directly changes zero rows — the ledger check alone only
 *    proves version bookkeeping.
 * 5. Empty table → 0-row no-op.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let workerBackedQueue: MinionQueue;

const V128_SQL = MIGRATIONS.find(m => m.version === 128)?.sql ?? '';

/** PGLite's prepared-statement path rejects multi-command SQL; the migration
 *  runner uses a different execution path. For the direct SQL-rerun check,
 *  split on statement terminators (the blob's only two `;` are terminators). */
const V128_STATEMENTS = V128_SQL.split(';').map(s => s.trim()).filter(Boolean);

async function execV128Directly(): Promise<void> {
  for (const stmt of V128_STATEMENTS) {
    await engine.executeRaw(stmt);
  }
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' }); // in-memory
  await engine.initSchema();
  queue = new MinionQueue(engine);
  const workerBackedEngine = new Proxy(engine, {
    get(target, prop) {
      if (prop === 'kind') return 'postgres';
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;
  workerBackedQueue = new MinionQueue(workerBackedEngine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM minion_jobs');
});

/** Force a row into a specific historical shape (add() stamps budgets and
 *  every row starts 'waiting', so legacy states are seeded by direct UPDATE —
 *  the same trick the wall-clock tests use). */
async function forceRow(id: number, sets: string, params: unknown[] = []): Promise<void> {
  await engine.executeRaw(`UPDATE minion_jobs SET ${sets} WHERE id = $${params.length + 1}`, [...params, id]);
}

async function snapshot(): Promise<Array<Record<string, unknown>>> {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT id, name, status, timeout_ms::text AS timeout_ms,
            timeout_at IS NULL AS timeout_at_null, error_text
       FROM minion_jobs ORDER BY id`,
  );
}

describe('migration v128 — structure', () => {
  test('exists with canonical name, idempotent flag, engine-agnostic sql', () => {
    const v128 = MIGRATIONS.find(m => m.version === 128);
    expect(v128).toBeDefined();
    expect(v128?.name).toBe('minion_jobs_timeout_backfill_and_duplicate_cycle_cleanup');
    expect(v128?.idempotent).toBe(true);
    expect(v128?.sqlFor).toBeUndefined();
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(128);
  });

  test('statement 1 covers all five non-terminal statuses and never stamps timeout_at', () => {
    expect(V128_SQL).toContain(`status IN ('waiting','active','delayed','waiting-children','paused')`);
    expect(V128_SQL).not.toContain('SET timeout_at');
  });

  test('statement 2 is restricted to ticker idempotency-key prefixes and top-level rows', () => {
    expect(V128_SQL).toContain(`idempotency_key LIKE 'autopilot-cycle:%'`);
    expect(V128_SQL).toContain(`idempotency_key LIKE 'autopilot-global:%'`);
    expect(V128_SQL).toContain('parent_job_id IS NULL');
  });
});

describe('migration v128 — backfill + cleanup semantics (PGLite)', () => {
  test('full matrix: backfill hits legacy non-terminal mapped rows only; cleanup keeps newest ticker row per scope', async () => {
    // --- Backfill fixtures (statement 1) ---
    // Legacy waiting subagent: NULL budget → 30min.
    const legacyWaiting = await queue.add('subagent', {}, undefined, { allowProtectedSubmit: true });
    await forceRow(legacyWaiting.id, `timeout_ms = NULL, timeout_at = NULL`);
    // Legacy ACTIVE autopilot-cycle mid-flight: NULL budget → 30min, but
    // timeout_at must STAY NULL (Codex C7 — no 1x kill armed mid-flight).
    const legacyActive = await queue.add('autopilot-cycle', { source_id: 'src-active' }, {
      idempotency_key: 'autopilot-cycle:src-active:slot-0',
    });
    await forceRow(legacyActive.id,
      `timeout_ms = NULL, timeout_at = NULL, status = 'active',
       lock_token = 'legacy-worker', lock_until = now() + interval '30 seconds',
       started_at = now() - interval '10 minutes'`);
    // Terminal row: NULL budget stays NULL (completed is not rescued).
    const completed = await queue.add('subagent', { done: true }, undefined, { allowProtectedSubmit: true });
    await forceRow(completed.id, `timeout_ms = NULL, status = 'completed', finished_at = now()`);
    // Unmapped name: stays NULL.
    const unmapped = await queue.add('sync', {});
    expect(unmapped.timeout_ms).toBeNull();
    // Explicit budget: untouched.
    const explicit = await workerBackedQueue.add('embed-backfill', { sourceId: 'x' }, { timeout_ms: 5000 });

    // --- Cleanup fixtures (statement 2) ---
    // Three ticker-keyed waiting cycles for ONE source, staggered ages —
    // newest must survive, older two cancelled.
    const dupOld = await queue.add('autopilot-cycle', { source_id: 'src-dup' }, {
      idempotency_key: 'autopilot-cycle:src-dup:slot-1',
    });
    await forceRow(dupOld.id, `timeout_ms = NULL, created_at = now() - interval '3 hours'`);
    const dupMid = await queue.add('autopilot-cycle', { source_id: 'src-dup' }, {
      idempotency_key: 'autopilot-cycle:src-dup:slot-2',
    });
    await forceRow(dupMid.id, `timeout_ms = NULL, created_at = now() - interval '2 hours'`);
    const dupNew = await queue.add('autopilot-cycle', { source_id: 'src-dup' }, {
      idempotency_key: 'autopilot-cycle:src-dup:slot-3',
    });
    await forceRow(dupNew.id, `timeout_ms = NULL, created_at = now() - interval '1 hour'`);
    // A DIFFERENT source keeps its own newest row (scope isolation).
    const otherSrc = await queue.add('autopilot-cycle', { source_id: 'src-other' }, {
      idempotency_key: 'autopilot-cycle:src-other:slot-1',
    });
    await forceRow(otherSrc.id, `created_at = now() - interval '4 hours'`);
    // Global maintenance duplicates (NULL source scope) dedupe independently.
    const globalOld = await queue.add('autopilot-global-maintenance', {}, {
      idempotency_key: 'autopilot-global:slot-1',
    });
    await forceRow(globalOld.id, `created_at = now() - interval '2 hours'`);
    const globalNew = await queue.add('autopilot-global-maintenance', {}, {
      idempotency_key: 'autopilot-global:slot-2',
    });
    // Manual submission: same name + source as the dup scope, custom phases,
    // NO ticker key — must never be touched (Codex C5).
    const manual = await queue.add('autopilot-cycle', { source_id: 'src-dup', phases: ['sync'] });
    await forceRow(manual.id, `created_at = now() - interval '5 hours'`);
    // Ticker-mimicking key but camelCase sourceId payload: the ticker never
    // writes sourceId, so this row is not ticker-provenance — the cleanup's
    // sourceId-IS-NULL guard must leave it alone even though its key matches
    // the prefix (adversarial-review tightening: without the guard, distinct
    // sourceId scopes would collapse into the empty source_id group).
    const camelMimic = await queue.add('autopilot-cycle', { sourceId: 'camel-src' }, {
      idempotency_key: 'autopilot-cycle:camel-mimic:slot-1',
    });
    await forceRow(camelMimic.id, `created_at = now() - interval '7 hours'`);
    // Parented row with a ticker-looking key: guarded by parent_job_id IS NULL.
    // Parent is seeded by direct UPDATE — add()'s parent_job_id opt would flip
    // the parent row to 'waiting-children' and pollute the dup-scope fixtures.
    const parented = await queue.add('autopilot-cycle', { source_id: 'src-dup' }, {
      idempotency_key: 'autopilot-cycle:src-dup:slot-child',
    });
    await forceRow(parented.id,
      `created_at = now() - interval '6 hours', parent_job_id = $1`, [dupNew.id]);

    // --- Apply v128 via the real migration runner (ledger rewind). ---
    await engine.setConfig('version', '127');
    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));

    const rows = await engine.executeRaw<{
      id: number; status: string; timeout_ms: string | null;
      timeout_at: string | null; error_text: string | null;
    }>(`SELECT id, status, timeout_ms::text AS timeout_ms, timeout_at::text AS timeout_at, error_text
          FROM minion_jobs`);
    const byId = new Map(rows.map(r => [Number(r.id), r]));

    // Statement 1 assertions.
    expect(Number(byId.get(legacyWaiting.id)!.timeout_ms)).toBe(1_800_000);
    expect(Number(byId.get(legacyActive.id)!.timeout_ms)).toBe(1_800_000);
    expect(byId.get(legacyActive.id)!.timeout_at).toBeNull();       // C7: no 1x kill armed
    expect(byId.get(legacyActive.id)!.status).toBe('active');
    expect(byId.get(completed.id)!.timeout_ms).toBeNull();          // terminal untouched
    expect(byId.get(unmapped.id)!.timeout_ms).toBeNull();           // not in map
    expect(Number(byId.get(explicit.id)!.timeout_ms)).toBe(5000);   // explicit wins

    // Statement 2 assertions.
    expect(byId.get(dupNew.id)!.status).toBe('waiting');            // newest survives
    expect(byId.get(dupOld.id)!.status).toBe('cancelled');
    expect(byId.get(dupMid.id)!.status).toBe('cancelled');
    expect(byId.get(dupOld.id)!.error_text).toContain('superseded duplicate autopilot cycle');
    expect(byId.get(otherSrc.id)!.status).toBe('waiting');          // other source keeps its one row
    expect(byId.get(globalNew.id)!.status).toBe('waiting');
    expect(byId.get(globalOld.id)!.status).toBe('cancelled');
    expect(byId.get(manual.id)!.status).toBe('waiting');            // manual never touched (C5)
    expect(byId.get(manual.id)!.error_text).toBeNull();
    expect(byId.get(parented.id)!.status).toBe('waiting');          // parented never touched
    expect(byId.get(camelMimic.id)!.status).toBe('waiting');        // camelCase sourceId never swept

    // Ledger idempotency: re-run applies nothing.
    const rerun = await runMigrations(engine);
    expect(rerun.applied).toBe(0);

    // SQL-level idempotency (Codex C9): re-execute the v128 SQL directly and
    // prove zero rows change — version bookkeeping alone can't show this.
    const before = await snapshot();
    await execV128Directly();
    const after = await snapshot();
    expect(after).toEqual(before);

    // Sanity on the split used above: exactly the two statements shipped.
    expect(V128_STATEMENTS.length).toBe(2);
  }, 30_000);

  test('empty table: v128 SQL is a 0-row no-op', async () => {
    const before = await snapshot();
    expect(before).toEqual([]);
    await execV128Directly();
    expect(await snapshot()).toEqual([]);
  });
});
