/**
 * #6696 C3, revised by #6712 PR 1: `--retry-failed` on a managed source settles failures an older gbrain recorded under
 * other cursor keys. The per-row action classifier (`managed-retry-actions.ts`) is gone: a source has one cursor key, and
 * the current key folds older-key cursors in (the newest unfinished one finishes in place under its key, the rest are
 * superseded with their failure rows). A failure no cursor holds at all is named with the orphan repair that retires it.
 *
 * Fixture: one source configured with strategy `markdown`, two unfinished cursors an older gbrain left under its own keys
 * (a `--full` run, and a newer run with an `--exclude`), both recorded before cursors kept their options, and one failure
 * row with no cursor, for a file sync does not index (so no successful run settles it on its own).
 *
 * Regression that fails it: the "no longer records them" text, a legacy failure that survives the retry, or a cursor-less
 * row with no printed way out.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { runSyncInner } from '../src/commands/sync/run.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readManagedSyncFailures, recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { __setManagedCursorKeyForTests } from '../src/core/persistence/sync-cursor-key.ts';
import { managedSyncOrphansRepair } from '../src/core/repair/managed-sync-orphans.ts';
import { runRepair } from '../src/core/repair/core.ts';
import { repairSpec } from '../src/core/repair/registry.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-legacy-retry-'));
const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, GBRAIN_SOURCE: undefined, GBRAIN_SYNC_NO_DELEGATE: '1', GBRAIN_BRAIN_ID: 'host',
  GBRAIN_BACKUP_CHECK: 'off', GBRAIN_SYNC_NO_EXTRACT_NUDGE: '1', OPENAI_API_KEY: 'sk-test-legacy-retry' };
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const captured: string[] = [];
const orig = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr), log: console.log, error: console.error };
async function capture(fn: () => Promise<unknown>): Promise<string> {
  captured.length = 0;
  process.stdout.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { captured.push(String(chunk)); return true; }) as typeof process.stderr.write;
  console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); };
  try { await fn(); } finally { process.stdout.write = orig.out; process.stderr.write = orig.err; console.log = orig.log; console.error = orig.error; }
  process.exitCode = 0;
  return captured.join('\n');
}
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const ctx = (engine: BrainEngine) => ({ engine, config: { engine: 'pglite' }, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false } as unknown as OperationContext);

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: env.OPENAI_API_KEY } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => [1, ...new Array(1535).fill(0)]) })) as never);
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await withEnv({ GBRAIN_HOME: home }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.();
  rmSync(home, { recursive: true, force: true });
});

const cursorKeys = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ key: string; syncOptions: Record<string, unknown> | null }>(
  "SELECT fingerprint AS key,completed_keys->0->'syncOptions' AS \"syncOptions\" FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]));
/** A run recorded before cursors kept their options: strip them from the header. */
const stripOptions = (engine: BrainEngine, key: string) => engine.executeRaw(
  "UPDATE op_checkpoints SET completed_keys=jsonb_set(completed_keys,'{0}',(completed_keys->0)-'syncOptions') WHERE op='managed-sync' AND fingerprint=$1", [key]);
const failureKeys = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ key: string }>(
  "SELECT fingerprint AS key FROM op_checkpoints WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$1 ORDER BY fingerprint", [id])).map(row => row.key);

/** Runs one printed action exactly as an agent would: a sync argv through the CLI, the orphan repair as preview then apply. */
async function runAction(engine: BrainEngine, command: string): Promise<void> {
  const argv = command.split(' ');
  expect(argv[0]).toBe('gbrain');
  if (argv[1] === 'sync') { await capture(() => runSyncInner(engine, argv.slice(2))); return; }
  expect(argv.slice(1, 3)).toEqual(['repair', 'managed-sync-orphans']);
  const scope = { brain_id: 'host', source_ids: [argv[argv.indexOf('--source') + 1]!] };
  const preview = await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: false, explicit: true, spec: repairSpec('managed-sync-orphans') });
  await runRepair(ctx(engine), managedSyncOrphansRepair, scope, { apply: true, explicit: true, expect: preview.preview_hash, spec: repairSpec('managed-sync-orphans') });
}

/** A managed source configured with strategy `markdown`: four notes and one file sync does not index. */
async function fixture(engine: BrainEngine) {
  const id = `legacy-retry-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const root = join(home, id); mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (let i = 0; i < 4; i++) writeFileSync(join(root, 'notes', `n${i}.md`), `---\ntitle: Note ${i}\n---\nA durable observation number ${i} about acme-example.\n`);
  mkdirSync(join(root, 'assets')); writeFileSync(join(root, 'assets', 'data.bin'), Buffer.from([0, 1, 2, 3]));
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'notes');
  const head = git(root, 'rev-parse', 'HEAD');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,$3::text::jsonb)', [id, root, JSON.stringify({ strategy: 'markdown' })]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  const [{ incarnation }] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation::text AS incarnation FROM sources WHERE id=$1', [id]);
  const run = (opts: Partial<SyncOpts>, budget = { maxPages: 1, maxMs: 1000 }) =>
    performManagedSync(engine, { sourceId: id, noPull: true, ...opts } as SyncOpts, budget);
  /** A failure recorded before failures kept their run's options. */
  const failure = (cursor_key: string, path: string) => recordManagedSyncFailure(engine, { source_id: id, source_incarnation: incarnation, path, code: 'source_changed',
    message: 'file and database disagree', request_id: null, run_id: `run-${cursor_key.slice(0, 8)}`, target: head, cursor_key, phase: 'receipt', state: 'failed',
    observation_id: `${cursor_key}:0` });
  return { id, run, failure };
}
const actionLine = (out: string, label: RegExp) => {
  const found = out.split('\n').find(text => label.test(text));
  expect(found, `no line matching ${label} in:\n${out}`).toBeDefined();
  return found!.slice(found!.lastIndexOf(': ') + 2).trim();
};

/** Runs `fn` as an older gbrain whose cursor key for this source is `key`, with the other older cursor out of its sight. */
async function legacy<T>(engine: BrainEngine, key: string, fn: () => Promise<T>, hide?: string): Promise<T> {
  const park = (fingerprint: string, op: string) => engine.executeRaw("UPDATE op_checkpoints SET op=$2 WHERE fingerprint=$1 AND op IN ('managed-sync','managed-sync-parked')", [fingerprint, op]);
  __setManagedCursorKeyForTests(() => key);
  if (hide) await park(hide, 'managed-sync-parked');
  try { return await fn(); } finally { __setManagedCursorKeyForTests(null); if (hide) await park(hide, 'managed-sync'); }
}
const orphanCommand = (id: string) => `gbrain repair managed-sync-orphans --source ${id}`;

test('legacy failures under older keys: one --retry-failed folds their cursors in and settles them; the printed repair settles the cursor-less row', async () => withEnv(env, async () => { for (const engine of engines) {
  const { id, run, failure } = await fixture(engine);
  const fullKey = `${id}-full`, excludeKey = `${id}-exclude`;
  expect(await legacy(engine, fullKey, () => run({ full: true }))).toMatchObject({ status: 'partial' });
  expect(await legacy(engine, excludeKey, () => run({ exclude: ['archive/**'] }), fullKey)).toMatchObject({ status: 'partial' });
  await stripOptions(engine, fullKey); await stripOptions(engine, excludeKey);
  const noCursorKey = `legacy-${randomUUID()}`;
  await failure(fullKey, 'notes/n1.md'); await failure(excludeKey, 'notes/n2.md'); await failure(noCursorKey, 'assets/data.bin');
  expect((await readManagedSyncFailures(engine, [id])).filter(row => row.syncOptions)).toEqual([]);

  const out = await capture(() => runSyncInner(engine, ['--source', id, '--no-pull', '--retry-failed']));
  expect(out).not.toContain('this receipt no longer records them');
  expect(out).toContain('Retrying 3 previously-failed file(s)...');
  expect(out).toContain(`1 of them belong to no sync run any more`);
  expect(out).toContain(orphanCommand(id));
  // The newer older-key cursor finished in place under its own key; the --full one was superseded with its failure.
  expect((await cursorKeys(engine, id)).map(row => row.key)).toEqual([excludeKey]);
  expect(await failureKeys(engine, id)).toEqual([noCursorKey]);

  await runAction(engine, orphanCommand(id));
  expect(await failureKeys(engine, id)).toEqual([]);
  expect(await readManagedSyncFailures(engine, [id])).toEqual([]);
} }), 240_000);

test('a cursor-less legacy failure for a file no run imports is named with the orphan repair, which clears it', async () => withEnv(env, async () => { for (const engine of engines) {
  const { id, run, failure } = await fixture(engine);
  // A --full run that finished and was retired: its failure row outlived its cursor and never recorded the options.
  const fullKey = `${id}-full`;
  expect(await legacy(engine, fullKey, () => run({ full: true }, { maxPages: 1000, maxMs: 60_000 }))).toMatchObject({ status: 'first_sync' });
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint=$1", [fullKey]);
  await failure(fullKey, 'assets/data.bin');
  const out = await capture(() => runSyncInner(engine, ['--source', id, '--no-pull', '--retry-failed']));
  expect(out).not.toContain('this receipt no longer records them');
  expect(out).toContain(orphanCommand(id));
  expect(await failureKeys(engine, id)).toEqual([fullKey]);
  await runAction(engine, orphanCommand(id));
  expect(await failureKeys(engine, id)).toEqual([]);
} }), 240_000);
