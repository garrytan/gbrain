/**
 * BrainEngine parity: the worktree binding reads of `gbrain doctor` (orphan_bindings, the consumer diagnostics):
 * listOrphanBindingRows, listWorktreeIds and listOwnerBindings (engine-sql/doctor-persistence.ts), with rows present.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on the same worktree, host binding, source binding and request rows, each member answers the same rows
 *    on PGLite, Postgres (DATABASE_URL, en_US.utf8) and Rust (GBRAIN_TEST_RUST_ARM=1): orphaned bindings by source id
 *    bytewise with their reason and in-flight request count; every worktree id; the worktrees another host owns, oldest
 *    first, with the owner's path and the source ids bytewise.
 *  - Regression: on the parent the Rust arm answered [] for all three although its store keeps the rows, so doctor
 *    orphan_bindings reported no orphan and the consumer diagnostics no foreign owner on a Rust brain.
 *  - Why existing coverage misses it: doctor-persistence.test.ts calls the three on a brain with no binding, where []
 *    is the right answer on every arm.
 *  - Seam: none. The rows come from the typed writer claim (claimWorktreeBinding) and insertWriteRequest. Generated ids
 *    and times are mapped to names or compared by shape.
 */
import { describe, expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktreeBinding } from '../../src/core/engine-sql/worktree-claim.ts';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const HOST_A = '00000000-0000-4000-8000-00000000000a';
const HOST_B = '00000000-0000-4000-8000-00000000000b';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PG_TIME = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?\+00$/;
/** Writes land at distinct instants, so "oldest first" has one answer. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

interface Worktree { owner: string | null; state?: string; hosts?: string[]; sources?: Array<{ id: string; incarnation?: string }> }

/** One worktree with its host bindings and source bindings; a source binds its live incarnation unless one is given. */
async function worktree(engine: BrainEngine, w: Worktree): Promise<string> {
  const id = randomUUID();
  await claimWorktreeBinding(engine, async store => {
    await store.insertWorktree({ id, ownerHostId: w.owner, ownerEpoch: 1, ...(w.state ? { state: w.state as 'active' } : {}) });
    for (const host of w.hosts ?? []) {
      await store.insertHostBinding({ worktreeId: id, hostId: host, localPath: `/var/tmp/wt-${host.slice(-1)}-${id.slice(0, 4)}`, coordinationPath: '/var/tmp/coord', gitDurability: null });
    }
    for (const source of w.sources ?? []) {
      const live = await store.lockSource(source.id);
      await store.insertSourceBinding({ sourceId: source.id, incarnation: source.incarnation ?? live!.incarnation, worktreeId: id, relativePath: '', topologyGeneration: 1 });
    }
  });
  await tick();
  return id;
}

/** One queued request on `sourceId` at `incarnation`. */
async function queue(engine: BrainEngine, sourceId: string, incarnation: string, state: 'queued' | 'deferred' = 'queued'): Promise<void> {
  const keys = ['principal:local_cli:binding-reads', 'brain'];
  await engine.lockPersistenceCounters(keys);
  await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'binding-reads', requestId: randomUUID(), operation: 'put_page', sourceId,
    sourceIncarnation: incarnation, pageId: null, slug: `notes/${randomUUID().slice(0, 8)}`, worktreeId: null, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: {}, authority: {}, intentBytes: 10, terminalReservation: 4096, targetKind: 'page',
    protocolVersion: 1, admitterVersion: 'v-test', admitterHostId: null, counterKeys: keys, clientRequestId: null,
    state, deferredRefreshId: null,
  });
}

describe('persistence binding reads', () => {
  parityTest(
    'listOrphanBindingRows names a removed source and a replaced incarnation by byte order, with its in-flight requests, and honours the limit',
    { methods: ['insertWriteRequest', 'listOrphanBindingRows'] },
    async (engine, backend) => {
      for (const id of ['ac', 'a-z', 'ab', 'live']) await createSource(engine, backend, id);
      const stale = randomUUID();
      const names = new Map<string, string>();
      names.set(await worktree(engine, { owner: HOST_A, hosts: [HOST_A], sources: [{ id: 'ab', incarnation: stale }, { id: 'live' }] }), 'w1');
      names.set(await worktree(engine, { owner: HOST_A, hosts: [HOST_A], sources: [{ id: 'a-z', incarnation: randomUUID() }, { id: 'gone-src', incarnation: randomUUID() }] }), 'w2');
      await queue(engine, 'ab', stale);
      await queue(engine, 'ab', stale, 'deferred');
      const view = (rows: Awaited<ReturnType<BrainEngine['listOrphanBindingRows']>>) => rows.map(r => {
        expect(r.source_incarnation).toMatch(UUID);
        return { source_id: r.source_id, worktree: names.get(r.worktree_id), reason: r.reason, pending: r.pending_requests };
      });
      const out = { all: view(await engine.listOrphanBindingRows(null)), first: view(await engine.listOrphanBindingRows(2)), zero: view(await engine.listOrphanBindingRows(0)) };
      expect(out.all).toEqual([
        { source_id: 'a-z', worktree: 'w2', reason: 'incarnation_replaced', pending: 0 },
        { source_id: 'ab', worktree: 'w1', reason: 'incarnation_replaced', pending: 2 },
        { source_id: 'gone-src', worktree: 'w2', reason: 'source_removed', pending: 0 },
      ]);
      expect(out.first).toEqual(out.all.slice(0, 2));
      expect(out.zero).toEqual(out.all);
      return out;
    },
  );

  parityTest(
    'listWorktreeIds answers every stored worktree id, retired and recovering ones too',
    { methods: ['listWorktreeIds'] },
    async (engine) => {
      const ids = [
        await worktree(engine, { owner: HOST_A }),
        await worktree(engine, { owner: null, state: 'recovering' }),
        await worktree(engine, { owner: HOST_B, state: 'retired' }),
      ];
      const listed = await engine.listWorktreeIds();
      for (const id of listed) expect(id).toMatch(UUID);
      const out = { count: listed.length, same: [...listed].sort().join() === [...ids].sort().join() };
      expect(out).toEqual({ count: 3, same: true });
      return out;
    },
  );

  parityTest(
    'listOwnerBindings lists the worktrees another host owns, oldest first, with the owner\'s path and its source ids by byte',
    { methods: ['listOwnerBindings'] },
    async (engine, backend) => {
      for (const id of ['ab', 'a-z', 'solo']) await createSource(engine, backend, id);
      const names = new Map<string, string>();
      names.set(await worktree(engine, { owner: HOST_B, hosts: [HOST_A, HOST_B], sources: [{ id: 'ab' }, { id: 'a-z' }] }), 'other-two-sources');
      names.set(await worktree(engine, { owner: HOST_A, hosts: [HOST_A], sources: [{ id: 'solo' }] }), 'mine');
      names.set(await worktree(engine, { owner: HOST_B, hosts: [HOST_B] }), 'other-no-source');
      names.set(await worktree(engine, { owner: HOST_B, state: 'recovering', hosts: [HOST_B] }), 'other-recovering');
      names.set(await worktree(engine, { owner: HOST_B, hosts: [HOST_A] }), 'other-unbound-owner');
      names.set(await worktree(engine, { owner: null, hosts: [HOST_A] }), 'unowned');
      const rows = await engine.listOwnerBindings(HOST_A);
      const out = rows.map(r => {
        expect(String(r.created_at)).toMatch(PG_TIME);
        expect(r.local_path).toBe(`/var/tmp/wt-b-${r.worktree_id.slice(0, 4)}`);
        return { worktree: names.get(r.worktree_id), owner: r.owner_host_id, source_ids: r.source_ids };
      });
      expect(out).toEqual([
        { worktree: 'other-two-sources', owner: HOST_B, source_ids: ['a-z', 'ab'] },
        { worktree: 'other-no-source', owner: HOST_B, source_ids: null },
      ]);
      const fromB = (await engine.listOwnerBindings(HOST_B)).map(r => names.get(r.worktree_id));
      expect(fromB).toEqual(['mine']);
      return { out, fromB };
    },
  );
});
