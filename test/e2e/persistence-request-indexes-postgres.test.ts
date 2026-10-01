import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { claimWorktree, getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { INCOMPLETE_SYNC_RECEIPT_SQL, readRequestIndexStates } from '../../src/core/persistence/checkpoint-validation.ts';
import { PERSISTENCE_SYNC_RUN_INDEXES } from '../../src/core/persistence/schema.ts';
import { SCHEMA_SQL } from '../../src/core/schema-embedded.generated.ts';
import { v179 } from '../../src/core/schema-migrations/v179-persistence-request-sync-run-indexes.ts';
import { requestIndexesCheck, requestGrowthCheck } from '../../src/commands/doctor/checks/persistence-requests.ts';
import { runRepair, resolveRepairScope } from '../../src/core/repair/core.ts';
import { requestIndexesRepair } from '../../src/core/repair/request-indexes.ts';
import { requirePostgresTestDatabase } from '../helpers/test-backends.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';

// #5762 on Postgres: the checkpoint validation is index-served on a
// 512k-row request table, the indexes stay out of the schema blob and are
// built CONCURRENTLY by v179, and `gbrain repair request-indexes` rebuilds a
// dropped or INVALID one on a current schema.

const home = mkdtempSync(join(tmpdir(), 'gbrain-5762-pg-'));
let engine: PostgresEngine;
let close: () => Promise<void>;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const NAMES = PERSISTENCE_SYNC_RUN_INDEXES.map(index => index.name);
const ctx = () => ({ engine, config: { engine: 'postgres' }, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;

beforeAll(async () => {
  const pg = await isolatedPersistencePostgres(requirePostgresTestDatabase());
  engine = pg.engine; close = pg.close;
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { await disposePersistenceConsumer(engine); });
  await close?.(); rmSync(home, { recursive: true, force: true });
});

async function fixture() {
  const id = `ix-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nObservation ${name} for the index test.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [] } };
}
const planNodes = (plan: Record<string, unknown>): Array<Record<string, unknown>> =>
  [plan, ...((plan.Plans as Array<Record<string, unknown>> | undefined) ?? []).flatMap(planNodes)];

test('#5762 on a 512k-row request table every probe is an index scan, and the former predicate was a sequential scan', async () => withEnv(env, async () => {
  const f = await fixture();
  const binding = (await getWorktreeBinding(engine, f.id))!;
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
  // 512k receipts over 8,000 earlier runs; one in eight rows belongs to this worktree, as in the #5762 report.
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,
      digest,intent,authority,intent_bytes,terminal_reservation,state)
    SELECT 'local_cli','seed',gen_random_uuid(),'submit_job',$1,$2::uuid,'seed-'||g,CASE WHEN g%8=0 THEN $3::uuid END,'d',
      jsonb_build_object('kind','managed_sync_import','runId',md5((g%8000)::text),'index',g/8000),'{}'::jsonb,1,16384,
      CASE WHEN g%97=0 THEN 'failed' ELSE 'committed' END
    FROM generate_series(1,512000) g`, [f.id, source.incarnation, binding.worktree_id]);
  await engine.executeRaw('ANALYZE persistence_requests');
  const runId = randomUUID();
  const [{ 'QUERY PLAN': [probe] }] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
    `EXPLAIN (FORMAT JSON) ${INCOMPLETE_SYNC_RECEIPT_SQL}`, [binding.worktree_id, runId]);
  const nodes = planNodes(probe.Plan);
  expect(nodes.filter(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'persistence_requests')).toEqual([]);
  const used = new Set(nodes.map(node => node['Index Name']).filter(Boolean));
  for (const name of ['persistence_requests_recovery', ...NAMES]) expect(used.has(name)).toBe(true);
  const [{ 'QUERY PLAN': [legacy] }] = await engine.executeRaw<{ 'QUERY PLAN': Array<{ Plan: Record<string, unknown> }> }>(
    `EXPLAIN (FORMAT JSON) SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND
      (r.recovery IS NOT NULL OR (r.intent->>'runId'=$2 AND r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND r.state<>'committed'
        AND (r.state IN ('queued','running','recovering') OR NOT EXISTS (SELECT 1 FROM persistence_requests committed
          WHERE committed.source_id=r.source_id AND committed.intent->>'runId'=$2 AND committed.intent->>'index'=r.intent->>'index' AND committed.state='committed')))) LIMIT 1`,
    [binding.worktree_id, runId]);
  expect(planNodes(legacy.Plan).some(node => node['Node Type'] === 'Seq Scan' && node['Relation Name'] === 'persistence_requests')).toBe(true);
  const sizes = await engine.executeRaw<{ name: string; bytes: string }>(
    'SELECT n.name, pg_relation_size(to_regclass(n.name))::text AS bytes FROM unnest($1::text[]) AS n(name)', [NAMES]);
  console.log(`[#5762] index sizes on 512k rows: ${sizes.map(row => `${row.name}=${row.bytes} bytes`).join(', ')}`);
  // The sync on the populated table still commits its checkpoint.
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  await engine.executeRaw("DELETE FROM persistence_requests WHERE principal_id='seed'");
}), 300_000);

test('#5762 the Postgres blob never builds the indexes; v179 builds them concurrently, one at a time', async () => withEnv(env, async () => {
  for (const name of NAMES) expect(SCHEMA_SQL).not.toContain(name);
  for (const name of NAMES) await engine.executeRaw(`DROP INDEX IF EXISTS ${name}`);
  await engine.runMigration(0, SCHEMA_SQL);
  expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['missing', 'missing']);
  const statements: string[] = [];
  const reserve = engine.withReservedConnection.bind(engine);
  engine.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(conn => fn({
    executeRaw: async (sql: string, params?: unknown[]) => { statements.push(sql); return conn.executeRaw(sql, params); },
  }))) as PostgresEngine['withReservedConnection'];
  try { await v179.handler!(engine); } finally { engine.withReservedConnection = reserve; }
  expect(statements.filter(sql => sql.startsWith('CREATE INDEX CONCURRENTLY IF NOT EXISTS')).map(sql => sql.split(/\s+/)[6])).toEqual(NAMES);
  expect(statements.filter(sql => /^(SET|RESET)\b/i.test(sql))).toEqual([]);
  expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid']);
}), 120_000);

test('#5762 gbrain repair request-indexes rebuilds a dropped and an INVALID index on a current schema; a second run is a no-op', async () => withEnv(env, async () => {
  await engine.executeRaw('DROP INDEX persistence_requests_sync_run_open');
  await engine.executeRaw("UPDATE pg_index SET indisvalid=false WHERE indexrelid='persistence_requests_sync_run_committed'::regclass");
  expect(await readRequestIndexStates(engine)).toEqual([{ name: NAMES[0], state: 'missing' }, { name: NAMES[1], state: 'invalid' }]);
  const doctor = await requestIndexesCheck(engine);
  expect(doctor).toMatchObject({ name: 'persistence_request_indexes', status: 'warn', details: { count: 2, command: 'gbrain repair request-indexes --apply' } });
  expect(doctor.message).toContain('persistence_requests_sync_run_committed is INVALID');
  const scope = await resolveRepairScope(engine);
  const preview = await runRepair(ctx(), requestIndexesRepair, scope, { apply: false });
  expect(preview).toMatchObject({ affected: 2, cost: { lifetime_ids: 0 }, apply_command: 'gbrain repair request-indexes --apply' });
  expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['missing', 'invalid']);
  const applied = await runRepair(ctx(), requestIndexesRepair, scope, { apply: true });
  expect(applied).toMatchObject({ applied: 2, complete: true });
  expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid']);
  expect((await requestIndexesCheck(engine)).status).toBe('ok');
  expect(await runRepair(ctx(), requestIndexesRepair, scope, { apply: true })).toMatchObject({ affected: 0, applied: 0, complete: true });
}), 120_000);

test('#5762 a build that leaves the index INVALID (a concurrent caller failed first) is reported, never counted as built', async () => withEnv(env, async () => {
  const { buildIndexOnline } = await import('../../src/core/schema-migrations/helpers.ts');
  const index = { ...PERSISTENCE_SYNC_RUN_INDEXES[0], table: 'persistence_requests' };
  await engine.executeRaw(`DROP INDEX ${index.name}`);
  const reserve = engine.withReservedConnection.bind(engine);
  // Another caller's failed build lands between this caller's check and its CREATE ... IF NOT EXISTS, which then skips it.
  engine.withReservedConnection = (async (fn: Parameters<PostgresEngine['withReservedConnection']>[0]) => reserve(async conn => {
    await conn.executeRaw(index.sql);
    await conn.executeRaw(`UPDATE pg_index SET indisvalid=false WHERE indexrelid='${index.name}'::regclass`);
    return fn(conn);
  })) as PostgresEngine['withReservedConnection'];
  try { await expect(buildIndexOnline(engine, 0, index)).rejects.toThrow(`Index ${index.name} is not valid after its concurrent build`); }
  finally { engine.withReservedConnection = reserve; }
  expect(await buildIndexOnline(engine, 0, index)).toBe('rebuilt');
  expect((await readRequestIndexStates(engine)).map(state => state.state)).toEqual(['valid', 'valid']);
}), 60_000);

test('#5762 recovery journey: a checkpoint timeout with a dropped index is fixed by the two printed commands', async () => withEnv(env, async () => {
  const f = await fixture();
  await engine.executeRaw('DROP INDEX persistence_requests_sync_run_committed');
  const transaction = engine.transaction;
  engine.transaction = async function<T>(this: PostgresEngine, run: (tx: PostgresEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, tx => run(new Proxy(tx, { get(target, property) {
      if (property === 'executeRaw') return (sql: string, params?: unknown[]) => sql === INCOMPLETE_SYNC_RECEIPT_SQL
        ? target.executeRaw('SELECT pg_sleep(8)::text AS request_id') : target.executeRaw(sql, params);
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as PostgresEngine)) as Promise<T>;
  } as PostgresEngine['transaction'];
  let result: Awaited<ReturnType<typeof performManagedSync>>;
  try {
    result = await performManagedSync(engine, f.opts);
    for (let waited = 0; result.status === 'partial' && waited < 30_000; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const [row] = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint'", [f.id]);
      if (row?.state === 'failed') result = await performManagedSync(engine, f.opts);
    }
  } finally { engine.transaction = transaction; }
  const suggestion = result.managedWrite!.suggestion;
  expect(result.managedWrite).toMatchObject({ write_error: 'checkpoint_validation_timeout', detail: 'index_missing' });
  const commands = [...suggestion.matchAll(/gbrain [^—]+?(?= — |$)/g)].map(match => match[0].trim());
  expect(commands).toEqual(['gbrain repair request-indexes --apply', `gbrain sync --source ${f.id} --no-pull --retry-failed --no-embed --no-extract`]);
  // Command 1: the printed rebuild.
  expect(await runRepair(ctx(), requestIndexesRepair, await resolveRepairScope(engine), { apply: true })).toMatchObject({ applied: 1 });
  // Command 2: the printed retry.
  expect((await performManagedSync(engine, { ...f.opts, retryFailed: true })).status).toBe('first_sync');
  expect(commands.length).toBeLessThanOrEqual(3);
}), 120_000);

test('#5762 persistence_request_growth reads an estimate on Postgres', async () => withEnv(env, async () => {
  const check = await requestGrowthCheck(engine);
  expect(check).toMatchObject({ name: 'persistence_request_growth', status: 'ok', details: { rows_exact: false } });
}), 60_000);
