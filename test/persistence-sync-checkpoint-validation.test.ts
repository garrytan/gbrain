import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { INCOMPLETE_SYNC_RECEIPT_SQL, checkpointRetryCommand, findIncompleteSyncReceipt, formatCheckpointTimeoutHint, readRequestIndexStates } from '../src/core/persistence/checkpoint-validation.ts';
import { persistenceOperations } from '../src/core/ops/persistence.ts';
import { printManagedSyncDiagnostic } from '../src/commands/sync-diagnostics.ts';
import { WRITE_ERROR_CODES } from '../src/core/persistence/types.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

// #5762: the managed sync checkpoint validation ran one OR predicate with a
// correlated sub-select over all of persistence_requests under the
// coordinator's 5 s statement timeout; a timeout was released as
// database_contention and retried ahead of every other write to the source.

const home = mkdtempSync(join(tmpdir(), 'gbrain-5762-'));
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv(env, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv(env, async () => { for (const engine of engines) await fn(engine); });

async function fixture(engine: BrainEngine) {
  const id = `ck-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of ['a', 'b']) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nObservation ${name} for the checkpoint.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'content');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true, explicitProcessing: [] } };
}

/** The validation statement exactly as it ran before #5762, kept only to prove parity. */
const LEGACY_SQL = `SELECT r.id FROM persistence_requests r WHERE r.worktree_id=$1::uuid AND
  (r.recovery IS NOT NULL OR (r.intent->>'runId'=$2 AND r.intent->>'kind' IN ('managed_sync_import','managed_sync_delete') AND r.state<>'committed'
    AND (r.state IN ('queued','running','recovering') OR NOT EXISTS (SELECT 1 FROM persistence_requests committed
      WHERE committed.source_id=r.source_id AND committed.intent->>'runId'=$2 AND committed.intent->>'index'=r.intent->>'index' AND committed.state='committed')))) LIMIT 1`;

test('#5762 the three index probes find exactly what the former predicate found', async () => each(async engine => {
  const f = await fixture(engine);
  const binding = (await getWorktreeBinding(engine, f.id))!;
  const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text FROM sources WHERE id=$1', [f.id]);
  const insert = async (runId: string, index: number, state: string, opts: { kind?: string; recovery?: boolean; worktree?: boolean } = {}) =>
    engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,worktree_id,
      digest,intent,authority,intent_bytes,terminal_reservation,state,recovery) VALUES('local_cli','parity',$1::uuid,'submit_job',$2,$3::uuid,'p',$4::uuid,
      'd',$5::text::jsonb,'{}'::jsonb,1,16384,$6,$7::text::jsonb)`, [randomUUID(), f.id, source.incarnation, opts.worktree === false ? null : binding.worktree_id,
      JSON.stringify({ kind: opts.kind ?? 'managed_sync_import', runId, index }), state, opts.recovery ? JSON.stringify({ version: 1 }) : null]);
  const scenarios: Array<[string, Array<[number, string, { kind?: string; recovery?: boolean; worktree?: boolean }?]>]> = [
    ['complete', [[0, 'committed'], [1, 'committed']]],
    ['queued receipt', [[0, 'committed'], [1, 'queued']]],
    ['running receipt', [[0, 'running']]],
    ['recovering receipt', [[0, 'recovering']]],
    ['failed without a committed retry', [[0, 'failed']]],
    ['failed then committed at the same index', [[0, 'failed'], [0, 'committed']]],
    ['cancelled without a committed retry', [[0, 'cancelled']]],
    ['conflict then committed at the same index', [[0, 'conflict'], [0, 'committed']]],
    ['a committed receipt with recovery still recorded', [[0, 'committed', { recovery: true }]]],
    ['a failed checkpoint request is not a page receipt', [[0, 'failed', { kind: 'managed_sync_checkpoint' }]]],
  ];
  for (const [name, rows] of scenarios) {
    await engine.executeRaw('DELETE FROM persistence_requests WHERE source_id=$1', [f.id]);
    const runId = randomUUID();
    for (const [index, state, opts] of rows) await insert(runId, index, state, opts);
    await insert(randomUUID(), 0, 'failed');
    const legacy = await engine.executeRaw(LEGACY_SQL, [binding.worktree_id, runId]);
    const probe = await findIncompleteSyncReceipt(engine, binding.worktree_id, runId);
    expect({ name, blocked: probe !== null }).toEqual({ name, blocked: legacy.length > 0 });
  }
  expect(await findIncompleteSyncReceipt(engine, binding.worktree_id, randomUUID())).toBeNull();
  await engine.executeRaw('DELETE FROM persistence_requests WHERE source_id=$1', [f.id]);
}), 180_000);

/** Makes the checkpoint's validation statement fail inside the coordinator's own transaction. */
function failValidation(engine: BrainEngine, failure: 'timeout' | 'lock'): () => void {
  const transaction = engine.transaction;
  engine.transaction = async function<T>(this: BrainEngine, run: (tx: BrainEngine) => Promise<T>): Promise<T> {
    return transaction.call(this, tx => run(new Proxy(tx, { get(target, property) {
      if (property === 'executeRaw') return async (sql: string, params?: unknown[]) => {
        if (sql !== INCOMPLETE_SYNC_RECEIPT_SQL) return target.executeRaw(sql, params);
        // Postgres raises a real statement timeout under the coordinator's own 5 s budget; PGLite has none, so the error is injected.
        if (failure === 'timeout' && engine.kind === 'postgres') return target.executeRaw('SELECT pg_sleep(8)::text AS request_id');
        throw Object.assign(new Error(failure === 'timeout' ? 'canceling statement due to statement timeout' : 'canceling statement due to lock timeout'),
          { code: failure === 'timeout' ? '57014' : '55P03' });
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    } }) as BrainEngine)) as Promise<T>;
  } as BrainEngine['transaction'];
  return () => { engine.transaction = transaction; };
}

test('#5762 a validation statement timeout fails the checkpoint terminally with a typed code and a filled hint; other writes proceed', async () => each(async engine => {
  const f = await fixture(engine);
  const restore = failValidation(engine, 'timeout');
  let result: Awaited<ReturnType<typeof performManagedSync>>;
  try {
    result = await performManagedSync(engine, f.opts);
    // A real 5 s statement timeout outlasts the sync's own 5 s wait; the same options then report the terminal outcome.
    for (let waited = 0; result.status === 'partial' && waited < 30_000; waited += 250) {
      await new Promise(resolve => setTimeout(resolve, 250));
      const [row] = await engine.executeRaw<{ state: string }>("SELECT state FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint'", [f.id]);
      if (row?.state === 'failed') result = await performManagedSync(engine, f.opts);
    }
  } finally { restore(); }
  expect(result).toMatchObject({ status: 'blocked_by_failures', failureCodes: [{ code: 'checkpoint_validation_timeout', count: 1 }] });
  const diagnostic = result.managedWrite!;
  expect(diagnostic).toMatchObject({ write_error: 'checkpoint_validation_timeout', reason: 'checkpoint_validation_timeout', detail: 'indexes_valid',
    docs: 'docs/guides/write-refusals.md#checkpoint-validation-timeout', write_request: { state: 'failed' } });
  expect(diagnostic.suggestion).toContain(`gbrain sync --source ${f.id} --no-pull --retry-failed --no-embed --no-extract`);
  expect(diagnostic.suggestion).toContain(diagnostic.write_request.request_id);
  const [checkpoint] = await engine.executeRaw<{ state: string; error_code: string; blocked_reason: string | null }>(
    "SELECT state,error_code,blocked_reason FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint'", [f.id]);
  expect(checkpoint).toEqual({ state: 'failed', error_code: 'checkpoint_validation_timeout', blocked_reason: null });
  const lines: string[] = [];
  printManagedSyncDiagnostic(result, { write: (line: string) => lines.push(line) } as unknown as NodeJS.WriteStream);
  expect(lines.join('')).toContain('Docs: docs/guides/write-refusals.md#checkpoint-validation-timeout');

  // Nothing is left queued ahead of other writes to the source.
  await engine.transaction(tx => withCoordinatedWrite(tx, [f.id], () => tx.executeRaw("UPDATE pages SET title='edited' WHERE source_id=$1 AND slug='a'", [f.id])));
  expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running','recovering')", [f.id])).toEqual([]);

  // The receipt rebuilds the same hint from its durable code after a restart.
  await disposePersistenceConsumer(engine);
  const ctx = { engine, config: { engine: engine.kind }, sourceId: f.id, remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const receipt = await persistenceOperations.find(op => op.name === 'get_write_request')!.handler(ctx, { request_id: diagnostic.write_request.request_id }) as Record<string, string>;
  expect(receipt).toMatchObject({ write_error: 'checkpoint_validation_timeout', detail: 'indexes_valid', docs: diagnostic.docs, suggestion: diagnostic.suggestion });

  // The printed retry admits a fresh run that commits.
  expect((await performManagedSync(engine, { ...f.opts, retryFailed: true })).status).toBe('first_sync');
}), 180_000);

test('#5762 a lock timeout in the validation stays transient contention', async () => each(async engine => {
  const f = await fixture(engine);
  const restore = failValidation(engine, 'lock');
  try { expect(await performManagedSync(engine, f.opts)).toMatchObject({ status: 'partial', reason: 'writer_pending' }); }
  finally { restore(); }
  const [checkpoint] = await engine.executeRaw<{ state: string; error_code: string | null }>(
    "SELECT state,error_code FROM persistence_requests WHERE source_id=$1 AND intent->>'kind'='managed_sync_checkpoint'", [f.id]);
  expect(checkpoint.error_code).toBeNull();
  expect(['queued', 'running']).toContain(checkpoint.state);
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
}), 180_000);

test('#5762 the hint names one of three index states and keeps the saved processing flags', async () => {
  const syncOptions = { full: false, workingTree: true, srcSubpath: null, exclude: [], includeHidden: [], strategy: null };
  const input = { requestId: 'req-1', sourceId: 'notes', processingOptions: { noEmbed: true, noExtract: false, noSchemaPack: true }, syncOptions };
  const retry = 'gbrain sync --source notes --no-pull --retry-failed --no-embed --no-schema-pack --working-tree';
  const building = formatCheckpointTimeoutHint([{ name: 'persistence_requests_sync_run_open', state: 'building',
    progress: { phase: 'building index: scanning table', blocks_done: 10, blocks_total: 40 } }], input);
  expect(building).toMatchObject({ detail: 'index_building' });
  expect(building.suggestion).toBe(`This release's request-index build is still running (persistence_requests_sync_run_open: building index: scanning table, 10/40 blocks). `
    + `Wait for it to finish (gbrain doctor shows persistence_request_indexes), then run: ${retry}`);
  const missing = formatCheckpointTimeoutHint([{ name: 'persistence_requests_sync_run_open', state: 'valid' },
    { name: 'persistence_requests_sync_run_committed', state: 'invalid' }], input);
  expect(missing).toMatchObject({ detail: 'index_missing' });
  expect(missing.suggestion).toBe(`The request index persistence_requests_sync_run_committed is INVALID. Rebuild it: gbrain repair request-indexes --apply — then run: ${retry}`);
  const valid = formatCheckpointTimeoutHint([{ name: 'persistence_requests_sync_run_open', state: 'valid' }], input);
  expect(valid.detail).toBe('indexes_valid');
  expect(valid.suggestion).toBe(`The request indexes are valid, so there is nothing to wait for. Run: ${retry}. If it times out again, report request req-1 `
    + 'and attach the persistence_request_indexes and persistence_request_growth entries of gbrain doctor --json.');
  expect(WRITE_ERROR_CODES).toContain('checkpoint_validation_timeout');
  // Every option that selects the cursor is printed, so the retry resumes the same cursor.
  expect(checkpointRetryCommand({ sourceId: 'notes', processingOptions: null, syncOptions: { full: true, workingTree: false, srcSubpath: 'docs/team a',
    exclude: ['drafts/**', "it's"], includeHidden: ['.notes'], strategy: 'markdown' } })).toBe(
    "gbrain sync --source notes --no-pull --retry-failed --full --src-subpath 'docs/team a' --exclude 'drafts/**' --exclude 'it'\\''s' --include-hidden .notes --strategy markdown");
  // A relative --src-subpath keeps the --repo base it resolved against.
  expect(checkpointRetryCommand({ sourceId: 'notes', processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: false },
    syncOptions: { ...syncOptions, workingTree: false, srcSubpath: 'guides' }, repoPath: '/work/repo/docs' }))
    .toBe('gbrain sync --source notes --no-pull --retry-failed --repo /work/repo/docs --no-embed --no-extract --src-subpath guides');
  // A compacted receipt, or a checkpoint admitted before its cursor options were recorded: no assumed defaults.
  expect(checkpointRetryCommand({ sourceId: 'notes', processingOptions: { noEmbed: true, noExtract: false, noSchemaPack: false } }))
    .toBe('gbrain sync --source notes --no-pull --retry-failed with the same options as the failed run (this receipt no longer records them)');
  expect(checkpointRetryCommand({ sourceId: 'notes' })).toBe('gbrain sync --source notes --no-pull --retry-failed with the same options as the failed run (this receipt no longer records them)');
});

test('#5762 a dropped index reads as missing and the hint then names the rebuild command', async () => each(async engine => {
  expect((await readRequestIndexStates(engine)).map(index => index.state)).toEqual(['valid', 'valid']);
  await engine.executeRaw('DROP INDEX persistence_requests_sync_run_committed');
  try {
    expect(await readRequestIndexStates(engine)).toEqual([{ name: 'persistence_requests_sync_run_open', state: 'valid' },
      { name: 'persistence_requests_sync_run_committed', state: 'missing' }]);
  } finally {
    const { PERSISTENCE_SYNC_RUN_COMMITTED_INDEX_SQL } = await import('../src/core/persistence/schema.ts');
    await engine.executeRaw(PERSISTENCE_SYNC_RUN_COMMITTED_INDEX_SQL);
  }
}), 60_000);
