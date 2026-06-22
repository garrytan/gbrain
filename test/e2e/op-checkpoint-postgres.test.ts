/**
 * E2E (real Postgres) — recordCompleted writes a JSONB *array*, not a scalar.
 *
 * Skipped gracefully when DATABASE_URL is unset. Catches a class of bug PGLite
 * cannot: postgres.js's `.unsafe(sql, params)` path (executeRawDirect →
 * runUnsafe) JSON-encodes a string parameter a SECOND time. So the pre-fix
 * `recordCompleted` — `JSON.stringify(sorted)` bound to a `$3::jsonb` cast —
 * produced a jsonb *scalar string* (`"[...]"`, jsonb_typeof = 'string'), which
 * trips migration v119's `op_checkpoints_completed_keys_array` CHECK
 * (`jsonb_typeof(completed_keys) = 'array'`) and fails the whole write. The fix
 * binds the array as `text[]` and builds the array in SQL via
 * `to_jsonb($3::text[])` (the same binding APPEND_PATHS_SQL uses).
 *
 * PGLite does not double-encode, so the PGLite unit suite (test/op-checkpoint.test.ts)
 * passes on BOTH the broken and fixed code — this real-Postgres test is the only
 * layer that regression-guards the binding.
 *
 * Scoped to a reserved `__test_ckpt_pg__` op so it never touches real checkpoint
 * rows; beforeAll/afterAll delete only that op.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { recordCompleted, loadOpCheckpoint, clearOpCheckpoint } from '../../src/core/op-checkpoint.ts';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  describe.skip('postgres E2E — op-checkpoint recordCompleted (skipped: DATABASE_URL unset)', () => {
    test('skipped', () => { expect(true).toBe(true); });
  });
} else {
  let engine: PostgresEngine;
  const OP = '__test_ckpt_pg__';

  const wipe = () => engine.executeRaw(`DELETE FROM op_checkpoints WHERE op = $1`, [OP]);

  beforeAll(async () => {
    engine = new PostgresEngine();
    await engine.connect({ database_url: dbUrl } as never);
    await engine.initSchema(); // applies migration v119 (the array CHECK)
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await engine.disconnect();
  });

  test('recordCompleted persists a JSONB array (survives the v119 array CHECK)', async () => {
    const key = { op: OP, fingerprint: 'arr00001' };
    const keys = ['chunk-2', 'chunk-1', 'chunk-3'];

    const ok = await recordCompleted(engine, key, keys);
    // Pre-fix: the double-encoded scalar string trips the CHECK; durableWrite
    // swallows the error and returns false. Post-fix: true.
    expect(ok).toBe(true);

    const rows = await engine.executeRaw<{ typ: string }>(
      `SELECT jsonb_typeof(completed_keys) AS typ FROM op_checkpoints
        WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    );
    expect(rows[0]?.typ).toBe('array');

    // Round-trips through the loader (sorted set).
    const loaded = await loadOpCheckpoint(engine, key);
    expect([...loaded].sort()).toEqual(['chunk-1', 'chunk-2', 'chunk-3']);

    await clearOpCheckpoint(engine, key);
  });

  test('recordCompleted REPLACE semantics keep the column an array', async () => {
    const key = { op: OP, fingerprint: 'arr00002' };

    expect(await recordCompleted(engine, key, ['a', 'b'])).toBe(true);
    // REPLACE (not append): a smaller set must overwrite, still a valid array.
    expect(await recordCompleted(engine, key, ['a'])).toBe(true);

    const rows = await engine.executeRaw<{ typ: string }>(
      `SELECT jsonb_typeof(completed_keys) AS typ FROM op_checkpoints
        WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    );
    expect(rows[0]?.typ).toBe('array');

    const loaded = await loadOpCheckpoint(engine, key);
    expect([...loaded].sort()).toEqual(['a']);

    await clearOpCheckpoint(engine, key);
  });
}
