/**
 * Claim fencing of the managed claim families on a multi-user Rust brain (lane LM slice 3, gate E1), through the typed engine
 * members and the napi addon (rust/crates/gbrain-store/src/persistence/claim_fence_tests.rs runs the same matrix in the store).
 *
 * Per family (grouped publication followers, coalesced Git effects, refresh rows, managed sync checkpoints):
 *  - a valid fenced claim, renewal, start, result and release succeeds and ends the claim;
 *  - a stale fence (the host lease taken over) refuses `lease_lost` / `epoch_moved` and changes no row;
 *  - a replacement-epoch fence (same host, new registration epoch) on the OLD claim refuses `claim_epoch_mismatch`;
 *  - a call with no fence on a multi-user brain is not refused for lacking one (multiuser rule: a caller with no host
 *    registered takes an implicit lease for a new claim) and refuses `held_by_another`, writing nothing, only on a claim a
 *    live registered holder owns;
 *  - the same calls with multi-user off and no fence behave as they always did.
 * The callers' own pass-through (`fenceOpts(engine)`) is checked for the group renewal, which reads the registered fence.
 *
 * The managed_persistence hold is lifted on each test engine (`liftManagedHold`); a user's engine keeps refusing.
 * Needs the addon `bun run rust:build` writes; skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRustAddon, type RustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { openRustEngine, type RustEngine } from '../src/core/rust-engine.ts';
import { rustLeases, type LeaseToken, type WriteOrigin } from '../src/core/rust-engine/store-members/leases.ts';
import { clearHostRegistration, setHostRegistration } from '../src/core/persistence/host-fence.ts';
import { renewGroupClaims } from '../src/core/persistence/journal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { liftManagedHold } from './engine-parity/rust-managed.ts';
import { withEnv } from './helpers/with-env.ts';

const TARGET = detectAddonTarget();
const BUILT = process.env.GBRAIN_RUST_ENGINE_ADDON
  ?? join(import.meta.dir, '..', 'rust', 'target', 'addon', `gbrain_engine.${TARGET ?? 'unsupported'}.node`);
const HAVE_ADDON = TARGET !== null && existsSync(BUILT);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT} does not exist; build the addon`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

const WT = 'f0000000-0000-4000-8000-0000000000a1';
const HOST = 'a0000000-0000-4000-8000-0000000000a1';
const holder = (host: string): WriteOrigin => ({ host_id: `${host}-host`, incarnation: `${host}-incarnation`, writer_id: 'local_cli:test' });

let addon: RustAddon | undefined;
const dirs: string[] = [];
const engines: RustEngine[] = [];

async function open(multiuser: boolean): Promise<RustEngine> {
  addon ??= await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: BUILT } });
  const path = mkdtempSync(join(tmpdir(), 'gbrain-rust-claim-fence-'));
  dirs.push(path);
  const engine = openRustEngine({ addon, databasePath: path });
  engines.push(engine);
  await engine.connect({ engine: 'pglite', database_path: path } as never);
  expect(engine.openStore('test').multiuser).toBe(multiuser);
  return liftManagedHold(engine);
}

/** Runs `run` on a fresh multi-user (or plain) engine; GBRAIN_RUST_MULTIUSER is only read at open. */
const on = <T>(multiuser: boolean, run: (engine: RustEngine) => Promise<T>) =>
  withEnv({ GBRAIN_RUST_MULTIUSER: multiuser ? '1' : undefined }, async () => run(await open(multiuser)));

async function refusal(fn: () => Promise<unknown>): Promise<{ code?: string; reason?: string }> {
  try { await fn(); } catch (error) { return { code: (error as OperationError).code, reason: (error as OperationError).reason }; }
  return {};
}
const lost = (reason: string) => ({ code: 'lease_lost', reason });

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.disconnect().catch(() => undefined);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A host registration: its lease token. `again` registers the same host under the next epoch; `takeover` is another host. */
const register = async (engine: RustEngine, host = 'a') => (await rustLeases(engine).acquire(`consumer:${host}-host`, holder(host), 600_000))!;
async function again(engine: RustEngine, old: LeaseToken): Promise<LeaseToken> {
  const leases = rustLeases(engine);
  await leases.release(old);
  const fresh = (await leases.acquire(old.name, holder('a'), 600_000))!;
  expect(fresh.epoch).toBe(old.epoch + 1);
  return fresh;
}
async function takeover(engine: RustEngine, old: LeaseToken): Promise<LeaseToken> {
  const leases = rustLeases(engine);
  await leases.release(old);
  return (await leases.acquire(old.name, holder('b'), 600_000))!;
}

const id = (n: number) => `b0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

async function admit(engine: RustEngine, n: number, intent: unknown, state: 'queued' = 'queued') {
  const membership = (await engine.readSourceMembership('default'))!;
  return engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'p1', requestId: id(n), operation: 'put_page', sourceId: 'default', sourceIncarnation: membership.incarnation,
    pageId: null, slug: `notes/n${n}`, worktreeId: WT, topologyGeneration: null, digest: 'd', intent, authority: {}, intentBytes: 10, terminalReservation: 4096,
    targetKind: 'page', protocolVersion: 1, admitterVersion: 'v', admitterHostId: null, counterKeys: [], clientRequestId: null, state, deferredRefreshId: null,
  });
}

describe('grouped publication followers', () => {
  async function setup(engine: RustEngine, followers = 3) {
    await (await engine.topologyStore()).insertWorktree(WT, HOST);
    const head = await admit(engine, 0, { kind: 'put_page' });
    for (let n = 1; n <= followers; n++) await admit(engine, n, { group: 'G' });
    return head;
  }
  const claim = async (engine: RustEngine, head: { worktree_id: string | null; sequence: string | number }, fence?: LeaseToken) =>
    (await engine.groupPublishStore()).claimFollowers({ worktree_id: head.worktree_id!, sequence: head.sequence }, 'sync:G', 10, 30_000, { pid: 1 }, fence ? { fence } : undefined);
  const members = (rows: Array<{ id: string; execution_token: string | null }>) => rows.map(r => ({ id: r.id, token: r.execution_token!, stamp: null }));
  const completion = (rows: Array<{ id: string; execution_token: string | null }>) =>
    rows.map(r => ({ id: r.id, token: r.execution_token!, outcome: '{"ok":true}', need: 100, principalKey: 'brain', retained: 0 }));
  const states = async (engine: RustEngine) => (await Promise.all([1, 2, 3].map(n => engine.readWriteRequest('local_cli', 'p1', id(n))))).map(r => r?.state);

  withAddon('a valid fenced group claims, renews, starts and completes; every member ends committed', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      const head = await setup(engine);
      const rows = await claim(engine, head, a);
      expect(rows).toHaveLength(3);
      const store = await engine.groupPublishStore();
      expect(await store.renewClaims(members(rows), 1000, { fence: a })).toHaveLength(3);
      expect(await store.markDispatched(members(rows), { fence: a })).toHaveLength(3);
      expect(await store.startPublication(rows.map(r => ({ id: r.id, token: r.execution_token! })), { fence: a })).toHaveLength(3);
      const done = await store.completeGroup(completion(rows), ['brain'], 'v', HOST, { fence: a });
      expect(done.map(r => r.state)).toEqual(['committed', 'committed', 'committed']);
    });
  });

  withAddon('a stale fence refuses every group entry and changes no row', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      const head = await setup(engine);
      const rows = await claim(engine, head, a);
      await takeover(engine, a);
      const before = await states(engine);
      const store = await engine.groupPublishStore();
      for (const call of [
        () => claim(engine, head, a),
        () => store.renewClaims(members(rows), 1000, { fence: a }),
        () => store.markDispatched(members(rows), { fence: a }),
        () => store.startPublication(rows.map(r => ({ id: r.id, token: r.execution_token! })), { fence: a }),
        () => store.completeGroup(completion(rows), ['brain'], 'v', HOST, { fence: a }),
        () => store.recordRecoveries(rows.map(r => ({ id: r.id, token: r.execution_token!, record: { k: 1 }, bytes: 5 })), 15, ['brain'], { fence: a }),
        () => store.clearRecoveries([], ['brain'], WT, { fence: a }),
      ]) expect(await refusal(call)).toEqual(lost('epoch_moved'));
      expect(await states(engine)).toEqual(before);
    });
  });

  withAddon('a replacement epoch of the same host cannot renew, start or complete the old claim', async () => {
    await on(true, async engine => {
      const a1 = await register(engine);
      const head = await setup(engine);
      const rows = await claim(engine, head, a1);
      const a2 = await again(engine, a1);
      const store = await engine.groupPublishStore();
      for (const call of [
        () => store.renewClaims(members(rows), 1000, { fence: a2 }),
        () => store.startPublication(rows.map(r => ({ id: r.id, token: r.execution_token! })), { fence: a2 }),
        () => store.completeGroup(completion(rows), ['brain'], 'v', HOST, { fence: a2 }),
      ]) expect(await refusal(call)).toEqual(lost('claim_epoch_mismatch'));
      expect(await states(engine)).toEqual(['running', 'running', 'running']);
    });
  });

  withAddon('a call with no fence on a multi-user brain is not refused for lacking one, and cannot touch a live holder\'s claim', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      const head = await setup(engine);
      const rows = await claim(engine, head, a);
      const store = await engine.groupPublishStore();
      // Every follower is claimed, so a claim with no fence takes nothing and is not refused.
      expect(await claim(engine, head)).toEqual([]);
      expect(await refusal(() => store.completeGroup(completion(rows), ['brain'], 'v', HOST))).toEqual(lost('held_by_another'));
      expect(await refusal(() => store.renewClaims(members(rows), 1000))).toEqual(lost('held_by_another'));
      expect(await states(engine)).toEqual(['running', 'running', 'running']);
    });
  });

  withAddon('a registered caller passes its own fence: the journal renewal runs under the registration', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      const head = await setup(engine);
      const rows = await claim(engine, head, a);
      const registration = { hostId: `a-host`, origin: holder('a'), fence: a };
      setHostRegistration(engine, registration);
      try {
        const held = await renewGroupClaims(engine, rows as never, 1000);
        expect(held.size).toBe(3);
        await takeover(engine, a);
        expect(await refusal(() => renewGroupClaims(engine, rows as never, 1000))).toEqual(lost('epoch_moved'));
      } finally { clearHostRegistration(engine, registration); }
    });
  });

  withAddon('multi-user off and no fence: the same calls behave as they always did', async () => {
    await on(false, async engine => {
      const head = await setup(engine);
      const rows = await claim(engine, head);
      expect(rows).toHaveLength(3);
      const store = await engine.groupPublishStore();
      expect(await store.renewClaims(members(rows), 1000)).toHaveLength(3);
      expect(await store.completeGroup(completion(rows), ['brain'], 'v', HOST)).toHaveLength(3);
      expect(await states(engine)).toEqual(['committed', 'committed', 'committed']);
    });
  });
});

describe('coalesced Git effects', () => {
  async function setup(engine: RustEngine, effects = 3) {
    await (await engine.topologyStore()).insertWorktree(WT, HOST);
    const membership = (await engine.readSourceMembership('default'))!;
    for (let n = 1; n <= effects; n++) {
      const request = await admit(engine, n, { kind: 'put_page' });
      await engine.insertPublicationEffects({ requestId: request.id, revision: null, sourceId: 'default', sourceIncarnation: membership.incarnation, worktreeId: WT,
        effects: [{ kind: 'git', data: { relative_path: `n${n}.md` } }] });
    }
  }
  const claim = (engine: RustEngine, fence?: LeaseToken) =>
    engine.claimCoalescedGitEffects<{ id: string; execution_token: string; state: string }>({ hostId: HOST, worktreeId: WT, limit: 10, deadOwners: [], ownerJson: JSON.stringify({ pid: 1 }), ...(fence ? { fence } : {}) });
  const refs = (rows: Array<{ id: string; execution_token: string }>) => rows.map(r => ({ id: String(r.id), token: r.execution_token }));

  withAddon('a coalesced claim records its epoch: it settles, yields and records its outcome under it', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      await setup(engine, 4);
      const rows = await claim(engine, a);
      expect(rows).toHaveLength(4);
      await engine.completeEffectRow({ id: rows[0]!.id, token: rows[0]!.execution_token, fence: a, outcomeJson: '{}' });
      const store = await engine.gitEffectStore();
      await store.yieldToPublications(refs(rows.slice(1, 2)), 1000, { fence: a });
      await store.recordPlainOutcome(refs(rows.slice(2)), '{"ok":true}', { fence: a });
    });
  });

  withAddon('a stale fence refuses the claim, the settle and the Git writes; a replacement epoch refuses claim_epoch_mismatch', async () => {
    await on(true, async engine => {
      const a1 = await register(engine);
      await setup(engine, 3);
      const rows = await claim(engine, a1);
      const store = await engine.gitEffectStore();
      const a2 = await again(engine, a1);
      expect(await refusal(() => engine.completeEffectRow({ id: rows[0]!.id, token: rows[0]!.execution_token, fence: a2, outcomeJson: '{}' }))).toEqual(lost('claim_epoch_mismatch'));
      expect(await refusal(() => store.yieldToPublications(refs(rows), 1000, { fence: a2 }))).toEqual(lost('claim_epoch_mismatch'));
      expect(await refusal(() => store.recordPlainOutcome(refs(rows), '{}', { fence: a2 }))).toEqual(lost('claim_epoch_mismatch'));
      // The old registration is gone altogether: its lease was released and taken again.
      expect(await refusal(() => claim(engine, a1))).toEqual(lost('epoch_moved'));
      expect(await refusal(() => store.recordPlainOutcome(refs(rows), '{}', { fence: a1 }))).toEqual(lost('epoch_moved'));
      // No effect changed: every claimed effect is still running under its claim.
      const states = await Promise.all(rows.map(async r => (await engine.readRequestEffects((r as unknown as { request_id: string }).request_id, 'git'))[0]?.state));
      expect(states).toEqual(['running', 'running', 'running']);
    });
  });

  withAddon('a call with no fence on a multi-user brain is not refused for lacking one, and cannot touch a live holder\'s claim', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      await setup(engine, 2);
      const rows = await claim(engine, a);
      expect(await claim(engine)).toEqual([]);
      const store = await engine.gitEffectStore();
      expect(await refusal(() => store.yieldToPublications(refs(rows), 1000))).toEqual(lost('held_by_another'));
      expect(await refusal(() => store.recordPlainOutcome(refs(rows), '{}'))).toEqual(lost('held_by_another'));
    });
  });

  withAddon('multi-user off and no fence: the claim and both Git writes behave as they always did', async () => {
    await on(false, async engine => {
      await setup(engine, 2);
      const rows = await claim(engine);
      expect(rows).toHaveLength(2);
      const store = await engine.gitEffectStore();
      await store.yieldToPublications(refs(rows.slice(0, 1)), 1000);
      await store.recordPlainOutcome(refs(rows.slice(1)), '{}');
    });
  });
});

describe('refresh rows', () => {
  const insert = (engine: RustEngine, fence?: LeaseToken) => engine.refreshStore().then(store => store.insertDraining({ worktreeId: WT, sourceIds: ['default'],
    principalId: 'b0000000-0000-4000-8000-0000000000b1', ownerEpoch: '1', topologyGeneration: '1', oldHead: 'aaa', targetHead: 'bbb', upstreamRef: 'origin/main',
    preserved: [], outcome: { holder: { pid: 1 } }, ...(fence ? { fence } : {}) }));

  withAddon('a refresh is claimed at insert, checked on every move and ended at the terminal state', async () => {
    await on(true, async engine => {
      await (await engine.topologyStore()).insertWorktree(WT, HOST);
      const a = await register(engine);
      const store = await engine.refreshStore();
      const row = await insert(engine, a);
      expect(await store.transition(row.id, ['draining'], 'fenced', {}, false, { fence: a })).toBe(true);
      expect((await store.replan(row.id, 'ccc', 'ddd', { fence: a }))?.target_head).toBe('ddd');
      expect(await store.markMergeStarted(row.id, 5, { fence: a })).toBe(true);
      await store.setHolder(row.id, { pid: 2 }, { fence: a });
      expect(await store.transition(row.id, ['fenced'], 'completed', {}, true, { fence: a })).toBe(true);
      expect((await store.read(row.id))?.state).toBe('completed');
    });
  });

  withAddon('a stale fence refuses every move; a replacement epoch refuses until the row is adopted', async () => {
    await on(true, async engine => {
      await (await engine.topologyStore()).insertWorktree(WT, HOST);
      const a1 = await register(engine);
      const store = await engine.refreshStore();
      const row = await insert(engine, a1);
      await store.transition(row.id, ['draining'], 'fenced', {}, false, { fence: a1 });
      const a2 = await again(engine, a1);
      expect(await refusal(() => store.transition(row.id, ['fenced'], 'merged', {}, false, { fence: a2 }))).toEqual(lost('claim_epoch_mismatch'));
      expect(await refusal(() => store.markMergeStarted(row.id, 5, { fence: a2 }))).toEqual(lost('claim_epoch_mismatch'));
      expect(await refusal(() => store.replan(row.id, 'c', 'd', { fence: a2 }))).toEqual(lost('claim_epoch_mismatch'));
      expect(await refusal(() => store.transition(row.id, ['fenced'], 'merged', {}, false, { fence: a1 }))).toEqual(lost('epoch_moved'));
      expect((await store.read(row.id))?.state).toBe('fenced');
      // The explicit adoption by the new holder takes a new claim; the move then goes through.
      expect(await store.adoptClaim!(row.id, { fence: a2 })).toBe(true);
      expect(await store.transition(row.id, ['fenced'], 'merged', {}, false, { fence: a2 })).toBe(true);
      // A takeover by another host leaves the first holder refused.
      const b = await takeover(engine, a2);
      expect(await refusal(() => store.transition(row.id, ['merged'], 'completed', {}, true, { fence: a2 }))).toEqual(lost('epoch_moved'));
      expect(await store.adoptClaim!(row.id, { fence: b })).toBe(true);
    });
  });

  withAddon('a call with no fence on a multi-user brain is not refused for lacking one, and cannot touch a live holder\'s claim', async () => {
    await on(true, async engine => {
      await (await engine.topologyStore()).insertWorktree(WT, HOST);
      const a = await register(engine);
      const store = await engine.refreshStore();
      const row = await insert(engine, a);
      expect(await refusal(() => store.transition(row.id, ['draining'], 'fenced', {}, false))).toEqual(lost('held_by_another'));
      expect((await store.read(row.id))?.state).toBe('draining');
      // A new holder takes the claim under an implicit lease: not refused for lacking a fence.
      await store.setHolder(row.id, { pid: 2 });
    });
  });

  withAddon('multi-user off and no fence: the same calls behave as they always did', async () => {
    await on(false, async engine => {
      await (await engine.topologyStore()).insertWorktree(WT, HOST);
      const store = await engine.refreshStore();
      const row = await insert(engine);
      expect(await store.transition(row.id, ['draining'], 'fenced', {}, false)).toBe(true);
      await store.setHolder(row.id, { pid: 2 });
      expect(await store.transition(row.id, ['fenced'], 'aborted', {}, true)).toBe(true);
    });
  });
});

describe('managed sync checkpoints', () => {
  const OP = 'managed-sync';
  const header = (index: number) => JSON.stringify([{ runId: 'run-1', index, total: 3, done: false }]);
  const insert = (engine: RustEngine, fence?: LeaseToken) => engine.runSyncStatement('cursor_insert', [OP, 'cursor-1', header(0)], fence ? { fence } : undefined);
  const swap = (engine: RustEngine, from: number, to: number, fence?: LeaseToken) => engine.runSyncStatement('cursor_swap', [OP, 'cursor-1', header(from), header(to)], fence ? { fence } : undefined);
  const adopt = (engine: RustEngine, fence?: LeaseToken) => engine.runSyncStatement('checkpoint_touch', [OP, 'cursor-1'], fence ? { fence } : undefined);
  const done = (engine: RustEngine, fence?: LeaseToken) => engine.runSyncStatement('cursor_mark_done', ['cursor-1'], fence ? { fence } : undefined);
  const cursor = (engine: RustEngine) => engine.runSyncStatement('checkpoint_keys', [OP, 'cursor-1']);

  withAddon('a cursor is claimed at insert, checked on every swap and ended when it is done', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      expect(await insert(engine, a)).toHaveLength(1);
      expect(await swap(engine, 0, 1, a)).toHaveLength(1);
      expect(await swap(engine, 1, 2, a)).toHaveLength(1);
      await done(engine, a);
      expect(await engine.runSyncStatement('finished_cursor_delete', ['cursor-1'], { fence: a })).toHaveLength(1);
      expect(await cursor(engine)).toHaveLength(0);
    });
  });

  withAddon('a stale fence refuses every cursor statement; a replacement epoch refuses until the cursor is adopted', async () => {
    await on(true, async engine => {
      const a1 = await register(engine);
      await insert(engine, a1);
      const a2 = await again(engine, a1);
      const before = await cursor(engine);
      expect(await refusal(() => swap(engine, 0, 1, a2))).toEqual(lost('claim_epoch_mismatch'));
      expect(await refusal(() => swap(engine, 0, 1, a1))).toEqual(lost('epoch_moved'));
      expect(await refusal(() => adopt(engine, a1))).toEqual(lost('epoch_moved'));
      expect(await refusal(() => done(engine, a1))).toEqual(lost('epoch_moved'));
      expect(await cursor(engine)).toEqual(before);
      await adopt(engine, a2);
      expect(await swap(engine, 0, 1, a2)).toHaveLength(1);
    });
  });

  withAddon('a call with no fence on a multi-user brain is not refused for lacking one, and cannot touch a live holder\'s claim', async () => {
    await on(true, async engine => {
      const a = await register(engine);
      await insert(engine, a);
      const before = await cursor(engine);
      expect(await refusal(() => swap(engine, 0, 1))).toEqual(lost('held_by_another'));
      expect(await insert(engine)).toEqual([]);
      expect(await cursor(engine)).toEqual(before);
      // The adoption and the done mark name no claim to check: neither is refused for lacking a fence.
      await adopt(engine);
      await done(engine);
    });
  });

  withAddon('multi-user off and no fence: the same statements behave as they always did', async () => {
    await on(false, async engine => {
      expect(await insert(engine)).toHaveLength(1);
      expect(await swap(engine, 0, 1)).toHaveLength(1);
      await adopt(engine);
      await done(engine);
    });
  });
});
