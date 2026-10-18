/**
 * Protects: SQL failures must not masquerade as old extraction schemas.
 * A real invalid integer in halt_reasons must warn without losing its row;
 * genuine missing columns retain unknown historical halts. Runs on PGLite
 * and in the PostgreSQL E2E wrapper with isolated tables/schema.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { computeExtractHealthCheck } from '../src/commands/doctor/checks/extraction-sync.ts';
import { readRecordedHaltReasons7d, upsertExtractRollup } from '../src/core/extract/rollup-writer.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) if (engine.kind === 'pglite') await engine.disconnect();
  await closePostgres?.();
});

test('corrupt numeric reasons containing schema-like text warn and preserve the evidence', async () => {
  for (const engine of engines) {
    await engine.executeRaw(`INSERT INTO extract_rollup_7d
      (kind, source_id, day, halt_count, halt_reasons)
      VALUES ('schema-error', 'default', CURRENT_DATE, 3,
        jsonb_build_object('item_error', 'no such table halt_reasons'))`);
    try {
      await expect(readRecordedHaltReasons7d(engine)).rejects.toMatchObject({ code: '22P02' });
      const check = await computeExtractHealthCheck(engine);
      expect(check.status).toBe('warn');
      expect(check.message).toContain('invalid input syntax');
      expect(check.message).not.toContain('not yet present');
      const [row] = await engine.executeRaw<{ halt_count: number; reason: string }>(
        `SELECT halt_count, halt_reasons->>'item_error' AS reason
         FROM extract_rollup_7d WHERE kind = 'schema-error'`);
      expect(row).toEqual({ halt_count: 3, reason: 'no such table halt_reasons' });
    } finally {
      await engine.executeRaw("DELETE FROM extract_rollup_7d WHERE kind = 'schema-error'");
    }
  }
}, 120_000);

test('genuine old schemas retain unknown halts, cap fallback and absent-table compatibility', async () => {
  for (const engine of engines) {
    await engine.executeRaw(`INSERT INTO extract_rollup_7d
      (kind, source_id, day, halt_count, round_completed_count)
      VALUES ('old-schema', 'default', CURRENT_DATE, 3, 1)`);
    await engine.executeRaw('ALTER TABLE extract_rollup_7d DROP COLUMN halt_reasons');
    try {
      const check = await computeExtractHealthCheck(engine);
      expect(check.status).toBe('warn');
      expect((check.details as { kinds: unknown[] }).kinds).toEqual([
        expect.objectContaining({ kind: 'old-schema', halt_count: 3, halt_reasons: { unknown: 3 }, halt_rate: 0.75 }),
      ]);
      await engine.executeRaw('ALTER TABLE extract_rollup_7d DROP COLUMN expected_limit_count');
      try {
        expect(await upsertExtractRollup(engine, { kind: 'old-schema', source_id: 'default', expected_limit_delta: 1 })).toEqual({ ok: true });
        const old = await computeExtractHealthCheck(engine);
        expect(old.status).toBe('warn');
        expect((old.details as { kinds: unknown[] }).kinds).toEqual([
          expect.objectContaining({ halt_count: 4, halt_reasons: { unknown: 4 }, expected_limit_count: 0 }),
        ]);
      } finally {
        await engine.executeRaw('ALTER TABLE extract_rollup_7d ADD COLUMN expected_limit_count INTEGER NOT NULL DEFAULT 0');
      }
    } finally {
      await engine.executeRaw("ALTER TABLE extract_rollup_7d ADD COLUMN halt_reasons JSONB NOT NULL DEFAULT '{}'::jsonb");
      await engine.executeRaw("DELETE FROM extract_rollup_7d WHERE kind = 'old-schema'");
    }
    await engine.executeRaw('ALTER TABLE extract_rollup_7d RENAME TO held_rollup');
    try {
      const check = await computeExtractHealthCheck(engine);
      expect(check.status).toBe('ok');
      expect(check.message).toContain('not yet present');
    } finally {
      await engine.executeRaw('ALTER TABLE held_rollup RENAME TO extract_rollup_7d');
    }
  }
}, 120_000);
