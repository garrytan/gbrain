/**
 * E2E for migration v47: facts.notability ALTER (B2 ship-blocker fix).
 *
 * Pins the idempotency contract under all four states:
 *   1. Fresh install (column already added by v45 inline) → v47 no-ops cleanly.
 *   2. Old brain (no column) → v47 adds column + CHECK constraint.
 *   3. Partial state (column exists, no CHECK) → v47 adds the named CHECK.
 *   4. Re-run after success → still no-op (the bisect contract: every
 *      migration must be re-runnable without harm).
 *
 * Real Postgres only — `CREATE EXTENSION vector` and the `facts` table
 * (with HALFVEC column on pgvector >= 0.7) are required. PGLite parity is
 * exercised by the unit-layer migration tests; this E2E focuses on the
 * Postgres-specific shape because that's where the original B2 bug bit
 * users.
 *
 * Gated by DATABASE_URL — skips when unset per CLAUDE.md lifecycle.
 *
 * Run: DATABASE_URL=... bun test test/e2e/migration-v47-notability.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import {
  hasDatabase,
  setupDB,
  teardownDB,
  getConn,
  getEngine,
  runMigrationsUpTo,
  setConfigVersion,
} from './helpers.ts';
import { MIGRATIONS, LATEST_VERSION } from '../../src/core/migrate.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping migration v47 E2E tests (DATABASE_URL not set)');
}

const v47 = MIGRATIONS.find(m => m.version === 47);
if (!skip && !v47) {
  throw new Error('Migration v47 not found in MIGRATIONS array. PR1 commit 2 should add it.');
}

/**
 * Drop notability column + named CHECK constraint to simulate an old brain
 * that ran v45 BEFORE notability was added to v45's inline DDL. Idempotent
 * via IF EXISTS clauses so we can call this between tests freely.
 */
async function simulateOldBrain(): Promise<void> {
  const conn = getConn();
  await conn.unsafe(`ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_notability_check`);
  // Drop any autogen CHECK that v45 inline might have added under a different name.
  // Postgres autogen CHECKs covering only `notability` are rare since v45's inline
  // was edited; in practice the named constraint is the one we care about.
  await conn.unsafe(`ALTER TABLE facts DROP COLUMN IF EXISTS notability`);
}

/**
 * Drop only the CHECK constraint, leaving the column. Simulates the
 * partial-state where ADD COLUMN succeeded but ADD CONSTRAINT didn't.
 */
async function simulatePartialState(): Promise<void> {
  const conn = getConn();
  await conn.unsafe(`ALTER TABLE facts DROP CONSTRAINT IF EXISTS facts_notability_check`);
  // Add the column back (without CHECK) if it was dropped.
  await conn.unsafe(`ALTER TABLE facts ADD COLUMN IF NOT EXISTS notability TEXT NOT NULL DEFAULT 'medium'`);
}

async function runV47(): Promise<void> {
  const engine = getEngine();
  const m = MIGRATIONS.find(x => x.version === 47);
  if (!m) throw new Error('Migration v47 not found');
  const sql = m.sqlFor?.[engine.kind] ?? m.sql;
  if (sql) {
    await engine.transaction(async (tx) => {
      await tx.runMigration(47, sql);
    });
  }
  if (m.handler) await m.handler(engine);
  await engine.setConfig('version', '47');
}

async function readNotabilityColumnState(): Promise<{
  exists: boolean;
  notNull: boolean;
  defaultExpr: string | null;
}> {
  const conn = getConn();
  const rows = await conn<Array<{ is_nullable: string; column_default: string | null }>>`
    SELECT is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'facts'
      AND column_name = 'notability'
  `;
  if (rows.length === 0) return { exists: false, notNull: false, defaultExpr: null };
  return {
    exists: true,
    notNull: rows[0].is_nullable === 'NO',
    defaultExpr: rows[0].column_default,
  };
}

async function readNamedCheckExists(): Promise<boolean> {
  const conn = getConn();
  const rows = await conn`
    SELECT 1 FROM pg_constraint
    WHERE conname = 'facts_notability_check'
      AND conrelid = 'facts'::regclass
  `;
  return rows.length === 1;
}

describeE2E('migration v47: facts.notability ALTER', () => {
  beforeAll(async () => {
    await setupDB();
    // setupDB() runs db.initSchema() (SCHEMA_SQL only, no migrations).
    // Advance to LATEST_VERSION so v45 lands and the facts table exists.
    await runMigrationsUpTo(getEngine(), LATEST_VERSION);
  }, 30_000);

  afterAll(async () => {
    await teardownDB();
  });

  test('after fresh install, notability column + named CHECK both exist', async () => {
    // Sanity: setupDB + runMigrationsUpTo(LATEST) lands v45 (which has
    // notability inline) + v47 (which is a no-op when column exists).
    const colState = await readNotabilityColumnState();
    expect(colState.exists).toBe(true);
    expect(colState.notNull).toBe(true);
    expect(colState.defaultExpr).toContain('medium');

    // The named CHECK MUST exist after v47 ran.
    const hasNamedCheck = await readNamedCheckExists();
    expect(hasNamedCheck).toBe(true);
  });

  test('old brain simulation: drop notability, run v47, column + CHECK reappear', async () => {
    await simulateOldBrain();
    // Verify the simulation worked.
    const before = await readNotabilityColumnState();
    expect(before.exists).toBe(false);

    // Roll the version back to 46 so v47 is "pending".
    await setConfigVersion(46);

    // Run v47.
    await runV47();

    // Column + CHECK both present.
    const after = await readNotabilityColumnState();
    expect(after.exists).toBe(true);
    expect(after.notNull).toBe(true);
    expect(after.defaultExpr).toContain('medium');

    const hasNamedCheck = await readNamedCheckExists();
    expect(hasNamedCheck).toBe(true);
  });

  test('partial state: column exists, named CHECK missing → v47 adds CHECK', async () => {
    await simulatePartialState();
    // Sanity: column present, named CHECK missing.
    const colState = await readNotabilityColumnState();
    expect(colState.exists).toBe(true);
    const checkBefore = await readNamedCheckExists();
    expect(checkBefore).toBe(false);

    // Re-run v47. It should ADD the CHECK without touching the column.
    await runV47();

    const checkAfter = await readNamedCheckExists();
    expect(checkAfter).toBe(true);
  });

  test('idempotent re-run on fully-migrated brain → no error, no state change', async () => {
    // Already fully migrated from the prior test. Run v47 again.
    const before = await readNotabilityColumnState();
    const checkBefore = await readNamedCheckExists();

    // Should not throw.
    await runV47();

    const after = await readNotabilityColumnState();
    const checkAfter = await readNamedCheckExists();
    expect(after).toEqual(before);
    expect(checkAfter).toBe(checkBefore);
    expect(checkAfter).toBe(true);
  });

  test('CHECK constraint actually rejects out-of-domain values', async () => {
    const conn = getConn();
    // Insert with valid notability — must succeed.
    await conn.unsafe(`
      INSERT INTO facts (source_id, fact, kind, source, notability)
      VALUES ('default', '__v46_check_test_valid__', 'fact', 'test', 'high')
    `);

    // Insert with invalid notability — must fail with CHECK violation.
    let threw = false;
    try {
      await conn.unsafe(`
        INSERT INTO facts (source_id, fact, kind, source, notability)
        VALUES ('default', '__v46_check_test_invalid__', 'fact', 'test', 'critical')
      `);
    } catch (e) {
      threw = true;
      expect(String(e)).toMatch(/check|constraint|violat/i);
    }
    expect(threw).toBe(true);

    // Cleanup.
    await conn.unsafe(`DELETE FROM facts WHERE fact LIKE '__v46_check_test%'`);
  });
});
