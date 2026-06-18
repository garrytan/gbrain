/**
 * Postgres regression for op_checkpoints.completed_keys shape.
 *
 * The broken path bound JSON.stringify(sorted) into `$3::jsonb` through
 * postgres.js unsafe/direct execution. Real Postgres stored that as a JSONB
 * string scalar; PGLite did not reproduce it.
 *
 * Run: DATABASE_URL=... bun test test/e2e/op-checkpoint-jsonb-postgres.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { recordCompleted, loadOpCheckpoint } from '../../src/core/op-checkpoint.ts';
import {
  hasDatabase, setupDB, teardownDB, getEngine, getConn,
} from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping op-checkpoint JSONB Postgres E2E (DATABASE_URL not set)');
}

describeE2E('op_checkpoints.completed_keys JSONB on Postgres', () => {
  beforeAll(async () => { await setupDB(); });
  afterAll(async () => { await teardownDB(); });

  test('recordCompleted stores a real JSONB array, not a string scalar', async () => {
    const engine = getEngine();
    const conn = getConn();
    const key = { op: 'embed', fingerprint: 'pg-jsonb-array' };

    await expect(recordCompleted(engine, key, ['chunk-b', 'chunk-a'])).resolves.toBe(true);

    const rows = await conn.unsafe(
      `SELECT jsonb_typeof(completed_keys) AS kind,
              completed_keys->>0 AS first,
              jsonb_array_length(completed_keys) AS len
       FROM op_checkpoints
       WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('array');
    expect(rows[0].first).toBe('chunk-a');
    expect(rows[0].len).toBe(2);
    await expect(loadOpCheckpoint(engine, key)).resolves.toEqual(['chunk-a', 'chunk-b']);
  }, 30_000);
});
