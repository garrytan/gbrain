/**
 * #6757 (wave 18): dream synthesis postprocessing joins each child's committed
 * put_page to its journal row by request id within the cycle's source
 * (`COMMITTED_OUTPUT_REQUESTS_SQL`). No index served that read (the unique key
 * leads with the principal) and the old text cast of the uuid column defeated
 * any index, so on a large request table it was a sequential scan that hit the
 * statement timeout after the paid children ran. The migration that builds
 * `persistence_requests_request_id` has the v179 online-index shape; the
 * Postgres blob omits the index, PGLite's carries it; `gbrain repair
 * request-indexes` rebuilds a dropped or INVALID one on a current schema.
 *
 * The migration is found by its name, never by its number: the number is
 * provisional until the merge slot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { readRequestIndexStates } from '../src/core/persistence/checkpoint-validation.ts';
import { PERSISTENCE_REQUEST_ID_INDEX, PERSISTENCE_REQUEST_ONLINE_INDEXES, POSTGRES_CONCURRENT_PERSISTENCE_INDEXES } from '../src/core/persistence/schema.ts';
import { COMMITTED_OUTPUT_REQUESTS_SQL } from '../src/core/cycle/synthesize-postprocess.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.generated.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.generated.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { runRepair, resolveRepairScope } from '../src/core/repair/core.ts';
import { requestIndexesRepair } from '../src/core/repair/request-indexes.ts';
import { requestIndexesCheck } from '../src/commands/doctor/checks/persistence-requests.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const INDEX = PERSISTENCE_REQUEST_ID_INDEX;
const migration = MIGRATIONS.find(m => m.name === 'persistence_request_id_index');

describe('#6757 the request-id index migration module', () => {
  test('is registered once in the v179 online-index shape', () => {
    expect(MIGRATIONS.filter(m => m.name === 'persistence_request_id_index')).toHaveLength(1);
    expect(migration).toMatchObject({ idempotent: true, transaction: false, sql: '' });
    expect(migration!.version).toBeGreaterThan(MIGRATIONS.find(m => m.name === 'persistence_request_slug_intent_index')!.version);
    expect(migration!.version).toBeLessThanOrEqual(LATEST_SCHEMA_VERSION);
    expect(typeof migration!.handler).toBe('function');
  });
  test('is DDL only and leads with the columns the committed-outputs read constrains', () => {
    expect(INDEX.sql).toMatch(/^CREATE INDEX IF NOT EXISTS persistence_requests_request_id\s+ON persistence_requests\(source_id,request_id\)$/);
    expect(INDEX.sql).not.toMatch(/ALTER TABLE|ADD COLUMN|UPDATE /i);
    expect(COMMITTED_OUTPUT_REQUESTS_SQL).toContain('p.request_id=ANY($1::uuid[])');
    expect(COMMITTED_OUTPUT_REQUESTS_SQL).not.toContain('::text');
  });
  test('the Postgres blob omits the index (the migration builds it CONCURRENTLY); the PGLite blob carries it; repair and doctor cover it', () => {
    expect(POSTGRES_CONCURRENT_PERSISTENCE_INDEXES.has(INDEX.sql)).toBe(true);
    expect(SCHEMA_SQL).not.toContain(INDEX.name);
    expect(PGLITE_SCHEMA_SQL).toContain(INDEX.name);
    expect(PERSISTENCE_REQUEST_ONLINE_INDEXES.map(index => index.name)).toContain(INDEX.name);
  });
});

for (const backend of testBackends()) describe(`[${backend}] #6757 the request-id index on a brain`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const ctx = () => ({ engine, config: { engine: backend }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
  const state = async () => (await readRequestIndexStates(engine, [INDEX]))[0]!.state;
  const incarnation = async () => (await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'"))[0]!.incarnation;
  const seed = (rows: number) => engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,intent_bytes,terminal_reservation,state,outcome)
    SELECT 'local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'seed-'||g,'d',jsonb_build_object('kind','put_page','n',g),'{}'::jsonb,1,64,'committed',jsonb_build_object('revision',gen_random_uuid()::text)
    FROM generate_series(1,$1::int) g`, [rows]);

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('a fresh brain has the index valid; the migration handler is a no-op on it', async () => {
    expect(await state()).toBe('valid');
    await migration!.handler!(engine);
    expect(await state()).toBe('valid');
  });

  test('the committed-outputs read returns the committed rows of the asked source only', async () => {
    await seed(20);
    const rows = await engine.executeRaw<{ request_id: string }>("SELECT request_id::text FROM persistence_requests WHERE principal_id='seed' ORDER BY sequence LIMIT 3");
    const ids = rows.map(r => r.request_id);
    const found = await engine.executeRaw<{ request: { request_id: string } }>(COMMITTED_OUTPUT_REQUESTS_SQL, [ids, 'default', await incarnation()]);
    expect(found.map(r => r.request.request_id).sort()).toEqual([...ids].sort());
    expect(await engine.executeRaw(COMMITTED_OUTPUT_REQUESTS_SQL, [ids, 'other-source', await incarnation()])).toEqual([]);
  });

  test('a populated brain upgrading from the previous schema version builds it in the migration', async () => {
    await seed(200);
    await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
    expect(await state()).toBe('missing');
    await engine.setConfig('version', String(migration!.version - 1));
    const result = await runMigrations(engine);
    expect(result.current).toBe(LATEST_SCHEMA_VERSION);
    expect(await state()).toBe('valid');
  }, 120_000);

  test('a dropped index is named by doctor and rebuilt by gbrain repair request-indexes; a second repair is a no-op', async () => {
    await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
    const check = await requestIndexesCheck(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(`${INDEX.name} is missing`);
    expect(check.message).toContain('gbrain repair request-indexes');
    const scope = await resolveRepairScope(engine);
    const preview = await runRepair(ctx(), requestIndexesRepair, scope, { apply: false });
    expect(preview).toMatchObject({ affected: 1, apply_command: 'gbrain repair request-indexes --apply' });
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 1, complete: true });
    expect(await state()).toBe('valid');
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ affected: 0, applied: 0, complete: true });
    expect(await requestIndexesCheck(engine)).toMatchObject({ status: 'ok', message: 'Request-table indexes are valid.' });
  }, 60_000);

  if (backend === 'postgres') {
    const explain = async (sql: string, ids: string[]) => JSON.stringify(await engine.executeRaw(`EXPLAIN (FORMAT JSON) ${sql}`, [ids, 'default', await incarnation()]));
    const masterSql = COMMITTED_OUTPUT_REQUESTS_SQL.replace('p.request_id=ANY($1::uuid[])', 'p.request_id::text=ANY($1::text[])');

    test('on a 50k-row request table the committed-outputs read is served by the index; the text-cast read it replaces seq-scans', async () => {
      await seed(50_000);
      await engine.executeRaw('ANALYZE persistence_requests');
      const ids = (await engine.executeRaw<{ request_id: string }>("SELECT request_id::text FROM persistence_requests WHERE principal_id='seed' ORDER BY sequence DESC LIMIT 4")).map(r => r.request_id);
      expect(await explain(COMMITTED_OUTPUT_REQUESTS_SQL, ids)).toContain(INDEX.name);
      expect(await explain(masterSql, ids)).toContain('Seq Scan');
      await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
      expect(await explain(COMMITTED_OUTPUT_REQUESTS_SQL, ids)).not.toContain(INDEX.name);
      await migration!.handler!(engine);
      expect(await explain(COMMITTED_OUTPUT_REQUESTS_SQL, ids)).toContain(INDEX.name);
    }, 180_000);

    test('an INVALID index (an interrupted concurrent build) is dropped and rebuilt CONCURRENTLY by repair', async () => {
      const pg = engine as PostgresEngine;
      await pg.executeRaw(`UPDATE pg_index SET indisvalid=false WHERE indexrelid='${INDEX.name}'::regclass`);
      expect(await state()).toBe('invalid');
      expect((await requestIndexesCheck(engine)).message).toContain(`${INDEX.name} is INVALID`);
      const statements: string[] = [];
      const reserve = pg.withReservedConnection.bind(pg);
      pg.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(conn => fn({
        executeRaw: async (sql: string, params?: unknown[]) => { statements.push(sql); return conn.executeRaw(sql, params); },
      }))) as PostgresEngine['withReservedConnection'];
      try {
        expect(await runRepair(ctx(), requestIndexesRepair, await resolveRepairScope(engine), { apply: true })).toMatchObject({ applied: 1, complete: true });
      } finally { pg.withReservedConnection = reserve; }
      expect(statements.filter(sql => sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')).map(sql => sql.split(/\s+/)[6])).toEqual([INDEX.name]);
      expect(await state()).toBe('valid');
    }, 120_000);
  }
});
