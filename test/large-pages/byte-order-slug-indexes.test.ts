/**
 * The per-source slug walks compare and order `slug COLLATE "C"`. The only slug indexes on pages and persistence_requests
 * use the database's default collation, so v338 adds idx_pages_source_slug_c and persistence_requests_source_slug_c on
 * (source_id, slug COLLATE "C"), and the drift-conflict audit groups by the same "C" expression so the second index can
 * feed its grouping.
 *
 * 1. Protects: initSchema leaves both indexes valid; the migration handler is a no-op on them and rebuilds a dropped
 *    one; `gbrain repair request-indexes` rebuilds the request-table index; on Postgres an INVALID leftover is dropped
 *    and rebuilt CONCURRENTLY outside a transaction. On Postgres the listPages slug keyset and the drift-conflict page
 *    (the SQL those functions really send, captured at the executor) read through the indexes over seeded, analyzed rows.
 * 2. Fails when: an index is missing or not in "C" (the control drops each and sees a Sort over the source), the audit
 *    groups by the default collation again (its GroupAggregate then cannot take the index order), or either query stops
 *    comparing slug in "C".
 * 3. Existing coverage: the parity suites pin the byte ORDER of these listings, not the plan; nothing else checks these
 *    two indexes. 4. No production seam: the SQL is captured by wrapping the executor the functions already take.
 * Runs on PGLite, and on Postgres when DATABASE_URL is set (test/postgres-unit-arms.txt). CI Postgres sorts text in
 * en_US.utf8; the default collation and "C" are different collations to the planner either way.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import type { ScopedRead } from '../../src/core/engine-sql/brands.ts';
import type { SqlFragment } from '../../src/core/engine-sql/fragment.ts';
import { renderFragment } from '../../src/core/engine-sql/fragment.ts';
import { listPages } from '../../src/core/engine-sql/pages.ts';
import { listDriftConflictGroups } from '../../src/core/engine-sql/repair-plan-scans.ts';
import { readRequestIndexStates } from '../../src/core/persistence/checkpoint-validation.ts';
import { PERSISTENCE_REQUEST_ONLINE_INDEXES, PERSISTENCE_REQUEST_SLUG_BYTE_ORDER_INDEX, POSTGRES_CONCURRENT_PERSISTENCE_INDEXES } from '../../src/core/persistence/schema.ts';
import { PGLITE_SCHEMA_SQL } from '../../src/core/pglite-schema.generated.ts';
import { SCHEMA_SQL } from '../../src/core/schema-embedded.generated.ts';
import { MIGRATIONS } from '../../src/core/schema-migrations/registry.generated.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { PAGES_SOURCE_SLUG_BYTE_ORDER_INDEX } from '../../src/core/schema-migrations/v338-byte-order-slug-indexes.ts';
import { runRepair, resolveRepairScope } from '../../src/core/repair/core.ts';
import { requestIndexesRepair } from '../../src/core/repair/request-indexes.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const PAGES = PAGES_SOURCE_SLUG_BYTE_ORDER_INDEX;
const REQUESTS = PERSISTENCE_REQUEST_SLUG_BYTE_ORDER_INDEX;
const migration = MIGRATIONS.find(m => m.name === 'byte_order_slug_indexes');

describe('v338 byte-order slug indexes: the migration module', () => {
  test('is registered once, in the online-index shape, and is DDL only', () => {
    expect(MIGRATIONS.filter(m => m.name === 'byte_order_slug_indexes')).toHaveLength(1);
    expect(migration).toMatchObject({ idempotent: true, transaction: false, sql: '' });
    expect(migration!.version).toBeLessThanOrEqual(LATEST_SCHEMA_VERSION);
    expect(typeof migration!.handler).toBe('function');
    expect(PAGES.sql).toBe('CREATE INDEX IF NOT EXISTS idx_pages_source_slug_c ON pages (source_id, slug COLLATE "C")');
    expect(REQUESTS.sql).toMatch(/^CREATE INDEX IF NOT EXISTS persistence_requests_source_slug_c\s+ON persistence_requests\(source_id,slug COLLATE "C"\)$/);
  });
  test('the Postgres blob omits both indexes; the PGLite blob carries only the request-table index', () => {
    expect(SCHEMA_SQL).not.toContain(PAGES.name);
    expect(SCHEMA_SQL).not.toContain(REQUESTS.name);
    expect(PGLITE_SCHEMA_SQL).toContain(REQUESTS.name);
    expect(PGLITE_SCHEMA_SQL).not.toContain(PAGES.name);
    expect(POSTGRES_CONCURRENT_PERSISTENCE_INDEXES.has(REQUESTS.sql)).toBe(true);
    expect(PERSISTENCE_REQUEST_ONLINE_INDEXES.map(index => index.name)).toContain(REQUESTS.name);
  });
});

for (const backend of testBackends()) describe(`[${backend}] v338 byte-order slug indexes on a brain`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  const ctx = () => ({ engine, config: { engine: backend }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
  const states = async () => (await readRequestIndexStates(engine, [PAGES, REQUESTS])).map(row => row.state);

  /** The statement listPages sends for a per-source slug keyset page, captured at the executor it takes. */
  const listPagesSql = async () => {
    let captured: SqlFragment | undefined;
    const exec = { run: async (fragment: SqlFragment) => { captured = fragment; return { rows: [], affectedRows: 0 }; } } as unknown as ScopedRead;
    await listPages(exec, { sourceId: 'default', sort: 'slug', slugAfter: 'notes/p5', limit: 50 });
    return renderFragment(captured!);
  };
  /** The drift-conflict page statement auditDriftConflicts sends (the typed read listDriftConflictGroups), captured at the executor it takes. */
  const driftPageSql = async () => {
    let captured: { text: string; params: unknown[] } | undefined;
    const exec = { executeRaw: async (sql: string, params?: unknown[]) => {
      if (!sql.includes('GROUP BY')) return [{ slugs: 0, receipts: 0 }];
      captured = { text: sql, params: params ?? [] };
      return [];
    } } as never;
    // The window auditDriftConflicts reads: this source's own requests, up to its newest (readDriftConflictBounds).
    const bounds = await engine.readDriftConflictBounds('default');
    const top = BigInt(bounds?.top ?? '0');
    await listDriftConflictGroups(exec, 'default', {
      incarnation: bounds?.incarnation ?? '00000000-0000-4000-8000-000000000000', floor: String(top - 100000n), through: String(top),
      requireLivePage: false, excludePrivate: false, after: '', limit: 100, driftMessage: 'The canonical file contains an uncoordinated local edit.',
    });
    return captured!;
  };

  beforeAll(async () => {
    if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); }, 60_000);

  test('initSchema builds both indexes valid, on (source_id, slug COLLATE "C"); the handler is a no-op on them', async () => {
    const rows = await engine.executeRaw<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1::text[]) ORDER BY indexname COLLATE "C"`, [[PAGES.name, REQUESTS.name]]);
    expect(rows.map(row => row.indexname)).toEqual([PAGES.name, REQUESTS.name]);
    for (const row of rows) expect(row.indexdef).toContain('(source_id, slug COLLATE "C")');
    expect(await states()).toEqual(['valid', 'valid']);
    await migration!.handler!(engine);
    await migration!.handler!(engine);
    expect(await states()).toEqual(['valid', 'valid']);
  });

  test('the slug walks compare and order slug in "C": the listPages keyset and the drift-conflict grouping', async () => {
    const pages = await listPagesSql();
    expect(pages.text).toContain('AND p.slug COLLATE "C" > $');
    expect(pages.text).toMatch(/ORDER BY p\.slug COLLATE "C" ASC, p\.source_id COLLATE "C" ASC, p\.id ASC/);
    const drift = await driftPageSql();
    expect(drift.text).toContain('SELECT r.slug COLLATE "C" AS slug,');
    expect(drift.text).toMatch(/r\.slug COLLATE "C" > \$\d+\s+GROUP BY r\.slug COLLATE "C" ORDER BY r\.slug COLLATE "C" LIMIT/);
  });

  test('a dropped index is rebuilt by the handler; gbrain repair request-indexes rebuilds the request-table index', async () => {
    await engine.executeRaw(`DROP INDEX ${PAGES.name}`);
    await engine.executeRaw(`DROP INDEX ${REQUESTS.name}`);
    expect(await states()).toEqual(['missing', 'missing']);
    await migration!.handler!(engine);
    expect(await states()).toEqual(['valid', 'valid']);
    await engine.executeRaw(`DROP INDEX ${REQUESTS.name}`);
    const scope = await resolveRepairScope(engine);
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: false })).toMatchObject({ affected: 1, apply_command: 'gbrain repair request-indexes --apply' });
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 1, complete: true });
    expect(await states()).toEqual(['valid', 'valid']);
  }, 60_000);

  if (backend !== 'postgres') return;

  const plan = async ({ text, params }: { text: string; params: unknown[] }) =>
    (await engine.executeRaw<{ 'QUERY PLAN': string }>(`EXPLAIN ${text}`, params)).map(row => row['QUERY PLAN']).join('\n');
  // A full sort of the source's rows (not an incremental sort over an index order) on the "C" slug key.
  const FULL_SLUG_SORT = /^\s*(->\s+)?Sort\s+\(.*\n\s+Sort Key: \(*((p|r)\.)?slug(\)::text\))? COLLATE "C"/m;

  test('over seeded, analyzed rows both walks read through the indexes; the control without them sorts', async () => {
    await engine.executeRaw(`INSERT INTO pages(source_id,slug,title,type,page_kind,compiled_truth,timeline,frontmatter)
      SELECT 'default','notes/p'||g,'t','note','markdown','b','','{}'::jsonb FROM generate_series(1,5000) g`);
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,intent_bytes,terminal_reservation,state,error_code,error_message)
      SELECT 'local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'notes/p'||(g%2000),md5(g::text),
        '{"kind":"put_page"}'::jsonb,'{}'::jsonb,1,64,'conflict','source_changed','drift' FROM generate_series(1,20000) g`);
    await engine.executeRaw('ANALYZE pages');
    await engine.executeRaw('ANALYZE persistence_requests');
    const pagesSql = await listPagesSql();
    const driftSql = await driftPageSql();
    const withIndexes = { pages: await plan(pagesSql), drift: await plan(driftSql) };
    expect(withIndexes.pages).toContain(`Index Scan using ${PAGES.name} on pages`);
    expect(withIndexes.pages).not.toMatch(FULL_SLUG_SORT);
    expect(withIndexes.drift).toContain(`Index Scan using ${REQUESTS.name} on persistence_requests`);
    expect(withIndexes.drift).not.toMatch(FULL_SLUG_SORT);

    await engine.executeRaw(`DROP INDEX ${PAGES.name}`);
    await engine.executeRaw(`DROP INDEX ${REQUESTS.name}`);
    const bare = { pages: await plan(pagesSql), drift: await plan(driftSql) };
    expect(bare.pages).not.toContain(PAGES.name);
    expect(bare.pages).toMatch(FULL_SLUG_SORT);
    expect(bare.drift).not.toContain(REQUESTS.name);
    expect(bare.drift).toMatch(FULL_SLUG_SORT);

    await migration!.handler!(engine);
    expect(await plan(pagesSql)).toContain(`Index Scan using ${PAGES.name} on pages`);
    expect(await plan(driftSql)).toContain(`Index Scan using ${REQUESTS.name} on persistence_requests`);
  }, 120_000);

  test('an INVALID leftover is dropped and rebuilt CONCURRENTLY outside a transaction, setting nothing on the session', async () => {
    const pg = engine as PostgresEngine;
    for (const index of [PAGES, REQUESTS]) await pg.executeRaw(`UPDATE pg_index SET indisvalid=false WHERE indexrelid='${index.name}'::regclass`);
    expect(await states()).toEqual(['invalid', 'invalid']);
    const statements: string[] = [];
    const reserve = pg.withReservedConnection.bind(pg);
    pg.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(conn => fn({
      executeRaw: async (sql: string, params?: unknown[]) => { statements.push(sql); return conn.executeRaw(sql, params); },
    }))) as PostgresEngine['withReservedConnection'];
    try { await migration!.handler!(pg); } finally { pg.withReservedConnection = reserve; }
    expect(statements.filter(sql => sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')).map(sql => sql.split(/\s+/)[6])).toEqual([PAGES.name, REQUESTS.name]);
    expect(statements.filter(sql => /^(SET|RESET|BEGIN)\b/i.test(sql))).toEqual([]);
    expect(await states()).toEqual(['valid', 'valid']);
  }, 60_000);
});
