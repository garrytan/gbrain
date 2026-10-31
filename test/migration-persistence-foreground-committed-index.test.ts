/**
 * #7649: a resident consumer's write claims after a restart run with an empty `syncSeen`, so their foreground-commit probe
 * (journal.ts `FOREGROUND_WAITING_ON`) starts at sequence 0 and, with no index on committed rows by (worktree, sequence),
 * walked every receipt on each claim. `persistence_requests_foreground_committed` serves it; its predicate must be the
 * probe's own (`state='committed' AND NOT SYNC_KIND(c)`) or the planner cannot use it. The migration has the v179
 * online-index shape: the Postgres blob omits the index and the migration builds it CONCURRENTLY, PGLite's blob carries
 * it, and `gbrain repair request-indexes` rebuilds a dropped or INVALID one on a current schema. The Postgres access path
 * on a large journal and an interrupted concurrent build are in test/e2e/persistence-claim-committed-probe-7649-postgres.test.ts.
 *
 * The migration is found by its name, never by its number: the number is provisional until the merge slot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { readRequestIndexStates } from '../src/core/persistence/checkpoint-validation.ts';
import { claimNextWrite, SYNC_KIND } from '../src/core/persistence/journal.ts';
import { PERSISTENCE_FOREGROUND_COMMITTED_INDEX, PERSISTENCE_REQUEST_ONLINE_INDEXES, PERSISTENCE_SCHEMA_STATEMENTS,
  POSTGRES_CONCURRENT_PERSISTENCE_INDEXES } from '../src/core/persistence/schema.ts';
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

const INDEX = PERSISTENCE_FOREGROUND_COMMITTED_INDEX;
const RECEIPTS = 20_000;
const FOREGROUND_TAIL = 20;
const migration = MIGRATIONS.find(m => m.name === 'persistence_foreground_committed_index');

describe('#7649 the foreground-commit index migration module', () => {
  test('is registered once in the v179 online-index shape, after the request-id index', () => {
    expect(MIGRATIONS.filter(m => m.name === 'persistence_foreground_committed_index')).toHaveLength(1);
    expect(migration).toMatchObject({ idempotent: true, transaction: false, sql: '' });
    expect(migration!.version).toBeGreaterThan(MIGRATIONS.find(m => m.name === 'persistence_request_id_index')!.version);
    expect(migration!.version).toBeLessThanOrEqual(LATEST_SCHEMA_VERSION);
    expect(typeof migration!.handler).toBe('function');
  });
  test("its predicate is the claim probe's committed non-sync condition, keyed by worktree and sequence; DDL only", () => {
    const sql: string = INDEX.sql;
    expect(sql).toBe(`CREATE INDEX IF NOT EXISTS persistence_requests_foreground_committed
  ON persistence_requests(worktree_id,sequence) WHERE state='committed' AND NOT ${SYNC_KIND('probe').replaceAll('probe.', '')}`);
    expect(INDEX.sql).not.toMatch(/ALTER TABLE|ADD COLUMN|UPDATE /i);
  });
  test('the Postgres blob omits the index (the migration builds it CONCURRENTLY); the PGLite blob and v151 carry it; repair and doctor cover it', () => {
    expect(POSTGRES_CONCURRENT_PERSISTENCE_INDEXES.has(INDEX.sql)).toBe(true);
    expect(SCHEMA_SQL).not.toContain(INDEX.name);
    expect(PGLITE_SCHEMA_SQL).toContain(INDEX.name);
    expect(PERSISTENCE_SCHEMA_STATEMENTS).toContain(INDEX.sql);
    expect(PERSISTENCE_REQUEST_ONLINE_INDEXES.map(index => index.name)).toContain(INDEX.name);
  });
});

for (const backend of testBackends()) describe(`[${backend}] #7649 the foreground-commit index on a brain`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const ctx = () => ({ engine, config: { engine: backend }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
  const state = async () => (await readRequestIndexStates(engine, [INDEX]))[0]!.state;
  const oid = async () => (await engine.executeRaw<{ oid: string }>('SELECT to_regclass($1)::oid::text AS oid', [INDEX.name]))[0]!.oid;

  beforeAll(async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); await closePostgres?.(); }, 60_000);

  test('a fresh brain has the index valid; the migration handler leaves it untouched', async () => {
    expect(await state()).toBe('valid');
    const before = await oid();
    await migration!.handler!(engine);
    expect(await oid()).toBe(before);
  });

  if (backend === 'pglite') test("on PGLite's journal of 20k sync receipts the cold claim's committed probe reads the index", async () => {
    const host = randomUUID(), worktree = randomUUID();
    await engine.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES ($1::uuid,$2::uuid,'active')`, [worktree, host]);
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
        worktree_id,slug,digest,intent,authority,intent_bytes,terminal_reservation,state,completed_at)
      SELECT 'local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),$1::uuid,'seed-'||g,'d',
        CASE WHEN g>$2::int-$3::int THEN jsonb_build_object('kind','put_page') ELSE jsonb_build_object('kind','managed_sync_import','runId','r','index',g) END,
        '{}'::jsonb,1,64,'committed',now()
      FROM generate_series(1,$2::int) g`, [worktree, RECEIPTS, FOREGROUND_TAIL]);
    for (const [slug, kind] of [['queued-sync', 'managed_sync_import'], ['queued-fg', 'put_page']]) {
      await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
          worktree_id,slug,digest,intent,authority,intent_bytes,terminal_reservation,state)
        VALUES ('local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),$1::uuid,$2,'d',
          jsonb_build_object('kind',$3::text),'{}'::jsonb,1,64,'queued')`, [worktree, slug, kind]);
    }
    await engine.executeRaw('ANALYZE persistence_requests');
    let plan = '';
    const original = engine.transactionDirect;
    engine.transactionDirect = ((fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => original.call(engine, async (tx: BrainEngine) => {
      const raw = tx.executeRaw.bind(tx);
      tx.executeRaw = (async (sql: string, params?: unknown[], options?: unknown) => {
        if (!sql.startsWith('WITH waiting AS MATERIALIZED')) return raw(sql, params as never, options as never);
        plan = (await raw<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params as never, options as never)).map(row => row['QUERY PLAN']).join('\n');
        return [];
      }) as BrainEngine['executeRaw'];
      return fn(tx);
    }, opts as never)) as BrainEngine['transactionDirect'];
    try { expect(await claimNextWrite(engine, host, 30_000, [], [], [], {})).toBeNull(); }
    finally { engine.transactionDirect = original; }
    expect(plan).toContain(`Index Only Scan using ${INDEX.name} on persistence_requests c`);
    expect(plan).not.toContain('Seq Scan on persistence_requests c');
    expect((await claimNextWrite(engine, host, 30_000, [], [], [], {}))?.slug).toBe('queued-fg');
  }, 60_000);

  test('a populated brain upgrading from the previous schema version builds it in the migration', async () => {
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
    expect(check.message).toContain(`${INDEX.name} is missing: request-table reads (managed sync checkpoints, write claims,`);
    expect(check.message).toContain('gbrain repair request-indexes');
    const scope = await resolveRepairScope(engine);
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: false })).toMatchObject({ affected: 1, apply_command: 'gbrain repair request-indexes --apply' });
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ applied: 1, complete: true });
    expect(await state()).toBe('valid');
    expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ affected: 0, applied: 0, complete: true });
    expect(await requestIndexesCheck(engine)).toMatchObject({ status: 'ok', message: 'Request-table indexes are valid.' });
  }, 60_000);
});
