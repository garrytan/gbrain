/**
 * Migration v131 (drop_job_wide_subagent_tool_use_id_unique) — #4155.
 *
 * tool_use_id stores the RAW provider id, and replay-style providers
 * (claude-cli spawns a fresh subprocess per turn from an id-stripped
 * transcript) reuse the same short id on every turn. The job-wide
 * UNIQUE (job_id, tool_use_id) constraint encoded the false assumption that
 * provider ids are job-unique; a reuse collided and dead-lettered the job.
 * Row identity is (job_id, message_idx, ordinal).
 *
 * Pinned contracts:
 * 1. v131 exists in MIGRATIONS with the canonical name, idempotent flag, and
 *    one engine-agnostic sql block (no sqlFor split).
 * 2. Fresh init: the schema no longer declares uniq_subagent_tools_use_id and
 *    two rows sharing (job_id, tool_use_id) can coexist.
 * 3. Upgrade: on a brain where the constraint still exists (positive control:
 *    the duplicate insert THROWS before the migration), a ledger rewind to
 *    130 → runMigrations applies v131, the constraint is gone, and the same
 *    duplicate insert succeeds. Re-run applies nothing, and re-executing the
 *    v131 SQL directly is a no-op (DROP CONSTRAINT IF EXISTS).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { MIGRATIONS, LATEST_VERSION, runMigrations } from '../src/core/migrate.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let jobId: number;

const V131_SQL = MIGRATIONS.find(m => m.version === 131)?.sql ?? '';

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
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM minion_jobs');
  const j = await queue.add('subagent', { prompt: 'x' }, {}, { allowProtectedSubmit: true });
  jobId = j.id;
});

/** Insert an execution row with an explicit (message_idx, ordinal) identity. */
async function insertExec(msgIdx: number, toolUseId: string, ordinal: number): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions
       (job_id, message_idx, tool_use_id, tool_name, input, status, ordinal)
     VALUES ($1, $2, $3, 'search', '{}'::jsonb, 'pending', $4)`,
    [jobId, msgIdx, toolUseId, ordinal],
  );
}

async function constraintExists(): Promise<boolean> {
  const rows = await engine.executeRaw<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE conname = 'uniq_subagent_tools_use_id'`,
  );
  return rows.length > 0;
}

describe('migration v131 — structure', () => {
  test('exists with canonical name, idempotent flag, engine-agnostic sql', () => {
    const v131 = MIGRATIONS.find(m => m.version === 131);
    expect(v131).toBeDefined();
    expect(v131?.name).toBe('drop_job_wide_subagent_tool_use_id_unique');
    expect(v131?.idempotent).toBe(true);
    expect(v131?.sqlFor).toBeUndefined();
    expect(V131_SQL).toContain('DROP CONSTRAINT IF EXISTS uniq_subagent_tools_use_id');
    expect(LATEST_VERSION).toBeGreaterThanOrEqual(131);
  });
});

describe('migration v131 — fresh init (PGLite)', () => {
  test('fresh schema has no job-wide unique; duplicate raw ids across turns coexist', async () => {
    expect(await constraintExists()).toBe(false);
    await insertExec(1, 'toolu_01', 0);
    await insertExec(3, 'toolu_01', 0); // same (job_id, tool_use_id), different turn
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM subagent_tool_executions WHERE job_id = $1 AND tool_use_id = 'toolu_01'`,
      [jobId],
    );
    expect(Number(rows[0].n)).toBe(2);
  });
});

describe('migration v131 — upgrade from a pre-v131 brain (PGLite)', () => {
  test('drops the constraint; duplicate insert throws before (positive control) and succeeds after', async () => {
    // Simulate a pre-v131 brain: re-add the job-wide constraint.
    await engine.executeRaw(
      `ALTER TABLE subagent_tool_executions
         ADD CONSTRAINT uniq_subagent_tools_use_id UNIQUE (job_id, tool_use_id)`,
    );
    expect(await constraintExists()).toBe(true);

    // Positive control: the guard actually fires pre-migration — this is the
    // exact #4155 dead-letter shape.
    await insertExec(1, 'toolu_01', 0);
    await expect(insertExec(3, 'toolu_01', 0)).rejects.toThrow(/uniq_subagent_tools_use_id|duplicate key/);

    // Apply v131 via the real migration runner (ledger rewind).
    await engine.setConfig('version', '130');
    const res = await runMigrations(engine);
    expect(res.applied).toBeGreaterThanOrEqual(1);
    expect(await engine.getConfig('version')).toBe(String(LATEST_VERSION));
    expect(await constraintExists()).toBe(false);

    // The same duplicate now persists.
    await insertExec(3, 'toolu_01', 0);
    const rows = await engine.executeRaw<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM subagent_tool_executions WHERE job_id = $1 AND tool_use_id = 'toolu_01'`,
      [jobId],
    );
    expect(Number(rows[0].n)).toBe(2);

    // Ledger idempotency: re-run applies nothing.
    const rerun = await runMigrations(engine);
    expect(rerun.applied).toBe(0);

    // SQL-level idempotency: DROP CONSTRAINT IF EXISTS on an absent
    // constraint is a no-op, not an error.
    await engine.executeRaw(V131_SQL);
    expect(await constraintExists()).toBe(false);
  });
});
