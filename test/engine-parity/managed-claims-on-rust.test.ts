/**
 * Engine parity: the claim members of managed mode on a Rust brain, hold kept for users (lane LM, slice 2, claims part):
 * the owner's reclaim of a write it released (`reclaimReleasedWrite`), the lane head claim (`claimNextLaneHead`: the typed
 * `selectClaimableLaneHead` and `stampLaneHeadClaim`) and the effect recovery claim (`claimAndRecoverEffect`: the typed
 * `claimEffectRecovery`), and the `owner_host_stale` doctor check, which reads the waiting writes through the topology store.
 *
 * Every case lifts the `managed_persistence` hold on its own Rust test engine (rust-managed.ts `liftManagedHold`), so the
 * ordinary Rust arm runs the managed path for real; `servedCapabilities()` still withholds the capability, so a user's Rust
 * brain keeps refusing (test/rust-managed-claims-hold.test.ts). Each case returns its answers and the arms must agree.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: an owner pass claims again a request it released to the queue only once its backoff elapsed (never earlier,
 *    never a request that is running or holds a recovery); the head of the next admitted group of a lane run is claimed in
 *    manifest order and stamped with the newest request sequence, but not while an earlier queued write, an earlier running
 *    request of another run or a foreground write that may go first is ahead, nor for a host that does not own the worktree;
 *    an effect with no recovery record is not claimed for recovery; `owner_host_stale` warns for a write waiting on a foreign
 *    owner that was quiet past the stale window, and says nothing for an own-host owner or no waiting write.
 *  - Regression: on the Rust engine each of those statements went through executeRaw and refused `engine_capability_missing`
 *    (capability raw_sql) by name, and the doctor check skipped itself with `reason: raw_sql` even where managed mode ran.
 *  - Why existing coverage misses it: test/persistence-*.test.ts and test/doctor-owner-host-stale.test.ts run on PGLite and
 *    Postgres only, and the lane head claim has no PGLite caller (lanes need a pool), so no case reached it on three arms.
 *  - Seam: real engines and real checkouts. A lane group head is admitted through `insertWriteRequest` (the journal member the
 *    admission uses) with the lane intent the managed sync writes; a consumer pass is held at its claim so nothing else claims.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { describe, expect } from 'bun:test';
import { createSource, parityArms, type ParityBackend } from './harness.ts';
import { liftManagedHold } from './rust-managed.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { installFaultHook } from '../../src/core/persistence/fault-points.ts';
import { hostIdFor, readLocalWriter } from '../../src/core/persistence/identity.ts';
import { claimNextLaneHead, claimNextWrite, completeWrite, reclaimReleasedWrite, releaseUnpublishedClaim } from '../../src/core/persistence/journal.ts';
import { releaseChargedInterruption } from '../../src/core/persistence/coordinator.ts';
import { claimAndRecoverEffect } from '../../src/core/persistence/effects.ts';
import { consumerIdentity } from '../../src/core/persistence/consumer-heartbeat.ts';
import { ownerHostStaleCheck } from '../../src/commands/doctor/checks/owner-host-stale.ts';
import type { WriteRequest } from '../../src/core/persistence/model.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const RUN = 'run-a';
const KEYS = ['principal:local_cli:parity-writer', 'brain'];
const OTHER_HOST = 'a0000000-0000-4000-8000-0000000000a2';

/** Lifts the hold on the Rust arm's engine, then runs `run` under a scratch GBRAIN_HOME with a claimed, activated checkout `work`. */
async function withManagedBrain<T>(engine: BrainEngine, backend: ParityBackend, run: (root: string) => Promise<T>, opts: { extraSources?: string[] } = {}): Promise<T> {
  if (backend === 'rust') liftManagedHold(engine);
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-managed-claims-')));
  try {
    return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1' }, async () => {
      const root = join(home, 'checkout');
      mkdirSync(join(root, 'notes'), { recursive: true });
      execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
      writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
      execFileSync('git', ['-C', root, 'add', '.']);
      execFileSync('git', ['-C', root, ...GIT_ID, 'commit', '-qm', 'notes']);
      await createSource(engine, backend, 'work', {}, root);
      for (const id of opts.extraSources ?? []) await createSource(engine, backend, id, {});
      const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
      await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
      await runPersistenceAdministration(engine, 'writer_activate', { confirm_quiesced: true, ...await reviewed('writer_activate') });
      try { return await run(root); } finally { installFaultHook(undefined); await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const ctxFor = (engine: BrainEngine) => ({ engine, sourceId: 'work', remote: false as const,
  config: { engine: engine.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

/** Holds every owner pass at its claim until `release()`; the dead owner's claim and the lane rows stay as the case staged them. */
function holdConsumer(): () => void {
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  installFaultHook(async point => { if (point === 'consumer:claiming') await held; });
  return () => { release(); installFaultHook(undefined); };
}

/** The worktree id of `work`'s binding on this host. */
const worktreeOf = async (engine: BrainEngine) => (await engine.getWorktreeBinding('work', hostIdFor(engine)))!.worktree_id;

/** Admits one queued request on `work`'s worktree through the journal member admission uses; returns its journal id. */
async function admit(engine: BrainEngine, worktreeId: string, intent: Record<string, unknown>, sourceId = 'work'): Promise<string> {
  const source = await engine.readSourceMembership(sourceId);
  const requestId = randomUUID();
  await engine.lockPersistenceCounters(KEYS);
  const { id } = await engine.insertWriteRequest({ principalKind: 'local_cli', principalId: 'parity-writer', requestId, operation: 'put_page',
    sourceId, sourceIncarnation: source!.incarnation, pageId: null, slug: `notes/n-${requestId.slice(0, 8)}`, worktreeId, topologyGeneration: null,
    digest: 'd'.repeat(64), intent: { ...intent, ...(intent.lane !== undefined ? { group: requestId } : {}) }, authority: { scopes: ['write'] }, intentBytes: 100,
    terminalReservation: 4096, targetKind: 'page', protocolVersion: 1, admitterVersion: 'parity', admitterHostId: null, counterKeys: KEYS,
    clientRequestId: null, state: 'queued', deferredRefreshId: null });
  return id;
}
const laneGroup = (engine: BrainEngine, worktreeId: string, run = RUN) => admit(engine, worktreeId, { kind: 'managed_sync_import', runId: 'sync-run', index: 0, lane: run });
const foreground = (engine: BrainEngine, worktreeId: string) => admit(engine, worktreeId, { kind: 'put_page' });

const sequenceOf = async (engine: BrainEngine, id: string) => String((await engine.readWriteRequestById(id))!.sequence);

/** A claimed row as the arms compare it: the labels stand for the ids, the token is only checked for being set. */
const shape = (row: (WriteRequest & { seen_sequence?: string }) | null, labels: Map<string, string>) => row && ({ request: labels.get(row.id), state: row.state,
  token: typeof row.execution_token === 'string' ? 'set' : row.execution_token, phase: (row.claim_phase as { phase?: string } | null)?.phase ?? null, blocked: row.blocked_reason ?? null });

describe('managed claims on a Rust brain, hold kept for users', () => {
  parityTest('an owner pass reclaims a write it released only after its backoff, and the reclaimed write then commits', {
    methods: ['worktreeClaimStore', 'reclaimReleasedWrite', 'releaseUnpublishedClaim', 'readWriteRequest'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, async root => {
    const host = hostIdFor(engine);
    const request_id = randomUUID();
    const release = holdConsumer();
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page', waitMs: 0,
      params: { slug: 'notes/lena-example', content: '---\ntype: note\ntitle: Lena Example\n---\nWorks at widget-co.\n', request_id } }).catch(() => null);
    const writer = (await readLocalWriter(engine, 'cli')).id;
    const stored = () => engine.readWriteRequest('local_cli', writer, request_id);
    const claimed = await claimNextWrite(engine, host, 30_000);
    // A statement timeout ends the claim's publication: the claim is released to the queue with a backoff of one second.
    const interruption = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
    const released = await releaseChargedInterruption(engine, claimed!, interruption, 'publication');
    const early = await reclaimReleasedWrite(engine, claimed!.id);
    const queued = await stored();
    await Bun.sleep(1_100);
    const due = await reclaimReleasedWrite(engine, claimed!.id);
    const again = await reclaimReleasedWrite(engine, claimed!.id);
    const labels = new Map([[claimed!.id, 'write']]);
    // The reclaiming pass lets go of the claim; the consumer then publishes the write.
    if (due) await releaseUnpublishedClaim(engine, due, 'database_contention');
    release();
    let final = await stored();
    for (let i = 0; i < 150 && final?.state !== 'committed'; i++) { await Bun.sleep(100); final = await stored(); }
    const answer = { claimed: shape(claimed, labels), released: released && { state: released.state, token: released.execution_token, transient: released.transient_interruptions, preparation: released.preparation_attempts },
      early, queued: queued && { state: queued.state, token: queued.execution_token }, due: shape(due, labels), again, final: final && { state: final.state },
      file: execFileSync('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).includes('lena-example') };
    expect(answer).toEqual({ claimed: { request: 'write', state: 'running', token: 'set', phase: 'preparing', blocked: null },
      released: { state: 'queued', token: null, transient: 1, preparation: 0 }, early: null, queued: { state: 'queued', token: null },
      due: { request: 'write', state: 'running', token: 'set', phase: 'preparing', blocked: null }, again: null, final: { state: 'committed' }, file: true });
    return answer;
  }));

  parityTest('the head of a lane group is claimed in manifest order once nothing blocks it, and is stamped with the newest request sequence', {
    methods: ['worktreeClaimStore', 'selectClaimableLaneHead', 'stampLaneHeadClaim', 'insertWriteRequest', 'lockPersistenceCounters', 'stampWriteClaim', 'readWriteRequestById'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, async () => {
    const host = hostIdFor(engine);
    const wt = await worktreeOf(engine);
    const release = holdConsumer();
    const early = await foreground(engine, wt);
    const first = await laneGroup(engine, wt);
    const second = await laneGroup(engine, wt);
    const labels = new Map([[early, 'foreground'], [first, 'first'], [second, 'second']]);
    const head = async (hostId = host, run = RUN) => { const row = await claimNextLaneHead(engine, hostId, wt, run, 30_000, null); return row && { ...shape(row, labels), seenIsNewest: row.seen_sequence === await sequenceOf(engine, second) }; };
    const queuedEarlier = await head();
    // The earlier write is claimed and running: it is a running request of no lane, so it still blocks the lane head.
    await engine.stampWriteClaim(early, randomUUID(), 60_000, JSON.stringify({ phase: 'preparing' }));
    const runningEarlier = await head();
    await engine.transaction(async tx => { await completeWrite(tx, (await tx.lockWriteRequest(early))!, 'committed', {}); });
    const wrongHost = await head(OTHER_HOST);
    const otherRun = await head(host, 'run-b');
    const claimedFirst = await head();
    const claimedSecond = await head();
    const exhausted = await head();
    release();
    const answer = { queuedEarlier, runningEarlier, wrongHost, otherRun, claimedFirst, claimedSecond, exhausted };
    expect(answer).toEqual({ queuedEarlier: null, runningEarlier: null, wrongHost: null, otherRun: null,
      claimedFirst: { request: 'first', state: 'running', token: 'set', phase: 'preparing', blocked: null, seenIsNewest: true },
      claimedSecond: { request: 'second', state: 'running', token: 'set', phase: 'preparing', blocked: null, seenIsNewest: true }, exhausted: null });
    return answer;
  }));

  parityTest('a foreground write that may go first holds the lane head back, as the switch and the seen sequence decide', {
    methods: ['worktreeClaimStore', 'selectClaimableLaneHead', 'stampLaneHeadClaim', 'insertWriteRequest', 'lockPersistenceCounters', 'stampWriteClaim', 'readWriteRequestById', 'setConfig'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, async () => {
    const host = hostIdFor(engine);
    const wt = await worktreeOf(engine);
    const release = holdConsumer();
    const committed = await foreground(engine, wt);
    const first = await laneGroup(engine, wt);
    await laneGroup(engine, wt);
    const waiting = await foreground(engine, wt);
    await engine.stampWriteClaim(committed, randomUUID(), 60_000, JSON.stringify({ phase: 'preparing' }));
    await engine.transaction(async tx => { await tx.lockPersistenceCounters(KEYS); await completeWrite(tx, (await tx.lockWriteRequest(committed))!, 'committed', {}); });
    const committedSequence = await sequenceOf(engine, committed);
    const labels = new Map([[first, 'first']]);
    const claim = async (seen: string | null) => shape(await claimNextLaneHead(engine, host, wt, RUN, 30_000, seen), labels);
    // The foreground write queued behind the heads waits: the lane gets no new head unless a foreground commit is newer than the seen sequence.
    const heldBack = await claim(committedSequence);
    await engine.setConfig('sync.foreground_priority', 'false');
    const overridden = await withEnv({ GBRAIN_SYNC_FOREGROUND_PRIORITY: '1' }, () => claim(committedSequence));
    // Another process claimed the waiting write and has not begun it: it still waits; this process's own claim does not hold its lane.
    await engine.setConfig('sync.foreground_priority', 'true');
    await engine.stampWriteClaim(waiting, randomUUID(), 60_000, JSON.stringify({ phase: 'preparing', owner: { nonce: 'another-process' } }));
    const claimedElsewhere = await claim(committedSequence);
    const earned = await claim(null);
    const answer = { heldBack, overridden, claimedElsewhere, earned, nonce: typeof consumerIdentity().nonce };
    release();
    expect(answer).toEqual({ heldBack: null, overridden: null, claimedElsewhere: null,
      earned: { request: 'first', state: 'running', token: 'set', phase: 'preparing', blocked: null }, nonce: 'string' });
    return answer;
  }));

  parityTest('an effect with no recovery record is not claimed for recovery, and its row stays as it was', {
    methods: ['worktreeClaimStore', 'claimEffectRecovery', 'selectClaimableEffect', 'insertPublicationEffects'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, async () => {
    const host = hostIdFor(engine);
    const request_id = randomUUID();
    const release = holdConsumer();
    await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page', waitMs: 0,
      params: { slug: 'notes/mira-example', content: '---\ntype: note\ntitle: Mira Example\n---\nWorks at widget-co.\n', request_id } }).catch(() => null);
    const claimed = await claimNextWrite(engine, host, 30_000);
    await engine.transaction(async tx => { await tx.lockPersistenceCounters(KEYS); await completeWrite(tx, (await tx.lockWriteRequest(claimed!.id))!, 'committed', {}); });
    const incarnation = (await engine.readSourceMembership('work'))!.incarnation;
    await engine.insertPublicationEffects({ requestId: claimed!.id, revision: null, sourceId: 'work', sourceIncarnation: incarnation, worktreeId: await worktreeOf(engine),
      effects: [{ kind: 'withdrawal-mirror', data: {} }] });
    const candidate = await engine.selectClaimableEffect<{ id: string | number; state: string; attempts: number; kind: string }>(host, []);
    const recovered = await claimAndRecoverEffect(engine, candidate!.id, host);
    const after = await engine.selectClaimableEffect<{ id: string | number; state: string; attempts: number }>(host, []);
    release();
    const answer = { queued: candidate && { state: candidate.state, attempts: Number(candidate.attempts) }, recovered: recovered ?? null,
      unchanged: after && String(after.id) === String(candidate!.id) && after.state === candidate!.state && Number(after.attempts) === Number(candidate!.attempts) };
    expect(answer).toEqual({ queued: { state: 'queued', attempts: 0 }, recovered: null, unchanged: true });
    return answer;
  }));

  parityTest('owner_host_stale warns for a write waiting on a foreign owner quiet past the window, and says nothing for an own-host owner', {
    methods: ['worktreeClaimStore', 'topologyStore', 'insertWriteRequest', 'lockPersistenceCounters'],
    timeout: 180_000,
  }, async (engine, backend) => withManagedBrain(engine, backend, async () => {
    const wt = await worktreeOf(engine);
    const release = holdConsumer();
    const view = (check: Awaited<ReturnType<typeof ownerHostStaleCheck>>) => {
      const details = check.details as { count: unknown; outcome?: unknown; stale?: Array<{ owner_host_id: string; source_ids: string[]; open_writes: number }> };
      return { status: check.status, count: details.count, outcome: details.outcome ?? null,
        stale: (details.stale ?? []).map(row => ({ owner: row.owner_host_id, sources: row.source_ids, open: row.open_writes })) };
    };
    const idle = view(await ownerHostStaleCheck(engine));
    await foreground(engine, wt);
    const own = await ownerHostStaleCheck(engine);
    // A second source bound to a worktree another host owns, with a write waiting on it.
    const foreignTree = randomUUID();
    const incarnation = (await engine.readSourceMembership('elsewhere'))!.incarnation;
    await engine.transaction(async tx => {
      const store = await tx.topologyStore();
      await store.insertWorktree(foreignTree, OTHER_HOST);
      await store.upsertSourceBinding('elsewhere', incarnation, foreignTree, '');
    });
    await admit(engine, foreignTree, { kind: 'put_page' }, 'elsewhere');
    // The 24 h quiet window cannot pass inside a test: the owner read's clock is moved 25 h on, everything else is the engine's own read.
    const aged = new Proxy(engine, { get: (target, key) => {
      const value = Reflect.get(target, key) as unknown;
      if (key !== 'topologyStore') return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      return async () => {
        const store = await target.topologyStore();
        return { ...store, ownerActivity: async (...args: Parameters<typeof store.ownerActivity>) =>
          (await store.ownerActivity(...args)).map(row => ({ ...row, db_now: new Date(Date.now() + 25 * 3_600_000).toISOString() })) };
      };
    } });
    const foreign = await ownerHostStaleCheck(aged);
    release();
    const answer = { idle, own: { ...view(own), message: own.message }, foreign: { ...view(foreign), message: foreign.message?.replace(/last active [^,]+,/, 'last active <time>,').replace(/waiting since [^ ]+/, 'waiting since <time>')
      .replace(OTHER_HOST, '<owner>').replace(/ \(this process holds the PGLite file[^)]*\)/, '') } };
    expect(answer.idle).toEqual({ status: 'ok', count: 0, outcome: null, stale: [] });
    expect(answer.own).toMatchObject({ status: 'ok', count: 0, message: 'Every worktree with waiting writes has a live or recently active owner host (1 checked).' });
    expect(answer.foreign).toMatchObject({ status: 'warn', count: 1, stale: [{ owner: OTHER_HOST, sources: ['elsewhere'], open: 1 }] });
    expect(answer.foreign.message).toContain('owner_host_stale: 1 write(s) wait for an owner host that runs no gbrain consumer');
    return { ...answer, foreign: { ...answer.foreign, message: undefined }, own: { ...answer.own, message: undefined } };
  }, { extraSources: ['elsewhere'] }));
});
