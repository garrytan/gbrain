/**
 * Turns shadow mode on for one opened engine (plan PR S1). The engine factory imports this module only when
 * state.json says shadow mode is on for the brain, so a brain that never used it loads none of src/shadow beyond
 * state.ts.
 *
 * Wiring: wrapper (captures reads after the primary answered) -> bounded MirrorQueue (sheds, never blocks) ->
 * ShadowSupervisor (lazy child, restarts, watchdog). The engine's disconnect flushes the counters and ends the
 * child's stdin without waiting.
 */
import type { BrainEngine } from '../core/engine.ts';
import { resolveServeGbrainCommand } from '../core/serve-service.ts';
import type { FollowOptions } from './follow.ts';
import { ShadowFollower } from './follower.ts';
import { openReadSource, type ReadSource } from './read-pool.ts';
import { Reconciler } from './reconcile.ts';
import { lostWriteRecorder } from './follow-child.ts';
import { confirmSeal, sealMark, type SealDeps } from './seal.ts';
import { createLsnWatch, makeAskHandler, type LsnWatch } from './checks.ts';
import { epochWatch, readEpoch } from './evidence-epoch.ts';
import { hasCapability } from '../core/engine-capabilities.ts';
import { readSeedRecord } from './seed.ts';
import { MirrorQueue, zeroUsage } from './mirror.ts';
import { SampleRegistry } from './samples.ts';
import { readShadowState, writeSampleRate, type ShadowState } from './state.ts';
import { ShadowSupervisor, type ShadowSupervisorOptions } from './supervisor.ts';
import { appendUsage } from './usage.ts';
import { wrapShadowEngine } from './wrapper.ts';
import { createWriteSampler } from './write-capture.ts';
import { recordLost } from './write-compare.ts';
import { WRITE_PROTOCOL, WriterObserver, type WriterIdentity } from './writer-observations.ts';
import { ensureWriterHooks, primaryTakesWriterHooks } from './writer-hooks.ts';
import { claimOwner } from '../core/persistence/claim-phase.ts';
import { hostIdFor } from '../core/persistence/identity.ts';
import { VERSION } from '../version.ts';

/** How often a long-running process appends its per-operation counts (and once more when its engine disconnects). */
export const USAGE_FLUSH_MS = 60_000;

export interface AttachShadowDeps {
  /** argv of the gbrain CLI to spawn; default the running gbrain, never a different one on PATH. */
  gbrainArgv?: string[];
  supervisor?: Partial<ShadowSupervisorOptions>;
  random?: () => number;
  /**
   * Shadow follow: a producer to publish committed primary writes to. When left out and the brain has been seeded
   * (seed.json), the follower applies committed writes to the Rust store (follower.ts) and a reconciler repairs what it
   * missed. A brain with no seed follows nothing.
   */
  follow?: FollowOptions;
  /**
   * True when the shadow child records write comparisons (the locked write tally; `attachShadow` sets it). Left out, no write is sampled and no pre-read is taken,
   * so primary writes pay nothing for evidence that would be dropped.
   */
  recordsWriteComparisons?: boolean;
  /** Tests only: the seal's database checks (seal.ts), so a PGLite lifecycle test can reach the seal the child would take. */
  sealChecks?: { mark: typeof sealMark; confirm: typeof confirmSeal };
}

export interface AttachedShadow<E extends BrainEngine> {
  engine: E;
  queue: MirrorQueue;
  supervisor: ShadowSupervisor;
  /** Set when the brain is seeded and `follow` was left out. */
  follower?: ShadowFollower;
  reconciler?: Reconciler;
  /** Notes this process's committed writes for swap eligibility (writer-observations.ts). */
  observer: WriterObserver;
  /** The freshness token every sample is captured with (checks.ts `createLsnWatch`). */
  lsnWatch: LsnWatch;
}

/** The child's argv for `dir`. */
export function shadowChildArgv(dir: string, gbrainArgv?: string[]): string[] {
  const base = gbrainArgv ?? resolveServeGbrainCommand({ which: () => null });
  return [...base, 'engine', 'shadow', '__child', dir];
}

export function attachShadowParts<E extends BrainEngine>(engine: E, dir: string, state: ShadowState, deps: AttachShadowDeps = {}): AttachedShadow<E> {
  const supervisor = new ShadowSupervisor({
    dir, argv: shadowChildArgv(dir, deps.gbrainArgv), onDirty: (relation) => reconciler?.markDirty(relation),
    onAsk: (ask) => asks(ask),
    // Each new child is asked once whether the last session's seal holds; deferred, as start() runs inside a send.
    onStart: () => { confirm = undefined; setImmediate(() => { if (sealDeps) confirm ??= (deps.sealChecks?.confirm ?? confirmSeal)(sealDeps); }); },
    ...deps.supervisor,
  });
  let confirm: Promise<void> | undefined; // the running child's seal confirmation (seal.ts), once asked
  let sealDeps: SealDeps | undefined; // set once the brain is seeded and has a read source
  const samples = new SampleRegistry();
  let generation: () => number | undefined = () => undefined; // the follower's write count, set once it exists
  let watch: LsnWatch | undefined; // the primary's freshness token, set once the child's read source exists
  const queue = new MirrorQueue({ bound: state.queue_bound, transport: supervisor, samples, generation: () => generation(), lsn: () => watch?.current() });
  const sink = {
    counters: queue.counters,
    offer: (capture: Parameters<MirrorQueue['offer']>[0], op?: string) => queue.offer(capture, op),
    token: () => queue.token(),
    use: (op: string, field: Parameters<MirrorQueue['meter']['note']>[1]) => queue.meter.note(op, field),
    active: () => supervisor.active(),
  };
  // Each call is noted under the epoch current when it happens, and the first call of a class is appended at once.
  queue.meter.bind({
    epoch: epochWatch(dir),
    register: (epoch_id, op) => appendUsage(dir, { ts: new Date().toISOString(), epoch_id, ops: { [op]: zeroUsage() } }),
  });
  const flushUsage = (): void => {
    const taken = queue.meter.take();
    if (!taken) return;
    const ts = new Date().toISOString();
    for (const [i, bucket] of taken.entries()) {
      try { appendUsage(dir, { ts, epoch_id: bucket.epoch_id, ops: bucket.ops }); } catch { queue.meter.restore(taken.slice(i)); return; }
    }
  };
  const usageTimer = setInterval(flushUsage, USAGE_FLUSH_MS);
  usageTimer.unref();
  const seeded = deps.follow === undefined && readSeedRecord(dir)?.digests === true;
  const rpc = <T>(method: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<T> => supervisor.request<T>(method, args, timeoutMs);
  const reads = seeded ? openReadSource(engine) : undefined;
  // The child's questions (checks.ts) read the primary through a source of their own, opened on first use, on a brain that was never seeded.
  let own: ReadSource | undefined;
  const askReads: ReadSource = reads ?? { pauseMs: 0, read: (fn) => (own ??= openReadSource(engine)).read(fn), close: async () => { await own?.close(); } };
  watch = createLsnWatch(askReads);
  void watch.ready(); // the first freshness token, so a sample captured a moment later has one to be held to
  const asks = makeAskHandler({ engine, reads: askReads, dir, rpc, samples, watch, get follower() { return follower; } });
  if (reads) sealDeps = { dir, reads, postgres: primaryTakesWriterHooks(state.primary_engine), rpc };
  const askConfirm = (): Promise<void> => (sealDeps ? (confirm ??= (deps.sealChecks?.confirm ?? confirmSeal)(sealDeps)) : Promise.resolve());
  // A write the child will never hear of leaves a line for whichever process owns the store next (follow-child.ts), so no
  // seal is trusted over it. One line a second is enough: the owner reads any line as "a write was lost".
  const lost = lostWriteRecorder({ dir });
  const follower = reads ? new ShadowFollower({
    reads, send: (line) => supervisor.send(line), rpc,
    onDirty: (relation) => reconciler?.markDirty(relation),
    onFirstBatch: () => { void reconciler?.probe().catch(() => undefined); },
    onLost: (reason) => lost.note(reason),
  }) : undefined;
  generation = () => follower?.published;
  const reconciler = reads ? new Reconciler({ dir, reads, rpc, follower, ready: askConfirm }) : undefined;
  reconciler?.startNightly();
  const observer = new WriterObserver({
    primary: engine, dir, identity: () => writerIdentity(engine),
    // A process opened while shadow mode was on outlives `stop`: it notes and repairs hooks only while state.json still says on.
    enabled: () => readShadowState(dir)?.enabled === true,
    ...(primaryTakesWriterHooks(state.primary_engine) ? { beforeFirstNote: () => ensureWriterHooks(engine, dir) } : {}),
  });
  engine.registerBeforeDisconnect(async () => {
    observer.stop();
    let settled = false;
    try {
      queue.stop(); // delivers the reads still queued, so the child sees them and the counters add up
      if (supervisor.active() && supervisor.childPid !== null) queue.flushStats();
      // Let the follower finish reading what was just committed; a slow read is shed rather than waited on.
      if (follower) settled = await Promise.race([follower.settle().then(() => true), new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 2_000).unref?.(); })]);
      await writes?.settle(2_000); // a read-back still running then is recorded as lost (`readback_abandoned`), not dropped
    } finally {
      clearInterval(usageTimer);
      flushUsage();
      reconciler?.stop();
      if (reconciler) await reconciler.idle(1_000); // a pass in flight stops at its next read and keeps its progress
      follower?.close(); // from here a write is only recorded as lost
      // Seal: tell the child its store holds every write this process committed, so the next session can carry the
      // watermark on (follow-child.ts, seal.ts). Only when the follower finished, holds nothing, and no other writer may
      // be writing unrecorded; the child refuses too when its own checks fail.
      // A close that does not seal tells the child why, so status names the reason.
      try {
        if (follower && sealDeps && supervisor.active() && supervisor.childPid !== null) {
          let refused: string | null = !settled ? 'follower_not_settled' : !follower.idle() ? 'follower_not_idle' : null;
          let token: string | null = null;
          if (!refused) {
            await Promise.race([askConfirm(), new Promise((resolve) => { setTimeout(resolve, 2_000).unref?.(); })]);
            const mark = await (deps.sealChecks?.mark ?? sealMark)(sealDeps);
            if ('refused' in mark) refused = mark.refused;
            else if (!follower.idle()) refused = 'follower_not_idle';
            else token = mark.token;
          }
          supervisor.send(JSON.stringify(refused ? { t: 'seal', db_at: null, refused } : { t: 'seal', db_at: token }) + '\n');
        }
      } catch { /* no seal: the next session starts with a full pass owed, as after a crash */ }
      await supervisor.drain(); // the CLI is about to exit and Bun drops what its pipe still holds: wait (bounded) for it to flush; stop() writes down how many samples were sent, so the child counts any it never got
      supervisor.stop();
      await reads?.close().catch(() => undefined);
      if (askReads !== reads) await askReads.close().catch(() => undefined);
    }
  });
  const follow = follower ? { sink: follower } : deps.follow;
  const onCommittedWrite = () => observer.note();
  // Write comparisons need the seeded store's epoch to count under (a brain that was never seeded samples no writes), a recorder for their outcomes (the child's locked tally) and a read the
  // serving process can bound: Postgres stops it with a server-side statement timeout; PGLite has one connection and a running statement cannot be cancelled, so a PGLite brain samples no writes.
  // A sample the pipe refuses, or a read-back left running at disconnect, is recorded for the owner child to count `uncomparable`: one line appended without a lock to this process's own file (this process never
  // writes the tally, whose lock could stall a write; see recordLost). With no epoch yet there is nothing to count under: the count then rides on the next line the child accepts, as it always did.
  const sampling = reads && deps.recordsWriteComparisons && hasCapability(engine, 'postgres_admin');
  const writes = sampling ? createWriteSampler({ rate: writeSampleRate(state), random: deps.random, send: (line) => supervisor.send(line), generation: writeGeneration(follower), active: () => supervisor.active(), owe: (n) => supervisor.owe(n), refuse: (n) => !!readEpoch(dir) && supervisor.oweRefused(n), lost: (reason) => { const epoch = readEpoch(dir)?.epoch_id; return epoch !== undefined && recordLost(dir, epoch, reason); } }) : undefined;
  return { engine: wrapShadowEngine(engine, sink, { sampleRate: state.sample_rate, random: deps.random, follow, onCommittedWrite, writes }), queue, supervisor, follower, reconciler, observer, lsnWatch: watch };
}

/** The write sampler's count of this process's writes that can change a compared row (follower.pageLinkWrites, not every batch: `published` stays what the stable rerun in checks.ts reads). */
export const writeGeneration = (follower: { pageLinkWrites: number } | undefined): (() => number | undefined) => () => follower?.pageLinkWrites;

/** This process's writer identity: the engine's host id, the name its pools give their connections, its kind, version. */
export function writerIdentity(engine: BrainEngine): WriterIdentity {
  const owner = claimOwner();
  // The same text db.ts gbrainApplicationName() gives the pools (pinned by a test), without loading the driver here.
  const applicationName = `gbrain ${owner.kind}:${owner.pid}:${(owner.nonce ?? '').slice(0, 8)}`.slice(0, 63);
  return { hostId: hostIdFor(engine), applicationName, processKind: owner.kind, gbrainVersion: VERSION, writeProtocol: WRITE_PROTOCOL };
}

/** The engine factory's entry point: the wrapped engine. */
export function attachShadow<E extends BrainEngine>(engine: E, dir: string, state: ShadowState): E {
  return attachShadowParts(engine, dir, state, { recordsWriteComparisons: true }).engine;
}
