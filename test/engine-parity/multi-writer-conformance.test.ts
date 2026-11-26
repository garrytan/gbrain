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
 *    an acknowledged write after its writer process is killed (a client crash: see C19 for what that does and does not prove). Each case asserts its invariant inside the scenario; the
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
 * The matrix row of each case (members, reference, cells) is multi-writer-cases.ts; test/multi-writer-cases.test.ts checks
 * that this file and the matrix agree. A case whose every engine cell is pending still has a real scenario body: it is
 * skipped by the harness, never run, and is the edit that turns the case on when its owner lands.
 */
import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine, FactRow } from '../../src/core/engine.ts';
import type { JobInsertValues } from '../../src/core/engine-sql/jobs.ts';
import type { CommitPosition } from '../../src/core/engine-members/commit-log.ts';
import type { PageInput } from '../../src/core/types.ts';
import type { LeaseToken, FenceOpts } from '../../src/core/engine-sql/lease-token.ts';
import { rustLeases, type RustLeases, type WriteOrigin } from '../../src/core/rust-engine/store-members/leases.ts';
import { withEnv } from '../helpers/with-env.ts';
import { parityArms, type ParityBackend, type ParityContext, rustArmModeProblem, rustArmMultiuser, rustMultiuserView } from './harness.ts';
import { clearHostRegistration, fenceOpts, hostLeaseName, setHostRegistration } from '../../src/core/persistence/host-fence.ts';
import { openRustBrainAt, resolvedMultiuser, RUST_MULTIUSER_CONFIG_KEY } from './rust-arm.ts';
import { testBackends } from '../helpers/test-backends.ts';
import {
  JOB_POLICY, acknowledgedWriteViolations, claimSpec, crashBody, crashKey, crashSlug, jobValues, runStressWriters, startWriter, stressSlug, stressViolations,
  type CrashObservation, type StressReport, type WriterConfig,
} from './multi-writer-support.ts';

const { parityTest } = parityArms(testBackends());

const SRC = 'default';
const NOTE = (title: string, body: string): PageInput => ({ type: 'note', title, compiled_truth: body, timeline: '' });

/** The `code` an error carries, or `threw` when it has none. */
const codeOf = (error: unknown): string => (error as { code?: string } | null)?.code ?? 'threw';

/** Runs `step(i)` for `i` in `0..n-1` at once. */
const together = <T>(n: number, step: (i: number) => Promise<T>): Promise<T[]> => Promise.all(Array.from({ length: n }, (_, i) => step(i)));

/** What an attempt did: the value it returned, or the code it threw with and the error itself. */
async function attempt<T>(run: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string; error: unknown }> {
  try { return { ok: true, value: await run() }; } catch (error) { return { ok: false, code: codeOf(error), error }; }
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

/** The code and reason of a refusal (`lease_lost` and its reason), from the error itself; null for an attempt that was accepted. */
function refusalOf(result: { ok: true } | { ok: false; error: unknown }): { code: string; reason: string | null } | null {
  if (result.ok) return null;
  const e = result.error as { code?: string; reason?: string; detail?: { reason?: string } };
  return { code: e?.code ?? 'threw', reason: e?.reason ?? e?.detail?.reason ?? null };
}

/**
 * The hosts of a case. On a Rust brain in multi-user mode (the `rust-mu` view) every protected cycle-lock call carries its
 * host's fence, so `host(n)` registers host `n` (takes its lease) and answers `{ fence }`; on every other arm it answers `{}`.
 * The view must be real: the case fails when the store did not resolve multi-user mode, and on plain Rust when it did.
 */
async function hostsOf(engine: BrainEngine, backend: ParityBackend, prefix = 'c06') {
  const mode = rustArmMultiuser();
  const mu = backend === 'rust' && mode !== 'off';
  if (backend === 'rust') expect(rustArmModeProblem(resolvedMultiuser(engine), mode)).toBeNull();
  const leases = (e: BrainEngine): RustLeases => rustLeases(e as never);
  const origin = (n: number): WriteOrigin => ({ host_id: `${prefix}-host-${n}`, incarnation: `inc-${n}`, writer_id: `writer-${n}` });
  return {
    mu, leases, origin,
    async host(n: number): Promise<FenceOpts> {
      if (!mu) return {};
      const fence = await leases(engine).acquire(hostLeaseName(`${prefix}-host-${n}`), origin(n), 10 * 60_000);
      expect(fence, `host ${n} could not register`).not.toBeNull();
      return { fence: fence! };
    },
  };
}

/**
 * Runs `run` with the hosts of a case registered the way a real consumer does it. On a Rust brain in multi-user mode every
 * protected call (job claims and their results, write claims, effect claims and results, the cycle lock) needs its host's
 * fence, so: the engine's own host (`fence`, the registration `fenceOpts(engine)` reads) takes the lease
 * `consumer:<host_id>` and is registered on the engine, cleared in `finally`; and `claimants(n)` registers `n` further hosts, one
 * per claimant, where the case means "several hosts" (each claimant's calls carry its own fence). On every other arm all of
 * these answer `{}`, so the calls are exactly what they were.
 */
async function withHosts<T>(engine: BrainEngine, backend: ParityBackend, prefix: string, run: (hosts: {
  mu: boolean; fence: FenceOpts; claimants(n: number): Promise<FenceOpts[]>;
}) => Promise<T>): Promise<T> {
  const hosts = await hostsOf(engine, backend, prefix);
  const own = await hosts.host(0);
  let registration: Parameters<typeof clearHostRegistration>[1] | null = null;
  if (own.fence) {
    registration = { hostId: `${prefix}-host-0`, origin: hosts.origin(0), fence: own.fence };
    setHostRegistration(engine, registration);
  }
  try {
    return await run({
      mu: hosts.mu, fence: fenceOpts(engine),
      claimants: async (n) => Promise.all(Array.from({ length: n }, (_, i) => hosts.host(i + 1))),
    });
  } finally {
    if (registration) clearHostRegistration(engine, registration);
  }
}

/** Whether a call that may refuse (`lease_lost` on a fence that no longer matches its claim) still renewed or took what it asked for. */
async function took(call: () => Promise<unknown>): Promise<boolean> {
  const r = await attempt(call);
  return r.ok && r.value === true;
}

// ---- jobs ---------------------------------------------------------------------------------------------------------

const admit = (engine: BrainEngine, extra: Partial<JobInsertValues> = {}) => engine.admitJob({ maxSpawnDepth: 5, insert: jobValues('work', extra) }, JOB_POLICY);

async function addJob(engine: BrainEngine, extra: Partial<JobInsertValues> = {}): Promise<number> {
  const out = await admit(engine, extra);
  expect(out.coalesced).toBe(false);
  return Number(out.row.id);
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
    expect(late.ok ? null : late.code).toBe('revision_conflict');
    expect((await bodyOf(engine, 'notes/c01'))!.split('\n').slice(1).length).toBe(lines.length);
    return { someWriterWon: acked.length > 0, lostOrPhantom: 0, staleWriter: 'revision_conflict' };
  });

  // C02: `upsertChunks` with an expected revision. A writer holding a stale revision gets a typed conflict and changes
  // nothing; a re-read gives the current revision, and the same call then succeeds.
  parityTest('C02 stale revision gets a typed conflict', { methods: ['putPage', 'readPageSnapshot', 'upsertChunks', 'getChunks'], mwCase: 'C02' }, async (engine) => {
    await engine.putPage('notes/c02', NOTE('C02', 'one'));
    const stale = (await engine.readPageSnapshot('notes/c02', { sourceId: SRC }))!.revision;
    await engine.putPage('notes/c02', NOTE('C02', 'two'), { expectedRevision: stale });
    const chunk = { chunk_index: 0, chunk_text: 'a part', chunk_source: 'compiled_truth' as const };
    const refused = await attempt(() => engine.upsertChunks('notes/c02', [chunk], { expectedRevision: stale }));
    expect(refused.ok ? null : refused.code).toBe('revision_conflict');
    expect(await engine.getChunks('notes/c02', { includeUnsealed: true }), 'the refused writer changed the chunks').toHaveLength(0);
    const fresh = (await engine.readPageSnapshot('notes/c02', { sourceId: SRC }))!.revision;
    expect(fresh).not.toBe(stale);
    await engine.upsertChunks('notes/c02', [chunk], { expectedRevision: fresh });
    const stored = (await engine.getChunks('notes/c02', { includeUnsealed: true })).map(c => c.chunk_text);
    expect(stored).toEqual(['a part']);
    return { refused: 'revision_conflict', afterReread: stored };
  });

  // C03: claiming a queued write is select-then-stamp in one transaction. Eight claimers race for one request: one
  // stamps it, the others find none, and only the winner's token renews the claim.
  parityTest('C03 two claimers of one write never both claim', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'selectClaimableWrite', 'stampWriteClaim', 'renewWriteClaim'],
    mwCase: 'C03',
  }, async (engine, backend) => withHosts(engine, backend, 'c03', async (hosts) => {
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
    // Each claimer is its own host: its calls carry its own fence (on a multi-user store a claim without one is refused).
    const claimerHosts = await hosts.claimants(claimers);
    const claimed = await together(claimers, (i) => engine.transactionDirect(async (tx) => {
      const head = await tx.selectClaimableWrite<{ id: string }>({
        hostId: 'e0000000-0000-4000-8000-0000000000e1', excludeRoots: [], fifoRoots: [], laneRoots: [], nonce: `claimer-${i}`, syncSeen: {},
        priority: null, leaseHolder: null, ...claimerHosts[i],
      });
      if (!head) return null;
      return (await tx.stampWriteClaim(head.id, token(i), 60_000, JSON.stringify({ phase: 'parity' }), claimerHosts[i])) ? i : null;
    }));
    const winners = claimed.filter((i): i is number => i !== null);
    expect(winners, `request ${request.id} was claimed by more than one claimer`).toHaveLength(1);
    const renewing: number[] = [];
    for (let i = 0; i < claimers; i++) {
      if (await took(() => engine.renewWriteClaim({ id: request.id, token: token(i), leaseMs: 60_000, phaseJson: null, ...claimerHosts[i] }))) renewing.push(i);
    }
    expect(renewing, 'a token other than the winner\'s renewed the claim').toEqual(winners);
    return { claimedBy: winners.length, renewedBy: renewing.length };
  }));

  // C04: `claimNextJob`. Eight workers claim a pile of jobs: each job is claimed once, none is lost.
  parityTest('C04 eight workers claim each job once', { methods: ['admitJob', 'claimNextJob', 'getJob'], mwCase: 'C04' }, async (engine, backend) => withHosts(engine, backend, 'c04', async (hosts) => {
    // The engines serialize this differently (row locks with SKIP LOCKED, one writer, or optimistic commits that rerun
    // on a conflict); what must match is the outcome: no job claimed twice, none lost, one claim each.
    const total = 48;
    const workerHosts = await hosts.claimants(8);
    const first = await addJob(engine);
    for (let i = 1; i < total; i++) await addJob(engine, { priority: i % 3 });
    const claimed = await together(8, async (w) => {
      const mine: number[] = [];
      for (;;) {
        const row = await engine.claimNextJob(claimSpec(`w${w}:a`, { ...workerHosts[w] }));
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
  }));

  // C05: an expired claim is reclaimed once, and renewing it with the old token is refused. Eight sweeps run together.
  parityTest('C05 expired claim is reclaimed once', { methods: ['admitJob', 'claimNextJob', 'reclaimStalledJobs', 'renewJobLease', 'getJob'], mwCase: 'C05' }, async (engine, backend) => withHosts(engine, backend, 'c05', async (hosts) => {
    // Host 0 of the claimants took the first claim; each sweep is its own host; host 1 takes the claim again.
    const [first, ...sweepers] = await hosts.claimants(9);
    const id = await addJob(engine, { max_stalled: 3 });
    expect((await engine.claimNextJob(claimSpec('w:1', { lockDurationMs: -60_000, ...first })))?.id).toBeDefined();
    const sweeps = await together(8, async (i) => (await engine.reclaimStalledJobs(0, sweepers[i])).requeued.map(r => Number(r.id)));
    expect(sweeps.flat(), 'the expired claim was reclaimed other than once in total').toEqual([id]);
    const after = (await engine.getJob(id))!;
    expect({ status: after.status, stalled: after.stalled_counter }).toEqual({ status: 'waiting', stalled: 1 });
    expect(await took(() => engine.renewJobLease(id, 'w:1', 30_000, { ...first })), 'the old token renewed').toBe(false);
    const again = await engine.reclaimStalledJobs(0, sweepers[0]);
    expect({ requeued: again.requeued.length, dead: again.dead.length }).toEqual({ requeued: 0, dead: 0 });
    // The job is claimable again, and only the new claimant's token renews.
    expect((await engine.claimNextJob(claimSpec('w:2', { ...sweepers[0] })))?.id).toBeDefined();
    expect(await took(() => engine.renewJobLease(id, 'w:1', 30_000, { ...first }))).toBe(false);
    expect(await took(() => engine.renewJobLease(id, 'w:2', 30_000, { ...sweepers[0] }))).toBe(true);
    return { reclaimedTotal: 1, stalled: after.stalled_counter, oldTokenRenews: false, newTokenRenews: true };
  }));

  // C06: a stale lease holder's data write is refused by its token. The check is the caller's: the writing transaction
  // asserts its lease (`assertCycleLease`, which on Postgres also holds the lease row until commit) and writes only while it
  // holds it. A holder paused past its expiry resumes after a takeover and must write nothing. On a Rust brain in
  // multi-user mode the cycle lock carries the host fence: every protected call passes its host's lease token, and a call
  // without one refuses `lease_lost` / `fence_missing` (so each holder here is a registered host with its own lease).
  parityTest('C06 stale holder\'s data write refused by its token', {
    methods: ['acquireCycleLock', 'transaction', 'assertCycleLease', 'putPage', 'readPageSnapshot'], mwCase: 'C06',
  }, async (engine, backend) => {
    const hosts = await hostsOf(engine, backend);
    const [fa, fb] = [await hosts.host(1), await hosts.host(2)];
    const [paused, taker] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b2'];
    const lease = (pid: number, token: string, extra: { ttlMinutes?: number; stealGraceSeconds?: number } = {}) =>
      ({ holderPid: pid, holderHost: `host-${pid}`, acquisitionToken: token, ttlMinutes: 30, stealGraceSeconds: 0, ...extra });
    expect(await engine.acquireCycleLock('gbrain-cycle:c06', { ...lease(1, paused, { ttlMinutes: -1 }), ...fa })).not.toBeNull();
    // A grace of -1 second: PGLite's clock ticks in milliseconds, so a zero grace may not have passed yet.
    expect(await engine.acquireCycleLock('gbrain-cycle:c06', { ...lease(2, taker, { stealGraceSeconds: -1 }), ...fb }), 'the takeover').not.toBeNull();
    const guardedWrite = (token: string, fence: FenceOpts, body: string) => engine.transaction(async (tx) => {
      if (!(await tx.assertCycleLease('gbrain-cycle:c06', token, fence))) return false;
      await tx.putPage('notes/c06-protected', NOTE('C06', body));
      return true;
    });
    const refused = await guardedWrite(paused, fa, 'from the paused holder');
    expect(refused, 'the paused holder kept its lease').toBe(false);
    expect(await bodyOf(engine, 'notes/c06-protected'), 'the paused holder wrote protected data').toBeNull();
    const accepted = await guardedWrite(taker, fb, 'from the new holder');
    expect(accepted).toBe(true);
    expect(await bodyOf(engine, 'notes/c06-protected')).toBe('from the new holder');
    return { pausedHolderWrote: refused, newHolderWrote: accepted };
  });

  // C06, variant `C06.partition`: a machine that comes back after a partition with old-epoch work is refused.
  //  1. Holder A takes the cycle lock and writes protected data; its hold is ended at a controlled moment (a refresh with a
  //     negative lifetime, never a sleep); B takes over; A comes back and its protected write with the old token is refused,
  //     it cannot renew or release, and no old-epoch data is written. A gets back in only by acquiring after B releases.
  //  2. In flight: A asserts its lease and stages a protected write inside an open transaction, its lease lapses while the
  //     transaction is open, and B tries to take over. Either B waits for A's transaction (Postgres: the assert holds the lease
  //     row; PGLite and the single-writer Rust store: one writer) and A's write lands BEFORE the takeover, or B is granted and
  //     A's commit is refused (`lease_lost`, or `write_conflict` on a store that checks at commit). Never A's write after B.
  //  3. Rust in multi-user mode only: the host fence. The host's lease is expired at a controlled moment (renewed with a short
  //     lifetime, then read until it is no longer live), every protected cycle-lock call with the old fence is refused
  //     `lease_lost` / `expired`, the host registers again under a new epoch, the old fence is refused `epoch_moved`, and the
  //     cycle lock A took under the old epoch cannot be refreshed under the new one (`claim_epoch_mismatch`).
  parityTest('C06 stale holder\'s data write refused by its token: a host back from a partition with old-epoch work is refused', {
    methods: ['acquireCycleLock', 'refreshCycleLock', 'releaseCycleLock', 'readCycleLocks', 'transaction', 'assertCycleLease', 'putPage', 'readPageSnapshot'],
    mwCase: 'C06.partition',
  }, async (engine, backend) => {
    const hosts = await hostsOf(engine, backend);
    const SLUG = 'notes/c06-partition-protected';
    const LOCK = 'gbrain-cycle:c06-partition';
    const [tokenA, tokenB, tokenA2] = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a2'];
    const lease = (pid: number, token: string, ttlMinutes = 30) => ({ holderPid: pid, holderHost: `host-${pid}`, acquisitionToken: token, ttlMinutes, stealGraceSeconds: 0 });
    const holderToken = async () => (await engine.readCycleLocks({ by: 'id', lockId: LOCK }))[0]?.acquisition_token ?? null;
    const guardedWrite = (lockId: string, token: string, fence: FenceOpts, slug: string, body: string) => engine.transaction(async (tx) => {
      if (!(await tx.assertCycleLease(lockId, token, fence))) return false;
      await tx.putPage(slug, NOTE('C06', body));
      return true;
    });

    // 1. The partition.
    const [fa, fb] = [await hosts.host(1), await hosts.host(2)];
    expect(await engine.acquireCycleLock(LOCK, { ...lease(1, tokenA), ...fa }), 'A could not take the lock').not.toBeNull();
    expect(await guardedWrite(LOCK, tokenA, fa, SLUG, 'epoch A'), 'a live holder must be able to write').toBe(true);
    // A is cut off: its hold ends now (a negative lifetime), so B can take it without waiting for a clock.
    expect(await engine.refreshCycleLock(LOCK, { holderPid: 1, acquisitionToken: tokenA, ttlMinutes: -1, ...fa }), 'A\'s hold did not end').toBe(true);
    // A grace of -1 second: a clock that ticks in milliseconds may not have passed a zero grace yet.
    expect(await engine.acquireCycleLock(LOCK, { ...lease(2, tokenB), stealGraceSeconds: -1, ...fb }), 'B never took over the lapsed lock').not.toBeNull();
    expect(await holderToken()).toBe(tokenB);
    expect(await guardedWrite(LOCK, tokenA, fa, SLUG, 'old-epoch work from A'), 'the old epoch\'s write was accepted').toBe(false);
    expect(await bodyOf(engine, SLUG), 'old-epoch work was written').toBe('epoch A');
    expect(await engine.refreshCycleLock(LOCK, { holderPid: 1, acquisitionToken: tokenA, ttlMinutes: 30, ...fa }), 'the old holder renewed').toBe(false);
    expect(await engine.releaseCycleLock(LOCK, { holderPid: 1, acquisitionToken: tokenA, ...fa }), 'the old holder released B\'s lease').toBe(false);
    expect(await holderToken()).toBe(tokenB);
    expect(await guardedWrite(LOCK, tokenB, fb, SLUG, 'epoch B'), 'the new holder must be able to write').toBe(true);
    expect(await guardedWrite(LOCK, tokenA, fa, SLUG, 'old-epoch work again')).toBe(false);
    expect(await bodyOf(engine, SLUG)).toBe('epoch B');
    expect(await engine.acquireCycleLock(LOCK, { ...lease(1, tokenA2), ...fa }), 'the lease is exclusive while B holds it').toBeNull();
    expect(await engine.releaseCycleLock(LOCK, { holderPid: 2, acquisitionToken: tokenB, ...fb })).toBe(true);
    expect(await engine.acquireCycleLock(LOCK, { ...lease(1, tokenA2), ...fa })).not.toBeNull();
    expect(await guardedWrite(LOCK, tokenA2, fa, SLUG, 'epoch A again')).toBe(true);
    expect(await guardedWrite(LOCK, tokenA, fa, SLUG, 'the first token again'), 'the first token works again').toBe(false);
    expect(await bodyOf(engine, SLUG)).toBe('epoch A again');

    // 2. In flight: A's lease lapses while its transaction is open.
    const SLUG_IF = 'notes/c06-inflight-protected';
    const inFlight = async (attemptNo: number, ttlMs: number) => {
      const lockId = `gbrain-cycle:c06-inflight-${attemptNo}`;
      const [tokA, tokB] = [`00000000-0000-4000-8000-0000000001a${attemptNo}`, `00000000-0000-4000-8000-0000000001b${attemptNo}`];
      // A holder and its protected calls: the cycle lock on every arm but Rust in multi-user mode, where the host's lease is the fence.
      type Side = { acquireA(): Promise<boolean>; assertA(tx: BrainEngine): Promise<boolean>; takeOver(): Promise<{ epoch: number | null } | null>; staleWrite(): Promise<boolean> };
      let side: Side;
      if (hosts.mu) {
        // The host's lease is the fence; A's cycle lock is held under it, and the in-transaction check is the cycle-lock assert
        // that carries it (the assert reads the host's lease record into the transaction). B takes over the HOST lease.
        const name = `consumer:c06-inflight-${attemptNo}`;
        let hostA: LeaseToken | null = null;
        const checked = async (tx: BrainEngine) => {
          const r = await attempt(() => tx.assertCycleLease(lockId, tokA, { fence: hostA! }));
          if (r.ok) return r.value;
          if (refusalOf(r)?.reason === 'expired') return false;
          throw r.error;
        };
        side = {
          acquireA: async () => {
            hostA = await hosts.leases(engine).acquire(name, hosts.origin(1), ttlMs);
            if (!hostA) return false;
            const lock = await attempt(() => engine.acquireCycleLock(lockId, { ...lease(1, tokA, 30), fence: hostA! }));
            if (lock.ok) return lock.value !== null;
            if (refusalOf(lock)?.reason === 'expired') return false; // the host's lease lapsed before its first call: a stalled machine
            throw lock.error;
          },
          assertA: checked,
          takeOver: async () => { const t = await hosts.leases(engine).acquire(name, hosts.origin(2), 60_000); return t && { epoch: t.epoch }; },
          staleWrite: async () => {
            const r = await attempt(() => engine.transaction(async (tx) => {
              if (!(await tx.assertCycleLease(lockId, tokA, { fence: hostA! }))) return false;
              await tx.putPage(SLUG_IF, NOTE('C06', 'old token after the takeover'));
              return true;
            }));
            return r.ok && r.value === true;
          },
        };
      } else {
        side = {
          acquireA: async () => (await engine.acquireCycleLock(lockId, { ...lease(1, tokA, ttlMs / 60_000), ...fa })) !== null,
          assertA: (tx) => tx.assertCycleLease(lockId, tokA, fa),
          takeOver: async () => ((await engine.acquireCycleLock(lockId, { ...lease(2, tokB), stealGraceSeconds: -1, ...fb })) ? { epoch: null } : null),
          staleWrite: () => guardedWrite(lockId, tokA, fa, SLUG_IF, 'old token after the takeover'),
        };
      }
      if (!(await side.acquireA())) return null; // A's lease had lapsed before it could take the lock: a stalled machine.
      const staged = Promise.withResolvers<boolean>();
      const gate = Promise.withResolvers<void>();
      const aTx = attempt(() => engine.transaction(async (tx) => {
        let held: boolean;
        try { held = await side.assertA(tx); } catch (error) { staged.resolve(false); throw error; }
        if (!held) { staged.resolve(false); return 'lapsed before the assert'; }
        await tx.putPage(SLUG_IF, NOTE('C06', 'in-flight from A'));
        staged.resolve(true);
        await gate.promise;
        return 'staged';
      }));
      if (!(await staged.promise)) { gate.resolve(); const ended = await aTx; if (!ended.ok) throw ended.error; return null; }
      await Bun.sleep(ttlMs + 100); // A's lease lapses while its transaction is open.
      const takeover = side.takeOver().then((value) => ({ value }), (error: unknown) => ({ error }));
      const settled = await Promise.race([takeover.then(() => 'granted' as const), Bun.sleep(400).then(() => 'waiting' as const)]);
      gate.resolve();
      return { a: await aTx, b: await takeover, waited: settled === 'waiting', side };
    };
    let flight: Awaited<ReturnType<typeof inFlight>> = null;
    for (const [i, ttlMs] of [300, 1_500, 6_000].entries()) {
      flight = await inFlight(i, ttlMs);
      if (flight) break; // A's lease had lapsed before its first assert: a stalled machine; run it again with a longer lifetime.
    }
    expect(flight, 'A\'s lease lapsed before its first assert at every lifetime').not.toBeNull();
    expect('error' in flight!.b ? flight!.b.error : null, 'the takeover errored').toBeNull();
    if (flight!.waited) {
      // Serial order: A's staged write landed before B was granted.
      expect(flight!.a.ok, 'A\'s transaction, which B waited for, was refused').toBe(true);
      expect(await bodyOf(engine, SLUG_IF), 'A\'s staged write is missing').toBe('in-flight from A');
      expect('value' in flight!.b && flight!.b.value, 'B was never granted after A committed').not.toBeFalsy();
    } else {
      // B was granted while A's transaction was open: A's commit must be refused and nothing of it written.
      expect(flight!.a.ok, 'B took the lease while A\'s transaction was open and A\'s commit still succeeded').toBe(false);
      expect(['lease_lost', 'write_conflict'], 'A\'s commit was refused for another reason').toContain((flight!.a as { code: string }).code);
      expect(await bodyOf(engine, SLUG_IF), 'A\'s refused transaction wrote protected data').toBeNull();
    }
    const before = await bodyOf(engine, SLUG_IF);
    expect(await flight!.side.staleWrite(), 'the old token wrote after the takeover').toBe(false);
    expect(await bodyOf(engine, SLUG_IF), 'old-token work landed after the takeover').toBe(before);

    // 3. The host fence (Rust in multi-user mode).
    if (hosts.mu) {
      const leases = hosts.leases(engine);
      const NAME = 'consumer:c06-partition-host';
      const LOCK3 = 'gbrain-cycle:c06-host';
      const tokenH = '00000000-0000-4000-8000-0000000002a1';
      const SLUG3 = 'notes/c06-host-protected';
      const f1 = (await leases.acquire(NAME, hosts.origin(1), 60_000))!;
      expect(f1, 'the host could not register').not.toBeNull();
      expect(await engine.acquireCycleLock(LOCK3, { ...lease(1, tokenH), fence: f1 })).not.toBeNull();
      // A protected write: the cycle-lock assert carries the host's fence (and reads its lease into the transaction), then the data write.
      const fencedWrite = (fence: LeaseToken, body: string, lockId = LOCK3, token = tokenH) => engine.transaction(async (tx) => {
        if (!(await tx.assertCycleLease(lockId, token, { fence }))) throw new Error('the lock is not held');
        await tx.putPage(SLUG3, NOTE('C06', body));
      });
      await fencedWrite(f1, 'epoch 1');
      // The partition: the host's lease is renewed with a short lifetime, then read until it is no longer live.
      await leases.renew(f1, 40);
      const until = Date.now() + 10_000;
      while ((await leases.read(NAME))?.live && Date.now() < until) await Bun.sleep(10);
      expect((await leases.read(NAME))?.live, 'the host\'s lease never lapsed').toBe(false);
      const old = { acquisition: '00000000-0000-4000-8000-0000000002b1' };
      const refusedWith = async (reason: string, fence: LeaseToken) => {
        const calls: Record<string, () => Promise<unknown>> = {
          'acquire a lock': () => engine.acquireCycleLock('gbrain-cycle:c06-other', { ...lease(1, old.acquisition), fence }),
          'refresh the lock': () => engine.refreshCycleLock(LOCK3, { holderPid: 1, acquisitionToken: tokenH, ttlMinutes: 30, fence }),
          'release the lock': () => engine.releaseCycleLock(LOCK3, { holderPid: 1, acquisitionToken: tokenH, fence }),
          'assert the lease': () => engine.assertCycleLease(LOCK3, tokenH, { fence }),
          'write protected data': () => fencedWrite(fence, 'old-epoch work'),
          'renew the host lease': () => leases.renew(fence, 60_000),
        };
        for (const [what, call] of Object.entries(calls)) {
          const r = await attempt(call);
          expect(r.ok ? 'accepted' : refusalOf(r), `the old fence was not refused (${reason}) when it tried to ${what}`).toEqual({ code: 'lease_lost', reason });
        }
      };
      await refusedWith('expired', f1);
      expect(await bodyOf(engine, SLUG3), 'old-epoch work was written').toBe('epoch 1');
      // The host registers again under a new epoch; everything it began under the old one is refused.
      const f2 = (await leases.acquire(NAME, hosts.origin(1), 60_000))!;
      expect(f2.epoch, 'registering again did not raise the epoch').toBeGreaterThan(f1.epoch);
      await refusedWith('epoch_moved', f1);
      expect(await bodyOf(engine, SLUG3)).toBe('epoch 1');
      const stale = await attempt(() => engine.refreshCycleLock(LOCK3, { holderPid: 1, acquisitionToken: tokenH, ttlMinutes: 30, fence: f2 }));
      expect(stale.ok ? 'accepted' : refusalOf(stale), 'a lock taken in the old epoch was finished in the new one').toEqual({ code: 'lease_lost', reason: 'claim_epoch_mismatch' });
      // Under the new epoch the host takes a lock of its own and writes.
      const tokenH2 = '00000000-0000-4000-8000-0000000002a2';
      expect(await engine.acquireCycleLock('gbrain-cycle:c06-host-2', { ...lease(1, tokenH2), fence: f2 })).not.toBeNull();
      await fencedWrite(f2, 'epoch 2', 'gbrain-cycle:c06-host-2', tokenH2);
      expect(await bodyOf(engine, SLUG3)).toBe('epoch 2');
    }
    return { oldEpochWriteRefused: true, protectedDataUnchanged: true, newHolderWrote: true, oldTokenRenewed: false, oldTokenReleased: false, reacquiredUnderNewEpoch: true, noOldEpochWriteAfterTakeover: true };
  });

  // C07: an effect is claimed once; if its owner dies between the action and recording it, the effect is claimed again,
  // the dead owner's late record changes nothing, and the request ends with one effect row.
  parityTest('C07 effect claimed once, rerun after owner crash', {
    methods: ['readSourceMembership', 'lockPersistenceCounters', 'insertWriteRequest', 'transactionDirect', 'declarePersistence', 'insertPublicationEffects',
      'selectClaimableEffect', 'stampEffectClaim', 'completeEffectRow', 'readRequestEffects'],
    mwCase: 'C07',
  }, async (engine, backend) => withHosts(engine, backend, 'c07', async (hosts) => {
    // Each claimant is its own host (the eight racing claimants, then the one that finds the dead owner's effect): its calls carry its own fence.
    const claimantHosts = await hosts.claimants(9);
    const fenceOf = (i: number) => claimantHosts[i === 99 ? 8 : i]!;
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
      // The stamp takes the same proven-dead owners the selection was given: a multi-user stamp takes a running effect only when
      // its claim lapsed or its owner is proven dead (the SQL engines ignore the list).
      return tx.stampEffectClaim<Claimed>({ id: next.id, token: token(i), ownerJson: owner(i), ...fenceOf(i), deadOwners: dead });
    });
    const won = await together(8, (i) => claim(i, []));
    const winners = won.map((row, i) => (row ? i : -1)).filter(i => i >= 0);
    expect(winners, 'one effect, several claimants').toHaveLength(1);
    const first = winners[0]!;
    const effect = won[first]!;
    // The owner dies after the action and before it records: its effect is claimable again and runs again.
    const rerun = await claim(99, [`7:n${first}:s`]);
    expect(rerun?.id, 'a dead owner\'s effect was not claimed again').toEqual(effect.id);
    // The dead owner's late record changes nothing: refused by its token, or by its fence's claim epoch on a multi-user store.
    await attempt(() => engine.completeEffectRow({ id: effect.id, token: token(first), outcomeJson: '{}', ...fenceOf(first) }));
    const afterDead = await engine.readRequestEffects(request.id);
    expect(afterDead.map(e => e.state), 'the dead owner recorded the effect').toEqual(['running']);
    await engine.completeEffectRow({ id: effect.id, token: token(99), outcomeJson: '{}', ...fenceOf(99) });
    const effects = await engine.readRequestEffects(request.id);
    expect(effects, 'a duplicate effect row').toHaveLength(1);
    expect(effects[0]!.state).toBe('committed');
    return { claimants: winners.length, reclaimed: true, deadOwnerRecorded: false, effectRows: effects.length, state: effects[0]!.state };
  }));

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

  // C16: a format upgrade runs once under concurrent openers; each sees the whole brain, old or new, never a partial one.
  // The upgrade this case drives is the one an older brain gets when it is first opened in multi-user mode with the commit log
  // on (the store enables the log, upgrades the format to 13 and logs its own upkeep): so it runs on the `rust-mu` view only.
  // A brain is made in plain mode (log off, older format), closed, and then five engines open it at once with the mode on:
  // the one that wins the owner lock upgrades it, and the others become clients of that owner (never an error, never a
  // second upgrade). The proof of "exactly once" is a control: the upgrade writes records to the commit log, and a brain that
  // one engine upgrades alone gets the very same records as the brain five engines opened together. PostgreSQL's equivalent
  // (concurrent `initSchema` on a database behind the code) is not written: its cell stays pending.
  parityTest('C16 format upgrade runs once under concurrent openers', { methods: ['putPage', 'getPage', 'getConfig', 'readCommitLog'], mwCase: 'C16' }, async (engine, backend, ctx) => {
    if (backend !== 'rust') throw new Error(`C16 drives the Rust commit-log format upgrade; there is no ${backend} scenario yet`);
    const mode = rustArmMultiuser();
    expect(mode, 'C16 upgrades a brain by opening it in multi-user mode: the arm must be multi-user').not.toBe('off');
    const route = rustMultiuserView();
    const SWITCHES = ['GBRAIN_RUST_MULTIUSER', 'GBRAIN_RUST_COMMIT_LOG'] as const;
    // The commit log format (rust/crates/gbrain-store/src/format.rs LOG_FORMAT_VERSION, 16 since lane L2's renumber
    // e435301421; the addon does not export it). gbrain-store tests/commit_log.rs pins the same number.
    const LOG_FORMAT_VERSION = 16;
    const formatOf = (dir: string) => JSON.parse(readFileSync(join(dir, 'FORMAT'), 'utf8')) as { format_version: number; log?: unknown };
    const roleOf = (e: unknown) => (e as { ownerRole?: string }).ownerRole;
    const openers: BrainEngine[] = [];
    try {
      /** An older-format brain: made in plain mode (the switches off), three pages, closed. On the config route it carries the row that turns multi-user on at its next open. */
      const oldBrain = async (dir: string) => {
        await withEnv(Object.fromEntries(SWITCHES.map(name => [name, undefined])), async () => {
          const plain = await openRustBrainAt(dir);
          try {
            for (let i = 0; i < 3; i++) await plain.putPage(`notes/c16-${i}`, NOTE(`C16 ${i}`, `kept across the upgrade ${i}`));
            if (route === 'config') await plain.setConfig(RUST_MULTIUSER_CONFIG_KEY, 'true');
          } finally { await plain.disconnect(); }
        });
        expect(formatOf(dir).log, 'the brain was not made in the older format').toBeUndefined();
        expect(formatOf(dir).format_version, 'the brain was not made in the older format').not.toBe(LOG_FORMAT_VERSION);
      };
      // What an upgrade leaves in the brain: the log's start and newest position (commits it made), and the format's log block.
      const upgraded = async (e: BrainEngine, dir: string) => {
        const page = await e.readCommitLog(null, 10_000);
        const log = formatOf(dir).log as { since?: unknown; base_format?: unknown } | undefined;
        return { newest: page.newest, oldest: page.oldest_retained, records: page.records.map(r => ({ ops: r.op_count, writes: r.write_ids.length })), since: log?.since, base: log?.base_format };
      };
      const whole = async (e: BrainEngine) => Promise.all([0, 1, 2].map(async i => (await e.getPage(`notes/c16-${i}`))?.compiled_truth ?? null));
      const expected = [0, 1, 2].map(i => `kept across the upgrade ${i}`);

      // The control: one engine (a spare of the arm, opened the way the arm opens every spare) upgrades an older brain alone.
      const control = ctx.unconnectedEngine();
      const solo = (control.config as unknown as { database_path: string }).database_path;
      await oldBrain(solo);
      await control.engine.connect(control.config);
      expect(formatOf(solo).format_version, 'a single opener did not upgrade the brain').toBe(LOG_FORMAT_VERSION);
      const soloUpgrade = await upgraded(control.engine, solo);
      expect(soloUpgrade.newest, 'the upgrade committed nothing: the control proves nothing').not.toBeNull();

      // Five openers at once. The first is another spare of the arm, opened the same way as the control, the others are plain engines.
      const { engine: first, config } = ctx.unconnectedEngine();
      const dir = (config as unknown as { database_path: string }).database_path;
      await oldBrain(dir);
      const connecting = [first.connect(config), ...Array.from({ length: 4 }, async () => { const e = await openRustBrainAt(dir, route === 'off' ? undefined : route); openers.push(e as unknown as BrainEngine); })];
      const settled = await Promise.allSettled(connecting);
      expect(settled.flatMap(r => (r.status === 'rejected' ? [codeOf(r.reason)] : [])), 'an opener of the brain being upgraded got an error').toEqual([]);
      const all = [first, ...openers];
      expect(all.map(roleOf).filter(r => r === 'owner'), 'not exactly one opener owns the brain').toHaveLength(1);
      expect(all.map(roleOf).filter(r => r === 'client'), 'the other openers are not clients of the owner').toHaveLength(4);
      expect(formatOf(dir).format_version, 'the brain was not upgraded').toBe(LOG_FORMAT_VERSION);
      for (const e of all) expect(await whole(e), 'an opener saw a partial brain').toEqual(expected);
      const versions = await Promise.all(all.map(e => e.getConfig('version')));
      expect(new Set(versions).size, 'openers report different formats').toBe(1);
      const togetherUpgrade = await upgraded(first, dir);
      expect(togetherUpgrade, 'five concurrent openers upgraded the brain other than once (its log start, newest commit and records are not the lone opener\'s)').toEqual(soloUpgrade);
      // A write after the upgrade, through whichever opener the arm holds, is seen by every opener.
      await first.putPage('notes/c16-after', NOTE('after', 'written after the upgrade'));
      for (const e of all) expect((await e.getPage('notes/c16-after'))?.compiled_truth, 'a write after the upgrade is not seen by every opener').toBe('written after the upgrade');
      return { openers: 5, owners: 1, clients: 4, upgradedTo: LOG_FORMAT_VERSION, wholeBrain: true, upgradeEqualsALoneOpener: true };
    } finally {
      for (const e of openers) await e.disconnect().catch(() => undefined);
    }
  });

  // C17: a second opener becomes a client, never an error; calls in flight retry and succeed.
  //  - Postgres: a second connection to the brain never gets a busy error; calls in flight on both connections all succeed.
  //  - Rust (the owner socket): the first engine is the owner, the second is a client of it (asserted by their roles, not
  //    assumed), the two see each other's writes, and 16 calls in flight on both succeed with no `store_locked`/`owner_busy`.
  //  - Rust with multi-user mode on (`rust-mu`, mode asserted on the arm's brain; the client has no store of its own and
  //    reaches that owner): the owner EXITS while 48 client calls are in flight. An exiting owner answers the calls it has not
  //    started as handed over and finishes the rest, and the client sends the handed-over calls again to the next owner, so
  //    every call succeeds, none is lost and no call ends `owner_unavailable`. Plain Rust ends such calls
  //    `owner_unavailable` (outcome unknown), so that half is multi-user only.
  //  PGLite refuses a second opener by design (n/a).
  parityTest('C17 a second opener becomes a client, never an error', { methods: ['putPage', 'getPage'], mwCase: 'C17' }, async (engine, backend, ctx) => {
    await engine.putPage('notes/c17-a', NOTE('A', 'written by the first opener'));
    const second = await ctx.sameBrainEngine();
    if (backend === 'rust') {
      expect((engine as unknown as { ownerRole?: string }).ownerRole, 'the first opener is not the owner').toBe('owner');
      expect((second as unknown as { ownerRole?: string }).ownerRole, 'the second opener did not become a client of the owner').toBe('client');
    }
    expect((await second.getPage('notes/c17-a'))?.compiled_truth, 'the second opener does not see the first\'s write').toBe('written by the first opener');
    await second.putPage('notes/c17-b', NOTE('B', 'written by the second opener'));
    expect((await engine.getPage('notes/c17-b'))?.compiled_truth, 'the first opener does not see the second\'s write').toBe('written by the second opener');
    const inFlight = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => (i % 2 ? second : engine).putPage(`notes/c17-${i}`, NOTE(`N${i}`, `call ${i}`))));
    const refused = inFlight.flatMap(r => (r.status === 'rejected' ? [codeOf(r.reason)] : []));
    expect(refused.filter(code => BUSY_CODES.has(code)), 'a call in flight got a busy error').toEqual([]);
    expect(refused, 'a call in flight was refused').toEqual([]);
    let handedOver = 0;
    if (backend === 'rust' && rustArmMultiuser() !== 'off') {
      const calls = Array.from({ length: 48 }, (_, i) => second.putPage(`notes/c17-h${i}`, NOTE(`H${i}`, `in flight at the handover ${i}`)));
      // Let the calls reach the owner (a call still unread in the socket when the owner closes ends outcome_unknown, which is
      // the same race a crash has); the owner then exits with some answered, some running and some queued.
      await Bun.sleep(10);
      await engine.disconnect();
      const settled = await Promise.allSettled(calls);
      const lost = settled.flatMap(r => (r.status === 'rejected' ? [codeOf(r.reason)] : []));
      expect(lost, 'a call in flight at the owner\'s exit ended in an error instead of being sent again').toEqual([]);
      for (let i = 0; i < 48; i++) expect(await bodyOf(second, `notes/c17-h${i}`), `the call ${i} in flight at the handover was lost`).toBe(`in flight at the handover ${i}`);
      expect((second as unknown as { ownerRole?: string }).ownerRole, 'the client did not take the brain over').toBe('owner');
      // The brain the client took over runs in the mode the arm turned on (it resolves the switch itself, from the env or its config row).
      expect(rustArmModeProblem(resolvedMultiuser(second), rustArmMultiuser()), 'the brain the client took over').toBeNull();
      handedOver = 48;
    }
    return { secondOpened: true, mutuallyVisible: true, inFlightRefused: refused.length, handedOver: handedOver > 0 };
  });

  // C18: many writers, every row family, no busy error: 64 writers in 8 processes. This process and seven writer processes
  // (test/engine-parity/fixtures/mw-writer.ts, each with its own pool on the arm's database) each run eight concurrent
  // writers; every writer writes two pages, submits a job under its request key and claims a job. The parent holds a start
  // barrier: it sends `GO` only after all seven children reported READY, and the case proves the loads overlapped (every
  // process started before any finished). It then checks every expected page slug and body, every request key once, and that the
  // claimed ids are exactly the stored jobs' ids. No lost update, no double claim, no busy error. Postgres: seven pools.
  // Rust: this process owns the brain and the seven are owner-socket clients (a second Rust process is a client; its `admitJob`
  // carries a policy object with functions, which do not cross the owner socket, so the cell is pending). PGLite is in-memory (n/a).
  parityTest('C18 64 writers in 8 processes, no busy error', { methods: ['putPage', 'readPageSnapshot', 'admitJob', 'claimNextJob', 'listJobs'], mwCase: 'C18' }, async (engine, backend, ctx) => {
    if (backend !== 'postgres' && backend !== 'rust') throw new Error(`C18 runs its writer processes on Postgres and Rust only, not on ${backend}`);
    // Postgres: each child has its own pool on the arm's database. Rust: the brain has one owner (this process, asserted below) and
    // each child is an owner-socket client of it, opened in the mode the arm runs (the child asserts what its brain resolved).
    const mode = rustArmMultiuser();
    const route = rustMultiuserView();
    if (backend === 'rust') {
      expect((engine as unknown as { ownerRole?: string }).ownerRole, 'this process does not own the brain the writer processes share').toBe('owner');
      expect(rustArmModeProblem(resolvedMultiuser(engine), mode), 'the owner of the brain').toBeNull();
    }
    const writerConfig = (index: number): WriterConfig => backend === 'postgres'
      ? { role: 'stress', backend: 'postgres', databaseUrl: (ctx.unconnectedEngine().config as { database_url?: string }).database_url!, index, startOnGo: true, deadlineMs: 90_000 }
      : { role: 'stress', backend: 'rust', databasePath: (engine as unknown as { databasePath: string }).databasePath, index, startOnGo: true, deadlineMs: 90_000,
        ...(route !== 'off' && { muRoute: route }), ...(mode === 'ambient' && { ambient: true }) };
    const children: ReturnType<typeof startWriter>[] = [];
    let reports: StressReport[];
    try {
      for (let i = 0; i < 7; i++) children.push(startWriter(writerConfig(i + 1)));
      await Promise.all(children.map(c => c.until(lines => lines.includes('READY'), 30_000, 'connect')));
      // The barrier: everyone is connected; the children start on GO and this process starts at once.
      for (const c of children) c.go();
      const startedAt = Date.now();
      const own = await runStressWriters(engine, 0);
      const mine: StressReport = { results: own, startedAt, finishedAt: Date.now() };
      await Promise.all(children.map(c => c.until(lines => lines.some(l => l.startsWith('RESULT ')), 60_000, 'finish its writers')));
      reports = [mine, ...children.map(c => JSON.parse(c.lines().find(l => l.startsWith('RESULT '))!.slice('RESULT '.length)) as StressReport)];
      const exits = await Promise.all(children.map(c => c.reap(15_000)));
      expect(exits.map(e => e.exitCode), 'a writer process did not exit cleanly').toEqual(children.map(() => 0));
    } finally {
      // Whatever happened, no child outlives the case.
      await Promise.all(children.map(c => c.reap(0)));
    }
    const pageBodies = new Map<string, string>();
    for (let id = 0; id < 64; id++) for (let round = 0; round < 2; round++) {
      const body = await bodyOf(engine, stressSlug(id, round));
      if (body !== null) pageBodies.set(stressSlug(id, round), body);
    }
    const jobIdsByKey = new Map<string, number[]>();
    for (const job of await engine.listJobs({ limit: 500 })) jobIdsByKey.set(String(job.idempotency_key), [...(jobIdsByKey.get(String(job.idempotency_key)) ?? []), Number(job.id)]);
    expect(stressViolations({ reports, pageBodies, jobIdsByKey }), 'the stress run lost or duplicated work, or did not contend').toEqual([]);
    const jobs = [...jobIdsByKey.values()].flat();
    const claimedIds = reports.flatMap(r => r.results).map(o => o.job).filter((id): id is number => id !== null);
    return { processes: 8, writers: 64, pages: 128, jobs: jobs.length, claimed: claimedIds.length, twice: 0, busy: 0, overlapped: true };
  });

  // C19: crash after commit keeps acknowledged writes. A writer process (test/engine-parity/fixtures/mw-writer.ts) writes a
  // page and submits a job under a request key, one write after another, and prints each write only after the engine
  // acknowledged it. This case SIGKILLs it mid-stream, then reads the brain through an engine of its own: every acknowledged write
  // has its page and exactly one job row, nothing is duplicated, and replaying each request key returns the stored row and
  // adds none. The check is `acknowledgedWriteViolations` (multi-writer-support.ts), proven with controls in
  // test/multi-writer-cases.test.ts.
  //
  // What this proves, exactly. Postgres: gbrain acknowledges a write only after the database committed it, so a writer that
  // dies right after its acknowledgements loses none and its replays duplicate none. It is NOT a database-server crash test:
  // the killed process is a client, and the reopening engine is the parent's connected pool, so the server never restarts and
  // Postgres's own durability (WAL, fsync) is not exercised. That guarantee belongs to Postgres. Rust: the writer process owns a
  // brain directory no engine here has open, and this case reopens that directory after the kill, so it is the store's own
  // recovery of acknowledged commits; on the rust-mu view the writer and the reopened brain must both resolve multi-user mode.
  // PGLite is in-memory: no durable brain to crash (n/a).
  parityTest('C19 crash after commit keeps acknowledged writes', { methods: ['putPage', 'readPageSnapshot', 'admitJob', 'listJobs'], mwCase: 'C19' }, async (engine, backend, ctx) => {
    const killAfter = 12;
    const { engine: spare, config } = ctx.unconnectedEngine();
    const base = { role: 'crash', max: 2_000, deadlineMs: 60_000 } as const;
    let writerConfig: WriterConfig;
    let reopen: () => Promise<BrainEngine>;
    if (backend === 'postgres') {
      writerConfig = { ...base, backend: 'postgres', databaseUrl: (config as { database_url?: string }).database_url! };
      reopen = async () => engine;
    } else if (backend === 'rust') {
      const route = rustMultiuserView();
      const brain = config as unknown as { database_path: string };
      // The config route's brain carries its own switch row: connecting the spare seeds it (and asserts it resolved), so the writer finds it on disk.
      if (route === 'config') { await spare.connect(config); await spare.disconnect(); }
      writerConfig = { ...base, backend: 'rust', databasePath: brain.database_path, ...(route !== 'off' && { muRoute: route }), ...(rustArmMultiuser() === 'ambient' && { ambient: true }) };
      reopen = async () => { await spare.connect(config); return spare; };
    } else {
      throw new Error(`C19 needs a durable brain to crash; ${backend} has none`);
    }
    const writer = startWriter(writerConfig);
    const route = rustMultiuserView();
    // On a Rust brain the writer process proves what mode its own store resolved (it fails to start otherwise).
    if (backend === 'rust') await writer.until(lines => lines.some(l => l.startsWith('RESOLVED ')), 30_000, 'open its brain');
    if (backend === 'rust') expect(writer.lines().includes('RESOLVED true'), `the writer's store resolved multi-user mode as ${writer.lines().find(l => l.startsWith('RESOLVED '))} on route ${route}, mode ${rustArmMultiuser()}`).toBe(rustArmMultiuser() !== 'off');
    const acks = (lines: string[]) => lines.filter(l => l.startsWith('ACK ')).map(l => Number(l.slice(4)));
    await writer.until(lines => acks(lines).length >= killAfter, 60_000, `acknowledge ${killAfter} writes`);
    const ended = await writer.kill();
    expect(ended.signal, 'the writer was not killed mid-stream').toBe('SIGKILL');
    const acknowledged = acks(writer.lines());
    expect(acknowledged.length, 'the kill came before the writer acknowledged enough').toBeGreaterThanOrEqual(killAfter);
    expect(acknowledged.length, 'the writer finished before the kill').toBeLessThan(base.max);
    // The brain after the crash, through an engine this process owns.
    const brain = await reopen();
    if (backend === 'rust') expect(rustArmModeProblem(resolvedMultiuser(brain), rustArmMultiuser()), 'the reopened brain').toBeNull();
    type Seen = CrashObservation & { ids: Map<string, number> };
    const observe = async (): Promise<Seen> => {
      const jobRowsByKey = new Map<string, number>();
      const ids = new Map<string, number>();
      for (const job of await brain.listJobs({ limit: 100_000 })) {
        const key = job.idempotency_key as string | null;
        if (key?.startsWith('c19-request-')) { jobRowsByKey.set(key, (jobRowsByKey.get(key) ?? 0) + 1); ids.set(key, Number(job.id)); }
      }
      const pageBodies = new Map<string, string>();
      for (let n = 0; n <= Math.max(...acknowledged) + 2; n++) {
        const body = await bodyOf(brain, crashSlug(n));
        if (body !== null) pageBodies.set(crashSlug(n), body);
      }
      return { acknowledged, jobRowsByKey, pageBodies, ids };
    };
    const before = await observe();
    expect(acknowledgedWriteViolations(before), 'the reopened brain lost or duplicated an acknowledged write').toEqual([]);
    for (const n of acknowledged) {
      const replay = await admit(brain, { idempotency_key: crashKey(n) });
      expect({ coalesced: replay.coalesced, sameRow: Number(replay.row.id) === before.ids.get(crashKey(n)) }, `replay ${n} did not return the stored row`).toEqual({ coalesced: true, sameRow: true });
      await brain.putPage(crashSlug(n), NOTE(`N${n}`, crashBody(n)));
    }
    expect(acknowledgedWriteViolations(await observe()), 'a replay duplicated a write').toEqual([]);
    return { killed: true, acknowledgedPresent: true, duplicates: 0, replaysReturnedStored: true };
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

  // C22: commit positions strictly increase: no two commits share one and positions only grow. Runs where the engine keeps a
  // commit log: the Rust engine in multi-user mode with the log on (`rust-mu`, both routes, which turn the log on and prove it).
  // A SQL engine and a Rust engine with the log off keep none and refuse `readCommitLog` and `lastCommitPosition` with
  // `engine_capability_missing` (reason `commit_log`), so those cells are `n/a`.
  // Eight concurrent writers write four pages each and a transaction writes one more; the log is read from the cursor taken
  // BEFORE the writes. Positions are only ever compared with each other (never admission order, callback order or created_at).
  parityTest('C22 commit position strictly increases', { methods: ['putPage', 'transaction', 'readCommitLog', 'lastCommitPosition'], mwCase: 'C22' }, async (engine) => {
    const order = (a: CommitPosition, b: CommitPosition) => a.sequence - b.sequence || a.index - b.index;
    const key = (p: CommitPosition) => `${p.sequence}.${p.index}`;
    // One warm-up write first: the first write of a brain may run logged upkeep (an index backfill), which has records of its own.
    // After it, every commit has exactly one record (rust/docs/store/commit-log.md: "every commit since `since` has a record").
    await engine.putPage('notes/c22-warm', NOTE('warm', 'before the cursor'));
    const cursor = await engine.lastCommitPosition();
    expect(cursor, 'the warm-up write left no commit position').not.toBeNull();
    // Every position a writer saw after its own write finished.
    const seen: CommitPosition[] = [];
    const observe = async () => { const at = await engine.lastCommitPosition(); expect(at, 'a finished write left no commit position').not.toBeNull(); seen.push(at!); };
    await together(8, async (w) => {
      for (let n = 0; n < 4; n++) { await engine.putPage(`notes/c22-${w}-${n}`, NOTE(`N${w}`, `commit ${n}`)); await observe(); }
    });
    // A transaction: its own engine answers the position it committed at, also after it ended.
    let inTx: Pick<BrainEngine, 'lastCommitPosition'> | undefined;
    await engine.transaction(async (tx) => {
      inTx = tx;
      await tx.putPage('notes/c22-tx', NOTE('tx', 'one transaction'));
      expect(await tx.lastCommitPosition(), 'a transaction that is still open reports a position').toBeNull();
    });
    const txAt = await inTx!.lastCommitPosition();
    expect(txAt, 'a committed transaction reports no position').not.toBeNull();
    const read = async () => {
      const page = await engine.readCommitLog(cursor, 10_000);
      expect(page.snapshot_required, 'the cursor taken before the writes cannot be continued from the log').toBe(false);
      return page.records;
    };
    const records = await read();
    const positions = records.map(r => r.position);
    expect(positions.length, 'the log has a different number of records than commits (a commit lost its record, or one has two)').toBe(33);
    for (const p of positions) expect(order(p, cursor!), `a record at ${key(p)} is not after the cursor ${key(cursor!)}`).toBeGreaterThan(0);
    expect(new Set(positions.map(key)).size, 'two commits share a position').toBe(positions.length);
    for (let i = 1; i < positions.length; i++) expect(order(positions[i]!, positions[i - 1]!), `positions went back or repeated at ${key(positions[i]!)}`).toBeGreaterThan(0);
    for (let i = 1; i < records.length; i++) expect(records[i]!.commit_time_us, `commit time did not rise at ${key(positions[i]!)}`).toBeGreaterThan(records[i - 1]!.commit_time_us);
    // Each position a write reported is exactly one record's position.
    const logged = new Set(positions.map(key));
    for (const p of [...seen, txAt!]) expect(logged.has(key(p)), `the position ${key(p)} a write reported is not in the log`).toBe(true);
    // The transaction's commit is its own record, after every position its engine's earlier writers saw only if it committed later; at least it is a record.
    expect(records.filter(r => key(r.position) === key(txAt!)), 'the transaction\'s position is not exactly one record').toHaveLength(1);
    // A later write takes a greater position than everything before it.
    const newest = positions[positions.length - 1]!;
    await engine.putPage('notes/c22-after', NOTE('after', 'one more'));
    const later = (await engine.lastCommitPosition())!;
    expect(order(later, newest), 'a later write did not take a greater position').toBeGreaterThan(0);
    const after = await read();
    expect(after.length, 'the later write did not add exactly one record').toBe(records.length + 1);
    expect(after.filter(r => key(r.position) === key(later)), 'the later write\'s position is not exactly one record').toHaveLength(1);
    return { writes: 33, recordsCoverWrites: true, distinct: true, increasing: true, timesRise: true, reportedPositionsAreRecords: true, laterIsGreater: true };
  });
});
