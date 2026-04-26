/**
 * test/regression-init-schema-forward-refs.test.ts
 *
 * Regression guard for the schema.sql / runMigrations ordering bug.
 *
 * BACKGROUND
 * ──────────
 * `engine.initSchema()` historically ran SCHEMA_SQL first and runMigrations
 * second. That works on a fresh install (SCHEMA_SQL bootstraps everything at
 * v(LATEST) shape), but breaks every upgrade that crosses a release where
 * SCHEMA_SQL added a new CREATE INDEX referencing a column added by a
 * pending migration.
 *
 * Examples that bit users in the wild:
 *   - v0.18.x: SCHEMA_SQL added
 *       CREATE INDEX idx_pages_source_id ON pages(source_id);
 *     while pages.source_id was first added by migration v21. Pre-v21
 *     brains aborted initSchema with "column 'source_id' does not exist"
 *     before runMigrations got a chance to add it.
 *   - v0.21.x: SCHEMA_SQL added
 *       CREATE INDEX idx_chunks_symbol_name
 *         ON content_chunks(symbol_name) WHERE symbol_name IS NOT NULL;
 *     while content_chunks.symbol_name was first added by migration v26.
 *     Pre-v26 brains aborted with "column 'symbol_name' does not exist".
 *
 * The fix swaps the order on existing brains: runMigrations FIRST (brings
 * schema to v(LATEST) shape), SCHEMA_SQL second (idempotent confirmation
 * pass via CREATE * IF NOT EXISTS).
 *
 * THIS TEST
 * ─────────
 * Reconstructs the v0.21.x failure shape against PGLite. Drops the
 * symbol_name column + its partial index after a clean LATEST bootstrap,
 * rolls config.version backwards to 25, and re-runs initSchema. With
 * the fix, runMigrations re-adds the column before SCHEMA_SQL's
 * forward-referencing CREATE INDEX hits it. Without the fix, initSchema
 * aborts on "column does not exist".
 */

import { describe, expect, it } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';

describe('regression: initSchema forward-reference ordering', () => {
  it('upgrade path — pre-v26 brain re-runs migrations before schema.sql snapshot', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({}); // in-memory
    await engine.initSchema(); // baseline → v(LATEST)

    // Roll back to a pre-v26 shape: drop the partial index then the column.
    // ALTER TABLE DROP COLUMN would CASCADE the index automatically, but
    // dropping it explicitly mirrors what an actual pre-v26 install looks
    // like (the index didn't exist there either).
    await engine.executeRaw(`DROP INDEX IF EXISTS idx_chunks_symbol_name`);
    await engine.executeRaw(
      `ALTER TABLE content_chunks DROP COLUMN IF EXISTS symbol_name`,
    );
    await engine.setConfig('version', '25');

    // Before the fix, this throws `column "symbol_name" does not exist`
    // at the SCHEMA_SQL step and never reaches runMigrations. After the
    // fix, runMigrations runs first, re-adds the column via v26, and
    // SCHEMA_SQL succeeds as an idempotent confirmation pass.
    await expect(engine.initSchema()).resolves.toBeUndefined();

    // The column is back.
    const cols = (await engine.executeRaw<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='content_chunks' AND column_name='symbol_name'`,
    )) as Array<{ column_name: string }>;
    expect(cols.length).toBe(1);

    // Version advanced to LATEST.
    const ver = await engine.getConfig('version');
    expect(ver).toBe(String(LATEST_VERSION));
  });

  it('fresh-install path — initSchema bootstraps a brand-new brain to LATEST', async () => {
    // Fresh PGLiteEngine: config table doesn't exist yet → fresh-install
    // branch fires. SCHEMA_SQL creates everything at v(LATEST) shape, then
    // runMigrations records version + handler side effects.
    const engine = new PGLiteEngine();
    await engine.connect({});
    await expect(engine.initSchema()).resolves.toBeUndefined();

    const ver = await engine.getConfig('version');
    expect(ver).toBe(String(LATEST_VERSION));
  });

  it('idempotency — re-running initSchema on a current brain is a no-op', async () => {
    const engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    const verAfterFirst = await engine.getConfig('version');

    // Second call: existing-brain branch, no pending migrations,
    // SCHEMA_SQL is the idempotent confirmation pass.
    await expect(engine.initSchema()).resolves.toBeUndefined();
    const verAfterSecond = await engine.getConfig('version');

    expect(verAfterSecond).toBe(verAfterFirst);
    expect(verAfterSecond).toBe(String(LATEST_VERSION));
  });
});
