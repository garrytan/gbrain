/**
 * #6712 PR 4b lane C: what the cursor adoption tests protected, on the live pass (design v3.2 §3.5, §3.6).
 *
 * A non-company source no longer keeps a cursor to adopt, so these replace persistence-sync-cursor-adoption.test.ts and
 * the fan-in half of persistence-sync-cursor-strategy-6696.test.ts. Protects:
 * - every request a pass admits carries the authority of the writer that admitted it, when several local writers run
 *   the passes of one source in turn;
 * - a revoked writer's pass is refused and admits nothing; another writer's pass converges;
 * - the legacy handover (`retireLegacyCursors`): a pass waits (`writer_pending`, naming the request) while a request under
 *   an older binary's unfinished cursor is running, then retires it and converges; a remote job retires nothing and
 *   names the brain host (`reconcile_host_required`), leaving every cursor row and request as it was; a pass killed
 *   right after it superseded an older cursor leaves that cursor retired, and the next pass converges.
 * Synthetic content only.
 */
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
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { resolveManagedSyncContext } from '../src/core/persistence/sync-discovery.ts';
import { managedSyncAuthority } from '../src/core/persistence/sync-authority.ts';
import { syncCursorOptions } from '../src/core/persistence/sync-slices.ts';
import { prepareRemoteJob, withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-pass-handover-'));
const homes = { a: join(home, 'writer-a'), b: join(home, 'writer-b'), c: join(home, 'writer-c') };
let engine: PGLiteEngine;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
beforeAll(async () => {
  for (const dir of Object.values(homes)) mkdirSync(dir, { recursive: true });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
}, 120_000);
afterEach(() => installFaultHook(undefined));
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: homes.a }, async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });
  rmSync(home, { recursive: true, force: true });
});
const NAMES = ['a', 'b', 'c', 'd'];
async function fixture() {
  const id = `handover-${randomUUID().slice(0, 12)}`, root = join(home, id);
  mkdirSync(root); git(root, 'init', '-q');
  for (const name of NAMES) writeFileSync(join(root, `${name}.md`), `---\ntitle: ${name}\n---\nA durable observation named ${name} at acme-example.\n`);
  git(root, 'add', '.'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'seed');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, root };
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
const opts = (sourceId: string): SyncOpts => ({ sourceId, noPull: true, noEmbed: true, noExtract: true });
const requests = async (id: string) => engine.executeRaw<{ request_id: string; principal_id: string; kind: string; state: string; writer: string | null }>(
  `SELECT request_id::text AS request_id, principal_id, intent->>'kind' AS kind, state, intent->'syncAuthority'->'writer'->'principal'->>'id' AS writer
     FROM persistence_requests WHERE source_id=$1 ORDER BY sequence`, [id]);
const cursorRows = async (id: string) => (await engine.executeRaw<{ key: string }>(
  "SELECT fingerprint AS key FROM op_checkpoints WHERE op='managed-sync' AND completed_keys->0->>'sourceId'=$1 ORDER BY fingerprint", [id])).map(row => row.key);
const livePages = async (id: string) => (await engine.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY slug', [id])).map(row => row.slug);
const minutesAgo = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

/** An unfinished cursor (and its manifest) an older binary left under `key` for the source, admitting nothing yet. */
async function legacyCursor(id: string, root: string, key: string, ageMinutes: number) {
  const incarnation = (await engine.executeRaw<{ i: string }>('SELECT incarnation::text AS i FROM sources WHERE id=$1', [id]))[0]!.i;
  const context = await resolveManagedSyncContext(engine, opts(id) as never);
  const authority = await managedSyncAuthority(engine, id, incarnation, root);
  const entries = NAMES.map(name => ({ path: `${name}.md`, sourcePath: `${name}.md`, action: 'import', working: false, slug: name, pageId: null, revision: null }));
  const binding = { ...context.binding, owner_epoch: String((context.binding as { owner_epoch?: unknown }).owner_epoch), topology_generation: String(context.binding.topology_generation) };
  const runId = `run-${key}`;
  const cursor = { binding, root: context.root, gitRoot: context.gitRoot, sourceId: id, incarnation, from: null, target: git(root, 'rev-parse', 'HEAD'), slugMode: 'git-root',
    discoveredAt: minutesAgo(ageMinutes), runId, index: 0, total: entries.length, authority, processingOptions: { noEmbed: true, noExtract: true, noSchemaPack: false },
    syncOptions: syncCursorOptions(opts(id)), counts: { added: 0, modified: 0, deleted: 0, chunks: 0 } };
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,$4::timestamptz)',
    ['managed-sync', key, JSON.stringify([cursor]), minutesAgo(ageMinutes)]);
  await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys,updated_at) VALUES($1,$2,$3::text::jsonb,$4::timestamptz)',
    ['managed-sync-manifest', runId, JSON.stringify(entries), minutesAgo(ageMinutes)]);
  return { incarnation, runId };
}

test('every request a pass admits carries the authority of the writer that admitted it, across writers taking turns', async () => as('a', async () => {
  const { id } = await fixture();
  expect(await as('a', () => performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 }))).toMatchObject({ status: 'partial' });
  expect((await as('b', () => performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 }))).status).toBe('partial');
  expect((await as('c', () => performManagedSync(engine, opts(id)))).status).toBe('first_sync');
  const rows = await requests(id);
  expect(new Set(rows.map(row => row.request_id)).size).toBe(rows.length);
  expect(rows.filter(row => row.kind === 'managed_sync_import').every(row => row.state === 'committed')).toBe(true);
  for (const row of rows.filter(row => row.writer !== null)) expect(row.principal_id).toBe(row.writer!);
  expect(new Set(rows.filter(row => row.kind === 'managed_sync_import').map(row => row.principal_id)).size).toBe(3);
  expect(await livePages(id)).toEqual(NAMES);
}), 180_000);

test('a revoked writer\'s pass is refused and admits nothing; another writer\'s pass converges', async () => as('a', async () => {
  const { id } = await fixture();
  expect(await as('b', () => performManagedSync(engine, opts(id), { maxPages: 1, maxMs: 1000 }))).toMatchObject({ status: 'partial' });
  const revoked = (await requests(id))[0]!.principal_id;
  await engine.executeRaw('UPDATE persistence_local_writers SET revoked_at=now() WHERE id=$1::uuid', [revoked]);
  const before = (await requests(id)).filter(row => row.principal_id === revoked);
  expect(before.length).toBeGreaterThan(0);
  const refused = await as('b', () => performManagedSync(engine, opts(id))).then(() => null, (error: unknown) => error);
  expect(refused).toMatchObject({ code: 'permission_denied' });
  expect((await requests(id)).filter(row => row.principal_id === revoked)).toEqual(before);
  expect((await as('c', () => performManagedSync(engine, opts(id)))).status).toBe('first_sync');
  expect((await requests(id)).filter(row => row.principal_id === revoked)).toEqual(before);
  expect(await livePages(id)).toEqual(NAMES);
}), 180_000);

test('a request still running under an older binary\'s unfinished cursor keeps the pass waiting; once it settles the pass retires the cursor and converges', async () => as('a', async () => {
  const { id, root } = await fixture();
  const key = `legacy-running-${id}`;
  const { incarnation, runId } = await legacyCursor(id, root, key, 60);
  const requestId = randomUUID();
  await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
      state,intent,updated_at,admitter_version)
    VALUES('local_cli','fixture',$1::uuid,'submit_job',$2,$3::uuid,'a',$4,'{}'::jsonb,0,0,'running',$5::text::jsonb,now(),'0.60.262.0')`,
    [requestId, id, incarnation, randomUUID(), JSON.stringify({ kind: 'managed_sync_import', cursorKey: key, runId, index: 0 })]);
  const waited = await performManagedSync(engine, opts(id));
  expect(waited).toMatchObject({ status: 'partial', reason: 'writer_pending', retryWait: { request_id: requestId, state: 'running' } });
  expect(await cursorRows(id)).toEqual([key]);
  expect(await livePages(id)).toEqual([]);
  await engine.executeRaw("UPDATE persistence_requests SET state='committed', completed_at=now() WHERE request_id=$1::uuid", [requestId]);
  const converged = await performManagedSync(engine, opts(id));
  expect(converged.status).toBe('first_sync');
  expect(await cursorRows(id)).toEqual([]);
  expect(await livePages(id)).toEqual(NAMES);
}), 180_000);

test('a remote job retires no unfinished local cursor: it names the brain host, every cursor row and request stays, and the host CLI then converges', async () => as('a', async () => {
  const { id, root } = await fixture();
  const newest = `legacy-newest-${id}`, older = `legacy-older-${id}`;
  await legacyCursor(id, root, older, 60);
  await legacyCursor(id, root, newest, 10);
  const before = { cursors: await cursorRows(id), requests: await requests(id) };
  expect(before.cursors).toEqual([newest, older].sort());
  const clientId = `handover-client-${randomUUID()}`;
  await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_name,client_secret_hash,scope,source_id,allowed_operations)
    VALUES($1,'example-client','test-only','admin',$2,ARRAY['submit_job'])`, [clientId, id]);
  try {
    const ctx = { engine, remote: true, sourceId: id, auth: { clientId, principal: { kind: 'oauth_client', id: clientId }, scopes: ['admin'], sourceId: id,
      allowedOperations: ['submit_job'] } } as unknown as OperationContext;
    const accepted = await prepareRemoteJob(ctx, 'sync', { noPull: true });
    const remote = await withSubmissionAuthority(accepted.authority, () => performManagedSync(engine, { ...accepted.data } as SyncOpts));
    expect({ status: remote.status, reason: remote.reason ?? null }).toEqual({ status: 'blocked_by_failures', reason: 'reconcile_host_required' });
  } finally { await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id=$1', [clientId]); }
  expect({ cursors: await cursorRows(id), requests: await requests(id) }).toEqual(before);
  expect(await livePages(id)).toEqual([]);
  expect((await performManagedSync(engine, opts(id))).status).toBe('first_sync');
  expect(await cursorRows(id)).toEqual([]);
  expect(await livePages(id)).toEqual(NAMES);
}), 180_000);

test('a pass killed right after it superseded an older cursor leaves that cursor retired, and the next pass converges', async () => as('a', async () => {
  const { id, root } = await fixture();
  const newest = `legacy-newest-${id}`, older = `legacy-older-${id}`;
  await legacyCursor(id, root, older, 60);
  await legacyCursor(id, root, newest, 10);
  installFaultHook(async (point, detail) => { if (point === 'sync:cursor_adopted' && detail.sourceId === id) throw new Error('killed after the supersede'); });
  await expect(performManagedSync(engine, opts(id))).rejects.toThrow('killed after the supersede');
  installFaultHook(undefined);
  expect(await cursorRows(id)).toEqual([newest]);
  expect(await livePages(id)).toEqual([]);
  expect((await performManagedSync(engine, opts(id))).status).toBe('first_sync');
  expect(await cursorRows(id)).toEqual([]);
  expect(await livePages(id)).toEqual(NAMES);
}), 180_000);
