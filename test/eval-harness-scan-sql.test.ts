/**
 * The SQL engines' scanTextColumns against a real catalog (src/core/engine-sql/eval-harness-reads.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the scan reads the tables it found in the catalog of the current schema, by schema-qualified name; it
 *    treats a page_id column as a page link only when it is an integer; and it refuses, naming the tables, when the
 *    running role cannot read every row of a scanned table (no SELECT, or row-level security applies to it).
 *  - Regression: the scan used unqualified names (a temporary table of the same name was read instead), joined every
 *    page_id to pages.id (a uuid page_id aborted the whole scan with 42883), and a role that row security filtered got
 *    an empty answer, which reads as "the text is gone".
 *  - Why existing coverage misses it: the engine parity file runs only gbrain's own tables as their owner, and the
 *    byte-for-byte pins answer the catalog with a recorder.
 *  - Seam: none. Real PGLite and, with DATABASE_URL, real Postgres; the row security case needs a real role.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine, NewFact } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const ROLLBACK = 'eval-harness-scan rollback';

const rolledBack = async (engine: BrainEngine, fn: (tx: BrainEngine) => Promise<void>) => {
  try {
    await engine.transaction(async tx => { await fn(tx); throw new Error(ROLLBACK); });
  } catch (error) {
    if ((error as Error).message !== ROLLBACK) throw error;
  }
};

/** The facts hits of a scan for `token`, as [table, value]. */
const factHits = async (engine: BrainEngine, token: string) =>
  (await engine.scanTextColumns({ pattern: token, activeOnly: false, tables: ['facts', 'eval_scan_links'] })).map(h => [h.table, h.value]);

function catalogCases(open: () => BrainEngine) {
  test('a temporary table named like a scanned table does not hide the stored rows', async () => {
    const engine = open();
    await engine.insertFact({ fact: 'shadowedtoken is stored', entity_slug: null, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: 'default' });
    await rolledBack(engine, async tx => {
      await tx.executeRaw('CREATE TEMPORARY TABLE facts (id bigint, fact text) ON COMMIT DROP');
      expect(await factHits(tx, 'shadowedtoken')).toEqual([['facts', 'shadowedtoken is stored']]);
    });
  }, 60_000);

  test('a table whose page_id is not an integer is scanned without a page join', async () => {
    const engine = open();
    await rolledBack(engine, async tx => {
      await tx.executeRaw('CREATE TABLE eval_scan_links (page_id uuid, note text)');
      await tx.executeRaw(`INSERT INTO eval_scan_links VALUES ('${randomUUID()}', 'uuidpagetoken here')`);
      const hits = await tx.scanTextColumns({ pattern: 'uuidpagetoken', activeOnly: true, tables: ['eval_scan_links'] });
      expect(hits.map(h => [h.table, h.column, h.page_id, h.value])).toEqual([['eval_scan_links', 'note', null, 'uuidpagetoken here']]);
    });
  }, 60_000);
}

describe.if(backends.includes('pglite'))('scanTextColumns on PGLite', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine?.disconnect(); });
  catalogCases(() => engine);
});

describe.if(backends.includes('postgres'))('scanTextColumns on Postgres', () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const reader = `gbrain_eval_scan_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  beforeAll(async () => {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; close = pg.close;
    await engine.executeRaw(`CREATE ROLE ${reader} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  }, 180_000);
  afterAll(async () => {
    await engine?.executeRaw(`DROP OWNED BY ${reader}`).catch(() => undefined);
    await engine?.executeRaw(`DROP ROLE IF EXISTS ${reader}`);
    await close?.();
  });
  catalogCases(() => engine);

  test('a role that row security filters is refused, naming the table, instead of answering no hits', async () => {
    await engine.insertFact({ fact: 'hiddentoken is stored', entity_slug: null, visibility: 'world', source: 'test', embedding: null } as NewFact, { source_id: 'default' });
    await rolledBack(engine, async tx => {
      const [{ schema }] = await tx.executeRaw<{ schema: string }>('SELECT current_schema()::text AS schema');
      await tx.executeRaw(`GRANT USAGE ON SCHEMA "${schema}" TO ${reader}`);
      await tx.executeRaw(`GRANT SELECT ON facts, pages TO ${reader}`);
      await tx.executeRaw('ALTER TABLE facts ENABLE ROW LEVEL SECURITY');
      await tx.executeRaw(`SET LOCAL ROLE ${reader}`);
      const refused = await tx.scanTextColumns({ pattern: 'hiddentoken', activeOnly: false, tables: ['facts'] }).then(() => 'ok', (e: Error) => e.message);
      // gbrain turns row security on for pages itself; the scan reads pages for the slug join, so it is named too.
      expect(refused).toBe('scanTextColumns: the running role cannot read every row of facts, pages; run the scan as the table owner or a BYPASSRLS role');
    });
    expect(await factHits(engine, 'hiddentoken')).toEqual([['facts', 'hiddentoken is stored']]);
  }, 120_000);
});
