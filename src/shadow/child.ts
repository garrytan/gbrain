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
 * The store is not seeded yet (seed and reconcile are plan PR S3), so once Rust implements a read, its answers
 * describe an empty store and mostly `diff`; the provisional report says so.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { gbrainPath } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { withCallerAccess, type CallerAccess } from '../core/search/private-visibility.ts';
import { openRustEngine, type RustEngineAddonHandle } from '../core/rust-engine.ts';
import { policyHash, READINESS_POLICY } from '../core/engine-swap/policy.ts';
import { RUST_ENGINE_ABI } from '../core/rust-engine/addon-manifest.ts';
import type { RustAddon } from '../core/rust-engine/addon-loader.ts';
import { servedCapabilities } from '../core/rust-engine/store-capabilities.ts';
import { loadRustEngineAddonOffline, type RustEngineAddonLoaderFn } from './addon.ts';
import { RERUN_DEADLINE_MS } from './checks.ts';
import { createAsker, createSerialQueue, membersDigest, policyApplies, privacyVerdict, RERUN_QUEUE_BOUND, resultDigest, safeCode } from './child-checks.ts';
import { classifyError, classifyResult, type Classification } from './classify.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { adapterIdentity, capabilitySetHash, currentBuild, ensureEpoch, internalErrorRecorder, type EpochBuild, type EpochManifest } from './evidence-epoch.ts';
import { exactnessArm, qualifyMismatch, SHADOW_COMPARATOR_VERSION } from './exactness.ts';
import { FollowChild, type FollowEvent, type FollowStore } from './follow-child.ts';
import { appendFault, appendLedgerRows, writeSummaryFile, type ShadowLedgerRow, type ShadowSummaryFile } from './ledger.ts';
import { newMirrorCounters, type MirrorCounters } from './mirror.ts';
import { appendRecall, IntervalGate, recallEligible, RECALL_INTERVAL_MS, scoreRecall, type RankedKey } from './recall.ts';
import { isShadowReadMember, SHADOW_READ_MEMBERS, type ShadowReadMember } from './reads.ts';
import { readSeedRecord } from './seed.ts';
import { shadowStatePath } from './state.ts';

export const SHADOW_CHILD_CALL_TIMEOUT_MS = 10_000;
export const SHADOW_CHILD_QUEUE_BOUND = 1024;
export const SHADOW_HEARTBEAT_MS = 5_000;
/** Timed-out calls that may still be running at once; past it new reads are shed and the heartbeat stops, so the supervisor restarts the child. */
export const SHADOW_CHILD_STALL_LIMIT = 4;

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
}

/** SHA-256 of the addon file the loader opened: the development override, else the cached build (addon-loader.ts). */
function addonFileSha256(addon: RustAddon): string | null {
  const path = process.env.GBRAIN_RUST_ENGINE_ADDON?.trim() || join(gbrainPath('engines', 'rust'), String(addon.engineBuild), `${String(addon.target)}.node`);
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
  let load: Awaited<ReturnType<RustEngineAddonLoaderFn>>;
  try {
    load = await (deps.loadAddon ?? loadRustEngineAddonOffline)();
  } catch (error) {
    load = { ok: false, code: 'rust_engine_addon_missing', reason: `loader_error:${classifyError(error).reason ?? 'unknown'}`, message: 'loader threw' };
  }
  // `stop --delete` can land while the addon loads: opening the store now would recreate the directory it removed.
  const hadState = existsSync(shadowStatePath(shadowDir));
  const deleted = (): boolean => !existsSync(shadowDir) || (hadState && !existsSync(shadowStatePath(shadowDir)));
  // The evidence epoch this child session belongs to. It names the addon THIS child loaded, so it is only valid while this
  // child is the owner of the Rust store: a client of another process's owner reads answers from an addon whose digest
  // the owner handshake does not carry, so it cannot name an epoch and its rows and counts carry none (fail closed).
  // Without a seed or a writable manifest there is no epoch either. The role is checked on every use, so a client that
  // takes over opens (or joins) the epoch for its own addon from then on.
  let epoch: EpochManifest | null = null;
  let epochTried = false;
  const seed = readSeedRecord(shadowDir);
  const isClient = (): boolean => (engine as { ownerRole?: string | null } | null)?.ownerRole === 'client';
  const epochNow = (): EpochManifest | null => {
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
  const curEpoch = (): string | null => epochNow()?.epoch_id ?? null;
  const recordRustError = internalErrorRecorder(shadowDir, () => epochNow()?.epoch_id ?? null, now);
  if (!load.ok) {
    unavailable = { outcome: 'addon_unavailable', reason: `${load.code}:${load.reason}` };
  } else if (deleted()) {
    unavailable = { outcome: 'error', reason: 'shadow_dir_deleted' };
  } else {
    try {
      const open = deps.openEngine ?? ((addon, store) => openRustEngine({ addon, databasePath: store }) as unknown as ShadowEngine);
      const storePath = join(shadowDir, 'store');
      engine = open(load.addon, storePath);
      await engine.connect({ database_path: storePath });
      if (deleted()) {
        await engine.disconnect().catch(() => {});
        rmSync(shadowDir, { recursive: true, force: true });
        throw Object.assign(new Error('shadow directory deleted while opening'), { code: 'shadow_dir_deleted' });
      }
    } catch (error) {
      recordRustError('open', error);
      engine = null;
      unavailable = { outcome: 'error', reason: `open_failed:${classifyError(error).reason ?? 'unknown'}` };
    }
  }

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
  const heartbeat = setInterval(() => {
    if (stalled.size >= SHADOW_CHILD_STALL_LIMIT) return; // wedged in native work: go quiet so the watchdog restarts this child
    follow.tick();
    try { deps.writeControl('{"t":"hb"}\n'); } catch { /* parent gone */ }
  }, deps.heartbeatMs ?? SHADOW_HEARTBEAT_MS);
  try { deps.writeControl('{"t":"hb"}\n'); } catch { /* parent gone */ }

  const pending: ReadEvent[] = [];
  const rows: ShadowLedgerRow[] = [];
  let handled = 0;
  let paused = false;
  let lastFlush = now();

  const flush = (force: boolean): void => {
    if (!force && rows.length < 50 && now() - lastFlush < 2_000) return;
    lastFlush = now();
    try {
      appendLedgerRows(shadowDir, rows.splice(0));
      summary.updated_at = new Date(now()).toISOString();
      writeSummaryFile(shadowDir, summary);
    } catch { /* a full disk loses evidence, never the child */ }
  };

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

  const session = deps.session ?? process.env.GBRAIN_SHADOW_SESSION ?? '';
  const ask = createAsker(deps.writeControl, session);

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
    const asked = primary as { digest?: string; members?: string; list?: boolean };
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
    const { verdict, complete } = await privacyVerdict(ask, args, phase === 'rerun' ? undefined : primary, rust, sid, phase, at, expectList);
    if (verdict === 'violation') return { outcome: 'privacy_diverged', reason: 'row_not_readable_by_caller' };
    if (verdict !== 'clean') return { outcome: 'inconclusive', reason: verdict, mismatch: c.outcome as 'diff' | 'order_diff' };
    if (exactnessArm(op) === 'private_ranked') {
      // The ranked-search exception (exactness.ts RANKED_PRIVATE_EXCEPTION): reported, with its count per member, only when every extra Rust row passed the check.
      if (!policyApplies(args)) return c;
      if (complete) return c.outcome === 'diff' ? { ...c, reason: 'extra_rows_cleared' } : c;
    }
    return lagged === null ? c : qualifyMismatch(op, c, lagged, { args: encodedArgs, primary, rust });
  };

  /** One stable rerun (checks.ts `stableRerun`): both engines read again at a generation the barrier proved quiet. */
  const rerunOne = async ({ event, args, c, rustMs, rows }: RerunTask): Promise<void> => {
    const skip = (why: string): void => record(event, c, rustMs, rows, `skipped:${why}`);
    const deadline = now() + RERUN_DEADLINE_MS;
    try {
      const answer = await ask({ kind: 'rerun', sid: event.sid, epoch_id: curEpoch() }, RERUN_DEADLINE_MS) as { digest: string; members?: string; stamp: number; epoch_id: string };
      if (curEpoch() === null || answer.epoch_id !== curEpoch()) return skip('epoch_changed'); // an answer for another epoch is dropped, never restamped
      let call!: Promise<unknown>;
      const out = await follow.exclusive(answer.stamp, () => callRust(event.op, args, event.access, Math.max(1, Math.min(timeoutMs, deadline - now())), (p) => { call = p; }));
      if (out?.timedOut) trackStall(call);
      if (out === null || out.timedOut) return skip(out === null ? 'watermark_moved' : 'timeout');
      const c2 = await judge(event.op, event.args, { digest: answer.digest, members: answer.members, list: Array.isArray(event.result) }, encodeValue(out.value), event.sid, 'rerun', now(), null);
      const orderOnly = c2.outcome === 'order_diff' && (exactnessArm(event.op) === 'membership' || exactnessArm(event.op) === 'private_ranked'); // these reads ignore order: the rows are the primary's
      if (c2.outcome === 'match' || orderOnly) record(event, c, rustMs, rows, 'matched'); // closed as unsuccessful, never a match
      else if (c2.outcome === 'privacy_diverged') record(event, c2, rustMs, rows, 'differed');
      else if (c2.outcome === 'inconclusive') skip(c2.reason ?? 'privacy_check');
      else if (c2.reason === 'extra_rows_cleared') record(event, { outcome: 'diff', reason: 'extra_rows_cleared', mismatch: c.mismatch ?? 'diff' }, rustMs, rows, 'differed');
      else record(event, { outcome: 'diff', reason: 'rerun_differs', mismatch: c.mismatch ?? (c2.outcome as 'diff' | 'order_diff') }, rustMs, rows, 'differed');
    } catch (error) {
      recordRustError('read', error);
      skip(safeCode((error as { code?: unknown })?.code));
    } finally { flush(true); } // a rerun is rare and slow: its row is written the moment it ends
  };
  const reruns = createSerialQueue<RerunTask>(RERUN_QUEUE_BOUND, rerunOne);

  // Vector recall (recall.ts): at most one reference run a minute, asked of the serving process off the request path.
  const recallGate = new IntervalGate(RECALL_INTERVAL_MS, now);
  let recalling: Promise<void> | null = null;
  const scoreRecallLater = (event: ReadEvent, args: unknown[], rust: unknown): void => {
    if (event.op !== 'searchVector' || !curEpoch() || recalling || !recallEligible(args) || !recallGate.take()) return;
    recalling = (async () => {
      try {
        const reference = await ask({ kind: 'vector', sid: event.sid }, RERUN_DEADLINE_MS) as RankedKey[];
        const score = scoreRecall(reference, event.result, rust);
        const epoch = curEpoch(); // a child that is no longer an owner names no epoch: the sample is dropped
        if (score && epoch) appendRecall(shadowDir, { ts: new Date(now()).toISOString(), epoch_id: epoch, ...score });
      } catch { /* an unscored sample is skipped, never counted */ }
      recalling = null;
    })();
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

  const rl = createInterface({ input: deps.input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let event: { t?: string; counters?: MirrorCounters; pid?: number };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.t === 'apply' || event.t === 'watermark' || event.t === 'depth' || event.t === 'rpc') { follow.handle(event as FollowEvent); continue; }
    if (event.t === 'answer') { ask.answer(event as never); continue; }
    if (event.t === 'stats' && event.counters) { summary.primary = { ...newMirrorCounters(), ...event.counters }; summary.primary_pid = event.pid; continue; }
    if (event.t !== 'read' || paused) continue;
    if (pending.length >= SHADOW_CHILD_QUEUE_BOUND) { summary.child_shed++; continue; }
    pending.push(event as ReadEvent);
    void drain();
  }
  // The serving process ended our stdin: nothing it was asked can still be answered. A queued rerun ends as skipped.
  ask.closeAll();
  for (const task of reruns.drop()) record(task.event, task.c, task.rustMs, task.rows, 'skipped:child_closing');
  await drain();
  await reruns.idle();
  await recalling;
  await follow.close();
  clearInterval(heartbeat);
  flush(true);
  if (engine) { try { await engine.disconnect(); } catch { /* exiting anyway */ } }
  return handled;
}
