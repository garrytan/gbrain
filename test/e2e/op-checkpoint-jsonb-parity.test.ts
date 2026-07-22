/**
 * E2E: op_checkpoints.completed_keys JSONB parity — #2339 regression guard.
 *
 * #2339: `recordCompleted` bound `JSON.stringify(array)` to a `$3::jsonb` param
 * via postgres.js `.unsafe()` (executeRawDirect). That double-encodes the value
 * into a jsonb *string scalar*, which violates the v119
 * `op_checkpoints_completed_keys_array CHECK (jsonb_typeof = 'array')` and aborts
 * EVERY sync on real Postgres at the first checkpoint write. PGLite's driver
 * parses the string silently, which is exactly why the unit suite stayed green
 * and the bug shipped — so this assertion can ONLY be made on real Postgres.
 *
 * This file uses the standard `hasDatabase()` skip gate (consistent with the
 * other e2e tests). The X2-A guarantee that it actually RUNS lives in a dedicated
 * CI job (.github/workflows) that provisions a Postgres service so DATABASE_URL
 * is always present there — rather than a fail-on-skip hack inside this file,
 * which would red-fail legitimate DB-less local runs.
 *
 * Fix under test: `$3::text::jsonb` binds the value as text, so the text→jsonb
 * cast parses it into a genuine jsonb array.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine, getConn } from './helpers.ts';
import { recordCompleted, loadOpCheckpoint } from '../../src/core/op-checkpoint.ts';

const describeE2E = hasDatabase() ? describe : describe.skip;

describeE2E('E2E: op_checkpoints completed_keys jsonb parity (#2339)', () => {
  beforeAll(async () => {
    await setupDB();
  });
  afterAll(async () => {
    await teardownDB();
  });

  const key = { op: 'sync-target', fingerprint: 'jsonb-parity-2339' };

  test('recordCompleted stores completed_keys as a jsonb ARRAY, not a double-encoded scalar', async () => {
    const engine = getEngine();

    // Pre-fix this throws SQLSTATE 23514 (the CHECK), durableWrite exhausts its
    // retries, and recordCompleted returns false. Post-fix it stores a real array.
    const ok = await recordCompleted(engine, key, ['b/2.md', 'a/1.md', 'c/3.md']);
    expect(ok).toBe(true);

    const sql = getConn();
    const [row] = await sql`
      SELECT jsonb_typeof(completed_keys)   AS t,
             jsonb_array_length(completed_keys) AS len,
             completed_keys ->> 0           AS first
      FROM op_checkpoints
      WHERE op = ${key.op} AND fingerprint = ${key.fingerprint}
    `;
    expect(row.t).toBe('array'); // pre-fix: 'string' (scalar) — the bug
    expect(Number(row.len)).toBe(3);
    expect(row.first).toBe('a/1.md'); // recordCompleted sorts the set
  }, 30_000);

  test('loadOpCheckpoint round-trips the recorded set', async () => {
    const engine = getEngine();
    const got = await loadOpCheckpoint(engine, key);
    expect(new Set(got)).toEqual(new Set(['a/1.md', 'b/2.md', 'c/3.md']));
  }, 30_000);

  test('REPLACE semantics: re-recording a smaller set drops stale keys (stays an array)', async () => {
    const engine = getEngine();
    const ok = await recordCompleted(engine, key, ['only/1.md']);
    expect(ok).toBe(true);

    const got = await loadOpCheckpoint(engine, key);
    expect(new Set(got)).toEqual(new Set(['only/1.md']));

    const sql = getConn();
    const [row] = await sql`
      SELECT jsonb_typeof(completed_keys) AS t
      FROM op_checkpoints
      WHERE op = ${key.op} AND fingerprint = ${key.fingerprint}
    `;
    expect(row.t).toBe('array');
  }, 30_000);
});
