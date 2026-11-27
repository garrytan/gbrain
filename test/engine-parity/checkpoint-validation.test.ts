/**
 * BrainEngine parity — the managed sync checkpoint's validation reads (persistence/checkpoint-validation.ts):
 * `findIncompleteSyncReceipt` and `probeCheckpointBlocker` (the receipt that blocks a run's checkpoint),
 * `findOpenPassWork` (the pass stamp's open-work check, with and without its own recovery) and
 * `listIncompleteSyncReceipts` (what `sync status` lists), each driven through its exported function.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a worktree with no receipts blocks nothing on every engine arm (PGLite, Postgres, Rust); a blocking
 *    receipt, a superseded one, one the cursor's settled ranges cover, a recovery row, another open managed-sync
 *    request and a run with more than 20 blockers answer the same on every arm that holds a managed worktree.
 *  - Regression: an engine that answers one of these differently lets a checkpoint or a pass stamp commit past an open
 *    page write, or refuses one that nothing blocks; a Rust brain has no SQL, so each read has to be a typed member.
 *  - Why existing coverage misses it: the reads ran through `executeRaw` in checkpoint-validation.ts, which no parity
 *    case can call (D18), and test/persistence-sync-checkpoint-validation.test.ts runs on PGLite and Postgres only.
 *  - Seam: the file's own exported functions. Requests are admitted through the real journal members (`insertWriteRequest`);
 *    a worktree binding is claimed through `worktreeClaimStore`. A Rust brain keeps no managed worktree (a request cannot
 *    name one), so the worktree-bound cases require `managed_persistence` and stop on that typed refusal there; the case
 *    with no worktree-bound receipt runs on all three arms.
 *
 * Rust known stop (every worktree-bound case): lane 5 owns managed persistence on Rust (the managed-persistence plan).
 * Until it lands, the Rust branches below stay. Loss row (Rust capability-loss list, until then):
 *   - Rust brain cannot hold worktree-bound requests; managed_persistence (owner lane 5, managed-persistence plan)
 */
import { describe, expect } from 'bun:test';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { claimWorktreeBinding } from '../../src/core/engine-sql/worktree-claim.ts';
import { requireManagedPersistence } from '../../src/core/rust-engine/errors.ts';
import { findIncompleteSyncReceipt, findOpenPassWork, listIncompleteSyncReceipts, probeCheckpointBlocker } from '../../src/core/persistence/checkpoint-validation.ts';

const { parityTest } = parityArms(testBackends());

const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const HOST = 'e0000000-0000-4000-8000-0000000000e1';
const SELF = 'f0000000-0000-4000-8000-0000000000f1';
const RUN = 'run-parity-1';
const OTHER_RUN = 'run-parity-2';
const worktree = (n: number) => `a1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const request = (n: number) => `b1000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

interface Seed {
  n: number;
  kind?: 'managed_sync_import' | 'managed_sync_delete' | 'managed_sync_checkpoint' | 'put_page';
  runId?: string;
  index?: number;
  /** The row's state after admission (admission itself only queues). */
  state?: 'queued' | 'running' | 'recovering' | 'committed' | 'failed' | 'cancelled' | 'conflict';
  recovery?: boolean;
  worktree?: number | null;
  slug?: string;
}

/** Claims worktree `n` (an unmanaged binding, as persistence/ownership.ts claimWorktree does). */
async function claimWorktree(engine: BrainEngine, n: number): Promise<string> {
  const id = worktree(n);
  await claimWorktreeBinding(engine, async store => { await store.insertWorktree({ id, ownerHostId: HOST, ownerEpoch: 1 }); });
  return id;
}

/** Admits one request through the journal and brings it to `state` (the journal admits queued rows only). */
async function seed(engine: BrainEngine, incarnation: string, row: Seed): Promise<string> {
  const requestId = request(row.n);
  await engine.lockPersistenceCounters(KEYS);
  await engine.insertWriteRequest({
    principalKind: 'local_cli', principalId: 'parity-writer', requestId, operation: 'submit_job', sourceId: 'default', sourceIncarnation: incarnation,
    pageId: null, slug: row.slug ?? `notes/receipt-${row.n}`, worktreeId: row.worktree == null ? null : worktree(row.worktree), topologyGeneration: null, digest: 'd'.repeat(64),
    intent: { kind: row.kind ?? 'managed_sync_import', runId: row.runId ?? RUN, index: row.index ?? 0 },
    authority: { scopes: ['write'] }, intentBytes: 100, terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity',
    admitterHostId: null, counterKeys: KEYS, clientRequestId: null, state: 'queued', deferredRefreshId: null,
  });
  if ((row.state ?? 'queued') !== 'queued' || row.recovery) {
    // No journal member moves an admitted row to another state or records a recovery on it: the row's state is set directly (SQL arms only).
    await engine.executeRaw('UPDATE persistence_requests SET state=$2, recovery=$3::text::jsonb, error_code=$4 WHERE request_id=$1::uuid',
      [requestId, row.state ?? 'queued', row.recovery ? JSON.stringify({ version: 1 }) : null, row.state === 'failed' ? 'write_failed' : null]);
  }
  return requestId;
}

type Settled = { from: number; ranges: Array<[number, number]> } | null;

/** Everything the three exported reads answer for one worktree and run. */
async function answers(engine: BrainEngine, worktreeId: string, runId: string, opts: { superseded?: string[]; settled?: Settled; self?: string } = {}) {
  const superseded = opts.superseded ?? [], settled = opts.settled ?? null, self = opts.self ?? SELF;
  return {
    receipt: await findIncompleteSyncReceipt(engine, worktreeId, runId, superseded, settled),
    probe: await probeCheckpointBlocker(engine, worktreeId, runId, superseded, settled),
    list: await listIncompleteSyncReceipts(engine, worktreeId, runId, superseded, settled),
    pass: await findOpenPassWork(engine, worktreeId, self),
    passOwn: await findOpenPassWork(engine, worktreeId, self, true),
  };
}

const incarnationOf = async (engine: BrainEngine) => (await engine.readSourceMembership('default'))!.incarnation;

describe('engine parity: sync checkpoint validation', () => {
  parityTest('a worktree no receipt names blocks nothing, whatever the run, the superseded list and the settled ranges', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest'],
    timeout: 60_000,
  }, async (engine) => {
    const incarnation = await incarnationOf(engine);
    // An open page receipt of the run that names no worktree: it belongs to no worktree, so it blocks no worktree's checkpoint.
    await seed(engine, incarnation, { n: 1, kind: 'managed_sync_import', state: 'queued', worktree: null });
    const settled: Settled = { from: 0, ranges: [[0, 3], [5, 9]] };
    const out = {
      plain: await answers(engine, worktree(1), RUN),
      superseded: await answers(engine, worktree(1), RUN, { superseded: [request(1)], settled }),
      other: await answers(engine, worktree(2), OTHER_RUN, { settled: { from: 0, ranges: [] } }),
    };
    const nothing = { receipt: null, probe: null, list: [], pass: null, passOwn: null };
    expect(out).toEqual({ plain: nothing, superseded: nothing, other: nothing });
    // A worktree id the statement cannot cast to a uuid refuses with the cast's message on every arm.
    const refused = await findIncompleteSyncReceipt(engine, 'not-a-uuid', RUN).then(() => null, (e: Error) => e.message);
    const refusedPass = await findOpenPassWork(engine, 'not-a-uuid', SELF).then(() => null, (e: Error) => e.message);
    expect({ refused, refusedPass }).toEqual({ refused: 'invalid input syntax for type uuid: "not-a-uuid"', refusedPass: 'invalid input syntax for type uuid: "not-a-uuid"' });
    return { out, refused, refusedPass };
  });

  parityTest('the three members, called directly: empty and non-empty lists, an upper-case worktree and a refused argument', {
    methods: ['readIncompleteSyncReceipt', 'readOpenPassWork', 'readIncompleteSyncReceiptRows'],
    timeout: 60_000,
  }, async (engine) => {
    const spec = { worktreeId: worktree(7), runId: RUN, superseded: [] as string[], ranges: [] as Array<[number, number]> };
    const wide = { ...spec, superseded: [request(1), request(2)], ranges: [[0, 3], [5, 9]] as Array<[number, number]> };
    const out = {
      receipt: [await engine.readIncompleteSyncReceipt(spec), await engine.readIncompleteSyncReceipt(wide), await engine.readIncompleteSyncReceipt({ ...spec, worktreeId: worktree(7).toUpperCase() })],
      pass: [await engine.readOpenPassWork({ worktreeId: worktree(7), selfRequestId: SELF, ownRecovery: false }), await engine.readOpenPassWork({ worktreeId: worktree(7), selfRequestId: SELF.toUpperCase(), ownRecovery: true })],
      rows: [await engine.readIncompleteSyncReceiptRows(spec), await engine.readIncompleteSyncReceiptRows(wide)],
    };
    expect(out).toEqual({ receipt: [null, null, null], pass: [null, null], rows: [[], []] });
    const refusals = {
      receipt: await engine.readIncompleteSyncReceipt({ ...spec, worktreeId: 'nope' }).then(() => null, (e: Error) => e.message),
      pass: await engine.readOpenPassWork({ worktreeId: worktree(7), selfRequestId: 'nope', ownRecovery: false }).then(() => null, (e: Error) => e.message),
      rows: await engine.readIncompleteSyncReceiptRows({ ...spec, worktreeId: 'nope' }).then(() => null, (e: Error) => e.message),
    };
    expect(refusals).toEqual({ receipt: 'invalid input syntax for type uuid: "nope"', pass: 'invalid input syntax for type uuid: "nope"', rows: 'invalid input syntax for type uuid: "nope"' });
    return { out, refusals };
  });

  parityTest('a blocking page receipt, a superseded one, one the settled ranges cover and a committed sibling at its index', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'worktreeClaimStore', 'transaction'],
    requires: 'managed_persistence',
    timeout: 60_000,
  }, async (engine) => {
    requireManagedPersistence(engine, 'sync receipts bound to a managed worktree', 'a request names a worktree only on a brain that manages one');
    const incarnation = await incarnationOf(engine);
    const view = (a: Awaited<ReturnType<typeof answers>>) => ({ ...a, list: a.list.map(r => ({ ...r })) });

    // Nothing open: committed page receipts, and an open request of another run of another worktree.
    const w1 = await claimWorktree(engine, 1), w2 = await claimWorktree(engine, 2);
    await seed(engine, incarnation, { n: 1, worktree: 1, state: 'committed', index: 0 });
    await seed(engine, incarnation, { n: 2, worktree: 1, state: 'committed', index: 1 });
    await seed(engine, incarnation, { n: 3, worktree: 2, state: 'queued', runId: OTHER_RUN });
    const quiet = view(await answers(engine, w1, RUN));

    // A queued page receipt blocks the checkpoint and the stamp; the stamp's own request does not block itself.
    const w3 = await claimWorktree(engine, 3);
    const queued = await seed(engine, incarnation, { n: 10, worktree: 3, state: 'queued', index: 4, slug: 'notes/open-page' });
    const blocking = view(await answers(engine, w3, RUN));
    const own = view(await answers(engine, w3, RUN, { self: queued }));
    const otherRun = view(await answers(engine, w3, OTHER_RUN));

    // A failed receipt blocks until the run converted it in place (superseded) or the cursor passed its index (settled).
    const w4 = await claimWorktree(engine, 4);
    const failed = await seed(engine, incarnation, { n: 20, worktree: 4, state: 'failed', index: 5 });
    const failedBlocks = view(await answers(engine, w4, RUN));
    const superseded = view(await answers(engine, w4, RUN, { superseded: [failed] }));
    const covered = view(await answers(engine, w4, RUN, { settled: { from: 0, ranges: [[3, 7]] } }));
    const missed = view(await answers(engine, w4, RUN, { settled: { from: 0, ranges: [[0, 4], [6, 9]] } }));
    const edge = view(await answers(engine, w4, RUN, { settled: { from: 0, ranges: [[5, 5]] } }));
    const emptyRanges = view(await answers(engine, w4, RUN, { settled: { from: 0, ranges: [] } }));
    // A queued receipt inside a settled range still blocks (only terminal, recovery-free receipts are skipped).
    const w5 = await claimWorktree(engine, 5);
    await seed(engine, incarnation, { n: 30, worktree: 5, state: 'running', index: 5 });
    const openInRange = view(await answers(engine, w5, RUN, { settled: { from: 0, ranges: [[3, 7]] } }));

    // A failed or cancelled receipt with a committed sibling at its index blocks nothing.
    const w6 = await claimWorktree(engine, 6);
    await seed(engine, incarnation, { n: 40, worktree: 6, state: 'failed', index: 2 });
    await seed(engine, incarnation, { n: 41, worktree: 6, state: 'cancelled', index: 3 });
    await seed(engine, incarnation, { n: 42, worktree: 6, state: 'committed', index: 2 });
    await seed(engine, incarnation, { n: 43, worktree: 6, state: 'committed', index: 3 });
    const sibling = view(await answers(engine, w6, RUN));

    const out = { quiet, blocking, own, otherRun, failedBlocks, superseded, covered, missed, edge, emptyRanges, openInRange, sibling };
    const none = { receipt: null, probe: null, list: [], pass: null, passOwn: null };
    expect({ quiet: out.quiet, own: out.own.pass, otherRun: out.otherRun.receipt, superseded: out.superseded, covered: out.covered, sibling: out.sibling })
      .toEqual({ quiet: none, own: null, otherRun: null, superseded: { ...none }, covered: { ...none }, sibling: { ...none } });
    expect(out.blocking.receipt).toBe(queued);
    expect(out.blocking.list).toEqual([{ request_id: queued, slug: 'notes/open-page', state: 'queued', code: null, index: 4, recovery: false }]);
    expect(out.failedBlocks.receipt).toBe(failed);
    expect(out.failedBlocks.pass).toBeNull();
    expect(out.missed.receipt).toBe(failed);
    expect(out.edge.receipt).toBeNull();
    expect(out.emptyRanges.receipt).toBe(failed);
    expect(out.openInRange.receipt).toBe(request(30));
    return out;
  });

  parityTest('a recovery row blocks the checkpoint and the stamp (the stamp\'s own recovery only when it is not folded), and another open managed-sync request blocks the stamp', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'worktreeClaimStore', 'transaction'],
    requires: 'managed_persistence',
    timeout: 60_000,
  }, async (engine) => {
    requireManagedPersistence(engine, 'sync receipts bound to a managed worktree', 'a request names a worktree only on a brain that manages one');
    const incarnation = await incarnationOf(engine);

    // A committed receipt that still records a recovery blocks every run of the worktree.
    const w1 = await claimWorktree(engine, 11);
    const recovering = await seed(engine, incarnation, { n: 50, worktree: 11, state: 'committed', recovery: true, runId: OTHER_RUN, kind: 'put_page', slug: 'notes/recovering' });
    const recovery = {
      checkpoint: await answers(engine, w1, RUN),
      ownStamp: await answers(engine, w1, RUN, { self: recovering }),
      otherStamp: await answers(engine, w1, RUN, { self: request(51) }),
    };
    expect(recovery.checkpoint.receipt).toBe(recovering);
    expect(recovery.checkpoint.list).toEqual([{ request_id: recovering, slug: 'notes/recovering', state: 'committed', code: null, index: 0, recovery: true }]);
    expect(recovery.ownStamp.pass).toBe(recovering);
    expect(recovery.ownStamp.passOwn).toBeNull();
    expect(recovery.otherStamp.passOwn).toBe(recovering);

    // Another open managed-sync request (a checkpoint, an import of another run, a delete) blocks the stamp, not the page receipts' validation.
    const w2 = await claimWorktree(engine, 12);
    const checkpoint = await seed(engine, incarnation, { n: 60, worktree: 12, state: 'running', kind: 'managed_sync_checkpoint', runId: OTHER_RUN });
    const open = {
      other: await answers(engine, w2, RUN),
      self: await answers(engine, w2, RUN, { self: checkpoint }),
    };
    expect(open.other).toMatchObject({ receipt: null, probe: null, list: [], pass: checkpoint, passOwn: checkpoint });
    expect(open.self).toMatchObject({ pass: null, passOwn: null });
    const w3 = await claimWorktree(engine, 13);
    await seed(engine, incarnation, { n: 70, worktree: 13, state: 'recovering', kind: 'managed_sync_delete', runId: OTHER_RUN, index: 1 });
    await seed(engine, incarnation, { n: 71, worktree: 13, state: 'committed', kind: 'managed_sync_checkpoint', runId: OTHER_RUN });
    await seed(engine, incarnation, { n: 72, worktree: 13, state: 'queued', kind: 'put_page' });
    const kinds = await answers(engine, w3, RUN);
    // A put_page request is not managed-sync work, and a committed checkpoint is not open.
    expect(kinds.pass).toBe(request(70));
    expect(kinds.receipt).toBeNull();
    return { recovery, open, kinds };
  });

  parityTest('more than 20 blocking receipts: the checkpoint names the first, the status list is capped at 20 in sequence order', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'worktreeClaimStore', 'transaction'],
    requires: 'managed_persistence',
    timeout: 120_000,
  }, async (engine) => {
    requireManagedPersistence(engine, 'sync receipts bound to a managed worktree', 'a request names a worktree only on a brain that manages one');
    const incarnation = await incarnationOf(engine);
    const w = await claimWorktree(engine, 21);
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) ids.push(await seed(engine, incarnation, { n: 100 + i, worktree: 21, state: 'queued', index: i }));
    const out = await answers(engine, w, RUN);
    expect(out.receipt).toBe(ids[0]);
    expect(out.list.map(r => r.request_id)).toEqual(ids.slice(0, 20));
    expect(out.list.map(r => r.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    // An open receipt blocks whether or not the run converted it: superseding changes nothing for queued rows.
    const superseded = await answers(engine, w, RUN, { superseded: ids.slice(0, 5) });
    expect(superseded.list.map(r => r.request_id)).toEqual(ids.slice(0, 20));
    return { out, superseded: superseded.receipt };
  });
});
