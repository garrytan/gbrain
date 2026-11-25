/**
 * Engine parity for the journal's managed-worktree reads on a real claimed checkout: the admission members
 * (engine-sql/persistence-admission.ts: readWorktreeAdmission, completeSyncedRefresh, hasDeferralRoom, readRefreshTiming,
 * countHeldBehindImport) over the refresh keyspace, the write claim's worktree terms (persistence-claims.ts
 * `claimableWriteFragment`, `CLAIM_HEAD`), the gated-mirror scan (persistence-effect-scans.ts `listGatedMirrorRequests`)
 * and the topology recovery pass (persistence/topology-recovery.ts `recoverSourceTopologies`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm through harness.ts), after
 *    `gbrain sources writer claim` binds a checkout to this host:
 *    - the admission reads see the active worktree, no refresh and a binding that holds only at its own topology
 *      generation and incarnation. The refresh keyspace (K1) and the deferral, timing and held-write answers are only
 *      read empty here: a refresh row is written only by `gbrain sources refresh` (worktree-refresh.ts, raw SQL, a named
 *      refusal on Rust) and the Rust store keeps no consumer rows, so no typed member can build those rows on every arm.
 *      Their non-empty answers are pinned by the store's own tests (rust/crates/gbrain-store/src/persistence/
 *      worktree_admission.rs) and on the SQL arms by test/persistence-admission-sql.test.ts;
 *    - a queued write on the worktree is claimable by the owning host only, and an unsettled withdrawal mirror on the
 *      same slug holds it back;
 *    - a withdrawal mirror parked by the segmented writer gate is listed for the owning host, not for another host, not
 *      when the gate's code is not allowed, and not once a sibling effect of the request parks with another code;
 *    - a recovering topology change on the worktree is attempted by the owning host's recovery pass.
 *  - Regression: the existing parity cases (persistence.test.ts, effect-scans.test.ts, owner-recovery-scans.test.ts)
 *    only ran these members on a brain with no worktree, where every answer is empty, so a Rust store that never read
 *    its worktree rows passed them. The topology pass returned 0 on an engine without managed_persistence
 *    (topology-recovery.ts `managesWorktrees`) before it scanned, so a recovering change on a claimed worktree of a Rust
 *    brain was never attempted and never reported.
 *  - Why existing coverage misses it: a managed worktree's rows cannot be built through the raw-SQL fixtures those files
 *    avoid (D18); here the real `writer_claim` administration builds them on every arm.
 *  - The topology attempt (topology-recovery.ts) runs on the typed topology store, so with the managed hold lifted on the
 *    Rust test engine (rust-managed.ts) the pass reaches the change there as on the SQL arms; it no longer stops on raw_sql.
 *  - Seam: none. Real engines, the real administration path and typed members only. Ids that differ per arm (worktree,
 *    journal and effect ids) are compared by role, never printed.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { WorktreeBinding } from '../../src/core/engine-sql/write-misc.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { WITHHELD_BY_MIRROR } from '../../src/core/persistence/effect-model.ts';
import { localHostId } from '../../src/core/persistence/identity.ts';
import { SEGMENTED_MIRROR_GATE_CODE } from '../../src/core/persistence/segmented-mirror-gate.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { recoverSourceTopologies } from '../../src/core/persistence/topology-recovery.ts';

const { parityTest } = parityArms(testBackends());

const PRINCIPAL = { kind: 'local_cli', id: 'parity-writer' };
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const OTHER_HOST = 'f0000000-0000-4000-8000-0000000000f9';
const UNKNOWN_REFRESH = 'f0000000-0000-4000-8000-0000000000fa';
const WRITE = 'f0000000-0000-4000-8000-0000000000f1';
const MIRROR = 'f0000000-0000-4000-8000-0000000000f2';
const RECOVERY = 'f0000000-0000-4000-8000-0000000000f3';
const TOKEN = 'f0000000-0000-4000-8000-0000000000f4';
const OTHER_TOKEN = 'f0000000-0000-4000-8000-0000000000f7';
const SLUG = 'notes/worktree-example';
const REVISION = 'f0000000-0000-4000-8000-0000000000f5';

/** Runs `run` under a scratch GBRAIN_HOME with a claimed checkout of source `work` bound to this host. */
async function withClaimedWorktree<T>(engine: BrainEngine, backend: ParityBackend,
  run: (ctx: { host: string; binding: WorktreeBinding; incarnation: string }) => Promise<T>): Promise<T> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-worktree-terms-parity-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const root = join(home, 'checkout');
      await Bun.write(join(root, 'example.md'), 'generic example');
      await createSource(engine, backend, 'work', {}, root);
      try {
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, admin_intent: 'writer_claim', expected_state: await writerAdminState(engine) });
        const host = localHostId();
        const binding = await engine.getWorktreeBinding('work', host);
        const source = await engine.readLedgerSource('work');
        expect({ bound: binding !== null, owner: binding?.owner_host_id === host, state: binding?.state }).toEqual({ bound: true, owner: true, state: 'active' });
        return await run({ host, binding: binding!, incarnation: source!.incarnation });
      } finally {
        await disposePersistenceConsumer(engine);
      }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

/** Inserts one queued put_page of SLUG on the worktree and returns its journal id. */
async function queueBoundWrite(engine: BrainEngine, binding: WorktreeBinding, incarnation: string, requestId: string): Promise<string> {
  await engine.lockPersistenceCounters(KEYS);
  const row = await engine.insertWriteRequest({
    principalKind: PRINCIPAL.kind, principalId: PRINCIPAL.id, requestId, operation: 'put_page', sourceId: 'work',
    sourceIncarnation: incarnation, pageId: null, slug: SLUG, worktreeId: binding.worktree_id, topologyGeneration: Number(binding.topology_generation),
    digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: SLUG }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  return row.id;
}

/** Queues the withdrawal effects (mirror, git, embedding) of journal request `id` on SLUG. */
async function queueWithdrawal(engine: BrainEngine, id: string): Promise<void> {
  await engine.transactionDirect(async tx => {
    await tx.declarePersistence();
    await tx.insertWithdrawalEffects({ requestId: id, sourceId: 'work', targets: [{ slug: SLUG, page_id: 1, revision: REVISION }] });
  });
}

/** The request id of the write the host would claim next, or null. */
async function claimHead(engine: BrainEngine, hostId: string): Promise<string | null> {
  return engine.transactionDirect(async tx => {
    const row = await tx.selectClaimableWrite<{ request_id: string }>({ hostId, excludeRoots: [], fifoRoots: [], laneRoots: [], nonce: 'parity-nonce',
      syncSeen: {}, priority: null, leaseHolder: null });
    return row?.request_id ?? null;
  });
}

describe('engine parity: the journal on a claimed worktree', () => {
  parityTest('the admission reads see the claimed worktree, its binding at its own generation and no refresh', {
    methods: ['getWorktreeBinding', 'readWorktreeAdmission', 'completeSyncedRefresh', 'hasDeferralRoom', 'readRefreshTiming', 'countHeldBehindImport'],
    timeout: 60_000,
  }, async (engine, backend) => withClaimedWorktree(engine, backend, async ({ binding, incarnation }) => {
    const key = { worktreeId: binding.worktree_id, sourceId: 'work', sourceIncarnation: incarnation, topologyGeneration: binding.topology_generation };
    const admission = await engine.readWorktreeAdmission(key);
    const answers = {
      admission: { worktree: admission.worktree && { state: admission.worktree.state, epoch: String(admission.worktree.owner_epoch) === String(binding.owner_epoch) },
        refresh: admission.refresh, bound: admission.bound },
      barrier: (await engine.readWorktreeAdmission(key, { lockRefresh: true })).bound,
      otherGeneration: (await engine.readWorktreeAdmission({ ...key, topologyGeneration: Number(binding.topology_generation) + 1 })).bound,
      otherIncarnation: (await engine.readWorktreeAdmission({ ...key, sourceIncarnation: UNKNOWN_REFRESH })).bound,
      completed: await engine.completeSyncedRefresh(UNKNOWN_REFRESH),
      room: await engine.hasDeferralRoom(binding.worktree_id, 'import_deferral', 30_000),
      timing: await engine.readRefreshTiming(UNKNOWN_REFRESH),
      held: await engine.countHeldBehindImport('work', null),
    };
    expect(answers).toEqual({
      admission: { worktree: { state: 'active', epoch: true }, refresh: null, bound: true }, barrier: true, otherGeneration: false,
      otherIncarnation: false, completed: false, room: true, timing: null, held: { count: 0, bytes: 0 },
    });
    return answers;
  }));

  parityTest('a queued write on the worktree is claimable by its owner host only, and an unsettled mirror on its slug holds it', {
    methods: ['hasClaimableWrite', 'selectClaimableWrite', 'insertWriteRequest', 'insertWithdrawalEffects'],
    timeout: 60_000,
  }, async (engine, backend) => withClaimedWorktree(engine, backend, async ({ host, binding, incarnation }) => {
    const empty = { owner: await claimHead(engine, host), any: await engine.hasClaimableWrite(host, []) };
    await queueBoundWrite(engine, binding, incarnation, WRITE);
    const queued = { owner: await claimHead(engine, host), other: await claimHead(engine, OTHER_HOST),
      any: await engine.hasClaimableWrite(host, []) };
    // An unsettled withdrawal mirror on the same slug holds the write back, even one of a later request.
    const mirror = await queueBoundWrite(engine, binding, incarnation, MIRROR);
    // A second queued write alone leaves the first at the head; its withdrawal mirror is what holds the slug.
    const secondQueued = await claimHead(engine, host);
    await queueWithdrawal(engine, mirror);
    const behindMirror = await claimHead(engine, host);
    const answers = { empty, queued, secondQueued, behindMirror };
    expect(answers).toEqual({ empty: { owner: null, any: false }, queued: { owner: WRITE, other: null, any: true }, secondQueued: WRITE, behindMirror: null });
    return answers;
  }));

  parityTest('a withdrawal mirror the segmented gate parked is listed for its owner host only, and not once a sibling effect parks outside the allowed codes', {
    methods: ['insertWriteRequest', 'insertWithdrawalEffects', 'selectClaimableEffect', 'stampEffectClaim', 'parkEffectRow', 'listGatedMirrorRequests'],
    timeout: 60_000,
  }, async (engine, backend) => withClaimedWorktree(engine, backend, async ({ host, binding, incarnation }) => {
    const id = await queueBoundWrite(engine, binding, incarnation, MIRROR);
    await queueWithdrawal(engine, id);
    const list = (h: string, allowed = [SEGMENTED_MIRROR_GATE_CODE, WITHHELD_BY_MIRROR]) => engine.listGatedMirrorRequests(h, SEGMENTED_MIRROR_GATE_CODE, allowed)
      .then(rows => rows.map(row => ({ journal: row.id === id, source: row.source_id, request: row.request_id })));
    const before = await list(host);
    const claim = await engine.transactionDirect(tx => tx.selectClaimableEffect<{ id: string | number; kind: string }>(host, []));
    expect(claim?.kind).toBe('withdrawal-mirror');
    await engine.stampEffectClaim({ id: claim!.id, token: TOKEN, ownerJson: JSON.stringify({ phase: 'parity' }) });
    await engine.parkEffectRow({ id: claim!.id, token: TOKEN, dataJson: JSON.stringify({ version: 2, targets: [{ slug: SLUG, page_id: 1, revision: REVISION }],
      parked: [{ slug: SLUG, error_code: SEGMENTED_MIRROR_GATE_CODE }] }) });
    const parked = { listed: await list(host), otherHost: await list(OTHER_HOST), gateNotAllowed: await list(host, [WITHHELD_BY_MIRROR]) };
    // A sibling effect of the same request parked with a code outside the allowed set vetoes the resume.
    const sibling = await engine.transactionDirect(tx => tx.selectClaimableEffect<{ id: string | number; kind: string }>(host, []));
    expect(sibling?.kind === 'git' || sibling?.kind === 'embedding').toBe(true);
    await engine.stampEffectClaim({ id: sibling!.id, token: OTHER_TOKEN, ownerJson: JSON.stringify({ phase: 'parity' }) });
    await engine.parkEffectRow({ id: sibling!.id, token: OTHER_TOKEN, dataJson: JSON.stringify({ version: 2, targets: [{ slug: SLUG, page_id: 1, revision: REVISION }],
      parked: [{ slug: SLUG, error_code: 'parity_other_code' }] }) });
    const answers = { before, parked, siblingVeto: await list(host) };
    expect(answers).toEqual({ before: [], parked: { listed: [{ journal: true, source: 'work', request: MIRROR }], otherHost: [], gateNotAllowed: [] }, siblingVeto: [] });
    return answers;
  }));

  parityTest('the topology recovery pass attempts a recovering change on the owner host\'s worktree', {
    methods: ['insertTopologyChange', 'listTopologyRecoveries'],
    timeout: 60_000,
  }, async (engine, backend) => withClaimedWorktree(engine, backend, async ({ host, binding, incarnation }) => {
    if (backend === 'rust') liftManagedHold(engine);
    const change = await engine.insertTopologyChange({ principalId: 'f0000000-0000-4000-8000-0000000000f6', requestId: RECOVERY, digest: 'e'.repeat(64), operation: 'writer_claim',
      sourceId: 'work', sourceIncarnation: incarnation, worktreeIds: [binding.worktree_id], state: 'recovering', recovery: { worktreeId: binding.worktree_id, step: 1 },
      recoveryBytes: 12, intentBytes: 34, terminalBytes: 4096, outcome: null });
    const attempts: Array<{ self: boolean; recovered: boolean }> = [];
    const pass = () => recoverSourceTopologies(engine, { hostId: host, limit: 2, onAttempt: (rowId, recovered) => attempts.push({ self: rowId === change.id, recovered }) });
    const answers = { result: await pass(), attempts, otherHost: await recoverSourceTopologies(engine, { hostId: OTHER_HOST, limit: 2 }) };
    // The fixture's change names no clone to finish, so the attempt ends without recovering it; what matters is that the
    // owner host's pass reached it and another host's did not.
    expect(answers).toEqual({ result: 0, attempts: [{ self: true, recovered: false }], otherHost: 0 });
    return answers;
  }));
});
