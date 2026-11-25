/**
 * BrainEngine parity — the multi-writer conformance suite C01..C22 (docs/designs/rust-engine/multi-user-server.md,
 * "Tests to write now", 1), through the typed BrainEngine members only.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: many writers on one brain never lose an update, never claim one job or write twice, never deadlock and
 *    never get a busy error, on every engine arm the support matrix (multi-writer-cases.ts) marks `runs`: PGLite where
 *    its one connection can express the case, Postgres, and the Rust arm where the single-writer store already holds
 *    the guarantee. A case the arm cannot express is `n/a`; one that waits for multi-writer Rust work is `pending`
 *    with its owner. The harness skips both and holds a `runs` cell to strict acceptance (harness.ts).
 *  - Regression: an engine that loses a compare-and-set write, hands one job or write to two claimants, over-admits a
 *    counter, lets two holders into one key, deadlocks two writers that take two pages in opposite orders, or forgets
 *    an acknowledged write after its connection goes away. Each case asserts its invariant inside the scenario; the
 *    returned values are outcomes only, never the order an engine took, as in jobs.test.ts ("claimNextJob from eight
 *    workers at once").
 *  - Why existing coverage misses it: the parity files run one writer at a time. test/engine-parity/jobs.test.ts has
 *    the one multi-worker claim case, and nothing compares engines on page, fact, lease or generation writers that
 *    overlap. The Rust store has its own suite (rust/crates/gbrain-store/tests/multi_writer_conformance.rs), which
 *    cannot see the engine members.
 *  - Seam: none. Real engines, typed members only (no executeRaw: D18). A second connection to the same brain is
 *    `ctx.sameBrainEngine()`; PGLite has one connection and refuses it, so the cases that need it are `n/a` there and
 *    the cases that only use it to widen the load fall back to the arm's own engine. Expired leases are made by negative
 *    durations, never by sleeping.
 *
 * The matrix row of each case (members, reference, cells) is multi-writer-cases.ts; multi-writer-cases.test.ts checks
 * that this file and the matrix agree. A case whose every engine cell is pending still has a real scenario body: it is
 * skipped by the harness, never run, and is the edit that turns the case on when its owner lands.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine, FactRow } from '../../src/core/engine.ts';
import type { AdmitJobPolicy, ClaimJobSpec, JobInsertValues, JobRow } from '../../src/core/engine-sql/jobs.ts';
import type { PageInput } from '../../src/core/types.ts';
import { APPLICATION_AUTHORITY, coalesceDecision, parseSubmissionAuthority } from '../../src/core/minions/submission-authority.ts';
import { parityArms, type ParityContext } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const NOTE = (title: string, body: string): PageInput => ({ type: 'note', title, compiled_truth: body, timeline: '' });

/** The `code` an error carries, or `threw` when it has none. */
const codeOf = (error: unknown): string => (error as { code?: string } | null)?.code ?? 'threw';

/** Runs `step(i)` for `i` in `0..n-1` at once. */
const together = <T>(n: number, step: (i: number) => Promise<T>): Promise<T[]> => Promise.all(Array.from({ length: n }, (_, i) => step(i)));

/** What an attempt did: the value it returned, or the code it threw with. */
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  try { return { ok: true, value: await run() }; } catch (error) { return { ok: false, code: codeOf(error) }; }
}

/** The page's body, or null when it is absent. */
async function bodyOf(engine: BrainEngine, slug: string): Promise<string | null> {
  const snap = await engine.readPageSnapshot(slug, { sourceId: SRC });
  return snap ? snap.page.compiled_truth : null;
}

/** Fails the case when `work` does not finish within `ms`: a deadlock must fail, not hang. */
async function within<T>(ms: number, what: string, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); });
  try { return await Promise.race([work, late]); } finally { clearTimeout(timer); }
}

const BUSY_CODES = new Set(['store_locked', 'pglite_busy', 'owner_unavailable', 'owner_busy']);

/**
 * `n` connections to the case's brain: the arm's engine and up to `n - 1` second connections. PGLite has one connection and
 * refuses the second (`same_brain_unavailable`): the cases that use this to widen the load run on the one engine there.
 */
async function connections(engine: BrainEngine, ctx: ParityContext, n: number): Promise<BrainEngine[]> {
  const all = [engine];
  for (let i = 1; i < n; i++) {
    try { all.push(await ctx.sameBrainEngine()); } catch (error) {
      if (codeOf(error) !== 'same_brain_unavailable' && !/same_brain_unavailable/.test(String((error as Error)?.message))) throw error;
      break;
    }
  }
  return all;
}

// ---- jobs ---------------------------------------------------------------------------------------------------------

function jobValues(name: string, extra: Partial<JobInsertValues> = {}): JobInsertValues {
  return {
    name, queue: 'default', status: 'waiting', priority: 0, data: {}, max_attempts: 3, backoff_type: 'exponential',
    backoff_delay: 1000, backoff_jitter: 0.2, delay_until: null, parent_job_id: null, on_child_fail: 'fail_parent',
    max_children: null, timeout_ms: null, lock_duration_ms: null, remove_on_complete: false, remove_on_fail: false,
    idempotency_key: null, quiet_hours: null, stagger_key: null, private_queue_owner_job_id: null,
    private_queue_owner_token: null, private_queue_lease_until: null, submission_authority: APPLICATION_AUTHORITY,
    spend_authorization: null, max_stalled: null, ...extra,
  };
}

const JOB_POLICY: AdmitJobPolicy = {
  decide: async (_tx, row) => coalesceDecision(row, APPLICATION_AUTHORITY),
  parentAuthorityKind: raw => parseSubmissionAuthority(raw)?.kind ?? null,
};

const admit = (engine: BrainEngine, extra: Partial<JobInsertValues> = {}) => engine.admitJob({ maxSpawnDepth: 5, insert: jobValues('work', extra) }, JOB_POLICY);

async function addJob(engine: BrainEngine, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, extra);
  expect(out.coalesced).toBe(false);
  return Number(out.row.id);
}

function claimSpec(token: string, extra: Partial<ClaimJobSpec> = {}): ClaimJobSpec {
  return {
    lockToken: token, lockDurationMs: 30_000, queue: 'default', names: ['work'], handlerTimeouts: {},
    handlerLockDurations: {}, legacySpend: { groupId: '00000000-0000-4000-8000-000000000001', capUsd: 5 }, ...extra,
  };
}

/** `{ value: count }` of the values, in value order. */
const tally = (values: unknown[]) => Object.fromEntries([...new Set(values.map(String))].sort().map(v => [v, values.filter(x => String(x) === v).length]));

describe('engine parity: multi-writer conformance', () => {
  // C01: a compare-and-set page write. Every writer appends its own line to one page at the revision it read; the page's
  // lines must be exactly the acknowledged writes (a lost update drops one, a phantom keeps one that was refused).
  parityTest('C01 same-page writers lose no update', { methods: ['putPage', 'readPageSnapshot'], mwCase: 'C01' }, async (engine) => {
    await engine.putPage('notes/c01', NOTE('C01', 'seed'));
    const stale = (await engine.readPageSnapshot('notes/c01', { sourceId: SRC }))!.revision;
    const writers = 8;
    const rounds = 4;
    const outcomes = await together(writers, async (w) => {
      const acked: string[] = [];
      const refused: string[] = [];
      for (let round = 0; round < rounds; round++) {
        const line = `w${w}r${round}`;
        const snap = (await engine.readPageSnapshot('notes/c01', { sourceId: SRC }))!;
        const wrote = await attempt(() => engine.putPage('notes/c01', NOTE('C01', `${snap.page.compiled_truth}\n${line}`), { expectedRevision: snap.revision }));
        if (wrote.ok) acked.push(line); else refused.push(wrote.code);
      }
      return { acked, refused };
    });
    const acked = outcomes.flatMap(o => o.acked).sort();
    const refused = outcomes.flatMap(o => o.refused);
    expect(acked.length).toBeGreaterThan(0);
    expect(acked.length + refused.length).toBe(writers * rounds);
    expect(refused.filter(code => code !== 'revision_conflict'), 'a refusal other than the typed conflict').toEqual([]);
    const lines = (await bodyOf(engine, 'notes/c01'))!.split('\n').slice(1);
    expect([...lines].sort(), 'an acknowledged write is missing from the page, or one that was refused landed').toEqual(acked);
    // The check can fail: a writer holding the revision read before all of this is refused, and changes nothing.
    const late = await attempt(() => engine.putPage('notes/c01', NOTE('C01', 'late'), { expectedRevision: stale }));
    expect(late).toEqual({ ok: false, code: 'revision_conflict' });
    expect((await bodyOf(engine, 'notes/c01'))!.split('\n').slice(1).length).toBe(lines.length);
    return { someWriterWon: acked.length > 0, lostOrPhantom: 0, staleWriter: late };
  });

  // C02: `upsertChunks` with an expected revision. A writer holding a stale revision gets a typed conflict and changes
  // nothing; a re-read gives the current revision, and the same call then succeeds.
  parityTest('C02 stale revision gets a typed conflict', { methods: ['putPage', 'readPageSnapshot', 'upsertChunks', 'getChunks'], mwCase: 'C02' }, async (engine) => {
    await engine.putPage('notes/c02', NOTE('C02', 'one'));
    const stale = (await engine.readPageSnapshot('notes/c02', { sourceId: SRC }))!.revision;
    await engine.putPage('notes/c02', NOTE('C02', 'two'), { expectedRevision: stale });
    const chunk = { chunk_index: 0, chunk_text: 'a part', chunk_source: 'compiled_truth' as const };
    const refused = await attempt(() => engine.upsertChunks('notes/c02', [chunk], { expectedRevision: stale }));
    expect(refused).toEqual({ ok: false, code: 'revision_conflict' });
    expect(await engine.getChunks('notes/c02', { includeUnsealed: true }), 'the refused writer changed the chunks').toHaveLength(0);
    const fresh = (await engine.readPageSnapshot('notes/c02', { sourceId: SRC }))!.revision;
    expect(fresh).not.toBe(stale);
    await engine.upsertChunks('notes/c02', [chunk], { expectedRevision: fresh });
    const stored = (await engine.getChunks('notes/c02', { includeUnsealed: true })).map(c => c.chunk_text);
    expect(stored).toEqual(['a part']);
    return { refused, afterReread: stored };
  });

  // C03: claiming a queued write is select-then-stamp in one transaction. Eight claimers race for one request: one
  // stamps it, the others find none, and only the winner's token renews the claim.
  parityTest('C03 two claimers of one write never both claim', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'selectClaimableWrite', 'stampWriteClaim', 'renewWriteClaim'],
    mwCase: 'C03',
  }, async (engine) => {
    const keys = ['principal:local_cli:parity-writer', 'brain'];
    const source = await engine.readSourceMembership(SRC);
    await engine.lockPersistenceCounters(keys);
    const request = await engine.insertWriteRequest({
      principalKind: 'local_cli', principalId: 'parity-writer', requestId: 'b0000000-0000-4000-8000-0000000000b1', operation: 'put_page',
      sourceId: SRC, sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/c03', worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/c03' }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
    const token = (i: number) => `c0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const claimers = 8;
    const claimed = await together(claimers, (i) => engine.transactionDirect(async (tx) => {
      const head = await tx.selectClaimableWrite<{ id: string }>({
        hostId: 'e0000000-0000-4000-8000-0000000000e1', excludeRoots: [], fifoRoots: [], laneRoots: [], nonce: `claimer-${i}`, syncSeen: {},
        priority: null, leaseHolder: null,
      });
      if (!head) return null;
      return (await tx.stampWriteClaim(head.id, token(i), 60_000, JSON.stringify({ phase: 'parity' }))) ? i : null;
    }));
    const winners = claimed.filter((i): i is number => i !== null);
    expect(winners, `request ${request.id} was claimed by more than one claimer`).toHaveLength(1);
    const renewing: number[] = [];
    for (let i = 0; i < claimers; i++) {
      if (await engine.renewWriteClaim({ id: request.id, token: token(i), leaseMs: 60_000, phaseJson: null })) renewing.push(i);
    }
    expect(renewing, 'a token other than the winner\'s renewed the claim').toEqual(winners);
    return { claimedBy: winners.length, renewedBy: renewing.length };
  });

  // C04: `claimNextJob`. Eight workers claim a pile of jobs: each job is claimed once, none is lost.
  parityTest('C04 eight workers claim each job once', { methods: ['admitJob', 'claimNextJob', 'getJob'], mwCase: 'C04' }, async (engine) => {
    // The engines serialize this differently (row locks with SKIP LOCKED, one writer, or optimistic commits that rerun
    // on a conflict); what must match is the outcome: no job claimed twice, none lost, one claim each.
    const total = 48;
    const first = await addJob(engine);
    for (let i = 1; i < total; i++) await addJob(engine, { priority: i % 3 });
    const claimed = await together(8, async (w) => {
      const mine: number[] = [];
      for (;;) {
        const row = await engine.claimNextJob(claimSpec(`w${w}:a`));
        if (!row) return mine;
        mine.push(Number(row.id) - first);
      }
    });
    const all = claimed.flat();
    expect(all.length - new Set(all).size, 'a job was claimed twice').toBe(0);
    expect([...all].sort((a, b) => a - b), 'a job was never claimed').toEqual(Array.from({ length: total }, (_, i) => i));
    const rows = await Promise.all(Array.from({ length: total }, (_, i) => engine.getJob(first + i)));
    expect(tally(rows.map(r => r?.status))).toEqual({ active: total });
    expect(tally(rows.map(r => Number(r?.claim_generation)))).toEqual({ '1': total });
    return { claimed: all.length, twice: 0, lost: 0, status: tally(rows.map(r => r?.status)), claimGeneration: tally(rows.map(r => Number(r?.claim_generation))) };
  });

  // C05: an expired claim is reclaimed once, and renewing it with the old token is refused. Eight sweeps run together.
  parityTest('C05 expired claim is reclaimed once', { methods: ['admitJob', 'claimNextJob', 'reclaimStalledJobs', 'renewJobLease', 'getJob'], mwCase: 'C05' }, async (engine) => {
    const id = await addJob(engine, { max_stalled: 3 });
    expect((await engine.claimNextJob(claimSpec('w:1', { lockDurationMs: -60_000 })))?.id).toBeDefined();
    const sweeps = await together(8, async () => (await engine.reclaimStalledJobs(0)).requeued.map(r => Number(r.id)));
    expect(sweeps.flat(), 'the expired claim was reclaimed other than once in total').toEqual([id]);
    const after = (await engine.getJob(id))!;
    expect({ status: after.status, stalled: after.stalled_counter }).toEqual({ status: 'waiting', stalled: 1 });
    expect(await engine.renewJobLease(id, 'w:1', 30_000), 'the old token renewed').toBe(false);
    const again = await engine.reclaimStalledJobs(0);
    expect({ requeued: again.requeued.length, dead: again.dead.length }).toEqual({ requeued: 0, dead: 0 });
    // The job is claimable again, and only the new claimant's token renews.
    expect((await engine.claimNextJob(claimSpec('w:2')))?.id).toBeDefined();
    expect(await engine.renewJobLease(id, 'w:1', 30_000)).toBe(false);
    expect(await engine.renewJobLease(id, 'w:2', 30_000)).toBe(true);
    return { reclaimedTotal: 1, stalled: after.stalled_counter, oldTokenRenews: false, newTokenRenews: true };
  });

  // C06: a stale lease holder's data write is refused by its token. Today the check is the caller's: the writing
  // transaction asserts its lease (`assertCycleLease`, which on Postgres also holds the lease row until commit) and
  // writes only while it holds it. A holder paused past its expiry resumes after a takeover and must write nothing.
  parityTest('C06 stale holder\'s data write refused by its token', {
    methods: ['acquireCycleLock', 'transaction', 'assertCycleLease', 'putPage', 'readPageSnapshot'], mwCase: 'C06',
  }, async (engine) => {
    const [paused, taker] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2'];
    const lease = (pid: number, token: string, extra: { ttlMinutes?: number; stealGraceSeconds?: number } = {}) =>
      ({ holderPid: pid, holderHost: `host-${pid}`, acquisitionToken: token, ttlMinutes: 30, stealGraceSeconds: 0, ...extra });
    expect(await engine.acquireCycleLock('gbrain-cycle:c06', lease(1, paused, { ttlMinutes: -1 }))).not.toBeNull();
    // A grace of -1 second: PGLite's clock ticks in milliseconds, so a zero grace may not have passed yet.
    expect(await engine.acquireCycleLock('gbrain-cycle:c06', lease(2, taker, { stealGraceSeconds: -1 })), 'the takeover').not.toBeNull();
    const guardedWrite = (token: string, body: string) => engine.transaction(async (tx) => {
      if (!(await tx.assertCycleLease('gbrain-cycle:c06', token))) return false;
      await tx.putPage('notes/c06-protected', NOTE('C06', body));
      return true;
    });
    const refused = await guardedWrite(paused, 'from the paused holder');
    expect(refused, 'the paused holder kept its lease').toBe(false);
    expect(await bodyOf(engine, 'notes/c06-protected'), 'the paused holder wrote protected data').toBeNull();
    const accepted = await guardedWrite(taker, 'from the new holder');
    expect(accepted).toBe(true);
    expect(await bodyOf(engine, 'notes/c06-protected')).toBe('from the new holder');
    return { pausedHolderWrote: refused, newHolderWrote: accepted };
  });

  // C06, variant `C06.partition`: a machine that comes back after a partition with old-epoch work is refused. Holder A
  // takes a short lease and writes protected data; it is cut off and its lease lapses; B takes over (a new epoch); A comes
  // back and its protected write with the old token is refused, it cannot renew or release, and no protected data of A's
  // old epoch is written. A then gets in only by re-acquiring after B, under a new epoch.
  // Postgres, PGLite and the single-writer Rust arm fence with the cycle lock members. On a Rust brain in multi-user mode
  // the fence is the store lease (`rustLeases`, host-fence): that branch is pending on the hosts work and is written
  // against the shape of src/core/rust-engine/store-members/leases.ts through a cast.
  parityTest('C06 stale holder\'s data write refused by its token: a host back from a partition with old-epoch work is refused', {
    methods: ['acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'transaction', 'assertCycleLease', 'putPage', 'readPageSnapshot'],
    mwCase: 'C06.partition',
  }, async (engine, backend) => {
    const SLUG = 'notes/c06-partition-protected';
    const outcome = { oldEpochWriteRefused: true, protectedDataUnchanged: true, newHolderWrote: true, oldTokenRenewed: false, oldTokenReleased: false, reacquiredUnderNewEpoch: true };
    if (backend === 'rust' && process.env.GBRAIN_RUST_MULTIUSER === '1') {
      // The store lease path (interface I-5): not BrainEngine members, reached through the Rust engine's store.
      type Holder = { host_id: string; incarnation: string; writer_id: string };
      type Lease = { name: string; epoch: number; token: string };
      type Leases = {
        acquireLease(a: { name: string; holder: Holder; ttl_ms: number }): Promise<Lease | null>;
        renewLease(a: { lease: Lease; ttl_ms: number }): Promise<void>;
        releaseLease(lease: Lease): Promise<void>;
        assertLease(lease: Lease): Promise<void>;
      };
      type Opens = { openStore(member: string): { brain: Leases } };
      const reasonOf = (error: unknown) => {
        const e = error as { code?: string; reason?: string; detail?: { reason?: string }; envelope?: { detail?: { reason?: string } } };
        return { code: e?.code ?? 'threw', reason: e?.reason ?? e?.detail?.reason ?? e?.envelope?.detail?.reason ?? null };
      };
      const leasesOf = (e: BrainEngine) => (e as unknown as Opens).openStore('leases').brain;
      const holder = (n: number): Holder => ({ host_id: `host-${n}`, incarnation: `inc-${n}`, writer_id: `writer-${n}` });
      const NAME = 'consumer:c06-partition';
      const ttlMs = 50;
      const a = await leasesOf(engine).acquireLease({ name: NAME, holder: holder(1), ttl_ms: ttlMs });
      expect(a).not.toBeNull();
      const guarded = (lease: Lease, body: string) => engine.transaction(async (tx) => {
        await leasesOf(tx).assertLease(lease);
        await tx.putPage(SLUG, NOTE('C06', body));
      });
      await guarded(a!, 'epoch A');
      await Bun.sleep(ttlMs * 3);
      // An expired lease cannot be renewed: its holder must acquire again, under a new epoch.
      const renewed = await attempt(() => leasesOf(engine).renewLease({ lease: a!, ttl_ms: 60_000 }));
      expect(renewed.ok ? null : reasonOf(renewed)).toEqual({ code: 'lease_lost', reason: 'expired' });
      const b = await leasesOf(engine).acquireLease({ name: NAME, holder: holder(2), ttl_ms: 60_000 });
      expect(b, 'the takeover').not.toBeNull();
      expect(b!.epoch, 'a takeover raises the epoch').toBeGreaterThan(a!.epoch);
      const stale = await attempt(() => guarded(a!, 'old-epoch work from A'));
      expect(stale.ok ? null : reasonOf(stale), 'the old epoch\'s write was not refused as epoch_moved').toEqual({ code: 'lease_lost', reason: 'epoch_moved' });
      expect(await bodyOf(engine, SLUG), 'old-epoch work was written').toBe('epoch A');
      await guarded(b!, 'epoch B');
      expect(await bodyOf(engine, SLUG)).toBe('epoch B');
      await leasesOf(engine).releaseLease(b!);
      const a2 = await leasesOf(engine).acquireLease({ name: NAME, holder: holder(1), ttl_ms: 60_000 });
      expect(a2!.epoch, 'the holder that came back re-acquired under a new epoch').toBeGreaterThan(b!.epoch);
      await guarded(a2!, 'epoch A again');
      expect((await attempt(() => guarded(a!, 'old token again'))).ok).toBe(false);
      expect(await bodyOf(engine, SLUG)).toBe('epoch A again');
      return outcome;
    }
    const LOCK = 'gbrain-cycle:c06-partition';
    const [tokenA, tokenB, tokenA2] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2'];
    const lease = (pid: number, token: string, ttlMinutes = 30) => ({ holderPid: pid, holderHost: `host-${pid}`, acquisitionToken: token, ttlMinutes, stealGraceSeconds: 0 });
    const holderToken = async () => (await engine.readCycleLocks({ by: 'id', lockId: LOCK }))[0]?.acquisition_token ?? null;
    const guardedWrite = (token: string, body: string) => engine.transaction(async (tx) => {
      if (!(await tx.assertCycleLease(LOCK, token))) return false;
      await tx.putPage(SLUG, NOTE('C06', body));
      return true;
    });
    // A holds a short lease (1.2 s) and writes while it holds it.
    expect(await engine.acquireCycleLock(LOCK, lease(1, tokenA, 0.02))).not.toBeNull();
    expect(await guardedWrite(tokenA, 'epoch A'), 'a live holder must be able to write').toBe(true);
    // A is cut off and stops renewing. B takes the lease as soon as it has lapsed (bounded wait, no fixed sleep).
    const deadline = Date.now() + 10_000;
    let took = await engine.acquireCycleLock(LOCK, lease(2, tokenB));
    while (took === null && Date.now() < deadline) { await Bun.sleep(25); took = await engine.acquireCycleLock(LOCK, lease(2, tokenB)); }
    expect(took, 'B never took over the lapsed lease').not.toBeNull();
    expect(await holderToken()).toBe(tokenB);
    // A comes back with work it began in the old epoch: refused, and nothing of it is written.
    expect(await guardedWrite(tokenA, 'old-epoch work from A'), 'the old epoch\'s write was accepted').toBe(false);
    expect(await bodyOf(engine, SLUG), 'old-epoch work was written').toBe('epoch A');
    // It cannot renew or release a lease that is no longer its own, and B keeps it.
    expect(await engine.refreshCycleLock(LOCK, { holderPid: 1, acquisitionToken: tokenA, ttlMinutes: 30 }), 'the old holder renewed').toBe(false);
    expect(await engine.releaseCycleLock(LOCK, { holderPid: 1, acquisitionToken: tokenA }), 'the old holder released B\'s lease').toBe(false);
    expect(await holderToken()).toBe(tokenB);
    expect(await guardedWrite(tokenB, 'epoch B'), 'the new holder must be able to write').toBe(true);
    expect(await guardedWrite(tokenA, 'old-epoch work again')).toBe(false);
    expect(await bodyOf(engine, SLUG)).toBe('epoch B');
    // Back in only by acquiring again: refused while B holds, granted after B releases, under a new token.
    expect(await engine.acquireCycleLock(LOCK, lease(1, tokenA2)), 'the lease is exclusive while B holds it').toBeNull();
    expect(await engine.releaseCycleLock(LOCK, { holderPid: 2, acquisitionToken: tokenB })).toBe(true);
    expect(await engine.acquireCycleLock(LOCK, lease(1, tokenA2))).not.toBeNull();
    expect(await guardedWrite(tokenA2, 'epoch A again')).toBe(true);
    expect(await guardedWrite(tokenA, 'the first token again'), 'the first token works again').toBe(false);
    expect(await bodyOf(engine, SLUG)).toBe('epoch A again');
    return outcome;
  });

  // C07: an effect is claimed once; if its owner dies between the action and recording it, the effect is claimed again,
  // the dead owner's late record changes nothing, and the request ends with one effect row.
  parityTest('C07 effect claimed once, rerun after owner crash', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects',
      'selectClaimableEffect', 'stampEffectClaim', 'completeEffectRow', 'readRequestEffects'],
    mwCase: 'C07',
  }, async (engine) => {
    const host = 'd0000000-0000-4000-8000-0000000000d1';
    const keys = ['principal:local_cli:parity-writer', 'brain'];
    const source = await engine.readSourceMembership(SRC);
    await engine.lockPersistenceCounters(keys);
    const request = await engine.insertWriteRequest({
      principalKind: 'local_cli', principalId: 'parity-writer', requestId: 'b0000000-0000-4000-8000-0000000000b1', operation: 'put_page',
      sourceId: SRC, sourceIncarnation: source!.incarnation, pageId: null, slug: 'notes/c07', worktreeId: null, topologyGeneration: null,
      digest: 'd'.repeat(64), intent: { kind: 'put_page', slug: 'notes/c07' }, authority: { scopes: ['write'] }, intentBytes: 100,
      terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: keys,
      clientRequestId: null, state: 'queued', deferredRefreshId: null,
    });
    await engine.transactionDirect(async (tx) => {
      await tx.declarePersistence();
      await tx.insertPublicationEffects({
        requestId: request.id, revision: null, sourceId: SRC, sourceIncarnation: source!.incarnation, worktreeId: null,
        effects: [{ kind: 'embedding', data: { slug: 'notes/c07', page_id: 1 } }],
      });
    });
    type Claimed = { id: string | number; execution_token: string };
    const token = (i: number) => `f0000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const owner = (i: number) => JSON.stringify({ token: token(i), owner: { pid: 7, nonce: `n${i}`, start: 's' } });
    const claim = (i: number, dead: string[]) => engine.transactionDirect(async (tx) => {
      await tx.declarePersistence();
      const next = await tx.selectClaimableEffect<{ id: string | number }>(host, dead);
      if (!next?.id) return null;
      return tx.stampEffectClaim<Claimed>({ id: next.id, token: token(i), ownerJson: owner(i) });
    });
    const won = await together(8, (i) => claim(i, []));
    const winners = won.map((row, i) => (row ? i : -1)).filter(i => i >= 0);
    expect(winners, 'one effect, several claimants').toHaveLength(1);
    const first = winners[0]!;
    const effect = won[first]!;
    // The owner dies after the action and before it records: its effect is claimable again and runs again.
    const rerun = await claim(99, [`7:n${first}:s`]);
    expect(rerun?.id, 'a dead owner\'s effect was not claimed again').toEqual(effect.id);
    await engine.completeEffectRow({ id: effect.id, token: token(first), outcomeJson: '{}' });
    const afterDead = await engine.readRequestEffects(request.id);
    expect(afterDead.map(e => e.state), 'the dead owner recorded the effect').toEqual(['running']);
    await engine.completeEffectRow({ id: effect.id, token: token(99), outcomeJson: '{}' });
    const effects = await engine.readRequestEffects(request.id);
    expect(effects, 'a duplicate effect row').toHaveLength(1);
    expect(effects[0]!.state).toBe('committed');
    return { claimants: winners.length, reclaimed: true, deadOwnerRecorded: false, effectRows: effects.length, state: effects[0]!.state };
  });

  // C08: a counter never over-admits. 24 callers ask a 24-hour daily cap of five judge slots at once: five are granted,
  // the count is five, and no update is lost.
  parityTest('C08 counter never over-admits', { methods: ['reserveChronicleJudgeSlot', 'countRecentChronicleReservations'], mwCase: 'C08' }, async (engine) => {
    const cap = 5;
    const granted = await together(24, (i) => engine.reserveChronicleJudgeSlot(cap, { sourceId: SRC, pageId: i + 1, contentHash: `hash-${i}` }));
    expect(granted.filter(Boolean).length, 'the cap did not hold, or a grant was lost').toBe(cap);
    expect(await engine.countRecentChronicleReservations(), 'the counter does not match the grants').toBe(cap);
    // The check can fail: with the cap raised, the next caller is granted and the counter moves.
    expect(await engine.reserveChronicleJudgeSlot(cap + 1, { sourceId: SRC, pageId: 99, contentHash: 'hash-more' })).toBe(true);
    expect(await engine.countRecentChronicleReservations()).toBe(cap + 1);
    return { granted: granted.filter(Boolean).length, count: cap, afterRaise: cap + 1 };
  });

  // C09: an idempotency key maps to one row. Eight concurrent submissions of one key: one inserts, the rest coalesce onto it.
  parityTest('C09 idempotency key maps to one row', { methods: ['admitJob', 'listJobs'], mwCase: 'C09' }, async (engine) => {
    const outcomes = await together(8, async () => {
      const out = await admit(engine, { idempotency_key: 'k1' });
      return { coalesced: out.coalesced, id: Number(out.row.id) };
    });
    expect(new Set(outcomes.map(o => o.id)).size, 'one key made more than one row').toBe(1);
    expect(outcomes.filter(o => !o.coalesced), 'not exactly one submission inserted').toHaveLength(1);
    expect(await engine.listJobs({ limit: 500 })).toHaveLength(1);
    // The check can fail: another key is another row.
    const other = await admit(engine, { idempotency_key: 'k2' });
    expect(other.coalesced).toBe(false);
    expect(await engine.listJobs({ limit: 500 })).toHaveLength(2);
    return { rows: 1, inserted: 1, coalesced: 7, otherKeyRows: 2 };
  });

  // C10: the facts of one entity form one stable order and none is lost. Eight writers append to one entity; the order
  // a reader sees is the same on every read and across pages of it, and holds every acknowledged fact once.
  parityTest('C10 facts of one entity form one total order', { methods: ['insertFact', 'listFactsByEntity'], mwCase: 'C10' }, async (engine) => {
    const writers = 8;
    const each = 4;
    const acked = (await together(writers, async (w) => {
      const mine: Array<{ id: number; text: string }> = [];
      for (let n = 0; n < each; n++) {
        const text = `fact ${w} ${n}`;
        const out = await engine.insertFact({ fact: text, entity_slug: 'people/alice-example', source: 'mcp:remember' }, { source_id: SRC });
        expect(out.status).toBe('inserted');
        mine.push({ id: Number(out.id), text });
      }
      return mine;
    })).flat();
    expect(new Set(acked.map(f => f.id)).size, 'a fact id was handed out twice').toBe(writers * each);
    const read = () => engine.listFactsByEntity(SRC, 'people/alice-example', { limit: 500 });
    const first = (await read()).map((f: FactRow) => f.fact);
    const second = (await read()).map((f: FactRow) => f.fact);
    expect(second, 'the order changed between reads').toEqual(first);
    expect([...first].sort(), 'a fact was lost or repeated').toEqual(acked.map(f => f.text).sort());
    const paged: string[] = [];
    for (let offset = 0; offset < first.length; offset += 7) {
      paged.push(...(await engine.listFactsByEntity(SRC, 'people/alice-example', { limit: 7, offset })).map((f: FactRow) => f.fact));
    }
    expect(paged, 'the pages of the order do not add up to the order').toEqual(first);
    return { facts: first.length, lost: 0, repeated: 0, stable: true, pagesAddUp: true };
  });

  // C11: the order of one entity's facts a reader sees is commit order. New rule (SQL reads order facts by
  // created_at, id, which is not commit order), pending on every engine until facts carry a sequence assigned at commit.
  // No engine member returns a commit position yet, so the body checks the part that is observable: a fact acknowledged
  // before another began reads before it, across rounds of concurrent appends. When a typed position member exists it
  // replaces this check with the exact commit-position comparison.
  parityTest('C11 per-entity order equals commit order', { methods: ['insertFact', 'listFactsByEntity'], mwCase: 'C11' }, async (engine) => {
    const rounds = 5;
    const perRound = 4;
    const roundOf = new Map<string, number>();
    for (let round = 0; round < rounds; round++) {
      await together(perRound, async (w) => {
        const text = `fact r${round} w${w}`;
        roundOf.set(text, round);
        await engine.insertFact({ fact: text, entity_slug: 'people/alice-example', source: 'mcp:remember' }, { source_id: SRC });
      });
    }
    const newestFirst = (await engine.listFactsByEntity(SRC, 'people/alice-example', { limit: 500 })).map((f: FactRow) => f.fact);
    const oldestFirst = [...newestFirst].reverse().map(text => roundOf.get(text)!);
    expect(oldestFirst, 'a fact acknowledged earlier reads after one acknowledged later').toEqual([...oldestFirst].sort((a, b) => a - b));
    expect(newestFirst).toHaveLength(rounds * perRound);
    return { facts: newestFirst.length, roundsInOrder: true };
  });

  // C12: two transactions each read their own uncommitted writes and never the other's. Opened together; one commits,
  // the other rolls back, so the rolled-back write must never be seen by the committing transaction or afterwards.
  parityTest('C12 two transactions read only their own writes', { methods: ['transaction', 'putPage', 'getPage'], mwCase: 'C12' }, async (engine) => {
    const rollback = new Error('rolled back on purpose');
    const run = (mine: string, theirs: string, commit: boolean) => engine.transaction(async (tx) => {
      await tx.putPage(mine, NOTE(mine, 'uncommitted'));
      await Bun.sleep(5);
      const sawOwn = (await tx.getPage(mine)) !== null;
      await Bun.sleep(5);
      const sawTheirs = (await tx.getPage(theirs)) !== null;
      if (!commit) throw Object.assign(rollback, { sawOwn, sawTheirs });
      return { sawOwn, sawTheirs };
    });
    const [kept, dropped] = await Promise.all([
      run('tx/kept', 'tx/dropped', true),
      run('tx/dropped', 'tx/kept', false).then(() => null, (error: Error & { sawOwn?: boolean }) => (error === rollback ? { sawOwn: error.sawOwn } : Promise.reject(error))),
    ]);
    expect(kept.sawOwn, 'a transaction cannot read its own write').toBe(true);
    expect(kept.sawTheirs, 'the committing transaction read the other\'s uncommitted write').toBe(false);
    expect(dropped?.sawOwn, 'the rolled-back transaction could not read its own write').toBe(true);
    expect(await engine.getPage('tx/kept'), 'a committed write is missing').not.toBeNull();
    expect(await engine.getPage('tx/dropped'), 'a rolled-back write is visible').toBeNull();
    return { keptSawOwn: kept.sawOwn, keptSawTheirs: kept.sawTheirs, droppedSawOwn: dropped?.sawOwn, committedVisible: true, rolledBackVisible: false };
  });

  // C13: transactions on different keys do not wait. A commit on another key lands while a transaction is open.
  // Postgres (row locks) runs it; PGLite has one connection and queues a second transaction behind the open one.
  parityTest('C13 transactions on different keys do not wait', { methods: ['putPage', 'transaction', 'lockPageKeys'], mwCase: 'C13' }, async (engine) => {
    await engine.putPage('notes/c13-a', NOTE('A', 'before'));
    const opened = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const open = engine.transaction(async (tx) => {
      await tx.lockPageKeys([{ sourceId: SRC, slug: 'notes/c13-a' }]);
      await tx.putPage('notes/c13-a', NOTE('A', 'from the transaction'));
      opened.resolve();
      await finish.promise;
    });
    try {
      await opened.promise;
      // The commit on another key must land while the transaction above is still open.
      await within(5_000, 'a commit on another key while a transaction was open', engine.putPage('notes/c13-b', NOTE('B', 'another key')));
    } finally {
      finish.resolve();
      await open;
    }
    expect(await bodyOf(engine, 'notes/c13-b')).toBe('another key');
    expect(await bodyOf(engine, 'notes/c13-a')).toBe('from the transaction');
    return { otherKeyCommittedWhileOpen: true };
  });

  // C14: concurrent publishers of one generation key: generations only grow and exactly one publisher wins. Each
  // publisher reads the live generation, then in a transaction takes the key lock, re-reads it and activates the next
  // generation only if it is still the one it read (the stale ones are fenced, as generations/publish.ts does).
  parityTest('C14 concurrent publishers, one winner', {
    methods: ['readLiveGenerationRow', 'activateGenerationRows', 'lockGenerationKey', 'transaction'], mwCase: 'C14',
  }, async (engine) => {
    const key = { sourceId: SRC, kind: 'managed_walk', ownerKey: 'input:c14' };
    const row = (generation: number, who: string) => ({
      generation, runId: null, operationId: `op-${who}`, inputPin: null, inputSize: null, completeness: '{}', setHash: 'h', restoreOf: null,
      activationId: null, locator: null,
    });
    const item = { item_key: 'atoms/x', identity_hash: 'x', action: 'published', preimage: null, preimage_bytes: null, pending: false };
    const publish = (who: string) => engine.transaction(async (tx) => {
      const seen = await tx.readLiveGenerationRow(key);
      await Bun.sleep(2);
      await tx.lockGenerationKey(`${key.sourceId}:${key.kind}:${key.ownerKey}`);
      const live = await tx.readLiveGenerationRow(key);
      if ((live?.id ?? null) !== (seen?.id ?? null)) return null;
      return tx.activateGenerationRows(key, live?.id ?? null, row((live?.generation ?? 0) + 1, who), [item]);
    });
    const first = await publish('first');
    expect(first).not.toBeNull();
    const results = await together(8, (i) => attempt(() => publish(`p${i}`)));
    const generations: number[] = [];
    let stale = 0;
    for (const r of results) {
      if (!r.ok) throw new Error(`a publisher failed instead of being fenced: ${r.code}`);
      if (r.value === null) stale++; else generations.push(Number(r.value));
    }
    const live = await engine.readLiveGenerationRow(key);
    // Publishers that read the same live row race for it; later ones may read the winner's row and win in turn, so the
    // check is on what must hold regardless: the live generation counts exactly the winning publishes, none twice.
    expect(live!.generation, 'a publish was lost or two won the same generation').toBe(1 + generations.length);
    expect(new Set(generations).size).toBe(generations.length);
    expect(generations.length, 'no publisher won').toBeGreaterThan(0);
    expect(generations.length + stale).toBe(8);
    return { liveGenerationCountsWinners: true, someWon: generations.length > 0 };
  });

  // C15: a transaction that holds a key through `lockPageKeys` is the only holder until it commits or aborts. Eight
  // writers take one hot key in three rounds (the middle round aborts): never two holders at once, and an aborted
  // holder releases the key. Whether different keys fly together is C13.
  parityTest('C15 single flight holds only its keys', { methods: ['transaction', 'lockPageKeys', 'putPage', 'readPageSnapshot'], mwCase: 'C15' }, async (engine) => {
    let inside = 0;
    let most = 0;
    const abort = new Error('aborted on purpose');
    let committed = 0;
    let aborted = 0;
    await together(8, async (w) => {
      for (let round = 0; round < 3; round++) {
        const outcome = await attempt(() => engine.transaction(async (tx) => {
          await tx.lockPageKeys([{ sourceId: SRC, slug: 'shared/hot' }]);
          most = Math.max(most, ++inside);
          await tx.putPage('shared/hot', NOTE('hot', `w${w} r${round}`));
          await Bun.sleep(2);
          inside--;
          if (round === 1) throw abort;
        }));
        if (outcome.ok) committed++; else if (outcome.code === 'threw') aborted++; else throw new Error(`unexpected ${outcome.code}`);
      }
    });
    expect(most, 'two holders of one key at once').toBe(1);
    expect({ committed, aborted }).toEqual({ committed: 16, aborted: 8 });
    // Released at commit and at abort: the key can be taken again at once.
    await within(5_000, 'taking a released key', engine.transaction(async (tx) => { await tx.lockPageKeys([{ sourceId: SRC, slug: 'shared/hot' }]); }));
    expect(await bodyOf(engine, 'shared/hot'), 'an aborted holder\'s write stayed').toMatch(/^w\d r[02]$/);
    return { mostHolders: most, committed, aborted, released: true };
  });

  // C16: a format upgrade runs once under concurrent openers. Pending on every engine that has a second connection:
  // no typed engine member reports the store's format after connect, and an older-format brain is made with
  // engine-private code, so the upgrade count and the old-or-new view are not observable through BrainEngine. The
  // body is the part that is: four openers connect to a brain with data at once, and every one reports the same
  // schema version and sees the whole brain. The store-level cases (upgrade once, concurrent open) are the exam today.
  parityTest('C16 format upgrade runs once under concurrent openers', { methods: ['putPage', 'getPage', 'getConfig'], mwCase: 'C16' }, async (engine, _backend, ctx) => {
    await engine.putPage('notes/c16', NOTE('C16', 'kept across the upgrade'));
    const openers = await together<BrainEngine>(4, () => ctx.sameBrainEngine());
    const seen = await Promise.all([engine, ...openers].map(async e => ({ version: await e.getConfig('version'), body: (await e.getPage('notes/c16'))?.compiled_truth ?? null })));
    expect(new Set(seen.map(s => s.version)).size, 'openers report different formats').toBe(1);
    expect(seen.map(s => s.body), 'an opener saw a partial brain').toEqual(seen.map(() => 'kept across the upgrade'));
    return { openers: seen.length, oneFormat: true, wholeBrain: true };
  });

  // C17: a second opener becomes a client, never an error. Postgres: a second connection to the brain never gets a busy
  // error, and calls in flight on both connections all succeed. PGLite refuses a second opener by design (n/a). The
  // owner-socket behavior of Rust (the client retries calls in flight by request id) is the server's: pending there.
  parityTest('C17 a second opener becomes a client, never an error', { methods: ['putPage', 'getPage'], mwCase: 'C17' }, async (engine, _backend, ctx) => {
    await engine.putPage('notes/c17-a', NOTE('A', 'written by the first opener'));
    const second = await ctx.sameBrainEngine();
    expect((await second.getPage('notes/c17-a'))?.compiled_truth, 'the second opener does not see the first\'s write').toBe('written by the first opener');
    await second.putPage('notes/c17-b', NOTE('B', 'written by the second opener'));
    expect((await engine.getPage('notes/c17-b'))?.compiled_truth, 'the first opener does not see the second\'s write').toBe('written by the second opener');
    const inFlight = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => (i % 2 ? second : engine).putPage(`notes/c17-${i}`, NOTE(`N${i}`, `call ${i}`))));
    const refused = inFlight.flatMap(r => (r.status === 'rejected' ? [codeOf(r.reason)] : []));
    expect(refused.filter(code => BUSY_CODES.has(code)), 'a call in flight got a busy error').toEqual([]);
    expect(refused, 'a call in flight was refused').toEqual([]);
    return { secondOpened: true, mutuallyVisible: true, inFlightRefused: refused.length };
  });

  // C18: many writers, every row family, no busy error. 64 writers share up to eight connections to the brain (PGLite and
  // the Rust owner's first connection: the arm's own engine): each writes its pages, submits a job under a request key and
  // claims jobs. No lost update, no double claim, no busy error.
  parityTest('C18 64 writers in 8 processes, no busy error', { methods: ['putPage', 'readPageSnapshot', 'admitJob', 'claimNextJob', 'listJobs'], mwCase: 'C18' }, async (engine, _backend, ctx) => {
    const conns = await connections(engine, ctx, 8);
    const writers = 64;
    const out = await together(writers, async (w) => {
      const db = conns[w % conns.length]!;
      const refused: string[] = [];
      const pages: string[] = [];
      for (let round = 0; round < 2; round++) {
        const slug = `notes/c18-${w}-${round}`;
        const wrote = await attempt(() => db.putPage(slug, NOTE(`W${w}`, `body ${w} ${round}`)));
        if (wrote.ok) pages.push(slug); else refused.push(wrote.code);
      }
      const submitted = await attempt(() => admit(db, { idempotency_key: `req-${w}` }));
      if (!submitted.ok) refused.push(submitted.code);
      const claimed = await attempt(() => db.claimNextJob(claimSpec(`w${w}:a`)));
      if (!claimed.ok) refused.push(claimed.code);
      return { pages, refused, job: claimed.ok && claimed.value ? Number(claimed.value.id) : null };
    });
    const refused = out.flatMap(o => o.refused);
    expect(refused.filter(code => BUSY_CODES.has(code)), 'a writer got a busy error').toEqual([]);
    expect(refused, 'a writer was refused').toEqual([]);
    for (const slug of out.flatMap(o => o.pages)) expect(await bodyOf(engine, slug), `${slug}: a write is missing`).not.toBeNull();
    expect(out.flatMap(o => o.pages)).toHaveLength(writers * 2);
    const jobs = await engine.listJobs({ limit: 500 });
    expect(jobs, 'a request key made more than one row, or a submission was lost').toHaveLength(writers);
    const claimedIds = out.map(o => o.job).filter((id): id is number => id !== null);
    expect(claimedIds.length - new Set(claimedIds).size, 'a job was claimed twice').toBe(0);
    expect(claimedIds, 'a job was left unclaimed while writers were idle').toHaveLength(writers);
    return { pages: writers * 2, jobs: jobs.length, claimed: claimedIds.length, twice: 0, busy: 0 };
  });

  // C19: crash after commit keeps acknowledged writes. A writer's connection goes away after its writes were
  // acknowledged (a second connection where the arm has one, else the arm's own engine stays): every acknowledged write
  // is present, and replaying each request id returns the stored row and makes no duplicate. The kill itself (SIGKILL of
  // a writing process mid-stream) is the store-level case and the crash robot under scripts/persistence/.
  parityTest('C19 crash after commit keeps acknowledged writes', { methods: ['putPage', 'readPageSnapshot', 'admitJob', 'listJobs'], mwCase: 'C19' }, async (engine, _backend, ctx) => {
    const conns = await connections(engine, ctx, 2);
    const writer = conns[1] ?? engine;
    const count = 20;
    const acked: Array<{ n: number; job: number }> = [];
    for (let n = 0; n < count; n++) {
      await writer.putPage(`notes/c19-${n}`, NOTE(`N${n}`, `acknowledged ${n}`));
      acked.push({ n, job: Number((await admit(writer, { idempotency_key: `request-${n}` })).row.id) });
    }
    if (writer !== engine) await writer.disconnect();
    for (const { n } of acked) expect(await bodyOf(engine, `notes/c19-${n}`), `acknowledged write ${n} is missing`).toBe(`acknowledged ${n}`);
    expect(await engine.listJobs({ limit: 500 })).toHaveLength(count);
    for (const { n, job } of acked) {
      const replay = await admit(engine, { idempotency_key: `request-${n}` });
      expect({ coalesced: replay.coalesced, same: Number(replay.row.id) === job }, `replay ${n} did not return the stored row`).toEqual({ coalesced: true, same: true });
      await engine.putPage(`notes/c19-${n}`, NOTE(`N${n}`, `acknowledged ${n}`));
    }
    expect(await engine.listJobs({ limit: 500 }), 'a replay duplicated a row').toHaveLength(count);
    return { present: count, jobsAfterReplay: count, replaysReturnedStored: count };
  });

  // C20: no deadlock across two pages taken in both orders. Eight writers take pair/a and pair/b in opposite orders:
  // once in transactions that lock their keys, once with compare-and-set writes and no lock at all. All finish, and every
  // update of the second form lands.
  parityTest('C20 no deadlock across two pages in both orders', { methods: ['putPage', 'readPageSnapshot', 'transaction', 'lockPageKeys'], mwCase: 'C20' }, async (engine) => {
    const order = (w: number) => (w % 2 === 0 ? ['pair/a', 'pair/b'] : ['pair/b', 'pair/a']);
    await within(30_000, 'writers taking two pages in opposite orders (locked)', together(8, async (w) => {
      for (let round = 0; round < 3; round++) {
        await engine.transaction(async (tx) => {
          await tx.lockPageKeys(order(w).map(slug => ({ sourceId: SRC, slug })));
          for (const slug of order(w)) await tx.putPage(slug, NOTE(slug, `locked ${w} ${round}`));
        });
      }
    }));
    expect(await bodyOf(engine, 'pair/a')).toMatch(/^locked \d \d$/);
    expect(await bodyOf(engine, 'pair/b')).toMatch(/^locked \d \d$/);
    // Compare-and-set, no locks: each writer appends its line to both pages and retries on a typed conflict.
    for (const slug of ['pair/a', 'pair/b']) await engine.putPage(slug, NOTE(slug, 'cas'));
    await within(30_000, 'writers taking two pages in opposite orders (compare-and-set)', together(8, async (w) => {
      for (const slug of order(w)) {
        for (;;) {
          const snap = (await engine.readPageSnapshot(slug, { sourceId: SRC }))!;
          const wrote = await attempt(() => engine.putPage(slug, NOTE(slug, `${snap.page.compiled_truth}\nw${w}`), { expectedRevision: snap.revision }));
          if (wrote.ok) break;
          expect(wrote.code).toBe('revision_conflict');
        }
      }
    }));
    for (const slug of ['pair/a', 'pair/b']) {
      expect((await bodyOf(engine, slug))!.split('\n').slice(1).sort(), `${slug}: an update was lost`).toEqual(Array.from({ length: 8 }, (_, w) => `w${w}`));
    }
    return { finished: true, updatesLanded: 8 };
  });

  // C21: a write acknowledged on one connection is seen on another given its commit position as a token. The token part
  // is new and pending on every engine (no engine returns a position; `transaction` returns the callback's value), and
  // PGLite has one connection (n/a). The body is today's plain read-after-commit on a second connection; it gains the
  // token (the read waits for it, or times out with `position_not_reached`) when a typed position member exists.
  parityTest('C21 read-your-writes token on a second connection', { methods: ['putPage', 'getPage'], mwCase: 'C21' }, async (engine, _backend, ctx) => {
    const second = await ctx.sameBrainEngine();
    for (let n = 0; n < 8; n++) {
      await engine.putPage(`notes/c21-${n}`, NOTE(`N${n}`, `acknowledged on A ${n}`));
      expect((await second.getPage(`notes/c21-${n}`))?.compiled_truth, `connection B does not see write ${n} acknowledged on A`).toBe(`acknowledged on A ${n}`);
    }
    return { seenByB: 8 };
  });

  // C22: commit positions strictly increase: no two commits share one and positions only grow. Pending on every engine
  // (`L2 commit log`): no engine exposes a typed commit-position or commit-log member, and no case substitutes admission
  // sequence, callback completion order or a local counter for one. The body reads the commit log through the member the
  // commit-log work adds (`readCommitLog(after, max)`, I-4) and stops as pending while it does not exist.
  parityTest('C22 commit position strictly increases', { methods: ['putPage'], mwCase: 'C22' }, async (engine) => {
    type Position = { sequence: number; index: number };
    type CommitLog = { readCommitLog(after: Position | null, max: number): Promise<{ records: Array<{ position: Position }> }> };
    const log = engine as unknown as Partial<CommitLog>;
    if (typeof log.readCommitLog !== 'function') throw new Error('C22 is pending: no typed commit-position member (commit-log work)');
    await together(8, async (w) => { for (let n = 0; n < 4; n++) await engine.putPage(`notes/c22-${w}-${n}`, NOTE(`N${w}`, `commit ${n}`)); });
    const read = () => log.readCommitLog!(null, 10_000).then(page => page.records.map(r => r.position));
    const positions = await read();
    const key = (p: Position) => p.sequence * 2 ** 32 + p.index;
    expect(positions.length, 'fewer commits than writes').toBeGreaterThanOrEqual(32);
    expect(new Set(positions.map(key)).size, 'two commits share a position').toBe(positions.length);
    expect(positions.map(key), 'positions went back').toEqual([...positions.map(key)].sort((a, b) => a - b));
    await engine.putPage('notes/c22-after', NOTE('after', 'one more'));
    const later = await read();
    expect(key(later[later.length - 1]!), 'a later commit did not take a greater position').toBeGreaterThan(key(positions[positions.length - 1]!));
    return { commits: positions.length, distinct: true, increasing: true };
  });
});
