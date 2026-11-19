/**
 * #7145: managed_guard_schema_drift names every column foresights did not create as table.column, classifies what
 * each does to foresights (blocks_inserts: NOT NULL with no default; guard_source_column: a page-child source_id;
 * harmless: nullable or defaulted and never read or written) and grades on the worst class: fail, warn, or ok
 * as information. PGLite in-memory, and an isolated Postgres database when DATABASE_URL is set
 * (test/postgres-unit-arms.txt).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { checkManagedGuardSchemaDrift } from '../src/commands/doctor/checks/managed-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) describe(`managed_guard_schema_drift classifies extra columns (${kind})`, () => {
  let engine: BrainEngine;
  let close: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  async function withColumns(ddl: string[], drop: string[], body: () => Promise<void>): Promise<void> {
    for (const sql of ddl) await engine.executeRaw(sql);
    try { await body(); } finally { for (const sql of drop) await engine.executeRaw(sql); }
  }

  test('only nullable or defaulted extra columns: named, harmless, ok as information', async () => {
    await withColumns(['ALTER TABLE facts ADD COLUMN external_note text', "ALTER TABLE pages ADD COLUMN external_score integer NOT NULL DEFAULT 0"],
      ['ALTER TABLE facts DROP COLUMN external_note', 'ALTER TABLE pages DROP COLUMN external_score'], async () => {
        const check = await checkManagedGuardSchemaDrift(engine);
        expect(check).toMatchObject({ status: 'ok', severity: 'info' });
        expect(check.details?.columns).toEqual([
          expect.objectContaining({ column: 'facts.external_note', class: 'harmless' }),
          expect.objectContaining({ column: 'pages.external_score', class: 'harmless' }),
        ]);
        expect(check.message).toContain('facts.external_note (harmless)');
        expect(check.message).toContain('pages.external_score (harmless)');
      });
  });

  test('a NOT NULL column with no default blocks foresights inserts: fail, with the SQL next step', async () => {
    await withColumns(['ALTER TABLE tags ADD COLUMN external_owner text', "UPDATE tags SET external_owner = 'x'", 'ALTER TABLE tags ALTER COLUMN external_owner SET NOT NULL',
      'ALTER TABLE facts ADD COLUMN external_note text'],
    ['ALTER TABLE tags DROP COLUMN external_owner', 'ALTER TABLE facts DROP COLUMN external_note'], async () => {
      const check = await checkManagedGuardSchemaDrift(engine);
      expect(check.status).toBe('fail');
      expect(check.details?.columns).toEqual([
        expect.objectContaining({ column: 'facts.external_note', class: 'harmless' }),
        expect.objectContaining({ column: 'tags.external_owner', class: 'blocks_inserts' }),
      ]);
      expect(check.message).toContain('tags.external_owner (blocks_inserts)');
      expect(check.message).toContain('ALTER TABLE tags ALTER COLUMN external_owner DROP NOT NULL');
      expect(check.fix_unavailable_reason).toBe('operator_judgement');
    });
  });

  test('a page-child source_id is a guard_source_column: warn, naming the upgrade step', async () => {
    await withColumns(['ALTER TABLE takes ADD COLUMN source_id text'], ['ALTER TABLE takes DROP COLUMN source_id'], async () => {
      const check = await checkManagedGuardSchemaDrift(engine);
      expect(check.status).toBe('warn');
      expect(check.details).toMatchObject({ page_child_source_columns: ['takes.source_id'], columns: [expect.objectContaining({ column: 'takes.source_id', class: 'guard_source_column' })] });
      expect(check.message).toContain('upgrade or restart');
    });
  });
});
