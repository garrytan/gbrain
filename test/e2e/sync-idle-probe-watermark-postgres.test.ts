/**
 * The managed sync idle pin's request probe on Postgres. Each idle pin (sync-pass-run.ts `pinPass`) runs `passIdleProbe`
 * with the converged pass row's `request_hwm`; its `newer` arm asked for a request of the worktree, or a worktree-less
 * request of the source incarnation, above that watermark. Written as one range on the `sequence` key filtered by that OR,
 * on a busy brain the planner read the whole request table (a sequential scan) on every idle pin, and a sparse worktree
 * walked the sequence key back past every newer row of the other worktrees. Live, that read was most of a 3-4 s idle setup.
 *
 * The journal here has the live shape: one dense worktree (two thirds of the rows, up to the newest sequence), a sparse one
 * whose newest request is well behind, and worktree-less requests of another source, ~1.9 KB a row. The probe statement is
 * the one passIdleProbe sends, intercepted at the engine and EXPLAINed with its own parameters. The migration is found by its
 * name: the number is provisional until the merge slot.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { passIdleProbe } from '../../src/core/persistence/sync-pass.ts';
import { readConvergedWatermark } from '../../src/core/persistence/sync-pass-batch.ts';
import { MANAGED_SYNC_PASS_OP } from '../../src/core/persistence/sync-pass-row.ts';
import { readRequestIndexStates } from '../../src/core/persistence/checkpoint-validation.ts';
import { MIGRATIONS } from '../../src/core/schema-migrations/registry.generated.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';

const migration = MIGRATIONS.find(m => m.name === 'persistence_request_watermark_indexes');
const HOST = randomUUID(), DENSE = randomUUID(), SPARSE = randomUUID();
const ROWS = 90_000;
/** Rows a probe may read and discard: a backward step per maximum, never a walk of other worktrees' rows. */
const FILTER_BUDGET = 100;

type PlanNode = Record<string, unknown> & { Plans?: PlanNode[] };
const nodes = (plan: PlanNode): PlanNode[] => [plan, ...(plan.Plans ?? []).flatMap(nodes)];

let engine: PostgresEngine;
let close: () => Promise<void>;
let incarnation: string;

/** Seeds a converged pass row for `default` at `hwm`, as a converged pass leaves it. */
async function convergedAt(hwm: string) {
  await engine.executeRaw(`DELETE FROM op_checkpoints WHERE op=$1`, [MANAGED_SYNC_PASS_OP]);
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES ($1,$2,
      jsonb_build_array(jsonb_build_object('source_id','default','obligations',jsonb_build_object('converged',
        jsonb_build_object('target','t','request_hwm',$3::text,'open_at_stamp','[]'::jsonb)))))`, [MANAGED_SYNC_PASS_OP, `default:${incarnation}`, hwm]);
}

/** The converged watermark a pass would stamp for `worktreeId` now. */
const stamp = async (worktreeId: string) => (await readConvergedWatermark(engine, { worktreeId, sourceId: 'default', incarnation }, null, 1000)).request_hwm;

/** passIdleProbe's result for `worktreeId`, and the EXPLAIN (ANALYZE) of the statement it sent, run the same way. */
async function probe(worktreeId: string): Promise<{ newer: boolean; plan: PlanNode }> {
  let plan: PlanNode | undefined;
  const raw = engine.executeRaw.bind(engine);
  const spy = (async (sql: string, params?: unknown[], options?: unknown) => {
    if (sql.startsWith('WITH pass AS') && !plan) {
      const [row] = await raw<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params as never, options as never);
      plan = row!['QUERY PLAN'][0]!.Plan;
    }
    return raw(sql, params as never, options as never);
  }) as BrainEngine['executeRaw'];
  const result = await passIdleProbe({ executeRaw: spy }, { sourceId: 'default', incarnation, worktreeId, requestHwm: null, openAtStamp: null });
  expect(plan).toBeDefined();
  return { newer: result.newer, plan: plan! };
}

/** The probe's reads of persistence_requests: node type, index, and rows read then discarded. */
const requestScans = (plan: PlanNode) => nodes(plan).filter(node => node['Relation Name'] === 'persistence_requests')
  .map(node => ({ type: String(node['Node Type']), index: node['Index Name'] as string | undefined, removed: Number(node['Rows Removed by Filter'] ?? 0) }));

beforeAll(async () => {
  const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
  engine = pg.engine; close = pg.close;
  incarnation = (await engine.executeRaw<{ incarnation: string }>(`SELECT incarnation::text FROM sources WHERE id='default'`))[0]!.incarnation;
  await engine.executeRaw(`INSERT INTO sources(id,name) VALUES ('other','other') ON CONFLICT DO NOTHING`);
  await engine.executeRaw(`INSERT INTO persistence_worktrees(id,owner_host_id,state) VALUES ($1::uuid,$3::uuid,'active'),($2::uuid,$3::uuid,'active')`, [DENSE, SPARSE, HOST]);
  // Two thirds dense; one in ten worktree-less of another source; the sparse worktree's last request at 85% of the journal.
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,
      worktree_id,slug,digest,intent,authority,intent_bytes,terminal_reservation,state,completed_at)
    SELECT 'local_cli','seed',gen_random_uuid(),'put_page',CASE WHEN g%10=1 THEN 'other' ELSE 'default' END,
      CASE WHEN g%10=1 THEN (SELECT incarnation FROM sources WHERE id='other') ELSE $3::uuid END,
      CASE WHEN g%10=1 THEN NULL WHEN g%300=0 AND g<$4::int*0.85 THEN $2::uuid ELSE $1::uuid END,'seed-'||g,'d',
      jsonb_build_object('kind','managed_sync_import','runId',md5((g/1000)::text),'index',g%1000,'slug','seed-'||g,'pad',repeat(md5(g::text),52)),
      '{}'::jsonb,1,64,'committed',now()
    FROM generate_series(1,$4::int) g`, [DENSE, SPARSE, incarnation, ROWS]);
  await engine.executeRaw('ANALYZE persistence_requests');
}, 300_000);
afterAll(async () => { await close?.(); }, 60_000);

describe('the idle pin request probe on a busy journal', () => {
  for (const [label, worktree] of [['the dense worktree', DENSE], ['a sparse worktree', SPARSE]] as const) {
    test(`converged, ${label} reads no request beyond a step per maximum, and nothing is newer`, async () => {
      await convergedAt(await stamp(worktree));
      const { newer, plan } = await probe(worktree);
      expect(newer).toBe(false);
      const scans = requestScans(plan);
      expect(scans.filter(scan => scan.type === 'Seq Scan')).toEqual([]);
      expect(Math.max(0, ...scans.map(scan => scan.removed))).toBeLessThan(FILTER_BUDGET);
    }, 120_000);
  }

  test('a newer request of the worktree, or a newer worktree-less one of the incarnation, is newer; another worktree\'s or source\'s is not', async () => {
    await convergedAt(await stamp(SPARSE));
    const insert = (worktree: string | null, source: string) => engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,
        source_id,source_incarnation,worktree_id,slug,digest,intent,authority,intent_bytes,terminal_reservation,state,completed_at)
      VALUES ('local_cli','seed',gen_random_uuid(),'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$1::uuid,'late-'||gen_random_uuid(),'d',
        '{"kind":"put_page"}'::jsonb,'{}'::jsonb,1,64,'committed',now())`, [worktree, source]);
    await insert(DENSE, 'default');
    await insert(null, 'other');
    expect((await probe(SPARSE)).newer).toBe(false);
    await insert(null, 'default');
    expect((await probe(SPARSE)).newer).toBe(true);
    await convergedAt(await stamp(SPARSE));
    expect((await probe(SPARSE)).newer).toBe(false);
    await insert(SPARSE, 'default');
    expect((await probe(SPARSE)).newer).toBe(true);
    await engine.executeRaw(`DELETE FROM persistence_requests WHERE slug LIKE 'late-%'`);
  }, 120_000);

  test('the migration is online and idempotent; without its indexes the probe reads the journal, and it builds them back', async () => {
    expect(migration).toMatchObject({ idempotent: true, transaction: false, sql: '' });
    const names = ['persistence_requests_worktree_sequence', 'persistence_requests_database_sequence'];
    expect((await readRequestIndexStates(engine, names.map(name => ({ name })))).map(index => index.state)).toEqual(['valid', 'valid']);
    for (const name of names) await engine.executeRaw(`DROP INDEX ${name}`);
    await engine.executeRaw('ANALYZE persistence_requests');
    await convergedAt(await stamp(SPARSE));
    const cold = requestScans((await probe(SPARSE)).plan);
    expect(Math.max(0, ...cold.map(scan => scan.removed))).toBeGreaterThan(FILTER_BUDGET);
    await migration!.handler!(engine);
    await migration!.handler!(engine);
    expect((await readRequestIndexStates(engine, names.map(name => ({ name })))).map(index => index.state)).toEqual(['valid', 'valid']);
    const warm = requestScans((await probe(SPARSE)).plan);
    expect(Math.max(0, ...warm.map(scan => scan.removed))).toBeLessThan(FILTER_BUDGET);
  }, 180_000);
});
