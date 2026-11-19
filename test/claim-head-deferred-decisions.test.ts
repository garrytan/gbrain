/**
 * The FIFO head read the engines run (engine-sql/persistence-claims.ts `claimHeadText`, written out from journal.ts
 * claimNextWrite and pinned to it by test/persistence-journal-statements.test.ts) holds five open-state lists of write
 * requests that leave `deferred` out. test/refresh-barrier-state-audit.test.ts records them; each case below proves one
 * decision on PGLite and, with DATABASE_URL, on Postgres.
 *
 * 1. Protects: a refresh's own member sync is never held behind a write that waits for that refresh, whether the deferred
 *    write sits ahead of the sync (the EARLIER_HEAD list of a worktree row) or behind it (the `waiting` list); a released
 *    deferred write is still ordered first (RELEASED_DEFERRED and the EARLIER_DEFERRED probe beside those lists). The two
 *    named-sync lists match managed sync rows, which are never deferred: admission defers no submit_job and an import hold
 *    takes no submit_job. The EARLIER_HEAD list of a row with no worktree matches rows that are never deferred: admission
 *    defers only a worktree write and an import hold needs a worktree.
 * 2. Fails when: someone adds `deferred` to one of those lists (the sync waits for a refresh that waits for it), drops the
 *    released-deferred ordering, or lets admission or an import hold defer a managed sync or a write with no worktree.
 * 3. Existing coverage: test/claim-fifo-foreground-waiting.test.ts covers released deferred rows next to sync rows; none
 *    covers an unreleased one or the deferral rules the named-sync and no-worktree lists depend on.
 * 4. Production seam: none (fixture topology and `deferred` rows are written directly under the replica role, as the fifo
 *    test does).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { admitWrite, claimNextWrite } from '../src/core/persistence/journal.ts';
import { submissionAuthority } from '../src/core/persistence/authority.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { holdForImport } from '../src/core/persistence/import-deferral.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { _resetRefreshBarrierCacheForTests } from '../src/core/persistence/refresh-barrier.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { editRequest } from './helpers/persistence-request-fixture.ts';
import { withEnv } from './helpers/with-env.ts';

const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const lite = new PGLiteEngine();
  await lite.connect({}); await lite.initSchema();
  engines.push(lite);
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push(pg.engine); closePostgres = pg.close;
  }
  for (const engine of engines) {
    await registerLocalWriter(engine, 'cli');
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  }
}, 120_000);
afterAll(async () => { await engines[0]?.disconnect(); await closePostgres?.(); });

const content = '---\ntitle: Example\ntype: note\n---\nA synthetic note.\n';

/** A new source bound to a worktree on its own host, so each scene's claims see only its own rows. */
async function scene(engine: BrainEngine) {
  const sourceId = `deferred-decision-${randomUUID().slice(0, 8)}`, host = randomUUID(), worktree = randomUUID();
  // The topology a fixture needs, set up without writer administration (replica role skips the managed-writer guard).
  const incarnation = await engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    await tx.executeRaw('INSERT INTO persistence_worktrees(id,owner_host_id) VALUES($1::uuid,$2::uuid)', [worktree, host]);
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [sourceId]);
    await tx.executeRaw('INSERT INTO persistence_source_bindings(source_id,source_incarnation,worktree_id) VALUES($1,$2::uuid,$3::uuid)', [sourceId, source!.incarnation, worktree]);
    return source!.incarnation;
  });
  const context: OperationContext = { engine, sourceId, remote: false, dryRun: false, config: { engine: engine.kind }, logger: { info() {}, warn() {}, error() {} } };
  /** Admits a write; `bound` admits it on the worktree (the deferral path), otherwise it is moved there afterwards. */
  const admit = async (operation: 'put_page' | 'submit_job', slug: string, opts: { kind?: string; bound?: boolean; worktree?: boolean } = {}) => {
    const authority = await submissionAuthority(context, operation, sourceId, incarnation, slug);
    const intent = opts.kind ? { slug, content, kind: opts.kind } : { slug, content };
    return admitWrite(engine, { principal: authority.principal, operation, sourceId, sourceIncarnation: incarnation, slug, pageId: null,
      requestId: randomUUID(), callerIntent: intent, intent, authority, deferrable: true,
      ...(opts.bound ? { worktreeId: worktree, topologyGeneration: 1 } : {}) });
  };
  const add = async (slug: string, kind?: string) => {
    const row = await admit('put_page', slug);
    await editRequest(engine, row.id, `worktree_id=$2::uuid${kind ? `,intent=jsonb_set(intent,'{kind}',to_jsonb($3::text))` : ''}`, kind ? [worktree, kind] : [worktree]);
    return row.id;
  };
  const sync = (slug: string) => add(slug, 'managed_sync_import');
  const refresh = async (state: 'draining' | 'syncing') => {
    const [row] = await engine.executeRaw<{ id: string }>(`INSERT INTO persistence_worktree_refreshes(worktree_id,source_ids,principal_id,owner_epoch,topology_generation,state,old_head,target_head,upstream_ref)
      VALUES($1::uuid,ARRAY[$2::text],$3::uuid,1,1,$4,'a','b','origin/main') RETURNING id::text`, [worktree, sourceId, randomUUID(), state]);
    return row!.id;
  };
  const release = (refreshId: string) => engine.executeRaw("UPDATE persistence_worktree_refreshes SET state='completed',completed_at=now(),released_at=now() WHERE id=$1::uuid", [refreshId]);
  /** Moves a queued write behind `refreshId`, as admission does during that refresh. */
  const defer = (id: string, refreshId: string) => engine.transaction(async tx => {
    await tx.executeRaw('SET LOCAL session_replication_role = replica');
    await tx.executeRaw("UPDATE persistence_requests SET state='deferred',deferred_refresh_id=$2::uuid WHERE id=$1::uuid", [id, refreshId]);
  });
  const seen: Record<string, string> = {};
  const claimRow = () => claimNextWrite(engine, host, 30_000, [], [], [], seen);
  const claim = async () => (await claimRow())?.id ?? null;
  const settle = (id: string) => editRequest(engine, id, `state='committed',execution_token=NULL,claim_expires_at=NULL,completed_at=now()`);
  const behindAll = async () => { seen[worktree] = (await engine.executeRaw<{ s: string }>('SELECT max(sequence)::text AS s FROM persistence_requests'))[0]!.s; };
  const state = async (id: string) => (await engine.executeRaw<{ state: string }>('SELECT state FROM persistence_requests WHERE id=$1::uuid', [id]))[0]!.state;
  return { sourceId, worktree, admit, add, sync, refresh, release, defer, claimRow, claim, settle, behindAll, state };
}

/** Runs `fn` per engine with the refresh barrier on. */
const each = (fn: (engine: BrainEngine) => Promise<void>) => withEnv({ GBRAIN_REFRESH_BARRIER: '1' }, async () => {
  resetWriteSwitches(); _resetRefreshBarrierCacheForTests();
  try { for (const engine of engines) await fn(engine); } finally { resetWriteSwitches(); _resetRefreshBarrierCacheForTests(); }
});

test('the waiting list: a write deferred behind a refresh holds back no member sync ahead of it; once released it goes first', () => each(async engine => {
  for (const released of [false, true]) {
    const s = await scene(engine);
    const refreshId = await s.refresh('syncing');
    const member = await s.sync('notes/member-a');
    const waiting = await s.add('notes/waiting-a');
    await s.defer(waiting, refreshId);
    if (released) await s.release(refreshId);
    await s.behindAll();
    expect(await s.claim()).toBe(released ? waiting : member);
  }
}), 60_000);

test('the EARLIER_HEAD list of a worktree row: a member sync behind a write deferred for its refresh is claimed; once released the write goes first', () => each(async engine => {
  for (const released of [false, true]) {
    const s = await scene(engine);
    const refreshId = await s.refresh('syncing');
    const waiting = await s.add('notes/waiting-b');
    await s.defer(waiting, refreshId);
    const member = await s.sync('notes/member-b');
    if (released) await s.release(refreshId);
    await s.behindAll();
    expect(await s.claim()).toBe(released ? waiting : member);
    if (released) { await s.settle(waiting); expect(await s.claim()).toBe(member); }
  }
}), 60_000);

test('the named-sync lists: a managed sync is never deferred, by an import hold or by admission during a refresh', () => each(async engine => {
  const s = await scene(engine);
  const queued = await s.admit('submit_job', 'notes/during-c', { kind: 'managed_sync_import', bound: true });
  expect(queued.state).toBe('queued');
  const claimed = await s.claimRow();
  expect(claimed?.id).toBe(queued.id);
  expect(await holdForImport(engine, claimed!, { importFrom: 'b' })).toBeNull();
  expect(await s.state(queued.id)).toBe('running');
  await s.settle(queued.id);
  await s.refresh('draining');
  const write = await s.admit('put_page', 'notes/during-c', { bound: true });
  expect(write.state).toBe('deferred');
  const synced = await s.admit('submit_job', 'notes/during-c', { kind: 'managed_sync_import', bound: true }).then(row => row.state, (error: { code?: string }) => error.code);
  expect(synced).toBe('worktree_refreshing');
}), 60_000);

test('the EARLIER_HEAD list of a row with no worktree: such a row is never deferred, by admission during a refresh or by an import hold', () => each(async engine => {
  const s = await scene(engine);
  await s.refresh('draining');
  const write = await s.admit('put_page', 'notes/unbound-d');
  expect(write.state).toBe('queued');
  const claimed = await s.claimRow();
  expect(claimed?.id).toBe(write.id);
  expect(await holdForImport(engine, claimed!, { importFrom: 'b' })).toBeNull();
  expect(await s.state(write.id)).toBe('running');
  await s.settle(write.id);
}), 60_000);
