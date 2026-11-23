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
import { existsSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { openRustEngine, type RustEngineAddonHandle } from '../core/rust-engine.ts';
import { loadRustEngineAddonOffline, type RustEngineAddonLoaderFn } from './addon.ts';
import { classifyError, classifyResult, type Classification } from './classify.ts';
import { decodeValue, encodeValue } from './codec.ts';
import { appendFault, appendLedgerRows, writeSummaryFile, type ShadowLedgerRow, type ShadowSummaryFile } from './ledger.ts';
import { newMirrorCounters, type MirrorCounters } from './mirror.ts';
import { isShadowReadMember, SHADOW_READ_MEMBERS } from './reads.ts';
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
}

interface ReadEvent {
  t: 'read';
  op: string;
  at: number;
  primary_ms: number;
  args: unknown[];
  result: unknown;
}

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
      engine = null;
      unavailable = { outcome: 'error', reason: `open_failed:${classifyError(error).reason ?? 'unknown'}` };
    }
  }

  const stalled = new Set<Promise<unknown>>();
  const heartbeat = setInterval(() => {
    if (stalled.size >= SHADOW_CHILD_STALL_LIMIT) return; // wedged in native work: go quiet so the watchdog restarts this child
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

  const record = (event: ReadEvent, c: Classification, rustMs: number | null, rustRows: number | null): void => {
    const ts = new Date(event.at || now()).toISOString();
    summary.first_event_at ??= ts;
    summary.last_event_at = ts;
    const counts = summary.by_op[event.op] ?? (summary.by_op[event.op] = {});
    counts[c.outcome] = (counts[c.outcome] ?? 0) + 1;
    rows.push({
      ts, op: event.op, outcome: c.outcome, ...(c.reason ? { reason: c.reason } : {}),
      primary_ms: Math.round(event.primary_ms * 1000) / 1000,
      rust_ms: rustMs === null ? null : Math.round(rustMs * 1000) / 1000,
      primary_rows: rowCount(event.result), rust_rows: rustRows,
    });
    handled++;
    if (c.outcome === 'privacy_diverged' && !paused) {
      paused = true;
      try { appendFault(shadowDir, { ts, kind: 'privacy_pause', detail: `op=${event.op} reason=${c.reason ?? 'unknown'}` }); } catch { /* disk */ }
      try { deps.writeControl('{"t":"pause","reason":"privacy_diverged"}\n'); } catch { /* parent gone */ }
    }
    flush(false);
  };

  const handle = async (event: ReadEvent): Promise<void> => {
    // After a privacy divergence nothing more is compared, queued events included.
    if (paused || !isShadowReadMember(event.op)) return;
    if (unavailable || !engine) { record(event, unavailable ?? { outcome: 'error', reason: 'no_engine' }, null, null); return; }
    const fn = engine[event.op];
    if (typeof fn !== 'function') { record(event, { outcome: 'capability_missing', reason: 'not_a_member' }, null, null); return; }
    if (stalled.size >= SHADOW_CHILD_STALL_LIMIT) { record(event, { outcome: 'timeout', reason: 'stalled' }, null, null); return; }
    const started = performance.now();
    try {
      const args = decodeValue(event.args) as unknown[]; // inside the try: one malformed event is recorded, never a wedged loop
      const call = Promise.resolve((fn as (...a: unknown[]) => unknown).apply(engine, args));
      const out = await withTimeout(call, timeoutMs);
      const rustMs = performance.now() - started;
      if (out.timedOut) {
        stalled.add(call);
        const settled = (): void => { stalled.delete(call); };
        call.then(settled, settled); // a call that never returns keeps its slot: that is what bounds the pile
        record(event, { outcome: 'timeout' }, rustMs, null);
        return;
      }
      const encoded = encodeValue(out.value);
      record(event, classifyResult(SHADOW_READ_MEMBERS[event.op], event.args, event.result, encoded, event.op), rustMs, rowCount(encoded));
    } catch (error) {
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
    if (event.t === 'stats' && event.counters) { summary.primary = { ...newMirrorCounters(), ...event.counters }; summary.primary_pid = event.pid; continue; }
    if (event.t !== 'read' || paused) continue;
    if (pending.length >= SHADOW_CHILD_QUEUE_BOUND) { summary.child_shed++; continue; }
    pending.push(event as ReadEvent);
    void drain();
  }
  await drain();
  clearInterval(heartbeat);
  flush(true);
  if (engine) { try { await engine.disconnect(); } catch { /* exiting anyway */ } }
  return handled;
}
