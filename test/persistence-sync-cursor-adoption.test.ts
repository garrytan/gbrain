import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SyncOpts } from '../src/commands/sync.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { __setManagedCursorKeyForTests, managedCursorKey, SUPERSEDED_BY_ADOPTION_MESSAGE } from '../src/core/persistence/sync-cursor-key.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

// #6712 PR 1: one cursor per source incarnation, adopted by whoever resumes it. What these tests protect:
//   - admitted requests keep their identity: they are read under the principal frozen in their own intent and publish
//     under it, while the resumer's authority is validated and stamped on the cursor in the adoption CAS and everything
//     frozen afterwards is admitted under the resumer (cross-principal, remote→local);
//   - a remote caller never adopts a local cursor (local→remote) and a revoked writer resumes nothing;
//   - the fan-in finishes an older key's newest unfinished cursor in place and supersedes the rest (their queued requests
//     cancelled), never retiring one whose request is still running, and never touching a company approval's cursor.
// The eng-review probe (adoption vs admitted-request identity) is the first test: a cross-principal adoption of a run
// whose admitted request is still running, new admissions after it, and a run stopped during checkpoint completion that
// a third writer finishes. On the base the resumer reads the admitted request under its own principal, misses it and
// admits it again under the same request_id.

const home = mkdtempSync(join(tmpdir(), 'gbrain-cursor-adoption-'));
const homes = { a: join(home, 'writer-a'), b: join(home, 'writer-b'), c: join(home, 'writer-c') };
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  for (const dir of Object.values(homes)) mkdirSync(dir, { recursive: true });
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engines.push(lite);
  if (process.env.DATABASE_URL) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterEach(() => installFaultHook(undefined));
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: homes.a }, async () => { for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); } });
  await closePostgres?.(); rmSync(home, { recursive: true, force: true });
});
async function fixture(engine: BrainEngine, names = ['a', 'b', 'c']) {
  const id = `adopt-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of names) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nA durable observation named ${name} at acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return id;
}
const env = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
/** Each writer is its own local CLI registration on the same host: the host identity is shared, the registration is not. */
function shareHost(writer: keyof typeof homes): void {
  const from = join(homes.a, '.gbrain', 'persistence', 'host.json'), dir = join(homes[writer], '.gbrain', 'persistence');
  if (writer === 'a' || !existsSync(from)) return;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, 'host.json'))) { copyFileSync(from, join(dir, 'host.json')); chmodSync(join(dir, 'host.json'), 0o600); }
}
const as = <T>(writer: keyof typeof homes, fn: () => Promise<T>) => { shareHost(writer); return withEnv({ GBRAIN_HOME: homes[writer], ...env }, fn); };
const each = (fn: (engine: BrainEngine) => Promise<void>) => as('a', async () => { for (const engine of engines) await fn(engine); });
const opts = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, noExtract: true });
const requests = async (engine: BrainEngine, id: string) => engine.executeRaw<{ request_id: string; principal_id: string; kind: string; state: string; writer: string }>(
  `SELECT request_id::text AS request_id, principal_id, intent->>'kind' AS kind, state, intent->'syncAuthority'->'writer'->'principal'->>'id' AS writer
     FROM persistence_requests WHERE source_id=$1 ORDER BY sequence`, [id]);
const cursorWriter = async (engine: BrainEngine, id: string) => (await engine.executeRaw<{ id: string }>(
  "SELECT completed_keys->0->'authority'->'writer'->'principal'->>'id' AS id FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1", [id]))[0]?.id;
/** Stalls the consumer's preparation of the matching request until released, so the run's wait ends with it admitted and running. */
function stallPreparation(match: (requestId: string) => Promise<boolean>) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  installFaultHook(async (point, detail) => { if (point === 'consumer:preparing' && detail.requestId && await match(detail.requestId)) await gate; });
  return release;
}

test('cross-principal adoption keeps every admitted request under its own principal: running members, new admissions, a stop during checkpoint completion', async () => each(async engine => {
  const id = await fixture(engine);
  const kindOf = async (requestId: string) => (await engine.executeRaw<{ kind: string }>("SELECT intent->>'kind' AS kind FROM persistence_requests WHERE request_id=$1::uuid", [requestId]))[0]?.kind;
  // Writer A commits one page.
  expect(await as('a', () => performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 }))).toMatchObject({ status: 'partial' });
  // Writer B admits the next page, whose preparation stalls: B's wait ends with it running.
  let release = stallPreparation(async rid => await kindOf(rid) === 'managed_sync_import');
  expect(await as('b', () => performManagedSync(engine, opts(id)))).toMatchObject({ status: 'partial', reason: 'writer_pending' });
  const [first, running] = await requests(engine, id);
  expect(running).toMatchObject({ state: 'running', kind: 'managed_sync_import' });
  expect(running!.principal_id).not.toBe(first!.principal_id);
  // Writer C adopts while B's request is still running, then admits the rest; its checkpoint's preparation stalls.
  const releaseB = release;
  release = stallPreparation(async rid => await kindOf(rid) === 'managed_sync_checkpoint');
  setTimeout(releaseB, 500);
  const byC = await as('c', () => performManagedSync(engine, opts(id)));
  expect(byC).toMatchObject({ status: 'partial', reason: 'writer_pending', cursorAdopted: { writer_changed: true } });
  // A (again) finishes the checkpoint C admitted, reading it under C's principal.
  setTimeout(release, 500);
  const byA = await as('a', () => performManagedSync(engine, opts(id)));
  expect(byA.status).toBe('first_sync');
  const rows = await requests(engine, id);
  expect(new Set(rows.map(row => row.request_id)).size).toBe(rows.length);
  expect(rows.map(row => [row.kind, row.state])).toEqual([['managed_sync_import', 'committed'], ['managed_sync_import', 'committed'],
    ['managed_sync_import', 'committed'], ['managed_sync_checkpoint', 'committed']]);
  // Every request was admitted by the writer whose authority it carries: A, B, C, C.
  for (const row of rows) expect(row.principal_id).toBe(row.writer);
  expect(rows[1]!.principal_id).toBe(running!.principal_id);
  expect(rows[2]!.principal_id).toBe(rows[3]!.principal_id);
  expect(new Set(rows.map(row => row.principal_id)).size).toBe(3);
  expect(await engine.getPage('c', { sourceId: id })).not.toBeNull();
}), 180_000);

test('remote→local: the host CLI adopts a remote job\'s unfinished cursor and admits the rest under its own grant', async () => each(async engine => {
  const id = await fixture(engine);
  const clientId = `adopt-client-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
    VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, id]);
  try {
    const ctx = { engine, remote: true, sourceId: id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: id,
      allowedOperations: ['submit_job'] } } as unknown as OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    expect(await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, { ...accepted.data } as SyncOpts, { maxPages: 1, maxMs: 1000 })))
      .toMatchObject({ status: 'partial' });
    expect(await cursorWriter(engine, id)).toBe(clientId);
    const local = await performManagedSync(engine, opts(id));
    expect(local).toMatchObject({ status: 'first_sync', cursorAdopted: { writer_changed: true } });
    const rows = await requests(engine, id);
    expect(rows[0]!.principal_id).toBe(clientId);
    expect(rows.slice(1).every(row => row.principal_id !== clientId && row.principal_id === row.writer)).toBe(true);
  } finally { await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id=$1', [clientId]); }
}), 180_000);

test('local→remote: a remote job never adopts a local cursor; it is told the host CLI resumes it', async () => each(async engine => {
  const id = await fixture(engine);
  expect(await performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
  const writer = await cursorWriter(engine, id);
  const clientId = `adopt-client-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
    VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, id]);
  try {
    const ctx = { engine, remote: true, sourceId: id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: id,
      allowedOperations: ['submit_job'] } } as unknown as OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    const refused = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, { ...accepted.data } as SyncOpts)).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'sync_in_progress', reason: 'local_resume_required', fix: { actor: 'user', argv: ['gbrain', 'sync', '--no-pull', '--source', id] } });
    expect(await cursorWriter(engine, id)).toBe(writer!);
    expect((await requests(engine, id)).every(row => row.principal_id !== clientId)).toBe(true);
  } finally { await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id=$1', [clientId]); }
  expect((await performManagedSync(engine, opts(id))).status).toBe('first_sync');
}), 180_000);

test('a revoked writer resumes nothing; another writer adopts its cursor and nothing more is admitted on the revoked grant', async () => each(async engine => {
  const id = await fixture(engine);
  expect(await as('b', () => performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 }))).toMatchObject({ status: 'partial' });
  const revoked = (await cursorWriter(engine, id))!;
  await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [revoked]);
  const refused = await as('b', () => performManagedSync(engine, opts(id))).then(() => null, (error: unknown) => error);
  expect(refused).toMatchObject({ code: 'permission_denied' });
  expect((await requests(engine, id)).filter(row => row.principal_id === revoked)).toHaveLength(1);
  expect((await as('c', () => performManagedSync(engine, opts(id)))).status).toBe('first_sync');
  expect((await requests(engine, id)).filter(row => row.principal_id === revoked)).toHaveLength(1);
  expect(await cursorWriter(engine, id)).not.toBe(revoked);
}), 180_000);

test('fan-in: the newest older-key cursor finishes in place; an older one is kept while its request runs, then superseded', async () => each(async engine => {
  const id = await fixture(engine, ['a', 'b', 'c', 'd']);
  const keys = async () => (await engine.executeRaw<{ key: string; done: string | null }>(
    "SELECT fingerprint AS key, completed_keys->0->>'done' AS done FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 ORDER BY fingerprint", [id]));
  const park = (key: string, op: string) => engine.executeRaw('UPDATE op_checkpoints SET op=$2 WHERE fingerprint=$1 AND op IN (\'managed-sync\',\'managed-sync-parked\')', [key, op]);
  let release = () => {};
  try {
    // An older binary's cursor (`legacy-newest`) that committed one page and has nothing open...
    __setManagedCursorKeyForTests(() => 'legacy-newest');
    expect(await performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
    await park('legacy-newest', 'managed-sync-parked');
    // ...and another (`legacy-running`) whose admitted request is still running.
    __setManagedCursorKeyForTests(() => 'legacy-running');
    release = stallPreparation(async () => true);
    expect(await performManagedSync(engine, opts(id))).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    await park('legacy-newest', 'managed-sync');
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '1 hour' WHERE op='managed-sync' AND fingerprint='legacy-running'");
  } finally { __setManagedCursorKeyForTests(null); }
  // The current key runs: the newest is adopted and finished in place; the running one is retained, never retired under its request.
  expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND intent->>'cursorKey'='legacy-running' AND state='running'", [id])).toHaveLength(1);
  // The pass waits for that request (writer_pending, naming it) instead of publishing beside it.
  const waited = await performManagedSync(engine, opts(id));
  expect(waited).toMatchObject({ status: 'partial', reason: 'writer_pending', retryWait: { state: 'running' }, cursorFanIn: { adopted: true, superseded: 0, retained: 1 } });
  release();
  installFaultHook(undefined);
  for (let i = 0; i < 100 && (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running')", [id])).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  const folded = await performManagedSync(engine, opts(id));
  expect({ status: folded.status, write: folded.managedWrite?.reason ?? null }).toEqual({ status: 'first_sync', write: null });
  expect(folded.cursorFanIn).toEqual({ adopted: true, superseded: 1, retained: 0 });
  expect((await keys()).map(row => row.key)).toEqual(['legacy-newest']);
  // The next run supersedes what is left of the older keys and finishes under the current key.
  writeFileSync(join(home, id, 'e.md'), '---\ntitle: e\n---\nA durable observation named e at acme-example.\n');
  git(join(home, id), 'add', '.'); git(join(home, id), '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'e');
  expect((await performManagedSync(engine, opts(id))).status).toBe('synced');
  const inc = (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [id]))[0]!.i;
  expect(await keys()).toEqual([{ key: managedCursorKey(inc, undefined), done: 'true' }]);
  expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state NOT IN ('committed','cancelled')", [id])).toHaveLength(0);
  const cancelled = await engine.executeRaw<{ message: string }>("SELECT error_message AS message FROM persistence_requests WHERE source_id=$1 AND state='cancelled'", [id]);
  for (const row of cancelled) expect(row.message).toBe(SUPERSEDED_BY_ADOPTION_MESSAGE);
  expect(await engine.getPage('e', { sourceId: id })).not.toBeNull();
}), 180_000);

test('fan-in is crash-safe: a run killed right after it supersedes an older-key cursor leaves it retired, and the next run finishes', async () => each(async engine => {
  const id = await fixture(engine, ['a', 'b', 'c', 'd']);
  const park = (key: string, op: string) => engine.executeRaw('UPDATE op_checkpoints SET op=$2 WHERE fingerprint=$1 AND op IN (\'managed-sync\',\'managed-sync-parked\')', [key, op]);
  const older = `${id}-older`, newest = `${id}-newest`;
  try {
    __setManagedCursorKeyForTests(() => older);
    expect(await performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
    await park(older, 'managed-sync-parked');
    __setManagedCursorKeyForTests(() => newest);
    expect(await performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
    await park(older, 'managed-sync');
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '1 hour' WHERE op='managed-sync' AND fingerprint=$1", [older]);
  } finally { __setManagedCursorKeyForTests(null); }
  for (let i = 0; i < 100 && (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running')", [id])).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  installFaultHook(async (point, detail) => { if (point === 'sync:cursor_adopted' && detail.sourceId === id) throw new Error('killed after the supersede'); });
  await expect(performManagedSync(engine, opts(id))).rejects.toThrow('killed after the supersede');
  installFaultHook(undefined);
  const cursors = async () => (await engine.executeRaw<{ key: string }>(
    "SELECT fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 ORDER BY fingerprint", [id])).map(row => row.key);
  expect(await cursors()).toEqual([newest]);
  const resumed = await performManagedSync(engine, opts(id));
  expect(resumed.status).toBe('first_sync');
  expect(resumed.cursorFanIn).toEqual({ adopted: true, superseded: 0, retained: 0 });
  for (const name of ['a', 'b', 'c', 'd']) expect(await engine.getPage(name, { sourceId: id })).not.toBeNull();
  expect(await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state NOT IN ('committed','cancelled')", [id])).toHaveLength(0);
  for (const row of await engine.executeRaw<{ message: string }>("SELECT error_message AS message FROM persistence_requests WHERE source_id=$1 AND state='cancelled'", [id])) {
    expect(row.message).toBe(SUPERSEDED_BY_ADOPTION_MESSAGE);
  }
}), 180_000);

// Outside-voice review: a request claimed between the fan-in's read and its retirement must still hold the pass back.
test('fan-in: a request claimed between the read and the retirement keeps the pass waiting (writer_pending), not draining beside it', async () => each(async engine => {
  const id = await fixture(engine, ['a', 'b', 'c', 'd']);
  const park = (key: string, op: string) => engine.executeRaw('UPDATE op_checkpoints SET op=$2 WHERE fingerprint=$1 AND op IN (\'managed-sync\',\'managed-sync-parked\')', [key, op]);
  const newest = `${id}-newest`, raced = `${id}-raced`;
  let release = () => {};
  try {
    __setManagedCursorKeyForTests(() => newest);
    expect(await performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
    await park(newest, 'managed-sync-parked');
    __setManagedCursorKeyForTests(() => raced);
    release = stallPreparation(async () => true);
    expect(await performManagedSync(engine, opts(id))).toMatchObject({ status: 'partial', reason: 'writer_pending' });
    await park(newest, 'managed-sync');
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '1 hour' WHERE op='managed-sync' AND fingerprint=$1", [raced]);
  } finally { __setManagedCursorKeyForTests(null); }
  // The fan-in's first read of the raced cursor's requests sees nothing open (the claim lands right after it).
  const execute = engine.executeRaw;
  let hidden = false;
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
    if (!hidden && sql.includes("intent->>'cursorKey'=$2") && sql.startsWith('SELECT * FROM persistence_requests') && params?.[1] === raced) { hidden = true; return []; }
    return execute.call(this, sql, params);
  } as BrainEngine['executeRaw'];
  let waited;
  try { waited = await performManagedSync(engine, opts(id)); } finally { engine.executeRaw = execute; }
  expect(hidden).toBe(true);
  expect(waited).toMatchObject({ status: 'partial', reason: 'writer_pending', retryWait: { state: 'running' }, cursorFanIn: { adopted: true, superseded: 0, retained: 1 } });
  release();
  installFaultHook(undefined);
  for (let i = 0; i < 100 && (await engine.executeRaw("SELECT 1 FROM persistence_requests WHERE source_id=$1 AND state IN ('queued','running')", [id])).length; i++) await new Promise(resolve => setTimeout(resolve, 100));
  expect((await performManagedSync(engine, opts(id))).status).toBe('first_sync');
}), 180_000);

// Outside-voice review: a remote caller refused adoption must not have cancelled or retired the local runs it passed over.
test('a remote job refused the local winner folds nothing in: every older-key cursor and its requests stay as they were', async () => each(async engine => {
  const id = await fixture(engine, ['a', 'b', 'c', 'd']);
  const park = (key: string, op: string) => engine.executeRaw('UPDATE op_checkpoints SET op=$2 WHERE fingerprint=$1 AND op IN (\'managed-sync\',\'managed-sync-parked\')', [key, op]);
  const newest = `${id}-newest`, older = `${id}-older`;
  const keys = async () => (await engine.executeRaw<{ key: string }>("SELECT fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 ORDER BY fingerprint", [id])).map(row => row.key);
  try {
    __setManagedCursorKeyForTests(() => older);
    expect(await performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
    await park(older, 'managed-sync-parked');
    __setManagedCursorKeyForTests(() => newest);
    expect(await performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 })).toMatchObject({ status: 'partial' });
    await park(older, 'managed-sync');
    await engine.executeRaw("UPDATE op_checkpoints SET updated_at=now()-interval '1 hour' WHERE op='managed-sync' AND fingerprint=$1", [older]);
  } finally { __setManagedCursorKeyForTests(null); }
  const before = { keys: await keys(), requests: await requests(engine, id) };
  expect(before.keys).toEqual([newest, older].sort());
  const clientId = `adopt-client-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
    VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, id]);
  try {
    const ctx = { engine, remote: true, sourceId: id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: id,
      allowedOperations: ['submit_job'] } } as unknown as OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    const refused = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, { ...accepted.data } as SyncOpts)).then(() => null, (error: unknown) => error);
    expect(refused).toMatchObject({ code: 'sync_in_progress', reason: 'local_resume_required' });
  } finally { await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id=$1', [clientId]); }
  expect({ keys: await keys(), requests: await requests(engine, id) }).toEqual(before);
  // The host CLI then folds them in.
  expect((await performManagedSync(engine, opts(id))).status).toBe('first_sync');
}), 180_000);

test('a company approval\'s cursor is never adopted or superseded by an ordinary run of the source', async () => each(async engine => {
  const id = await fixture(engine);
  const inc = (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [id]))[0]!.i;
  const header = { sourceId: id, incarnation: inc, runId: randomUUID(), index: 0, total: 0, companyReceiptId: 'receipt-example', counts: {} };
  await engine.executeRaw("INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES('managed-sync','company-example',$1::text::jsonb)", [JSON.stringify([header])]);
  const result = await performManagedSync(engine, opts(id));
  expect(result.status).toBe('first_sync');
  expect(result.cursorFanIn).toBeUndefined();
  expect(await engine.executeRaw("SELECT 1 FROM op_checkpoints WHERE op='managed-sync' AND fingerprint='company-example'")).toHaveLength(1);
  await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='managed-sync' AND fingerprint='company-example'");
}), 180_000);
