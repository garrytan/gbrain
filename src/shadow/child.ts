/**
 * The supervised shadow child (plan PR S1; decision D13 s3). Runs as `gbrain engine shadow __child <shadow dir>`.
 *
 * The serving process never loads the Rust addon: this child does. It reads NDJSON events from stdin, runs each
 * mirrored read on the Rust engine over `<shadow dir>/store`, classifies the result against the primary's
 * (classify.ts) and appends a content-free ledger row. It writes `{"t":"hb"}` heartbeats to stdout so the supervisor
 * can tell a hung child from a quiet one, and `{"t":"pause"}` on a privacy divergence, which stops mirroring in the
 * serving process. When the addon is missing or mismatched, every event is recorded `addon_unavailable` with the
 * loader's code, so the evidence shows why nothing was compared. Stdin closing ends the child.
 *
 * The store is the one `gbrain engine shadow seed` filled from the brain, and the follower (follow-child.ts) keeps it level
 * with the brain's writes, so a read's answer comes from the brain's own data. A brain that was never seeded, or whose
 * seed is not followed, has an empty or stale store; reads against it mostly `diff`, and `status` says the brain needs a seed or a reseed.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { withCallerAccess, type CallerAccess } from '../core/search/private-visibility.ts';
import { openRustEngine, type RustEngineAddonHandle } from '../core/rust-engine.ts';
import { policyHash, READINESS_POLICY } from '../core/engine-swap/policy.ts';
import { RUST_ENGINE_ABI } from '../core/rust-engine/addon-manifest.ts';
import { loadedAddonPath, type RustAddon } from '../core/rust-engine/addon-loader.ts';
import { servedCapabilities } from '../core/rust-engine/store-capabilities.ts';
import { loadRustEngineAddonOffline, type RustEngineAddonLoaderFn } from './addon.ts';
import { RERUN_DEADLINE_MS } from './checks.ts';
import { createAsker, createSerialQueue, createWaiter, membersDigest, policyApplies, privacyVerdict, RERUN_QUEUE_BOUND, resultDigest, safeCode } from './child-checks.ts';
import { classifyError, classifyResult, type Classification } from './classify.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { adapterIdentity, capabilitySetHash, currentBuild, ensureEpoch, internalErrorRecorder, readEpoch, type EpochBuild, type EpochManifest } from './evidence-epoch.ts';
import { exactnessArm, qualifyMismatch, SHADOW_COMPARATOR_VERSION } from './exactness.ts';
import { FollowChild, type FollowEvent, type FollowStore } from './follow-child.ts';
import { appendFault, appendLedgerRows, writeSummaryFile, type ShadowLedgerRow, type ShadowSummaryFile } from './ledger.ts';
import { newMirrorCounters, type MirrorCounters } from './mirror.ts';
import { createWriteComparer } from './write-compare-child.ts';
import { droppedWeight, readOwed, sampleQualifyingWeight, sampleWeight, WriteTally } from './write-compare.ts';
import { appendRecall, IntervalGate, recallEligible, RECALL_INTERVAL_MS, scoreRecall, type RankedKey } from './recall.ts';
import { isShadowReadMember, SHADOW_READ_MEMBERS, type ShadowReadMember } from './reads.ts';
import { readSeedRecord } from './seed.ts';
import { shadowStatePath } from './state.ts';

export const SHADOW_CHILD_CALL_TIMEOUT_MS = 10_000;
export const SHADOW_CHILD_QUEUE_BOUND = 1024;
export const SHADOW_HEARTBEAT_MS = 5_000;
/** After input ends the child drains, writes its evidence and exits; past this it flushes what it has and exits anyway (the parent's own kill timer dies with the parent). */
export const SHADOW_CHILD_EXIT_DEADLINE_MS = 30_000;
/** Timed-out calls that may still be running at once; past it new reads are shed and the heartbeat stops, so the supervisor restarts the child. */
export const SHADOW_CHILD_STALL_LIMIT = 4;
/** What a wait for the follow lock that ran out of time answers (child.ts `rerunOne`, `scoreWithReruns`): a timeout whose stall is the lock's chain, not a Rust call. */
const LOCK_WAIT_TIMEOUT = Object.freeze({ timedOut: true as const });
/** Runs of one sample (the first check, then reruns from a new freshness token) before one that keeps moving stays unresolved. */
export const RERUN_ATTEMPTS = 3;
/** Waits before a run that follows a check whose freshness token moved: the 1st, 2nd and 3rd such move. Each is scaled by 1 +/- RERUN_BACKOFF_JITTER; the worst total (13.1 s) stays inside RERUN_BACKOFF_TOTAL_MS. */
export const RERUN_BACKOFF_MS: readonly number[] = [500, 2_000, 8_000];
export const RERUN_BACKOFF_JITTER = 0.25;
export const RERUN_BACKOFF_TOTAL_MS = 15_000;
/** How long to wait after the `moves`th check moved, before running the sample again. `random` is in [0, 1). */
export const rerunBackoffMs = (moves: number, random: () => number = Math.random): number =>
  Math.round((RERUN_BACKOFF_MS[Math.min(moves, RERUN_BACKOFF_MS.length) - 1] ?? 0) * (1 - RERUN_BACKOFF_JITTER + 2 * RERUN_BACKOFF_JITTER * random()));
const MOVED_CODES: ReadonlySet<string> = new Set(['moved', 'write_after_barrier']); // a write landed after the barrier: the same thing for a rerun

type ShadowEngine = Pick<BrainEngine, 'connect' | 'disconnect'> & Record<string, unknown>;

export interface ShadowChildDeps {
  input: NodeJS.ReadableStream;
  /** Control lines to the supervisor (heartbeat, pause). */
  writeControl: (line: string) => void;
  /** Default: the offline loader (addon.ts); the child never fetches. */
  loadAddon?: RustEngineAddonLoaderFn;
  openEngine?: (addon: RustEngineAddonHandle, storePath: string) => ShadowEngine;
  timeoutMs?: number;
  heartbeatMs?: number;
  /** Set by the process entry: called with 0 at the exit deadline. In-process callers leave it unset and get no deadline. */
  exit?: (code: number) => void;
  exitDeadlineMs?: number;
  flushMs?: number;
  /** The obligation pass (default 10 s): a seam for tests. */
  passMs?: number;
  childId?: string;
  now?: () => number;
  /** The approved readiness policy's hash, an evidence epoch input (evidence-epoch.ts); default `policyHash(READINESS_POLICY)` (engine-swap/policy.ts): the approved policy's hash, not an in-force one. */
  readinessPolicyHash?: () => string;
  /** SHA-256 of the loaded addon file, or null when it cannot be read; default hashes the file the loader opened. */
  addonSha256?: (addon: RustAddon) => string | null;
  /** The build recorded when a new epoch opens (not an epoch input); default `currentBuild()`. */
  build?: () => EpochBuild;
  /** The TS adapter version, an epoch input; default `SHADOW_ADAPTER_VERSION`. */
  adapterVersion?: number;
  /** The capability names the Rust engine reports; default `servedCapabilities()`. */
  capabilities?: () => Iterable<string>;
  /** The session nonce the supervisor gave this child (GBRAIN_SHADOW_SESSION); asks and answers carry it. */
  session?: string;
  /** Seam for tests: called with each ledger row as it is recorded, before it is flushed. */
  onRow?: (row: ShadowLedgerRow) => void;
  /** Seams for tests: the wait before a rerun after a moved check (default: a timer that the end of input cuts short) and its jitter source. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/** SHA-256 of the addon file the loader opened: the development override, else the cached build (addon-loader.ts). */
function addonFileSha256(addon: RustAddon): string | null {
  const path = loadedAddonPath(addon, process.env.GBRAIN_RUST_ENGINE_ADDON);
  if (!path) return null;
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return null; } // silent-read-ok: null is the typed marker; the epoch records `unreadable`, never a digest
}

interface ReadEvent {
  t: 'read';
  id?: number;
  /** The opaque sample id (samples.ts): the serving process keeps the arguments and the caller record under it. */
  sid?: string;
  op: string;
  at: number;
  primary_ms: number;
  args: unknown[];
  result: unknown;
  /** The caller-access record the primary read ran under (mirror.ts); Rust runs under it. Absent on a line from an older serving process. */
  access?: CallerAccess;
}

/** A mismatch no one could explain, waiting for its stable rerun (plan decision 7); its ledger row is written when that ends. */
interface RerunTask { event: ReadEvent; args: unknown[]; c: Classification; rustMs: number; rows: number | null }

function rowCount(encoded: unknown): number | null {
  if (Array.isArray(encoded)) return encoded.length;
  if (encoded === null || encoded === undefined) return 0;
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), ms);
    promise.then((value) => { clearTimeout(timer); resolve({ timedOut: false, value }); },
      (error) => { clearTimeout(timer); reject(error); });
  });
}

/** The control writer for a child process's stdout. A short-lived parent (a CLI call, a cron job) closes its end before the first heartbeat; that must not kill the child before it writes evidence. */
export function pipeControlWriter(out: NodeJS.WriteStream): (line: string) => void {
  let closed = false;
  // cli.ts exits on SIGPIPE and on an EPIPE from stdout (a pipeline's `| head`); this child has no pipeline, so it takes both over.
  process.removeAllListeners('SIGPIPE');
  process.on('SIGPIPE', () => {});
  out.removeAllListeners('error');
  out.on('error', () => { closed = true; }); // EPIPE: the parent is gone, so no more heartbeats
  return (line) => { if (!closed) out.write(line); };
}

/**
 * How a finished rerun closes its sample. The same rows in another order are the primary's rows on the reads that ignore order
 * (membership, ranked private): closed as matched, never a match. A rerun that cleared the extra rows of a ranked read is a reported ranking difference.
 */
function settleRerun(closed: (why: string) => void, row: (c: Classification, why: string) => void, op: string, c: Classification, c2: Classification): void {
  const orderOnly = c2.outcome === 'order_diff' && (exactnessArm(op) === 'membership' || exactnessArm(op) === 'private_ranked');
  if (c2.outcome === 'match' || orderOnly) closed('matched'); // closed as unsuccessful, never a match
  else if (c2.outcome === 'privacy_diverged') row(c2, 'differed');
  else if (c2.outcome === 'inconclusive') closed(`skipped:${c2.reason ?? 'privacy_check'}`);
  else if (c2.reason === 'extra_rows_cleared') row({ outcome: 'diff', reason: 'extra_rows_cleared', mismatch: c.mismatch ?? 'diff' }, 'differed');
  else row({ outcome: 'diff', reason: 'rerun_differs', mismatch: c.mismatch ?? (c2.outcome as 'diff' | 'order_diff') }, 'differed');
}

/** What a recall score needs of the child: its asks, the follow lock and the Rust call (child.ts keeps their state). */
interface RecallEnv {
  ask: (payload: Record<string, unknown>, timeoutMs: number) => Promise<unknown>;
  exclusive: (stamp: number, fn: () => Promise<unknown>) => Promise<{ value?: unknown; timedOut?: boolean } | null>;
  callRust: (op: string, args: unknown[], access: ReadEvent['access'], ms: number) => Promise<{ value?: unknown; timedOut?: boolean }>;
  curEpoch: () => string | null;
  now: () => number;
  timeoutMs: number;
  /** The wait before a rerun after a moved check (a timer, never a busy loop); default: none, as before. */
  pause?: (ms: number) => Promise<void>;
  random?: () => number;
  write: (score: NonNullable<ReturnType<typeof scoreRecall>>, epoch: string) => void;
}

/**
 * Scores one vector read against the exact reference (checks.ts `vectorReference`). When the corpus moved before the reference
 * ended (`moved`), both engines and the reference are run again from a new position, up to RERUN_ATTEMPTS times in all; a
 * sample that keeps moving is not scored. An unscored sample is skipped, never counted.
 */
export async function scoreWithReruns(env: RecallEnv, event: ReadEvent, args: unknown[], rust: unknown): Promise<void> {
  try {
    const deadline = env.now() + RERUN_DEADLINE_MS * RERUN_ATTEMPTS;
    let primary: unknown = event.result;
    let theirs: unknown = rust;
    let phase: 'sample' | 'rerun' = 'sample';
    let attemptId: string | undefined; // the rerun attempt the reference is held to: never another's
    for (let attempt = 1; ; attempt++) {
      try {
        const reference = await env.ask({ kind: 'vector', sid: event.sid, phase, ...(attemptId === undefined ? {} : { attempt: attemptId }) }, RERUN_DEADLINE_MS) as RankedKey[];
        const score = scoreRecall(reference, primary, theirs);
        const epoch = env.curEpoch(); // a child that is no longer an owner names no epoch: the sample is dropped
        if (score && epoch) env.write(score, epoch);
        return;
      } catch (error) {
        if (safeCode((error as { code?: unknown })?.code) !== 'moved' || attempt >= RERUN_ATTEMPTS || env.now() > deadline) return;
        await env.pause?.(rerunBackoffMs(attempt, env.random)); // a quiet window may follow: the fresh run starts after it, off the serving process
        if (env.now() > deadline) return;
        const answer = await env.ask({ kind: 'rerun', sid: event.sid, epoch_id: env.curEpoch() }, RERUN_DEADLINE_MS) as { stamp: number; epoch_id: string; keys?: Array<RankedKey | null>; attempt?: string };
        if (env.curEpoch() === null || answer.epoch_id !== env.curEpoch() || !answer.keys || !answer.attempt) return;
        const out = await env.exclusive(answer.stamp, () => env.callRust(event.op, args, event.access, env.timeoutMs));
        if (out === null || out.timedOut) return;
        primary = answer.keys.map((k) => (k ? { chunk_id: k.k, score: k.s } : null)); // holes kept: a malformed position still takes its place
        attemptId = answer.attempt;
        theirs = encodeValue(out.value);
        phase = 'rerun';
      }
    }
  } catch { /* an unscored sample is skipped, never counted */ }
}

/** The result of opening the Rust store: the engine, or why there is none (`unavailable`), and whether the open gave up waiting. */
interface OpenedStore { engine: ShadowEngine | null; unavailable: Classification | null; openTimedOut: boolean }

/** Opens the Rust store for the child; a failure leaves no engine and names the reason, it never throws. */
async function openRustStore(
  shadowDir: string, deps: ShadowChildDeps, load: Awaited<ReturnType<RustEngineAddonLoaderFn>>,
  deleted: () => boolean, recordRustError: (where: string, error: unknown) => void,
): Promise<OpenedStore> {
  if (!load.ok) return { engine: null, unavailable: { outcome: 'addon_unavailable', reason: `${load.code}:${load.reason}` }, openTimedOut: false };
  if (deleted()) return { engine: null, unavailable: { outcome: 'error', reason: 'shadow_dir_deleted' }, openTimedOut: false };
  let engine: ShadowEngine | null = null;
  let openTimedOut = false;
  try {
    const open = deps.openEngine ?? ((addon, store) => openRustEngine({ addon, databasePath: store }) as unknown as ShadowEngine);
    const storePath = join(shadowDir, 'store');
    engine = open(load.addon, storePath);
    // A connect that never returns would keep the exit deadline (armed after input ends) from ever starting; a child with a deadline gives up on it.
    const connecting = engine.connect({ database_path: storePath });
    if (deps.exit && (await withTimeout(connecting, deps.exitDeadlineMs ?? SHADOW_CHILD_EXIT_DEADLINE_MS)).timedOut) {
      // The child gives up on this store: it closes it if the open ever finishes, and goes quiet so the parent's watchdog restarts the child.
      const abandoned = engine;
      void connecting.then(() => abandoned.disconnect(), () => undefined).catch(() => undefined);
      openTimedOut = true;
      throw Object.assign(new Error('opening the Rust store timed out'), { code: 'open_timeout' });
    }
    await connecting;
    if (deleted()) {
      await engine.disconnect().catch(() => {});
      rmSync(shadowDir, { recursive: true, force: true });
      throw Object.assign(new Error('shadow directory deleted while opening'), { code: 'shadow_dir_deleted' });
    }
    return { engine, unavailable: null, openTimedOut };
  } catch (error) {
    recordRustError('open', error);
    return { engine: null, unavailable: { outcome: 'error', reason: `open_failed:${classifyError(error).reason ?? 'unknown'}` }, openTimedOut };
  }
}

/**
 * The follow chains a caller gave up waiting for (an apply that has not ended). While one is open the child is unhealthy by itself: it stops heartbeating, so the supervisor's
 * watchdog restarts it, whether or not later reads or reruns reach a stall of their own (a later rerun waits for a barrier behind the same chain and never reaches the lock).
 */
function createWedgeWatch(pending: () => Promise<unknown>, track: (chain: Promise<unknown>) => void): { mark(): void; open(): boolean } {
  const chains = new Set<Promise<unknown>>();
  return {
    mark(): void { const chain = pending(); chains.add(chain); track(chain); const done = (): void => { chains.delete(chain); }; chain.then(done, done); },
    open: (): boolean => chains.size > 0,
  };
}

/**
 * The evidence epoch a child session belongs to, read lazily. It names the addon THIS child loaded, so it is only valid while this
 * child is the owner of the Rust store: a client of another process's owner reads answers from an addon whose digest
 * the owner handshake does not carry, so it cannot name an epoch and its rows and counts carry none (fail closed).
 * Without a seed or a writable manifest there is no epoch either. The role is checked on every use, so a client that
 * takes over opens (or joins) the epoch for its own addon from then on.
 */
function childEpoch(
  shadowDir: string, deps: ShadowChildDeps, load: Awaited<ReturnType<RustEngineAddonLoaderFn>>,
  deleted: () => boolean, isClient: () => boolean, now: () => number,
): () => EpochManifest | null {
  let epoch: EpochManifest | null = null;
  let epochTried = false;
  const seed = readSeedRecord(shadowDir);
  return () => {
    if (isClient()) return null;
    if (!epochTried) {
      epochTried = true;
      if (seed && !deleted()) { // a deleted shadow directory must not be recreated by the manifest
        try {
          epoch = ensureEpoch(shadowDir, {
            seed_id: seed.seed_id,
            rust_addon_sha256: load.ok ? ((deps.addonSha256 ?? addonFileSha256)(load.addon) ?? 'unreadable') : null,
            comparator_version: SHADOW_COMPARATOR_VERSION,
            adapter_version: adapterIdentity(RUST_ENGINE_ABI, load.ok ? String(load.addon.catalogVersion) : 'none', deps.adapterVersion),
            capability_set_hash: load.ok ? capabilitySetHash((deps.capabilities ?? servedCapabilities)()) : null,
            readiness_policy_hash: (deps.readinessPolicyHash ?? (() => policyHash(READINESS_POLICY)))(),
          }, now(), (deps.build ?? currentBuild)());
        } catch { epoch = null; }
      }
    }
    return epoch;
  };
}

/** Runs the child loop until stdin closes. Resolves with the number of events handled. */
export async function runShadowChild(shadowDir: string, deps: ShadowChildDeps): Promise<number> {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? SHADOW_CHILD_CALL_TIMEOUT_MS;
  const childId = deps.childId ?? `${process.pid}-${now()}`;
  const summary: ShadowSummaryFile = {
    version: 1, child_id: childId, started_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(),
    first_event_at: null, last_event_at: null, by_op: {}, child_shed: 0, primary: newMirrorCounters(),
  };

  let engine: ShadowEngine | null = null;
  let unavailable: Classification | null = null;
  let openTimedOut = false;
  let load: Awaited<ReturnType<RustEngineAddonLoaderFn>>;
  try {
    load = await (deps.loadAddon ?? loadRustEngineAddonOffline)();
  } catch (error) {
    load = { ok: false, code: 'rust_engine_addon_missing', reason: `loader_error:${classifyError(error).reason ?? 'unknown'}`, message: 'loader threw' };
  }
  // `stop --delete` can land while the addon loads: opening the store now would recreate the directory it removed.
  const hadState = existsSync(shadowStatePath(shadowDir));
  const deleted = (): boolean => !existsSync(shadowDir) || (hadState && !existsSync(shadowStatePath(shadowDir)));
  const isClient = (): boolean => (engine as { ownerRole?: string | null } | null)?.ownerRole === 'client';
  const epochNow = childEpoch(shadowDir, deps, load, deleted, isClient, now);
  const curEpoch = (): string | null => epochNow()?.epoch_id ?? null;
  const recordRustError = internalErrorRecorder(shadowDir, () => epochNow()?.epoch_id ?? null, now);
  const opened = await openRustStore(shadowDir, deps, load, deleted, recordRustError);
  engine = opened.engine;
  unavailable = opened.unavailable;
  openTimedOut = opened.openTimedOut;

  epochNow(); // the role is known now: an owner (or a child with no engine) opens its epoch before the first row

  // The follower (apply lines and reconcile calls) works on the same Rust store; it exists once the engine is open.
  const rustEngine = engine as unknown as { storeFor?: (member: string) => Promise<FollowStore>; ownerRole?: string | null } | null;
  const follow = new FollowChild({
    dir: shadowDir, writeControl: deps.writeControl, now,
    store: async () => { try { return (await rustEngine?.storeFor?.('follow')) ?? null; } catch (error) { recordRustError('open', error); return null; } },
    owner: () => rustEngine?.ownerRole !== 'client',
    onRustError: recordRustError,
    epochId: () => epochNow()?.epoch_id ?? null,
  });
  const stalled = new Set<Promise<unknown>>();
  const wedged = createWedgeWatch(() => follow.pending(), (chain) => trackStall(chain));
  const heartbeat = setInterval(() => {
    if (openTimedOut || stalled.size >= SHADOW_CHILD_STALL_LIMIT) return; // wedged in native work: go quiet so the watchdog restarts this child
    follow.tick();
    if (wedged.open()) return; // the follow chain is stuck: no heartbeat until it recovers
    try { deps.writeControl('{"t":"hb"}\n'); } catch { /* parent gone */ }
  }, deps.heartbeatMs ?? SHADOW_HEARTBEAT_MS);
  if (!openTimedOut) try { deps.writeControl('{"t":"hb"}\n'); } catch { /* parent gone */ }

  const pending: ReadEvent[] = []; const rows: ShadowLedgerRow[] = [];
  let handled = 0; let paused = false; let lastFlush = now();

  const flush = (force: boolean): void => {
    if (!force && rows.length < 50 && now() - lastFlush < 2_000) return;
    lastFlush = now();
    try {
      appendLedgerRows(shadowDir, rows.splice(0));
      summary.updated_at = new Date(now()).toISOString();
      writeSummaryFile(shadowDir, summary);
    } catch { /* a full disk loses evidence, never the child */ }
  };

  // Finished comparisons reach disk within a couple of seconds even when no more reads arrive (a kill loses at most that window).
  const flusher = setInterval(() => { if (rows.length) flush(true); }, deps.flushMs ?? 2_000);
  (flusher as { unref?: () => void }).unref?.();

  const record = (event: ReadEvent, c: Classification, rustMs: number | null, rustRows: number | null, rerun?: string): void => {
    const ts = new Date(event.at || now()).toISOString();
    summary.first_event_at ??= ts;
    summary.last_event_at = ts;
    if (rerun !== 'pending') { // an unresolved row is counted in the summary when its completion row is written
      const counts = summary.by_op[event.op] ?? (summary.by_op[event.op] = {});
      counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
    }
    const row: ShadowLedgerRow = {
      ts, op: event.op, outcome: c.outcome, ...(c.reason ? { reason: c.reason } : {}), ...(c.mismatch ? { mismatch: c.mismatch } : {}),
      ...(epochNow() ? { epoch_id: epochNow()!.epoch_id } : {}), ...(rerun ? { rerun, sid: sidOf(event) } : {}), ...(policyApplies(event.args as unknown[]) ? { private_read: true } : {}),
      primary_ms: Math.round(event.primary_ms * 1000) / 1000,
      rust_ms: rustMs === null ? null : Math.round(rustMs * 1000) / 1000,
      primary_rows: rowCount(event.result), rust_rows: rustRows,
    };
    rows.push(row);
    try { deps.onRow?.(row); } catch { /* a test seam */ }
    if (rerun !== 'pending') handled++;
    if (rerun === 'pending') flush(true); // the unresolved row is on disk before anything else can happen to this child
    if (c.outcome === 'privacy_diverged' && !paused) {
      paused = true;
      try { appendFault(shadowDir, { ts, kind: 'privacy_pause', detail: `op=${event.op} reason=${c.reason ?? 'unknown'}`, ...(curEpoch() ? { epoch_id: curEpoch()! } : {}) }); } catch { /* disk */ }
      try { deps.writeControl('{"t":"pause","reason":"privacy_diverged"}\n'); } catch { /* parent gone */ }
    }
    flush(false);
  };

  // Write comparisons (write-compare.ts): sampled page and link writes replayed on a scratch store, counted under the current epoch.
  const session = deps.session ?? process.env.GBRAIN_SHADOW_SESSION ?? '';
  const writes = createWriteComparer({ dir: shadowDir, load, tally: new WriteTally(shadowDir, curEpoch, () => !deleted(), process.pid, session, now), alive: () => !deleted(), openEngine: deps.openEngine, onError: recordRustError });
  const ask = createAsker(deps.writeControl, session);
  // A client child's (or a retired one's) lost lines are written on the same 2 s beat, never one durable write per verdict.
  const lineFlusher = setInterval(() => { try { writes.flush(); } catch { /* the lines stay held; the next beat tries again */ } }, deps.flushMs ?? 2_000);
  (lineFlusher as { unref?: () => void }).unref?.();
  // Every 10 s: one more save of what could not be saved, the lines held, and the obligations of sessions that are gone (an owner child settles them). A save that keeps failing for a minute with outcomes held ends this child: the
  // supervisor restarts it, and the next owner books what it never settled, so the session is not held open for good by one child's failing save.
  const obligationPass = setInterval(() => { try { if (writes.pass()) { flush(true); deps.exit?.(1); } } catch { /* a failed pass is retried at the next one */ } }, deps.passMs ?? 10_000);
  (obligationPass as { unref?: () => void }).unref?.();

  /** A call that never returns keeps its slot: that is what bounds the pile. */
  const trackStall = (call: Promise<unknown>): void => { stalled.add(call); const settled = (): void => { stalled.delete(call); }; call.then(settled, settled); };

  /** A row's sample id: the serving process's, else one of this child's own (a line from an older serving process has none). */
  let localSid = 0;
  const sids = new WeakMap<ReadEvent, string>();
  const sidOf = (event: ReadEvent): string => event.sid ?? sids.get(event) ?? (sids.set(event, `${childId}.${event.id ?? ++localSid}`), sids.get(event)!);

  /** The Rust read of `op`, under the caller access the primary read ran under. */
  const callRust = (op: string, args: unknown[], access: CallerAccess | undefined, ms: number, onCall?: (call: Promise<unknown>) => void) => {
    const run = (): unknown => (engine![op] as (...a: unknown[]) => unknown).apply(engine, args);
    const call = Promise.resolve(access ? withCallerAccess(access, run) : run());
    call.catch((error) => recordRustError('read', error)); // seen even when it rejects after the timeout; one failure is recorded once
    onCall?.(call);
    return withTimeout(call, ms);
  };

  /**
   * Classifies one comparison, then asks the serving process about the Rust pages the primary's answer lacked (privacy). A
   * mismatch on an exactness comparison is qualified as stale or inconclusive (`lagged`); a rerun passes null and keeps the raw mismatch.
   */
  const judge = async (op: string, encodedArgs: unknown[], primary: unknown, rust: unknown, sid: string | undefined, phase: 'sample' | 'rerun', at: number, lagged: boolean | null): Promise<Classification> => {
    // A rerun holds the DIGESTS of the primary's answer (the serving process keeps the answer: nothing but digests crosses the control channel): the whole
    // answer, and for a ranked read its membership (rows without scores, in a fixed order). Only a leak, equality, or equal membership is decided here:
    // the same rows in another order or with other scores are an order_diff, as on a first read; anything else is a plain diff, and the privacy question compares rows there.
    const kind = SHADOW_READ_MEMBERS[op as ShadowReadMember];
    const asked = primary as { digest?: string; members?: string; list?: boolean; attempt?: string };
    const c = phase === 'rerun'
      ? ((leak) => (leak.outcome === 'privacy_diverged' ? leak
        : resultDigest(rust) === asked.digest ? { outcome: 'match' as const }
        : kind === 'ranked' && asked.members !== undefined && membersDigest(rust) === asked.members ? { outcome: 'order_diff' as const }
        : { outcome: 'diff' as const }))(classifyResult(kind, encodedArgs, null, rust, op))
      : classifyResult(kind, encodedArgs, primary, rust, op);
    if (c.outcome === 'match' || c.outcome === 'privacy_diverged') return c;
    const args = decodeValue(encodedArgs) as unknown[];
    // A read that answers a list is one the primary answered with a list (the first answer, for a rerun) or a ranked read: its answer must be a list.
    const expectList = kind === 'ranked' || (phase === 'rerun' ? asked.list === true : Array.isArray(primary));
    const { verdict, complete } = await privacyVerdict(ask, args, phase === 'rerun' ? undefined : primary, rust, sid, phase, at, expectList, phase === 'rerun' ? asked.attempt : undefined);
    if (verdict === 'violation') return { outcome: 'privacy_diverged', reason: 'row_not_readable_by_caller' };
    if (verdict !== 'clean') return { outcome: 'inconclusive', reason: verdict, mismatch: c.outcome as 'diff' | 'order_diff' };
    if (exactnessArm(op) === 'private_ranked') {
      // The ranked-search exception (exactness.ts RANKED_PRIVATE_EXCEPTION): reported, with its count per member, only when every extra Rust row passed the check.
      if (!policyApplies(args)) return c;
      if (complete) return c.outcome === 'diff' ? { ...c, reason: 'extra_rows_cleared' } : c;
    }
    return lagged === null ? c : qualifyMismatch(op, c, lagged, { args: encodedArgs, primary, rust });
  };

  /**
   * One stable rerun (checks.ts `stableRerun`): both engines read again at a generation the barrier proved quiet. A rerun whose
   * proof that nothing was written moved (the primary's freshness token changed before its check ended, or a write landed after
   * the barrier) is run again, from a new position, up to RERUN_ATTEMPTS times, each after a growing wait (RERUN_BACKOFF_MS); a sample still moving then stays unresolved
   * (`skipped:moved`), which counts as unexplained.
   */
  const rerunOne = async ({ event, args, c, rustMs, rows }: RerunTask): Promise<void> => {
    // The privacy reason found by any rerun of this sample (the first check may have named none) rides on every unsuccessful settlement after it, until a later completed check resolves the sample.
    let unsettled: string | undefined;
    const carried = (): Classification => (unsettled === undefined ? c : { ...c, reason: unsettled });
    const skip = (why: string): void => record(event, carried(), rustMs, rows, `skipped:${why}`); let moves = c.reason === 'privacy_check_moved' ? 1 : 0; // checks of this sample whose position moved so far: each wait is longer than the last
    try {
      for (let attempt = 1; attempt <= RERUN_ATTEMPTS; attempt++) {
        const retry = (): boolean => { const more = attempt < RERUN_ATTEMPTS; moves++; if (!more) skip('moved'); return more; };
        if (moves > 0) { await waiter.pause(rerunBackoffMs(moves, deps.random)); if (waiter.closed()) return skip('child_closing'); } const deadline = now() + RERUN_DEADLINE_MS; let answer: { digest: string; members?: string; stamp: number; epoch_id: string; attempt?: string };
        try { answer = await ask({ kind: 'rerun', sid: event.sid, epoch_id: curEpoch() }, RERUN_DEADLINE_MS) as typeof answer; } catch (error) {
          if (!MOVED_CODES.has(safeCode((error as { code?: unknown })?.code))) throw error;
          if (retry()) continue; return;
        }
        if (curEpoch() === null || answer.epoch_id !== curEpoch()) return skip('epoch_changed'); // an answer for another epoch is dropped, never restamped
        let call!: Promise<unknown>;
        // The wait for the follow lock has the same deadline as the call: an apply that never ends holds the lock, and the rerun then ends as a timeout and records a stall (the chain it waits on), so the queue moves on to the next rerun.
        const out = await follow.exclusive(answer.stamp, () => callRust(event.op, args, event.access, Math.max(1, Math.min(timeoutMs, deadline - now())), (p) => { call = p; }), { ms: Math.max(1, Math.min(timeoutMs, deadline - now())), onTimeout: LOCK_WAIT_TIMEOUT });
        if (out === LOCK_WAIT_TIMEOUT) wedged.mark(); else if (out?.timedOut) trackStall(call);
        if (out === null || out.timedOut) return skip(out === null ? 'watermark_moved' : 'timeout');
        const c2 = await judge(event.op, event.args, { digest: answer.digest, members: answer.members, attempt: answer.attempt, list: Array.isArray(event.result) }, encodeValue(out.value), event.sid, 'rerun', now(), null);
        if (c2.outcome === 'inconclusive' && c2.reason?.startsWith('privacy_check_')) unsettled = c2.reason; // this rerun's own privacy check could not be settled
        if (c2.outcome === 'inconclusive' && c2.reason === 'privacy_check_moved') { if (retry()) continue; return; }
        settleRerun((why) => record(event, carried(), rustMs, rows, why), (row, why) => record(event, row, rustMs, rows, why), event.op, c, c2);
        return;
      }
    } catch (error) {
      recordRustError('read', error);
      skip(safeCode((error as { code?: unknown })?.code));
    } finally { flush(true); } // a rerun is rare and slow: its row is written the moment it ends
  };
  const reruns = createSerialQueue<RerunTask>(RERUN_QUEUE_BOUND, rerunOne); const waiter = createWaiter(deps.sleep); // the wait before a rerun: a timer nothing else waits on; the end of input cuts it short

  // Vector recall (recall.ts): at most one reference run a minute, asked of the serving process off the request path.
  const recallGate = new IntervalGate(RECALL_INTERVAL_MS, now);
  let recalling: Promise<void> | null = null;
  const recallEnv: RecallEnv = { ask, now, timeoutMs, curEpoch, pause: waiter.pause, random: deps.random, exclusive: async (stamp, fn) => { const out = await follow.exclusive(stamp, fn, { ms: timeoutMs, onTimeout: LOCK_WAIT_TIMEOUT }); if (out === LOCK_WAIT_TIMEOUT) wedged.mark(); return out as never; }, callRust: (op, a, access, ms) => callRust(op, a, access, ms) as never,
    write: (score, epoch) => appendRecall(shadowDir, { ts: new Date(now()).toISOString(), epoch_id: epoch, ...score }, { currentEpochOnly: true }) };
  const scoreRecallLater = (event: ReadEvent, args: unknown[], rust: unknown): void => {
    if (event.op !== 'searchVector' || !curEpoch() || recalling || !recallEligible(args) || !recallGate.take()) return;
    recalling = scoreWithReruns(recallEnv, event, args, rust).finally(() => { recalling = null; });
  };

  const handle = async (event: ReadEvent): Promise<void> => {
    // After a privacy divergence nothing more is compared, queued events included.
    if (paused || !isShadowReadMember(event.op)) return;
    if (unavailable || !engine) { record(event, unavailable ?? { outcome: 'error', reason: 'no_engine' }, null, null); return; }
    const fn = engine[event.op];
    if (typeof fn !== 'function') { record(event, { outcome: 'capability_missing', reason: 'not_a_member' }, null, null); return; }
    if (stalled.size >= SHADOW_CHILD_STALL_LIMIT) { record(event, { outcome: 'timeout', reason: 'stalled' }, null, null); return; }
    const started = performance.now();
    // Stale needs evidence: committed work older than this read that the follower had not applied, when the read
    // started or when it was compared.
    const capturedAt = event.at || now();
    let lagged = follow.pendingBefore(capturedAt);
    try {
      const args = decodeValue(event.args) as unknown[]; // inside the try: one malformed event is recorded, never a wedged loop
      let call!: Promise<unknown>;
      const out = await callRust(event.op, args, event.access, timeoutMs, (p) => { call = p; });
      const rustMs = performance.now() - started;
      if (out.timedOut) {
        trackStall(call);
        record(event, { outcome: 'timeout' }, rustMs, null);
        return;
      }
      const encoded = encodeValue(out.value);
      lagged ||= follow.pendingBefore(capturedAt);
      const c = await judge(event.op, event.args, event.result, encoded, event.sid, 'sample', capturedAt, lagged);
      scoreRecallLater(event, args, encoded);
      const task: RerunTask = { event, args, c, rustMs, rows: rowCount(encoded) };
      if (c.outcome !== 'inconclusive') record(event, c, rustMs, task.rows);
      else if (!curEpoch()) record(event, c, rustMs, task.rows, 'skipped:no_epoch');
      else {
        record(event, c, rustMs, task.rows, 'pending'); // unresolved is on disk first: status reads it as unexplained until its completion row, even if this child dies
        if (!reruns.add(task)) record(event, c, rustMs, task.rows, 'skipped:queue_full');
      }
    } catch (error) {
      recordRustError('read', error);
      record(event, classifyError(error), performance.now() - started, null);
    }
  };

  let draining: Promise<void> | null = null;
  const drain = (): Promise<void> => {
    draining ??= (async () => {
      try { while (pending.length > 0) await handle(pending.shift()!); } finally { draining = null; }
    })();
    return draining;
  };

  let receivedQualifying = 0; // the part of `received` that is page and link writes, counted from the same bytes as the serving process counted it (write-compare.ts sampleQualifyingWeight)
  let received = 0; // write samples read from the pipe, whole lines only (a line the exit of the serving process cut short is not one)
  const rl = createInterface({ input: deps.input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let event: { t?: string; counters?: MirrorCounters; pid?: number; dropped?: number };
    try { event = JSON.parse(line); } catch { const w = sampleWeight(`${line}\n`); if (w > 0) { const q = sampleQualifyingWeight(`${line}\n`); received += w; receivedQualifying += q; writes.unreadable(w, q); } continue; } // a write line that cannot be read still stands for the samples its text states: settled once, as `uncomparable`
    if (event.t === 'apply' || event.t === 'watermark' || event.t === 'depth' || event.t === 'rpc') { follow.handle(event as FollowEvent); continue; }
    if (event.t === 'answer') { ask.answer(event as never); continue; }
    if (event.t === 'write') { const q = sampleQualifyingWeight(`${line}\n`); received += 1 + droppedWeight(event.dropped); receivedQualifying += q; writes.handle(event as never, line.length, q); continue; } // the weight the serving process counted when it sent the line (write-compare.ts sampleWeight)
    if (event.t === 'stats' && event.counters) { summary.primary = { ...newMirrorCounters(), ...event.counters }; summary.primary_pid = event.pid; continue; }
    if (event.t !== 'read' || paused) continue;
    if (pending.length >= SHADOW_CHILD_QUEUE_BOUND) { summary.child_shed++; continue; }
    pending.push(event as ReadEvent);
    void drain();
  }
  if (deps.exit) {
    const timer = setTimeout(() => { summary.child_shed += pending.length; writes.abandon(); flush(true); deps.exit!(0); }, deps.exitDeadlineMs ?? SHADOW_CHILD_EXIT_DEADLINE_MS);
    (timer as { unref?: () => void }).unref?.();
  }
  // The serving process wrote down, durably and before any line reached the pipe, how many write samples it owes this session (`write-owed.<session>.json`). What it owed and this child never read was dropped in its pipe at its exit: it is
  // booked as `pipe_unflushed`, settled in this child's own saves. A file that is there and cannot be read stays, and status reads it as no evidence.
  const owedRecord = readOwed(shadowDir, session);
  if (owedRecord !== null && owedRecord !== 'unreadable') {
    // Only the lost page and link writes count against the share: the other writes owed less the other writes read are booked as `pipe_unflushed_nonqualifying`; every other lost sample, including any count the two ends
    // disagree on, is `pipe_unflushed`. A record with no qualifying count (an older serving process) books every one as `pipe_unflushed`.
    const lost = Math.max(0, owedRecord.owed - received);
    const nonqualifying = owedRecord.owed_qualifying === undefined ? 0 : Math.min(lost, Math.max(0, (owedRecord.owed - owedRecord.owed_qualifying) - (received - receivedQualifying)));
    writes.missing(lost, nonqualifying);
  }
  // The serving process ended our stdin: nothing it was asked can still be answered. A queued rerun ends as skipped.
  ask.closeAll(); waiter.close(); // a rerun waiting for a quiet window ends now, as skipped
  for (const task of reruns.drop()) record(task.event, task.c, task.rustMs, task.rows, 'skipped:child_closing');
  await drain();
  await reruns.idle();
  await recalling;
  // The owed file is removed only now, once the serving process closed it and the settled count read back from disk covers everything it owed: a failed final save (or a death or the exit deadline before it) leaves it, and the next owner
  // worker books what was never settled as receipt_orphaned (more than was lost, never less); with it gone, status would read measured with an outcome that was only ever in memory.
  if (await writes.idle()) { try { writes.finish(); } catch { /* the file stays: the next owner worker settles it, or status reads no evidence */ } }
  await follow.close();
  clearInterval(heartbeat);
  clearInterval(flusher);
  clearInterval(lineFlusher);
  clearInterval(obligationPass);
  flush(true);
  if (engine) { try { await engine.disconnect(); } catch { /* exiting anyway */ } }
  return handled;
}
