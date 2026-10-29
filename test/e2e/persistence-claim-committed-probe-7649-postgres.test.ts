/**
 * #7649 on Postgres: after a restart a resident consumer claims with an empty `syncSeen`, so the foreground-commit probe
 * of both write claims (journal.ts `FOREGROUND_WAITING_ON`: a committed non-sync request on the worktree after the bound)
 * starts at sequence 0. With no index on committed rows by (worktree, sequence) the planner walked the sequence key or the
 * heap through every receipt, sync receipts included, on every claim; on a large request table each claim overran the 5 s
 * claim phase, so the write queue grew and sync never committed.
 *
 * The plans here are of the statements `claimNextWrite` and `claimNextLaneHead` send, with their own parameters: the
 * claim's transaction is intercepted at the statement, which is EXPLAINed instead of run. The journal holds 160k receipts,
 * nearly all sync imports, with the foreground commits at its end (a big import, then ordinary writes), and a queued sync
 * row ahead of a queued foreground write on one worktree, so the claim evaluates the probe. The migration that builds the
 * index is found by its name: the number is provisional until the merge slot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import postgres from '#postgres';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { claimNextLaneHead, claimNextWrite } from '../../src/core/persistence/journal.ts';
import { readRequestIndexStates } from '../../src/core/persistence/checkpoint-validation.ts';
import { PERSISTENCE_FOREGROUND_COMMITTED_INDEX } from '../../src/core/persistence/schema.ts';
import { requestIndexesCheck } from '../../src/commands/doctor/checks/persistence-requests.ts';
import { MIGRATIONS } from '../../src/core/schema-migrations/registry.generated.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const INDEX = PERSISTENCE_FOREGROUND_COMMITTED_INDEX;
const migration = MIGRATIONS.find(m => m.name === 'persistence_foreground_committed_index');
const HOST = randomUUID(), WA = randomUUID(), WB = randomUUID();
const RECEIPTS = 160_000;
const RUN = 'run-7649';

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

let engine: PostgresEngine;
let databaseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
  engine = pg.engine; databaseUrl = pg.databaseUrl; close = pg.close;
  await engine.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES ($1::uuid,$3::uuid,'active'),($2::uuid,$3::uuid,'active')`, [WA, WB, HOST]);
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
      worktree_id,slug,digest,intent,authority,intent_bytes,terminal_reservation,state,completed_at)
    SELECT 'local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),
      CASE WHEN g%2=0 THEN $1::uuid ELSE $2::uuid END,'seed-'||g,'d',
      CASE WHEN g%20=0 AND g>$3::int*0.98 THEN jsonb_build_object('kind','put_page','slug','seed-'||g)
        ELSE jsonb_build_object('kind','managed_sync_import','runId',md5((g/1000)::text),'index',g%1000,'slug','seed-'||g) END,
      '{}'::jsonb,1,64,'committed',now()
    FROM generate_series(1,$3::int) g`, [WA, WB, RECEIPTS]);
  for (const [slug, intent] of [['queued-sync', { kind: 'managed_sync_import', runId: 'live', index: 0, slug: 'queued-sync', lane: RUN }],
    ['queued-fg', { kind: 'put_page', slug: 'queued-fg' }]] as const) {
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
        worktree_id,slug,digest,intent,authority,intent_bytes,terminal_reservation,state)
      VALUES ('local_cli','seed',gen_random_uuid(),'put_page','default',(SELECT incarnation FROM sources WHERE id='default'),$1::uuid,$2,'d',$3::text::jsonb,'{}'::jsonb,1,64,'queued')`,
      [WA, slug, JSON.stringify(intent)]);
  }
  await engine.executeRaw(`UPDATE persistence_requests SET intent=intent||jsonb_build_object('group',request_id::text) WHERE slug='queued-sync'`);
  await engine.executeRaw('ANALYZE persistence_requests');
}, 180_000);
afterAll(async () => { await close?.(); }, 60_000);

/** EXPLAIN (ANALYZE) of the claim statement each claim sends, in its own transaction with its own parameters; the claim then finds nothing. */
async function claimPlans(): Promise<Record<'write' | 'laneHead', PlanNode>> {
  const plans: Partial<Record<'write' | 'laneHead', PlanNode>> = {};
  const original = engine.transactionDirect;
  engine.transactionDirect = ((fn: (tx: BrainEngine) => Promise<unknown>, opts?: unknown) => original.call(engine, async (tx: BrainEngine) => {
    const raw = tx.executeRaw.bind(tx);
    tx.executeRaw = (async (sql: string, params?: unknown[], options?: unknown) => {
      const label = sql.startsWith('WITH waiting AS MATERIALIZED') ? 'write'
        : /^SELECT r\.\* FROM persistence_requests r\s+JOIN persistence_worktrees/.test(sql) ? 'laneHead' : null;
      if (!label) return raw(sql, params as never, options as never);
      const [row] = await raw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params as never, options as never);
      plans[label] = row!['QUERY PLAN'][0]!.Plan;
      return [];
    }) as BrainEngine['executeRaw'];
    return fn(tx);
  }, opts as never)) as PostgresEngine['transactionDirect'];
  try {
    expect(await claimNextWrite(engine, HOST, 30_000, [], [], [], {})).toBeNull();
    expect(await claimNextLaneHead(engine, HOST, WA, RUN, 30_000, null)).toBeNull();
  } finally {
    engine.transactionDirect = original;
  }
  expect(Object.keys(plans).sort()).toEqual(['laneHead', 'write']);
  return plans as Record<'write' | 'laneHead', PlanNode>;
}

/** The committed probe's scans (alias `c` in FOREGROUND_WAITING_ON): node type, indexes read and rows read then discarded. */
const committedProbe = (plan: PlanNode) => nodes(plan)
  .filter(node => node.Alias === 'c' && node['Relation Name'] === 'persistence_requests')
  .map(node => ({ type: node['Node Type'], indexes: [...new Set(nodes(node).map(n => n['Index Name']).filter(Boolean))],
    removed: Number(node['Rows Removed by Filter'] ?? 0) }));

describe('#7649 the cold claim committed probe', () => {
  test('with an empty syncSeen both claims read the committed probe through the new index, and nothing is filtered out', async () => {
    const plans = await claimPlans();
    for (const plan of [plans.write, plans.laneHead]) {
      const probe = committedProbe(plan);
      expect(probe.length).toBeGreaterThan(0);
      for (const scan of probe) {
        expect(scan.type).not.toBe('Seq Scan');
        expect(scan.indexes).toEqual([INDEX.name]);
        expect(scan.removed).toBe(0);
      }
    }
  }, 120_000);

  test('without the index the probe walks the sync receipts; the migration builds it back and the probe reads it again', async () => {
    await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
    const cold = await claimPlans();
    for (const plan of [cold.write, cold.laneHead]) {
      const probe = committedProbe(plan);
      expect(probe.length).toBeGreaterThan(0);
      expect(probe.flatMap(scan => scan.indexes)).not.toContain(INDEX.name);
      expect(Math.max(...probe.map(scan => scan.removed))).toBeGreaterThan(RECEIPTS / 2);
    }
    await migration!.handler!(engine);
    expect((await readRequestIndexStates(engine, [INDEX]))[0]!.state).toBe('valid');
    const warm = await claimPlans();
    for (const plan of [warm.write, warm.laneHead]) expect(committedProbe(plan).flatMap(scan => scan.indexes)).toEqual([INDEX.name]);
  }, 180_000);

  test('the real claim still claims the queued foreground write ahead of the sync row it passes', async () => {
    const row = await claimNextWrite(engine, HOST, 30_000, [], [], [], {});
    expect(row?.slug).toBe('queued-fg');
    expect(row?.passed_sync).toBe(true);
  }, 60_000);
});

describe('#7649 an interrupted CONCURRENTLY build', () => {
  test('the migration runs outside a transaction and is idempotent', () => {
    expect(MIGRATIONS.filter(m => m.name === 'persistence_foreground_committed_index')).toHaveLength(1);
    expect(migration).toMatchObject({ idempotent: true, transaction: false, sql: '' });
  });

  test('a build cancelled while it waits for a writer leaves an INVALID index, which the migration drops and rebuilds CONCURRENTLY', async () => {
    await engine.executeRaw(`DROP INDEX ${INDEX.name}`);
    const writer = postgres(databaseUrl, { max: 1, prepare: false });
    const builder = postgres(databaseUrl, { max: 1, prepare: false });
    try {
      let release!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      let locked!: () => void;
      const holding = new Promise<void>(resolve => { locked = resolve; });
      const writerTx = writer.begin(async sql => {
        await sql.unsafe('LOCK TABLE persistence_requests IN ROW EXCLUSIVE MODE');
        locked();
        await released;
      });
      await holding;
      await builder.unsafe(`SET statement_timeout = '1s'`);
      // CREATE INDEX CONCURRENTLY commits the catalog entry, then waits for the writer: the timeout leaves it INVALID.
      await expect(builder.unsafe(INDEX.sql.replace('CREATE INDEX', 'CREATE INDEX CONCURRENTLY'))).rejects.toThrow(/statement timeout/);
      release();
      await writerTx;
    } finally {
      await writer.end();
      await builder.end();
    }
    expect((await readRequestIndexStates(engine, [INDEX]))[0]!.state).toBe('invalid');
    expect((await requestIndexesCheck(engine)).message).toContain(`${INDEX.name} is INVALID`);
    const [before] = await engine.executeRaw<{ oid: string }>('SELECT to_regclass($1)::oid::text AS oid', [INDEX.name]);

    const statements: string[] = [];
    const reserve = engine.withReservedConnection.bind(engine);
    engine.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(conn => fn({
      executeRaw: async (sql: string, params?: unknown[]) => { statements.push(sql); return conn.executeRaw(sql, params); },
    }))) as PostgresEngine['withReservedConnection'];
    try {
      await migration!.handler!(engine);
    } finally { engine.withReservedConnection = reserve; }
    expect(statements.filter(sql => sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')).map(sql => sql.split(/\s+/)[6])).toEqual([INDEX.name]);
    expect((await readRequestIndexStates(engine, [INDEX]))[0]!.state).toBe('valid');
    const [after] = await engine.executeRaw<{ oid: string }>('SELECT to_regclass($1)::oid::text AS oid', [INDEX.name]);
    expect(after!.oid).not.toBe(before!.oid);
    expect(await requestIndexesCheck(engine)).toMatchObject({ status: 'ok' });

    await migration!.handler!(engine);
    const [again] = await engine.executeRaw<{ oid: string }>('SELECT to_regclass($1)::oid::text AS oid', [INDEX.name]);
    expect(again!.oid).toBe(after!.oid);
  }, 120_000);
});
