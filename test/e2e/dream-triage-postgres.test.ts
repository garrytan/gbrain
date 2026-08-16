/**
 * #4152 — Postgres-only checks for the triage-v1 dream_verdicts widening.
 *
 * DATABASE_URL-gated: self-skips without a real Postgres (same placement
 * pattern as test/e2e/op-checkpoint-jsonb-parity.test.ts — picked up by the
 * existing Postgres-service CI job; deliberately NOT a .serial.test.ts,
 * which would need its own workflow job and silently never run).
 *
 * Covers what PGLite structurally cannot:
 *   1. Migration-129 upgrade path: a brain whose dream_verdicts predates the
 *      six triage columns gains them from the idempotent ALTERs.
 *   2. jsonb_typeof on the postgres.js write path: segments/entities land as
 *      real jsonb ARRAYS, not double-encoded string scalars (#2339 class).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';
import { runMigrations } from '../../src/core/migrate.ts';

const describePg = hasDatabase() ? describe : describe.skip;

describePg('#4152 dream_verdicts triage-v1 — Postgres', () => {
  beforeAll(async () => {
    await setupDB();
  }, 90_000);

  afterAll(async () => {
    await teardownDB();
  }, 30_000);

  test('migration 129 upgrade path: pre-129 table shape gains the six columns idempotently', async () => {
    const engine = getEngine();
    // Simulate a pre-129 brain: drop the triage columns, then re-run
    // migrations. The idempotent ALTER ... IF NOT EXISTS set must restore
    // them without erroring on any other (already-applied) migration.
    await engine.executeRaw(`
      ALTER TABLE dream_verdicts
        DROP COLUMN IF EXISTS score,
        DROP COLUMN IF EXISTS content_type,
        DROP COLUMN IF EXISTS segments,
        DROP COLUMN IF EXISTS entities,
        DROP COLUMN IF EXISTS model,
        DROP COLUMN IF EXISTS triage_version
    `);
    await engine.setConfig('version', '128'); // force the v129 step to re-run
    await runMigrations(engine);
    const cols = await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'dream_verdicts'`,
    );
    const names = new Set(cols.map(c => c.column_name));
    for (const c of ['score', 'content_type', 'segments', 'entities', 'model', 'triage_version']) {
      expect(names.has(c)).toBe(true);
    }
  }, 60_000);

  test('jsonb_typeof: segments/entities are jsonb arrays on disk, never string scalars', async () => {
    const engine = getEngine();
    await engine.putDreamVerdict('/corpus/typeof.txt', 'typeof-hash-0001', {
      worth_processing: true,
      reasons: ['r1'],
      score: 0.7,
      content_type: 'idea',
      segments: [{ quote: 'verbatim', note: 'n' }],
      entities: ['acme-example'],
      model: 'anthropic:claude-haiku-4-5-20251001',
      triage_version: 1,
    });
    const rows = await engine.executeRaw<{ seg_t: string; ent_t: string; reasons_t: string }>(
      `SELECT jsonb_typeof(segments) AS seg_t, jsonb_typeof(entities) AS ent_t,
              jsonb_typeof(reasons) AS reasons_t
         FROM dream_verdicts
        WHERE file_path = '/corpus/typeof.txt' AND content_hash = 'typeof-hash-0001'`,
    );
    // 'string' here = the #2339 double-encode bug PGLite can't surface.
    expect(rows[0].seg_t).toBe('array');
    expect(rows[0].ent_t).toBe('array');
    expect(rows[0].reasons_t).toBe('array');
  }, 30_000);
});
