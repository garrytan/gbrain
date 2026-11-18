/**
 * The three memos of the worktree binding read answer the typed `getWorktreeBinding` member by its own key:
 * a group's preparation (group-publish.ts `preparationReads`), a batch's shared pre-admission reads
 * (page-mutations.ts `batchSharedReads`) and the per-process pre-admission cache (preadmit-cache.ts `preadmitReads`).
 *
 * Protects:
 * - two binding reads of one source and host in one preparation, batch or cache lifetime reach the engine once;
 * - a different source or host is its own read;
 * - an absent binding (null) is never kept, because a later member may claim the worktree and read it again
 *   (ownership.ts `claimWorktree` reads the binding it just made through the same engine);
 * - the group's shared read takes no member's read deadline (#6278), like the shared source read.
 * Fails when a memo keys the binding by a statement text the typed member never sends (the memo is then dead and
 * every member reads the binding again), or when a memo keeps a null binding.
 * No database: each engine is a counting fake.
 */
import { afterEach, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { WorktreeBinding } from '../src/core/persistence/ownership.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';
import { batchSharedReads } from '../src/core/persistence/page-mutations.ts';
import { dropPreadmitCache, preadmitReads } from '../src/core/persistence/preadmit-cache.ts';
import { resetWriteSwitches } from '../src/core/persistence/switches.ts';
import { readDeadline, withReadDeadline } from '../src/core/read-deadline.ts';

const HOST = '00000000-0000-4000-8000-000000000001';
const OTHER_HOST = '00000000-0000-4000-8000-000000000002';

function bindingFor(sourceId: string): WorktreeBinding {
  return {
    source_id: sourceId, source_incarnation: 'inc-1', worktree_id: 'wt-1', relative_path: '', topology_generation: '1',
    owner_host_id: HOST, owner_epoch: '1', state: 'active', local_path: '/brain', coordination_path: '/brain/.coord',
    git_durability: null, prepared_at: null, canonical_git: false,
  } as unknown as WorktreeBinding;
}

/** A fake engine that counts its typed binding reads; `bound` lists the sources that have a binding. */
function countingEngine(bound: ReadonlySet<string>, extra: Record<string, unknown> = {}) {
  const calls: Array<{ sourceId: string; hostId: string | null; deadline: number | undefined }> = [];
  const engine = {
    kind: 'postgres',
    getWorktreeBinding: async (sourceId: string, hostId: string | null) => {
      calls.push({ sourceId, hostId, deadline: readDeadline() });
      return bound.has(sourceId) ? bindingFor(sourceId) : null;
    },
    executeRaw: async (sql: string) => (/persistence_brain/.test(sql) ? [{ brain_id: 'brain-1' }] : []),
    getConfigValues: async () => [],
    ...extra,
  } as unknown as BrainEngine;
  return { engine, calls };
}

afterEach(() => { resetWriteSwitches(); });

test('a group preparation reads one binding once, a different key again, and keeps no null binding', async () => {
  const { engine, calls } = countingEngine(new Set(['default']));
  const reads = preparationReads(engine);
  const [a, b] = await Promise.all([reads.getWorktreeBinding('default', HOST), reads.getWorktreeBinding('default', HOST)]);
  expect(a?.local_path).toBe('/brain');
  expect(b?.local_path).toBe('/brain');
  expect(await reads.getWorktreeBinding('default', HOST)).not.toBeNull();
  expect(calls.filter(call => call.sourceId === 'default' && call.hostId === HOST)).toHaveLength(1);
  await reads.getWorktreeBinding('default', OTHER_HOST);
  expect(calls).toHaveLength(2);
  expect(await reads.getWorktreeBinding('unbound', HOST)).toBeNull();
  expect(await reads.getWorktreeBinding('unbound', HOST)).toBeNull();
  expect(calls.filter(call => call.sourceId === 'unbound')).toHaveLength(2);
});

test('a group preparation\'s shared binding read takes no member\'s read deadline', async () => {
  const { engine, calls } = countingEngine(new Set(['default']));
  const reads = preparationReads(engine);
  await withReadDeadline(Date.now() + 60_000, () => reads.getWorktreeBinding('default', HOST));
  expect(calls).toHaveLength(1);
  expect(calls[0]!.deadline).toBeUndefined();
});

test('a batch\'s shared reads answer one binding once, a different key again, and keep no null binding', async () => {
  const { engine, calls } = countingEngine(new Set(['default']));
  const reads = batchSharedReads(engine);
  await reads.getWorktreeBinding('default', HOST);
  const again = await reads.getWorktreeBinding('default', HOST);
  expect(again?.local_path).toBe('/brain');
  expect(calls).toHaveLength(1);
  await reads.getWorktreeBinding('other', HOST);
  expect(calls).toHaveLength(2);
  expect(await reads.getWorktreeBinding('unbound', HOST)).toBeNull();
  expect(await reads.getWorktreeBinding('unbound', HOST)).toBeNull();
  expect(calls.filter(call => call.sourceId === 'unbound')).toHaveLength(2);
});

test('the pre-admission cache answers an active local binding once and never keeps an absent one', async () => {
  const { engine, calls } = countingEngine(new Set(['default']));
  try {
    const first = await preadmitReads(engine);
    expect(first).not.toBeNull();
    expect((await first!.getWorktreeBinding('default', HOST))?.local_path).toBe('/brain');
    // A second write's pre-admission view of the same engine, inside the TTL.
    const second = await preadmitReads(engine);
    expect((await second!.getWorktreeBinding('default', HOST))?.local_path).toBe('/brain');
    expect(calls).toHaveLength(1);
    await second!.getWorktreeBinding('default', OTHER_HOST);
    expect(calls).toHaveLength(2);
    expect(await second!.getWorktreeBinding('unbound', HOST)).toBeNull();
    expect(await second!.getWorktreeBinding('unbound', HOST)).toBeNull();
    expect(calls.filter(call => call.sourceId === 'unbound')).toHaveLength(2);
  } finally { dropPreadmitCache(engine); }
});
