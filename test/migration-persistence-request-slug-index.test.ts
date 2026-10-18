/**
 * #6511 (GBRA-79 wave 16, G3.1 [R4]): the migration that builds the purge's
 * slug index on the request table (`persistence_requests_slug_intent`) has the
 * v179 shape: `transaction: false`, an empty `sql`, a handler that runs
 * `buildIndexOnline` (CONCURRENTLY on Postgres, inline on PGLite). DDL only:
 * no `ALTER TABLE … ADD COLUMN` (DECISIONS.md D2 keeps the cap column out).
 * The Postgres schema blob omits the index; PGLite's blob carries it, so a fresh
 * PGLite brain needs no build. `gbrain repair request-indexes` rebuilds a
 * dropped (both engines) or INVALID (Postgres) index on a current schema, and a
 * concurrent writer keeps committing while the Postgres build runs.
 *
 * The migration is found by its name, never by its number: the number is
 * provisional until the merge slot (GBRA-81 carries a sibling).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { readRequestIndexStates } from '../src/core/persistence/checkpoint-validation.ts';
import { PERSISTENCE_REQUEST_ONLINE_INDEXES, PERSISTENCE_REQUEST_SLUG_INTENT_INDEX, POSTGRES_CONCURRENT_PERSISTENCE_INDEXES } from '../src/core/persistence/schema.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.generated.ts';
import { SCHEMA_SQL } from '../src/core/schema-embedded.generated.ts';
import { MIGRATIONS } from '../src/core/schema-migrations/registry.generated.ts';
import { LATEST_SCHEMA_VERSION } from '../src/core/schema-migrations/latest.generated.ts';
import { runRepair, resolveRepairScope } from '../src/core/repair/core.ts';
import { requestIndexesRepair } from '../src/core/repair/request-indexes.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const INDEX = PERSISTENCE_REQUEST_SLUG_INTENT_INDEX;
const migration = MIGRATIONS.find(m => m.name === 'persistence_request_slug_intent_index');

describe('#6511 the slug index migration module', () => {
  test('is registered once, in this release, in the v179 online-index shape', () => {
    expect(MIGRATIONS.filter(m => m.name === 'persistence_request_slug_intent_index')).toHaveLength(1);
    expect(migration).toMatchObject({ idempotent: true, transaction: false, sql: '' });
    // Numbered at the merge slot; it is one of this release's migrations, not necessarily the last (v241 follows it).
    expect(migration!.version).toBeGreaterThan(239);
    expect(migration!.version).toBeLessThanOrEqual(LATEST_SCHEMA_VERSION);
    expect(typeof migration!.handler).toBe('function');
  });
  test('is DDL only: an index on the request table, no column and no backfill', () => {
    expect(INDEX.sql).toMatch(/^CREATE INDEX IF NOT EXISTS persistence_requests_slug_intent\s+ON persistence_requests\(source_id,slug,sequence\) WHERE intent IS NOT NULL AND NOT compacted$/);
    expect(INDEX.sql).not.toMatch(/ALTER TABLE|ADD COLUMN|UPDATE /i);
    expect(migration!.sql).not.toMatch(/ALTER TABLE|ADD COLUMN/i);
  });
  test('the Postgres blob omits the index (the migration builds it CONCURRENTLY); the PGLite blob carries it', () => {
    expect(POSTGRES_CONCURRENT_PERSISTENCE_INDEXES.has(INDEX.sql)).toBe(true);
    expect(SCHEMA_SQL).not.toContain(INDEX.name);
    expect(PGLITE_SCHEMA_SQL).toContain(INDEX.name);
    expect(PERSISTENCE_REQUEST_ONLINE_INDEXES.map(index => index.name)).toContain(INDEX.name);
  });
});

for (const backend of testBackends()) describe(`[${backend}] #6511 the slug index on a brain`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const ctx = () => ({ engine, config: { engine: backend }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
  const state = async () => (await readRequestIndexStates(engine, [INDEX]))[0]!.state;
  const explain = async (slug: string) => JSON.stringify(await engine.executeRaw(
    `EXPLAIN (FORMAT JSON) SELECT id::text FROM persistence_requests WHERE source_id=$1 AND slug=ANY($2::text[]) AND NOT compacted AND intent IS NOT NULL ORDER BY sequence LIMIT 10000`,
    ['default', [slug]]));

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('a current brain has the index valid; the migration handler is a no-op on it', async () => {
    expect(await state()).toBe('valid');
    await migration!.handler!(engine);
    expect(await state()).toBe('valid');
  });

  test('a dropped index is rebuilt by the migration handler and by gbrain repair request-indexes; a second repair is a no-op', async () => {
    await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
    expect(await state()).toBe('missing');
    await migration!.handler!(engine);
    expect(await state()).toBe('valid');
    await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
    const scope = await resolveRepairScope(engine);
    const preview = await runRepair(ctx(), requestIndexesRepair, scope, { apply: false });
    expect(preview).toMatchObject({ affected: 1, apply_command: 'gbrain repair request-indexes --apply' });
    expect(await state()).toBe('missing');
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 1, complete: true });
    expect(await state()).toBe('valid');
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ affected: 0, applied: 0, complete: true });
  }, 60_000);

  if (backend === 'postgres') {
    test('the purge slug lookup is served by the index on a wide request table, and was a sequential scan without it', async () => {
      await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,intent_bytes,terminal_reservation,state)
        SELECT 'local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),'seed-'||g,'d',jsonb_build_object('kind','put_page','n',g),'{}'::jsonb,1,64,'committed'
        FROM generate_series(1,50000) g`);
      await engine.executeRaw('ANALYZE persistence_requests');
      expect(await explain('seed-7')).toContain(INDEX.name);
      await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
      expect(await explain('seed-7')).toContain('Seq Scan');
      await migration!.handler!(engine);
      expect(await explain('seed-7')).toContain(INDEX.name);
    }, 120_000);

    test('an INVALID index (an interrupted concurrent build) is dropped and rebuilt; the build is CONCURRENTLY outside a transaction and sets nothing on the session', async () => {
      const pg = engine as PostgresEngine;
      await pg.executeRaw(`UPDATE pg_index SET indisvalid=false WHERE indexrelid='${INDEX.name}'::regclass`);
      expect(await state()).toBe('invalid');
      const statements: string[] = [];
      const reserve = pg.withReservedConnection.bind(pg);
      pg.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(conn => fn({
        executeRaw: async (sql: string, params?: unknown[]) => { statements.push(sql); return conn.executeRaw(sql, params); },
      }))) as PostgresEngine['withReservedConnection'];
      try { await migration!.handler!(pg); } finally { pg.withReservedConnection = reserve; }
      expect(statements.filter(sql => sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')).map(sql => sql.split(/\s+/)[6])).toEqual([INDEX.name]);
      expect(statements.filter(sql => /^(SET|RESET|BEGIN)\b/i.test(sql))).toEqual([]);
      expect(await state()).toBe('valid');
    }, 60_000);

    test('a writer committing request rows during the concurrent build is never blocked', async () => {
      const pg = engine as PostgresEngine;
      await pg.executeRaw(`DROP INDEX ${INDEX.name}`);
      let stop = false, committed = 0;
      const writer = (async () => {
        while (!stop) {
          await pg.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,intent,authority,intent_bytes,terminal_reservation,state)
            VALUES('local_cli','writer',$1::uuid,'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),$2,'d','{"kind":"put_page"}'::jsonb,'{}'::jsonb,1,32,'committed')`, [randomUUID(), `live-${committed}`]);
          committed++;
        }
      })();
      const reserve = pg.withReservedConnection.bind(pg);
      // The build holds its connection a while so the writer provably overlaps it.
      pg.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(async conn => {
        await conn.executeRaw('SELECT pg_sleep(0.5)');
        return fn(conn);
      })) as PostgresEngine['withReservedConnection'];
      const before = committed;
      try { await migration!.handler!(pg); } finally { pg.withReservedConnection = reserve; stop = true; await writer; }
      expect(committed).toBeGreaterThan(before);
      expect(await state()).toBe('valid');
      expect(await explain('live-1')).toContain(INDEX.name);
    }, 60_000);
  }
});
