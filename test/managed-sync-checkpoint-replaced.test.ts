/**
 * Wave 16 G3.4 (#6513 comments, [R11]): a managed sync checkpoint whose cursor
 * another run of the same source replaced is superseded, not failed.
 *
 * Before, a `runId` mismatch at the shared validator (`sync-prepare.ts`,
 * "The accepted sync cursor changed before publication.") and at the final
 * locked CAS ("The sync cursor is not fully committed.") both refused
 * `revision_conflict`; the loser's run then recorded a `managed-sync-failure`
 * row through `settleFailedRequest`, doctor reported it as unresolved, and
 * `--retry-failed` treated it as a page fault. The replacing run re-covers the
 * source from its own discovery, so the loser's checkpoint has nothing left to
 * publish.
 *
 * Contract pinned here, on PGLite and Postgres:
 *  - replacement before validation, and between validation and the final CAS,
 *    both refuse `sync_cursor_replaced` with receipt state `conflict`;
 *  - the awaiting run settles it with no failure row and no ledger mirror
 *    row, re-reads the winning cursor as it stands (its run id, index and
 *    manifest kept) and finishes it in the same invocation, as the admission
 *    path already does when the cursor moves under it; `--retry-failed`
 *    afterwards converts nothing;
 *  - controls: a same-run index lag keeps `revision_conflict` and is still
 *    recorded; a missing manifest keeps `storage_error`.
 * `test/managed-sync-page-fault-holds.test.ts` keeps proving that a real page
 * fault still converts under `--retry-failed`.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { loadSyncFailures } from '../src/core/sync-failure-ledger.ts';
import postgres from '#postgres';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6513-ckpt-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
let postgresUrl: string | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; postgresUrl = pg.databaseUrl; }
}, 120_000);
/** A second session on the Postgres arm: what another process's committed replacement looks like to the publishing transaction. */
async function withSideConnection<T>(fn: (side: (sql: string, params: unknown[]) => Promise<unknown>) => Promise<T>): Promise<T> {
  const sql = postgres(postgresUrl!, { max: 1, prepare: false });
  try { return await fn((text, params) => sql.unsafe(text, params as never[])); } finally { await sql.end(); }
}
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) { rmSync(join(home, 'sync-failures.jsonl'), { force: true }); await fn(engine); } });

async function fixture(engine: BrainEngine) {
  const id = `ckr-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nObservation ${name} for the replaced checkpoint.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}

/** The sync run's admission guard (ENG-A7): the last statement of the transaction that admits the checkpoint request. */
const ADMISSION_GUARD = /pending'->'intent' = \$3::text::jsonb AS same FROM op_checkpoints WHERE op=\$1 AND fingerprint=\$2 FOR SHARE/;
/** The checkpoint apply's locked compare-and-swap, after the shared validator passed. */
const FINAL_CAS = /SELECT completed_keys FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=\$1 FOR UPDATE/;

type Replaced = { key: string; winner: string; winnerRun: string } | null;
/** What `replaceCursor` writes: the same header under a new `runId`, index 0, no pending request, plus the new run's manifest. */
async function replaceCursorRow(run: (sql: string, params: unknown[]) => Promise<unknown>, key: string, oldRun: string): Promise<{ winnerRun: string }> {
  const winnerRun = randomUUID();
  await run("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) SELECT 'managed-sync-manifest',$2,completed_keys FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [oldRun, winnerRun]);
  await run(`UPDATE op_checkpoints SET completed_keys=jsonb_build_array(((completed_keys->0)-'pending'-'group'-'progress') || jsonb_build_object('runId',$2::text,'index',0)),updated_at=now()
    WHERE op='managed-sync' AND fingerprint=$1`, [key, winnerRun]);
  return { winnerRun };
}
/**
 * Another run of the source replaces the cursor under its key while the loser's checkpoint request is in flight.
 * `at: 'validator'`: the replacement commits with the admission of the checkpoint, so the coordinator's shared validator
 * reads the new run (both engines). `at: 'cas'`: the replacement commits on a second connection after validation passed
 * and before the final locked compare-and-swap (Postgres only: PGLite is one session and cannot commit a concurrent
 * write inside another transaction). `at: 'lag'` moves the index back one under the same run and `at: 'manifest'`
 * deletes the run's manifest, both inside the publishing transaction (rolled back with the refusal, which is all the
 * control observes). Each fires once, on the checkpoint only.
 */
function interfere(engine: BrainEngine, at: 'validator' | 'cas' | 'lag' | 'manifest', side?: (sql: string, params: unknown[]) => Promise<unknown>): { restore: () => void; replaced: () => Replaced } {
  const transaction = engine.transaction;
  let replaced: Replaced = null;
  let fired = false;
  const header = (target: BrainEngine, key: string) => target.executeRaw<{ kind: string | null; run_id: string; total: number; text: string }>(
    "SELECT completed_keys->0->'pending'->'intent'->>'kind' AS kind,completed_keys->0->>'runId' AS run_id,(completed_keys->0->>'total')::int AS total,completed_keys::text AS text FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [key]);
  engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, tx => run(new Proxy(tx, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (fired) return target.executeRaw(sql, params);
        if (at === 'validator' && ADMISSION_GUARD.test(sql) && (JSON.parse(params![2] as string) as { kind: string }).kind === 'managed_sync_checkpoint') {
          const rows = await target.executeRaw(sql, params);
          fired = true;
          const key = params![1] as string;
          const [head] = await header(target, key);
          const { winnerRun } = await replaceCursorRow((q, p) => target.executeRaw(q, p), key, head!.run_id);
          replaced = { key, winner: (await header(target, key))[0]!.text, winnerRun };
          return rows;
        }
        if (at !== 'validator' && FINAL_CAS.test(sql)) {
          const key = params![0] as string;
          const [head] = await header(target, key);
          if (head?.kind === 'managed_sync_checkpoint') {
            fired = true;
            if (at === 'lag') await target.executeRaw("UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0,index}',to_jsonb($2::int)) WHERE op='managed-sync' AND fingerprint=$1", [key, head.total - 1]);
            else if (at === 'manifest') await target.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync-manifest' AND fingerprint=$1", [head.run_id]);
            else {
              const { winnerRun } = await replaceCursorRow(side!, key, head.run_id);
              const [row] = await side!("SELECT completed_keys::text AS winner FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [key]) as Array<{ winner: string }>;
              replaced = { key, winner: row!.winner, winnerRun };
            }
          }
        }
        return target.executeRaw(sql, params);
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine)) as Promise<T>;
  } as BrainEngine['transaction'];
  return { restore: () => { engine.transaction = transaction; }, replaced: () => replaced };
}

const checkpointReceipt = async (engine: BrainEngine, sourceId: string) => engine.executeRaw<{ state: string; error_code: string | null; error_message: string | null; request_id: string }>(
  "SELECT state,error_code,error_message,request_id::text AS request_id FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint' ORDER BY sequence", [sourceId]);
const failureRows = async (engine: BrainEngine, key: string) => engine.executeRaw<{ code: string }>("SELECT completed_keys->0->>'code' AS code FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1", [key]);
const lastCommit = async (engine: BrainEngine, sourceId: string) => (await engine.executeRaw<{ last_commit: string | null }>('SELECT last_commit FROM sources WHERE id=$1', [sourceId]))[0]!.last_commit;

for (const at of ['validator', 'cas'] as const) {
  test(`a checkpoint whose cursor another run replaced ${at === 'validator' ? 'before validation' : 'between validation and the final CAS'} is superseded: conflict receipt, no failure row, winner untouched, next run finishes the winner`, async () => each(async engine => {
    if (at === 'cas' && engine.kind !== 'postgres') return;
    const f = await fixture(engine);
    const scenario = async (side?: (sql: string, params: unknown[]) => Promise<unknown>) => {
      const hook = interfere(engine, at, side);
      try { return { loser: await performManagedSync(engine, f.opts), replaced: hook.replaced() }; } finally { hook.restore(); }
    };
    const { loser, replaced } = at === 'cas' ? await withSideConnection(scenario) : await scenario();
    expect(replaced).not.toBeNull();
    // The loser's receipt: a conflict with the supersession code, never a failure; the same invocation then finished the winner.
    const receipts = await checkpointReceipt(engine, f.id);
    expect(receipts[0]).toMatchObject({ state: 'conflict', error_code: 'sync_cursor_replaced' });
    expect(receipts[0]!.error_message).toContain('replaced the cursor');
    expect(receipts.map(row => row.state)).toEqual(['conflict', 'committed']);
    // No managed-sync failure recorded (durable or mirrored), nothing converted as a page fault, and the run went on with the winning cursor as it stood.
    expect(await failureRows(engine, replaced!.key)).toEqual([]);
    expect(loadSyncFailures().filter(row => row.source_id === f.id)).toEqual([]);
    expect(loser).toMatchObject({ status: 'first_sync', runId: replaced!.winnerRun, added: 2 });
    expect(loser.failures).toBeUndefined();
    expect(loser.managedWrite).toBeUndefined();
    expect(loser.converted_from_failed).toBeUndefined();
    const [winner] = await engine.executeRaw<{ run_id: string; done: boolean | null; index: number }>(
      "SELECT completed_keys->0->>'runId' AS run_id,(completed_keys->0->>'done')::boolean AS done,(completed_keys->0->>'index')::int AS index FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [replaced!.key]);
    expect(winner).toEqual({ run_id: replaced!.winnerRun, done: true, index: 2 });
    expect(await lastCommit(engine, f.id)).toBe(git(f.root, 'rev-parse', 'HEAD'));
    // --retry-failed afterwards has nothing to retry and converts nothing.
    const next = await performManagedSync(engine, { ...f.opts, retryFailed: true });
    expect(next.status).toBe('up_to_date');
    expect(next.converted_from_failed).toBeUndefined();
    expect(await failureRows(engine, replaced!.key)).toEqual([]);
  }), 180_000);
}

test('controls: a same-run index lag keeps revision_conflict and is still recorded; a missing manifest keeps storage_error', async () => each(async engine => {
  for (const [at, code, message] of [['lag', 'revision_conflict', 'not fully committed'], ['manifest', 'storage_error', 'manifest is incomplete']] as const) {
    const f = await fixture(engine);
    const hook = interfere(engine, at);
    let result: Awaited<ReturnType<typeof performManagedSync>>;
    try { result = await performManagedSync(engine, f.opts); } finally { hook.restore(); }
    const [receipt] = await checkpointReceipt(engine, f.id);
    expect({ at, state: receipt!.state, code: receipt!.error_code }).toEqual({ at, state: code === 'revision_conflict' ? 'conflict' : 'failed', code });
    expect(receipt!.error_message).toContain(message);
    expect(result).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code, count: 1 }] });
    const [key] = await engine.executeRaw<{ fingerprint: string }>("SELECT fingerprint FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [f.id]);
    expect((await failureRows(engine, key!.fingerprint)).map(row => row.code)).toEqual([code]);
    expect(await lastCommit(engine, f.id)).toBeNull();
  }
}), 240_000);
