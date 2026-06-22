/**
 * Regression: op_checkpoints.completed_keys must be a JSONB ARRAY on Postgres.
 *
 * recordCompleted() binds `JSON.stringify(sorted)` as a positional parameter to
 * a `$N::jsonb` cast. On postgres.js (`^3.4.0`) the server describes that
 * parameter via the cast as json/jsonb, and postgres.js then serializes the
 * bind value with its JSON serializer (JSON.stringify) — so a pre-stringified
 * JSON array `["abc"]` is double-encoded into a JSONB STRING scalar
 * `"[\"abc\"]"`. jsonb_typeof then returns 'string', which violates migration
 * v119's `CHECK (jsonb_typeof(completed_keys) = 'array')` and hard-fails every
 * sync-target pin write — the sync aborts with "checkpoint target write failed
 * (pool unavailable)" and imports 0 files.
 *
 * The fix casts `$N::text::jsonb` so the param is sent as text and Postgres
 * parses the JSON text into a real array. This bug is Postgres-only: PGLite
 * does not double-encode, so the PGLite coverage in test/op-checkpoint.test.ts
 * cannot catch it — hence this dedicated e2e file.
 *
 * Skipped when DATABASE_URL is unset — mirrors every other test/e2e/ file.
 * Bring up gbrain-test-pg via the canonical lifecycle described in CLAUDE.md.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupDB, teardownDB, hasDatabase } from './helpers.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { recordCompleted, loadOpCheckpoint } from '../../src/core/op-checkpoint.ts';

const skip = !hasDatabase();
const describeIfDB = skip ? describe.skip : describe;

if (skip) {
  // eslint-disable-next-line no-console
  console.log('Skipping op-checkpoint-jsonb-postgres E2E (DATABASE_URL not set)');
}

let engine: PostgresEngine;

beforeAll(async () => {
  if (skip) return;
  engine = await setupDB();
}, 30_000);

afterAll(async () => {
  if (skip) return;
  await teardownDB();
});

beforeEach(async () => {
  if (skip) return;
  await engine.executeRaw(`DELETE FROM op_checkpoint_paths`);
  await engine.executeRaw(`DELETE FROM op_checkpoints`);
});

describeIfDB('op_checkpoints JSONB array write on Postgres (postgres.js $N::jsonb double-encode)', () => {
  test('recordCompleted stores completed_keys as a JSONB array, not a string scalar', async () => {
    // A single commit-sha key — exactly the shape sync.ts persists for the pin
    // via `recordCompleted(engine, ckpt.target, [pin])`.
    const key = { op: 'sync-target', fingerprint: 'jsonb-typeof' };

    // With the bug (`$N::jsonb`) this write fails the v119 array CHECK and
    // durableWrite returns false; with the fix (`$N::text::jsonb`) it lands.
    const ok = await recordCompleted(engine, key, ['00edc69af71ac1621d28020ee61c84cc82520788']);
    expect(ok).toBe(true);

    const rows = await engine.executeRaw<{ t: string | null }>(
      `SELECT jsonb_typeof(completed_keys) AS t
         FROM op_checkpoints WHERE op = $1 AND fingerprint = $2`,
      [key.op, key.fingerprint],
    );
    // Bare `$N::jsonb` double-encodes to a JSONB string scalar → 'string'.
    expect(rows[0]?.t).toBe('array');
  });

  test('recordCompleted satisfies the v119 array CHECK and round-trips through loadOpCheckpoint', async () => {
    const key = { op: 'sync-target', fingerprint: 'roundtrip' };

    const ok = await recordCompleted(engine, key, ['b', 'a']);
    expect(ok).toBe(true);

    const loaded = await loadOpCheckpoint(engine, key);
    expect([...loaded].sort()).toEqual(['a', 'b']);
  });
});
