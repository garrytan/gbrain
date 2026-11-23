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
import { readFileSync } from 'node:fs';
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
import { createAsker, createSerialQueue, privacyVerdict, RERUN_QUEUE_BOUND } from './child-checks.ts';
import { classifyError, classifyResult, type Classification } from './classify.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { capabilitySetHash, currentBuild, ensureEpoch, internalErrorRecorder, type EpochBuild, type EpochManifest } from './evidence-epoch.ts';
import { qualifyMismatch, SHADOW_COMPARATOR_VERSION } from './exactness.ts';
import { FollowChild, type FollowEvent, type FollowStore } from './follow-child.ts';
import { appendFault, appendLedgerRows, writeSummaryFile, type ShadowLedgerRow, type ShadowSummaryFile } from './ledger.ts';
import { newMirrorCounters, type MirrorCounters } from './mirror.ts';
import { appendRecall, IntervalGate, recallEligible, RECALL_INTERVAL_MS, scoreRecall, type RankedKey } from './recall.ts';
import { isShadowReadMember, SHADOW_READ_MEMBERS, type ShadowReadMember } from './reads.ts';
import { readSeedRecord } from './seed.ts';

export const SHADOW_CHILD_CALL_TIMEOUT_MS = 10_000;
export const SHADOW_CHILD_QUEUE_BOUND = 1024;
export const SHADOW_HEARTBEAT_MS = 5_000;

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
  /** The capability names the Rust engine reports; default `servedCapabilities()`. */
  capabilities?: () => Iterable<string>;
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
  // The evidence epoch this child session belongs to. Without a seed or a writable manifest there is no epoch: its rows
  // carry none and count for nothing.
  let epoch: EpochManifest | null = null;
  const seed = readSeedRecord(shadowDir);
  if (seed) {
    try {
      epoch = ensureEpoch(shadowDir, {
        seed_id: seed.seed_id,
        rust_addon_sha256: load.ok ? ((deps.addonSha256 ?? addonFileSha256)(load.addon) ?? 'unreadable') : null,
        comparator_version: SHADOW_COMPARATOR_VERSION,
        adapter_version: `abi${RUST_ENGINE_ABI}.catalog${load.ok ? String(load.addon.catalogVersion) : 'none'}`,
        capability_set_hash: load.ok ? capabilitySetHash((deps.capabilities ?? servedCapabilities)()) : null,
        readiness_policy_hash: (deps.readinessPolicyHash ?? (() => policyHash(READINESS_POLICY)))(),
      }, now(), (deps.build ?? currentBuild)());
    } catch { epoch = null; }
  }
  const epochId = epoch?.epoch_id ?? null;
  const recordRustError = internalErrorRecorder(shadowDir, epochId, now);
  if (!load.ok) {
    unavailable = { outcome: 'addon_unavailable', reason: `${load.code}:${load.reason}` };
  } else {
    try {
      const open = deps.openEngine ?? ((addon, store) => openRustEngine({ addon, databasePath: store }) as unknown as ShadowEngine);
      const storePath = join(shadowDir, 'store');
      engine = open(load.addon, storePath);
      await engine.connect({ database_path: storePath });
    } catch (error) {
      recordRustError('open', error);
      engine = null;
      unavailable = { outcome: 'error', reason: `open_failed:${classifyError(error).reason ?? 'unknown'}` };
    }
  }

  // The follower (apply lines and reconcile calls) works on the same Rust store; it exists once the engine is open.
  const rustEngine = engine as unknown as { storeFor?: (member: string) => Promise<FollowStore>; ownerRole?: string | null } | null;
  const follow = new FollowChild({
    dir: shadowDir, writeControl: deps.writeControl, now,
    store: async () => { try { return (await rustEngine?.storeFor?.('follow')) ?? null; } catch (error) { recordRustError('open', error); return null; } },
    owner: () => rustEngine?.ownerRole !== 'client',
    onRustError: recordRustError,
  });
  const heartbeat = setInterval(() => { follow.tick(); try { deps.writeControl('{"t":"hb"}\n'); } catch { /* parent gone */ } }, deps.heartbeatMs ?? SHADOW_HEARTBEAT_MS);
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
    const counts = summary.by_op[event.op] ?? (summary.by_op[event.op] = {});
    counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
    const row: ShadowLedgerRow = {
      ts, op: event.op, outcome: c.outcome, ...(c.reason ? { reason: c.reason } : {}), ...(c.mismatch ? { mismatch: c.mismatch } : {}),
      ...(epochId ? { epoch_id: epochId } : {}), ...(rerun ? { rerun } : {}),
      primary_ms: Math.round(event.primary_ms * 1000) / 1000,
      rust_ms: rustMs === null ? null : Math.round(rustMs * 1000) / 1000,
      primary_rows: rowCount(event.result), rust_rows: rustRows,
    };
    rows.push(row);
    try { deps.onRow?.(row); } catch { /* a test seam */ }
    handled++;
    if (c.outcome === 'privacy_diverged' && !paused) {
      paused = true;
      try { appendFault(shadowDir, { ts, kind: 'privacy_pause', detail: `op=${event.op} reason=${c.reason ?? 'unknown'}`, ...(epochId ? { epoch_id: epochId } : {}) }); } catch { /* disk */ }
      try { deps.writeControl('{"t":"pause","reason":"privacy_diverged"}\n'); } catch { /* parent gone */ }
    }
    flush(false);
  };

  const ask = createAsker(deps.writeControl);

  /** The Rust read of `op`, under the caller access the primary read ran under. */
  const callRust = (op: string, args: unknown[], access: CallerAccess | undefined, ms: number) => {
    const run = (): unknown => (engine![op] as (...a: unknown[]) => unknown).apply(engine, args);
    return withTimeout(Promise.resolve(access ? withCallerAccess(access, run) : run()), ms);
  };

  /**
   * Classifies one comparison, then asks the serving process about the Rust pages the primary's answer lacked (privacy). A
   * mismatch on an exactness comparison is qualified as stale or inconclusive (`lagged`); a rerun passes null and keeps the raw mismatch.
   */
  const judge = async (op: string, encodedArgs: unknown[], primary: unknown, rust: unknown, access: CallerAccess | undefined, at: number, lagged: boolean | null): Promise<Classification> => {
    const c = classifyResult(SHADOW_READ_MEMBERS[op as ShadowReadMember], encodedArgs, primary, rust);
    if (c.outcome === 'match' || c.outcome === 'privacy_diverged') return c;
    const verdict = await privacyVerdict(ask, decodeValue(encodedArgs) as unknown[], primary, rust, access, at);
    if (verdict === 'violation') return { outcome: 'privacy_diverged', reason: 'row_not_readable_by_caller' };
    if (verdict !== 'clean') return { outcome: 'inconclusive', reason: verdict, mismatch: c.outcome as 'diff' | 'order_diff' };
    return lagged === null ? c : qualifyMismatch(op, c, lagged, { args: encodedArgs, primary, rust });
  };

  /** One stable rerun (checks.ts `stableRerun`): both engines read again at a generation the barrier proved quiet. */
  const rerunOne = async ({ event, args, c, rustMs, rows }: RerunTask): Promise<void> => {
    const skip = (why: string): void => record(event, c, rustMs, rows, `skipped:${why}`);
    const deadline = now() + RERUN_DEADLINE_MS;
    try {
      const answer = await ask({ kind: 'rerun', op: event.op, args: event.args, access: event.access, epoch_id: epochId }, RERUN_DEADLINE_MS) as { result: unknown; stamp: number; epoch_id: string };
      if (answer.epoch_id !== epochId) return skip('epoch_changed'); // an answer for another epoch is dropped, never restamped
      const out = await follow.exclusive(answer.stamp, () => callRust(event.op, args, event.access, Math.max(1, Math.min(timeoutMs, deadline - now()))));
      if (out === null || out.timedOut) return skip(out === null ? 'watermark_moved' : 'timeout');
      const c2 = await judge(event.op, event.args, answer.result, encodeValue(out.value), event.access, now(), null);
      if (c2.outcome === 'match') record(event, c, rustMs, rows, 'matched'); // closed as unsuccessful, never a match
      else if (c2.outcome === 'privacy_diverged') record(event, c2, rustMs, rows, 'differed');
      else if (c2.outcome === 'inconclusive') skip(c2.reason ?? 'privacy_check');
      else record(event, { outcome: 'diff', reason: 'rerun_differs', mismatch: c.mismatch ?? (c2.outcome as 'diff' | 'order_diff') }, rustMs, rows, 'differed');
    } catch (error) {
      recordRustError('read', error);
      skip(String((error as { code?: unknown })?.code ?? 'failed').slice(0, 40));
    } finally { flush(true); } // a rerun is rare and slow: its row is written the moment it ends
  };
  const reruns = createSerialQueue<RerunTask>(RERUN_QUEUE_BOUND, rerunOne);

  // Vector recall (recall.ts): at most one reference run a minute, asked of the serving process off the request path.
  const recallGate = new IntervalGate(RECALL_INTERVAL_MS, now);
  let recalling: Promise<void> | null = null;
  const scoreRecallLater = (event: ReadEvent, args: unknown[], rust: unknown): void => {
    if (event.op !== 'searchVector' || !epochId || recalling || !recallEligible(args) || !recallGate.take()) return;
    recalling = (async () => {
      try {
        const reference = await ask({ kind: 'vector', args: event.args, access: event.access }, RERUN_DEADLINE_MS) as RankedKey[];
        const score = scoreRecall(reference, event.result, rust);
        if (score) appendRecall(shadowDir, { ts: new Date(now()).toISOString(), epoch_id: epochId, ...score });
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
    const args = decodeValue(event.args) as unknown[];
    const started = performance.now();
    // Stale needs evidence: committed work older than this read that the follower had not applied, when the read
    // started or when it was compared.
    const capturedAt = event.at || now();
    let lagged = follow.pendingBefore(capturedAt);
    try {
      const out = await callRust(event.op, args, event.access, timeoutMs);
      const rustMs = performance.now() - started;
      if (out.timedOut) { record(event, { outcome: 'timeout' }, rustMs, null); return; }
      const encoded = encodeValue(out.value);
      lagged ||= follow.pendingBefore(capturedAt);
      const c = await judge(event.op, event.args, event.result, encoded, event.access, capturedAt, lagged);
      scoreRecallLater(event, args, encoded);
      const task: RerunTask = { event, args, c, rustMs, rows: rowCount(encoded) };
      if (c.outcome !== 'inconclusive') record(event, c, rustMs, task.rows);
      else if (!epochId) record(event, c, rustMs, task.rows, 'skipped:no_epoch');
      else if (!reruns.add(task)) record(event, c, rustMs, task.rows, 'skipped:queue_full');
    } catch (error) {
      recordRustError('read', error);
      record(event, classifyError(error), performance.now() - started, null);
    }
  };

  let draining: Promise<void> | null = null;
  const drain = (): Promise<void> => {
    draining ??= (async () => {
      while (pending.length > 0) await handle(pending.shift()!);
      draining = null;
    })();
    return draining;
  };

  const rl = createInterface({ input: deps.input, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let event: { t?: string; counters?: MirrorCounters };
    try { event = JSON.parse(line); } catch { continue; }
    if (event.t === 'apply' || event.t === 'watermark' || event.t === 'depth' || event.t === 'rpc') { follow.handle(event as FollowEvent); continue; }
    if (event.t === 'answer') { ask.answer(event as never); continue; }
    if (event.t === 'stats' && event.counters) { summary.primary = { ...newMirrorCounters(), ...event.counters }; continue; }
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
