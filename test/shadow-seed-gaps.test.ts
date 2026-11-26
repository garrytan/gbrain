/**
 * The shadow seed's gap count (src/shadow/seed-gaps.ts) on a real PGLite primary.
 *
 * Protects: a swap to a seeded Rust store is refused while the primary holds rows the seed did
 * not copy and did not name as a loss. A pending rename repair (an `op_checkpoints` row of op
 * `sync-identity-downgrade`) is brain state inside a not-copied table, so it must count as the
 * gap `sync_identity_downgrades`; a checkpoint of any other op must not.
 * Regression it catches: the count ignoring `gap_rows`, which lets a swap drop pending rename
 * repairs silently, or counting a covered table as a gap.
 * A column of a copied relation that the store cannot keep yet (`gap_columns`) counts the rows
 * that hold a value, and is skipped when the primary has no such column.
 * Not covered elsewhere: the Rust test pins the plan's `op_checkpoints` split; this file checks
 * the count that reads the primary.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { SeedPlan } from '../src/core/rust-engine/store.ts';
import { IDENTITY_DOWNGRADE_OP } from '../src/core/sync-identity-downgrades.ts';
import { countSeedGaps, primaryTables, type SeedQuery } from '../src/shadow/seed-gaps.ts';

let engine: PGLiteEngine;
let query: SeedQuery;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  query = (sql, params) => engine.executeRaw(sql, params);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const OP_CHECKPOINTS = {
  table: 'op_checkpoints',
  kind: 'machine_local' as const,
  read: 'an interrupted bulk operation starts again',
  gap_rows: { gap: 'sync_identity_downgrades', column: 'op', equals: IDENTITY_DOWNGRADE_OP },
};

/** A plan that covers every primary table except `left` and `op_checkpoints` (not copied). */
async function planLeaving(left: string): Promise<SeedPlan> {
  const tables = await primaryTables(query);
  return {
    relations: tables.filter(t => t !== left && t !== 'op_checkpoints').map(relation => ({ relation, key: ['id'], removable: true })),
    carried: [],
    not_copied: [OP_CHECKPOINTS],
    gap_columns: [],
  };
}

async function checkpoint(op: string, fingerprint: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, '[]'::jsonb, now())`,
    [op, fingerprint],
  );
}

describe('countSeedGaps', () => {
  test('a pending rename repair is a gap; another checkpoint is a loss', async () => {
    await checkpoint(IDENTITY_DOWNGRADE_OP, '41');
    await checkpoint('import-batch', 'abc');
    const counts = await countSeedGaps(await planLeaving('loop_suppressions'), query);
    expect(counts).toEqual({ loop_suppressions: 0, sync_identity_downgrades: 1 });
  });

  test('every uncovered table is counted, with its rows', async () => {
    await engine.executeRaw(`INSERT INTO loop_suppressions (source_id, kind, value) VALUES ('default', 'sender', 'a@example.com'), ('default', 'thread', 't-1')`);
    const counts = await countSeedGaps(await planLeaving('loop_suppressions'), query);
    expect(counts).toEqual({ loop_suppressions: 2, sync_identity_downgrades: 0 });
  });

  test('a covered table is never a gap', async () => {
    await checkpoint(IDENTITY_DOWNGRADE_OP, '41');
    const tables = await primaryTables(query);
    expect(tables).toContain('op_checkpoints');
    const plan: SeedPlan = { relations: tables.map(relation => ({ relation, key: ['id'], removable: true })), carried: [], not_copied: [], gap_columns: [] };
    expect(await countSeedGaps(plan, query)).toEqual({});
  });

  test('a gap column counts the rows that hold a value; a column the primary lacks is skipped', async () => {
    await engine.putPage('notes/kept', { type: 'note', title: 'Kept', compiled_truth: 'body' });
    await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'body' });
    await engine.executeRaw(`UPDATE pages SET deleted_at = now() WHERE slug = 'notes/gone'`);
    const tables = await primaryTables(query);
    const plan: SeedPlan = {
      relations: tables.map(relation => ({ relation, key: ['id'], removable: true })),
      carried: [],
      not_copied: [],
      gap_columns: [
        { table: 'pages', column: 'deleted_at', gap: 'pages.deleted_at' },
        { table: 'pages', column: 'no_such_column', gap: 'pages.no_such_column' },
      ],
    };
    expect(await countSeedGaps(plan, query)).toEqual({ 'pages.deleted_at': 1 });
  });
});
