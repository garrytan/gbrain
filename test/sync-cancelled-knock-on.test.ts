/**
 * #6402: a knock-on `cancelled` receipt is a retryable page fault, the same verdict sync's own `Next:` gives.
 *
 * Protects: `cancelled` is in the fault table (page / retry / not needs_human), so `sync status` hands the
 * loop the retry instead of paging a person; a group head whose window predecessor was never admitted is
 * cancelled with a message naming that request, not "an earlier page did not commit"; the failure ledger
 * restarts `first_seen`/`attempts` when a run targets a new commit (a `--retry-failed` of the same target keeps
 * counting, as `persistence-sync-failures.serial.test.ts` pins) and moves `updated_at`; a resume refused for conflicting
 * cursor options (`invalid_params`, a caller error) leaves the recorded diagnosis untouched.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readSyncStatus } from '../src/core/persistence/sync-status.ts';
import { classifySyncFault } from '../src/core/persistence/sync-fault-class.ts';
import { managedSyncRetryCommand, readManagedSyncFailures, recordManagedSyncFailure } from '../src/core/persistence/sync-failures.ts';
import { claimedHeadOrder, WINDOW_CANCEL_MESSAGE } from '../src/core/persistence/sync-window.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { localHostId, registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-6402-'));
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (body: string) => `---\ntitle: Example\n---\n${body}\n`;
async function fixture(files: Record<string, string>) {
  const id = `kc-${randomUUID().replace(/-/g, '').slice(0, 20)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const [path, body] of Object.entries(files)) writeFileSync(join(root, path), body);
  commit(root, 'fixture');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,'{}')", [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root, opts: { sourceId: id, noPull: true, noEmbed: true, noExtract: true } };
}
/** A managed run stopped on a recorded page failure, with its cursor unfinished. */
async function blockedRun() {
  const f = await fixture({ 'a.md': note('Alpha one.'), 'b.md': note('Beta one.') });
  expect((await performManagedSync(engine, f.opts)).status).toBe('first_sync');
  writeFileSync(join(f.root, 'a.md'), note('Alpha two.')); writeFileSync(join(f.root, 'b.md'), note('Beta two.'));
  commit(f.root, 'version two');
  writeFileSync(join(f.root, 'b.md'), note('Beta, uncommitted.'));
  await engine.setConfig('sync.holds', 'fail');
  try { expect((await performManagedSync(engine, f.opts)).status).toBe('blocked_by_failures'); }
  finally { await engine.executeRaw("DELETE FROM config WHERE key='sync.holds'"); }
  return f;
}

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

test('the classifier treats a knock-on cancel as a retryable page fault', () => {
  expect(classifySyncFault({ code: 'cancelled', message: WINDOW_CANCEL_MESSAGE })).toEqual({ class: 'page', safe_actions: ['retry'], needs_human: false });
});

test('sync status turns a cancelled knock-on into the retry sync prints, not a human page', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const f = await blockedRun();
  await engine.executeRaw(`UPDATE op_checkpoints SET completed_keys=jsonb_set(jsonb_set(completed_keys,'{0,code}','"cancelled"'),'{0,message}',to_jsonb($1::text))
    WHERE op='managed-sync-failure' AND completed_keys->0->>'source_id'=$2`, [WINDOW_CANCEL_MESSAGE, f.id]);
  const status = await readSyncStatus(engine, f.id);
  expect(status.last_error).toMatchObject({ code: 'cancelled', class: 'page', safe_actions: ['retry'], needs_human: false });
  expect(status.needs_human).toBe(false);
  const [failure] = await readManagedSyncFailures(engine, [f.id]);
  const printed = managedSyncRetryCommand(failure!).split(' ');
  expect([...status.next!.argv!].sort()).toEqual([...printed].sort());
}), 120_000);

test('a resume refused for conflicting cursor options leaves the recorded failure untouched', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const f = await blockedRun();
  const [before] = await readManagedSyncFailures(engine, [f.id]);
  expect(before!.code).toBe('source_changed');
  await expect(performManagedSync(engine, { ...f.opts, noEmbed: false, explicitProcessing: ['noEmbed'] })).rejects.toMatchObject({ code: 'invalid_params' });
  const [after] = await readManagedSyncFailures(engine, [f.id]);
  expect(after).toMatchObject({ code: 'source_changed', observation_id: before!.observation_id, attempts: before!.attempts });
}), 120_000);

test('the ledger restarts first_seen and attempts when the run targets a new commit, keeps counting a retry of the same target, and moves updated_at', async () => withEnv({ GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home }, async () => {
  const key = `ledger-${randomUUID()}`;
  const base = { source_id: 'default', source_incarnation: 'x', path: 'a.md', code: 'cancelled', message: WINDOW_CANCEL_MESSAGE, request_id: null,
    cursor_key: key, phase: 'receipt' as const, state: 'failed' };
  const updatedAt = async () => (await engine.executeRaw<{ t: string }>("SELECT updated_at::text AS t FROM op_checkpoints WHERE op='managed-sync-failure' AND fingerprint=$1", [key]))[0]!.t;
  const one = await recordManagedSyncFailure(engine, { ...base, target: 'c1', run_id: 'run-1', observation_id: 'run-1:0', first_seen: '2026-01-01T00:00:00.000Z' });
  expect(one.failure).toMatchObject({ attempts: 1, first_seen: '2026-01-01T00:00:00.000Z' });
  const t1 = await updatedAt();
  await new Promise(resolve => setTimeout(resolve, 20));
  const two = await recordManagedSyncFailure(engine, { ...base, target: 'c1', run_id: 'run-1b', observation_id: 'run-1b:0' });
  expect(two.failure).toMatchObject({ attempts: 2, first_seen: '2026-01-01T00:00:00.000Z' });
  const t2 = await updatedAt();
  expect(t2 > t1).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 20));
  const next = await recordManagedSyncFailure(engine, { ...base, target: 'c2', run_id: 'run-2', observation_id: 'run-2:0' });
  expect(next.failure.attempts).toBe(1);
  expect(next.failure.first_seen).not.toBe('2026-01-01T00:00:00.000Z');
  expect((await updatedAt()) > t2).toBe(true);
}));

test('a head whose window predecessor was never admitted is cancelled naming that request', async () => withEnv({ GBRAIN_HOME: home }, async () => {
  await registerLocalWriter(engine, 'cli');
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const ctx: OperationContext = { engine, config: { engine: 'pglite' }, dryRun: false, remote: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as OperationContext;
  const authority = await submissionAuthority(ctx, 'put_page', 'default', source!.incarnation, 'notes/knock-on');
  const missing = randomUUID();
  const intent = { content: note('Knock-on.'), after: missing };
  await admitWrite(engine, { principal: authority.principal, authority, operation: 'put_page', sourceId: 'default', sourceIncarnation: source!.incarnation,
    slug: 'notes/knock-on', pageId: null, requestId: randomUUID(), callerIntent: intent, intent });
  const head = (await claimNextWrite(engine, localHostId()))!;
  const settled = await claimedHeadOrder(engine, head, false);
  expect(Array.isArray(settled)).toBe(true);
  const [row] = settled as Awaited<ReturnType<typeof claimNextWrite>>[];
  expect(row!.state).toBe('cancelled');
  expect(row!.error_code).toBe('cancelled');
  expect(row!.error_message).toContain(missing);
  expect(row!.error_message).not.toBe(WINDOW_CANCEL_MESSAGE);
}));
