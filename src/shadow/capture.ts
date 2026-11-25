/**
 * The shadow capture recorder (docs/guides/shadow-capture.md). Off unless `gbrain engine shadow capture on --yes`.
 *
 * A Proxy over the engine the factory built records every BrainEngine call the process makes: the member, its
 * arguments encoded at call entry (codec.ts, so a later change by the caller cannot alter the record), the
 * credential-free caller-access record active during the call, start and end times, and the outcome (a SHA-256 of
 * the encoded result, or the error code). Results are never stored. Transactions record begin and end with
 * `committed` or `rolled_back`; their calls carry the transaction id. Raw SQL, reserved connections and calls with a
 * function argument are recorded as `gap` (member name only).
 *
 * Each process appends to its own segment file in the current epoch directory, from a bounded in-memory buffer,
 * asynchronously. Nothing waits on capture and a capture fault never changes an answer: a full buffer, an append
 * error, low disk or an epoch over its byte budget drops records and writes a `gap` when it can.
 *
 * Purge: every owner purge appends to the purge log (`purge-events.jsonl`) before it commits. The epoch keeps the
 * log's size and mtime from when it began. Before every flush the recorder compares them; any change, or a log it
 * cannot stat, invalidates the epoch: the pointer flips to `invalidated` first, then the epoch's segments and its base
 * copies are deleted. `appendPurgeIntent` also notifies this module directly (`onPurgeIntent`).
 */
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { onPurgeIntent, purgeMirrorPath } from '../core/belief/purge-mirror.ts';
import { configDir } from '../core/config.ts';
import { registerEngineView, viewedEngine } from '../core/persistence/switches.ts';
import { RUST_ENGINE_MEMBERS } from '../core/rust-engine/members.ts';
import { callerAccessRecord } from '../core/search/private-visibility.ts';
import { CAPTURE_BUDGET_BYTES, CaptureTooLargeError, canonicalJson, encodeArgs, encodeValue } from './codec.ts';
import { captureIsOn, writePrivateJson } from './capture-state.ts';
import { ReplayError } from './replay-errors.ts';

export const CAPTURE_RECORD_VERSION = 1;
export const CAPTURE_LIMITS = {
  recordBytes: 1 << 20,
  bufferBytes: 8 << 20,
  epochBytes: 4 * 1024 ** 3,
  minFreeBytes: 2 * 1024 ** 3,
  minFreeRatio: 0.05,
  flushMs: 50,
};

export type PurgeBaseline = { size: number; mtime_ms: number } | 'absent';

export interface EpochPointer {
  version: 1;
  id: string;
  state: 'recording' | 'sealing' | 'sealed' | 'invalidated';
  started_at: string;
  /** While sealing: calls that started before this belong to this epoch; later ones to the next. */
  sealing_since?: string;
  purge_log: PurgeBaseline;
  reason?: string;
}

export interface CaptureRecord {
  v: 1;
  proc: string;
  seq: number;
  t0: number;
  t1: number;
  kind: 'engine' | 'tx' | 'gap';
  member?: string;
  args?: unknown;
  access?: unknown;
  ok?: boolean;
  h?: string;
  code?: string;
  tx?: string;
  parent_tx?: string;
  phase?: 'begin' | 'committed' | 'rolled_back';
  reason?: string;
  count?: number;
}

export const epochPointerPath = (cap: string) => join(cap, 'epoch.json');
export const epochDir = (cap: string, id: string) => join(cap, `epoch-${id}`);
export const basesDir = (cap: string, id: string) => join(cap, 'bases', id);
/** One file per recording process, written at its first recorded call, before any record exists (see sealEpoch). */
export const recordersDir = (cap: string) => join(cap, 'recorders');

/** True while a process with this id runs on this machine. */
export function processAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function readEpoch(cap: string): EpochPointer | null {
  try {
    const p = JSON.parse(readFileSync(epochPointerPath(cap), 'utf8')) as EpochPointer;
    return p?.version === 1 && typeof p.id === 'string' ? p : null;
  } catch { // silent-read-ok: no readable epoch means no recording: every recorder stops appending and replay has nothing to replay
    return null;
  }
}

/** The purge log's size and mtime, `absent` when it does not exist, null when it cannot be read (fails closed). */
export function purgeBaseline(home = configDir()): PurgeBaseline | null {
  try {
    const st = statSync(purgeMirrorPath(home));
    return { size: st.size, mtime_ms: Math.trunc(st.mtimeMs) };
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : null;
  }
}

export function purgeLogChanged(baseline: PurgeBaseline, home = configDir()): boolean {
  const now = purgeBaseline(home);
  if (now === null) return true;
  if (now === 'absent' || baseline === 'absent') return now !== baseline;
  return now.size !== baseline.size || now.mtime_ms !== baseline.mtime_ms;
}

/** Starts a new recording epoch (the caller seeds its base copies next). */
export function startEpoch(cap: string, home = configDir(), now = new Date()): EpochPointer {
  const baseline = purgeBaseline(home);
  if (baseline === null) throw new ReplayError('shadow_replay_purged', 'the purge log cannot be read, so no epoch starts');
  const id = `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(4).toString('hex')}`;
  mkdirSync(epochDir(cap, id), { recursive: true, mode: 0o700 });
  const pointer: EpochPointer = { version: 1, id, state: 'recording', started_at: now.toISOString(), purge_log: baseline };
  writePrivateJson(epochPointerPath(cap), pointer);
  return pointer;
}

export function setEpochState(cap: string, pointer: EpochPointer, state: EpochPointer['state'], reason?: string): void {
  writePrivateJson(epochPointerPath(cap), { ...pointer, state, ...(reason ? { reason } : {}) });
}

function removeTree(path: string): void {
  for (let i = 0; i < 5 && existsSync(path); i++) {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* a late appender re-created a file: retry */ }
  }
}

/** Every replay run's content-bearing paths: copied segments, work copies, throwaway home, minimizer brains, run file. */
function runCopies(cap: string): string[] {
  const out: string[] = [];
  const runs = join(cap, '..', 'replay');
  if (existsSync(runs)) for (const run of readdirSync(runs)) for (const sub of ['work', 'segments', 'home', 'fresh', 'run.json']) out.push(join(runs, run, sub));
  return out;
}

function removeAll(paths: string[]): string[] {
  const removed = [...new Set(paths)].filter(existsSync);
  for (const path of removed) removeTree(path);
  return removed;
}

/** Retires one epoch after its replay: its recording and base copies and every run's copies. Other epochs stay. */
export function deleteEpochData(cap: string, id: string): string[] {
  return removeAll([epochDir(cap, id), basesDir(cap, id), ...runCopies(cap)]);
}

/**
 * The purge cleanup: deletes every recording and copy the capture directory holds, all epochs and base copies (ones a
 * crashed nightly run left behind too) and every run's copies. Reports (content-free) stay. Safe to repeat.
 */
export function deleteAllCaptureData(cap: string): string[] {
  const gone: string[] = [];
  if (existsSync(cap)) for (const f of readdirSync(cap)) if (f.startsWith('epoch-')) gone.push(join(cap, f));
  const bases = join(cap, 'bases');
  if (existsSync(bases)) for (const f of readdirSync(bases)) gone.push(join(bases, f));
  return removeAll([...gone, ...runCopies(cap), join(cap, 'retry.json')]);
}


/**
 * THE purge owner; every purge entry point calls it (test "purge entry points" checks the source). Whatever the pointer
 * says: flip it to invalidated, then delete every epoch, base copy, run copy and retry record. Safe to repeat.
 */
export function purgeCapture(cap: string): true {
  const pointer = readEpoch(cap);
  if (pointer && !(pointer.state === 'invalidated' && pointer.reason === 'purge')) setEpochState(cap, pointer, 'invalidated', 'purge');
  deleteAllCaptureData(cap);
  return true;
}

/** Runs purgeCapture when the purge log changed (or cannot be read) since the current epoch began. True when it did. */
export function purgeIfLogChanged(cap: string, home?: string): boolean {
  const pointer = readEpoch(cap);
  if (!pointer || pointer.state === 'invalidated' || !purgeLogChanged(pointer.purge_log, home)) return false;
  return purgeCapture(cap);
}

/** Retires one epoch that ends without a purge (never seeded, seed failed): that epoch only. */
export function retireEpoch(cap: string, reason: 'unseeded' | 'seed_failed'): void {
  const pointer = readEpoch(cap);
  if (pointer && pointer.state !== 'invalidated') setEpochState(cap, pointer, 'invalidated', reason);
  if (pointer) deleteEpochData(cap, pointer.id);
}

/**
 * Installs the purge listener for a brain that has a capture directory, whether capture is on, off or killed by the
 * environment. One listener per capture directory for the life of the process, so a reconnect (disconnect then
 * connect on the same engine) never leaves the engine deaf to purges.
 */
const purgeWatched = new Set<string>();
export function watchPurges(cap: string): void {
  if (purgeWatched.has(cap)) return;
  purgeWatched.add(cap);
  onPurgeIntent(() => { try { purgeCapture(cap); } catch { /* fail open */ } });
}

/** Finishes an interrupted cleanup before anything new starts (the nightly run, under its lock). */
export function resumeInvalidatedCleanup(cap: string): void {
  const pointer = readEpoch(cap);
  if (pointer?.state === 'invalidated' && pointer.reason === 'purge') purgeCapture(cap);
  else if (pointer?.state === 'invalidated') deleteEpochData(cap, pointer.id);
}

const SEAL_TICK_MS = 100;

/**
 * Seals the recording epoch (a nightly replay's first step). The handshake: the pointer flips to `sealing` at time T;
 * calls that started before T belong to this epoch, later ones to the next. Every recorder registers before its first
 * record exists, so every recorder that can hold a record of this epoch is in the registry when the sealer reads it.
 * Each live recorder drains its records of this epoch and acknowledges; the sealer waits for them (dead ones flushed
 * at exit), then marks the epoch sealed and starts the next one at T. `unacked`: live recorders that did not
 * acknowledge in time, whose last calls may be missing, so a replay of this epoch cannot claim complete coverage.
 */
export async function sealEpoch(cap: string, opts: { home?: string; timeoutMs?: number; now?: () => Date } = {}):
  Promise<{ sealed: EpochPointer; next: EpochPointer; unacked: number } | null> {
  const pointer = readEpoch(cap);
  if (!pointer || pointer.state !== 'recording') return null;
  const t = opts.now?.() ?? new Date();
  const sealing: EpochPointer = { ...pointer, state: 'sealing', sealing_since: t.toISOString() };
  writePrivateJson(epochPointerPath(cap), sealing);
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  let pending: string[] = [];
  for (;;) {
    if (readEpoch(cap)?.state !== 'sealing') return null; // a purge invalidated it meanwhile
    pending = [];
    const reg = recordersDir(cap);
    for (const f of existsSync(reg) ? readdirSync(reg).filter(f => f.endsWith('.json')) : []) {
      const proc = f.slice(0, -5);
      let pid: number | undefined;
      try { pid = (JSON.parse(readFileSync(join(reg, f), 'utf8')) as { pid?: number }).pid; } catch { pid = undefined; } // silent-read-ok: an unreadable registration counts as live until it acknowledges
      if (pid !== undefined && !processAlive(pid)) { rmSync(join(reg, f), { force: true }); continue; }
      if (!existsSync(join(epochDir(cap, pointer.id), `ack-${proc}`))) pending.push(proc);
    }
    if (!pending.length || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, SEAL_TICK_MS / 2));
  }
  const sealed: EpochPointer = { ...sealing, state: 'sealed' };
  writePrivateJson(epochPointerPath(cap), sealed);
  return { sealed, next: startEpoch(cap, opts.home, t), unacked: pending.length };
}

/** Reads one segment file; a torn last line is skipped and reported. */
export function readSegment(path: string): { records: CaptureRecord[]; torn: boolean } {
  const lines = readFileSync(path, 'utf8').split('\n');
  const records: CaptureRecord[] = [];
  let torn = false;
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try { records.push(JSON.parse(line) as CaptureRecord); } catch { if (i >= lines.length - 2) torn = true; else throw new Error(`corrupt record in ${path}`); }
  });
  return { records, torn };
}

/** One process's segment writer. */
export class CaptureWriter {
  readonly proc = `${process.pid}-${randomBytes(3).toString('hex')}`;
  private seq = 0;
  private buffer: Array<{ t0: number; line: string }> = [];
  private bytes = 0;
  private dropped = 0;
  private dropReason = '';
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private registered = false;
  /** Start times of calls still running; a seal is acknowledged only when none started before it. */
  private readonly inFlight = new Map<number, number>();
  private freeCheckedAt = 0;
  private lowDisk = false;

  constructor(readonly cap: string, readonly home = configDir(), readonly env: Record<string, string | undefined> = process.env) {}

  nextSeq(): number { return ++this.seq; }

  push(rec: Omit<CaptureRecord, 'v' | 'proc' | 'seq'>): void {
    let line: string;
    try { line = JSON.stringify({ v: 1, proc: this.proc, seq: this.nextSeq(), ...rec }); } catch { return this.drop('encode'); }
    if (line.length > CAPTURE_LIMITS.recordBytes) {
      line = JSON.stringify({ v: 1, proc: this.proc, seq: this.seq, t0: rec.t0, t1: rec.t1, kind: 'gap', member: rec.member, reason: 'too_large', tx: rec.tx });
    }
    if (this.bytes + line.length > CAPTURE_LIMITS.bufferBytes) return this.drop('buffer_full');
    this.buffer.push({ t0: rec.t0, line });
    this.bytes += line.length + 1;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, CAPTURE_LIMITS.flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /**
   * Registers this process as a recorder, once, at the start of its first recorded call (before the call's record
   * exists, so a seal that started later sees it), and starts the seal watcher that drains and acknowledges a seal.
   */
  markActive(): void {
    if (this.registered) return;
    this.registered = true;
    try { writePrivateJson(join(recordersDir(this.cap), `${this.proc}.json`), { pid: process.pid, since: new Date().toISOString() }); } catch { /* best effort */ }
    // Lives as long as the process (unref'd): a reconnect or an idle resident process still drains and acknowledges.
    const timer = setInterval(() => { try { this.drainForSeal(); } catch { /* a capture fault never reaches the brain process */ } }, SEAL_TICK_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  /**
   * The recorder's half of the seal handshake: when the epoch is sealing, write every buffered record of a call that
   * started before the seal into it (later calls stay buffered for the next epoch), then acknowledge.
   */
  drainForSeal(): void {
    const epoch = readEpoch(this.cap);
    if (!epoch || epoch.state !== 'sealing' || !epoch.sealing_since) return;
    const ack = join(epochDir(this.cap, epoch.id), `ack-${this.proc}`);
    const until = Date.parse(epoch.sealing_since);
    if (existsSync(ack) || [...this.inFlight.keys()].some(t0 => t0 < until)) return; // a call of this epoch still runs
    const data = this.take(epoch, until);
    if (data) appendFileSync(join(epochDir(this.cap, epoch.id), `${this.proc}.jsonl`), data, { mode: 0o600 });
    writeFileSync(ack, '', { mode: 0o600 });
  }


  /** Marks a call running from `t0`; the returned function marks it done. */
  enter(t0: number): () => void {
    this.inFlight.set(t0, (this.inFlight.get(t0) ?? 0) + 1);
    return () => { const n = (this.inFlight.get(t0) ?? 1) - 1; if (n > 0) this.inFlight.set(t0, n); else this.inFlight.delete(t0); };
  }

  private drop(reason: string): void { this.dropped++; this.dropReason = reason; }

  /**
   * Discards the buffer when nothing may be written. Off, a purge or no epoch need no record (nothing is being
   * replayed); a budget stop (low disk, epoch over budget) keeps the count, so the next write that lands is a gap and
   * the replay says its coverage is incomplete.
   */
  private discard(stop: string): void {
    if (stop === 'sealing') return; // later calls stay buffered for the next epoch
    const lost = this.buffer.length;
    this.buffer = [];
    this.bytes = 0;
    if (stop === 'budget' || stop === 'error') { this.dropped += lost; this.dropReason = stop; } else this.dropped = 0;
  }

  /** The segment path to append to now, or null (and the reason) when nothing may be written. */
  private target(): { path: string; epoch: EpochPointer } | { stop: string } {
    if (!captureIsOn(this.cap, this.env)) return { stop: 'off' };
    if (purgeIfLogChanged(this.cap, this.home)) return { stop: 'purged' };
    const epoch = readEpoch(this.cap);
    if (epoch?.state === 'sealing') { this.drainForSeal(); return { stop: 'sealing' }; }
    if (!epoch || epoch.state !== 'recording') return { stop: 'no_epoch' };
    const dir = epochDir(this.cap, epoch.id);
    if (!existsSync(dir)) return { stop: 'no_epoch' };
    const now = Date.now();
    if (now - this.freeCheckedAt > 5000) {
      this.freeCheckedAt = now;
      try {
        const fs = statfsSync(dir);
        const free = Number(fs.bavail) * Number(fs.bsize);
        let used = 0;
        for (const f of readdirSync(dir)) used += statSync(join(dir, f)).size;
        this.lowDisk = free < CAPTURE_LIMITS.minFreeBytes || free < CAPTURE_LIMITS.minFreeRatio * Number(fs.blocks) * Number(fs.bsize)
          || used > CAPTURE_LIMITS.epochBytes;
      } catch { this.lowDisk = true; }
    }
    if (this.lowDisk) return { stop: 'budget' };
    return { path: join(dir, `${this.proc}.jsonl`), epoch };
  }

  /**
   * The buffered lines for `epoch`: a record whose call started before the epoch began belongs to an earlier one (which
   * a purge may have invalidated since) and is dropped, never written into the new recording. With `until` (a seal's
   * drain), records of calls that started at or after it stay buffered for the next epoch.
   */
  private take(epoch: EpochPointer, until = Infinity): string {
    const since = Date.parse(epoch.started_at);
    const lines: string[] = [];
    const keep: Array<{ t0: number; line: string }> = [];
    for (const b of this.buffer) { if (b.t0 >= until) keep.push(b); else if (b.t0 >= since) lines.push(b.line); else this.drop('earlier_epoch'); }
    this.buffer = keep;
    this.bytes = keep.reduce((n, b) => n + b.line.length + 1, 0);
    if (this.dropped) {
      lines.push(JSON.stringify({ v: 1, proc: this.proc, seq: this.nextSeq(), t0: Date.now(), t1: Date.now(), kind: 'gap', reason: this.dropReason, count: this.dropped }));
      this.dropped = 0;
    }
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.flush());
    const run = async () => {
      if (!this.buffer.length && !this.dropped) return;
      let t: ReturnType<CaptureWriter['target']>;
      try { t = this.target(); } catch { t = { stop: 'error' }; } // a capture fault never reaches the brain process
      if ('stop' in t) { this.discard(t.stop); return; }
      const data = this.take(t.epoch);
      try { await appendFile(t.path, data, { mode: 0o600 }); } catch { this.drop('append_error'); }
    };
    this.flushing = run().catch(() => { this.drop('flush_error'); }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Synchronous flush for process exit. */
  flushSync(): void {
    if (!this.buffer.length && !this.dropped) return;
    let t: ReturnType<CaptureWriter['target']>;
    try { t = this.target(); } catch { t = { stop: 'error' }; } // exit hook: a capture fault never fails shutdown
    if ('stop' in t) { this.discard(t.stop); return; }
    try { appendFileSync(t.path, this.take(t.epoch), { mode: 0o600 }); } catch { /* exit: nothing left to do */ }
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const LIFECYCLE = new Set(['connect', 'disconnect', 'registerBeforeDisconnect', 'initSchema', 'constructor']);
const GAP_MEMBERS = new Set(['executeRaw', 'executeRawDirect', 'executeRawJsonb', 'withReservedConnection', 'reserve']);
const TX_MEMBERS = new Set(['transaction', 'transactionDirect']);

function hasFunctionArg(args: unknown[]): boolean {
  return args.some(a => typeof a === 'function'
    || (!!a && typeof a === 'object' && !Array.isArray(a) && !ArrayBuffer.isView(a)
      && Object.entries(a).some(([k, v]) => k !== 'signal' && typeof v === 'function')));
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === 'function';
}

/** The result's hash, bounded: a result over the capture budget is not copied or serialized past the budget. */
function outcomeOf(result: unknown): { ok: true; h: string } {
  try { return { ok: true, h: sha256(canonicalJson(encodeValue(result, undefined, { left: CAPTURE_BUDGET_BYTES }))) }; }
  catch (e) { return { ok: true, h: e instanceof CaptureTooLargeError ? 'too_large' : 'unencodable' }; } // silent-read-ok: a result that cannot be hashed is recorded as such; the call's own answer is untouched
}

function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' ? code : (e as Error)?.name ?? 'error';
}

/** Wraps `engine` so every call is recorded through `writer`. */
export function wrapCaptureEngine<E extends BrainEngine>(engine: E, writer: CaptureWriter, tx?: string): E {
  let txSeq = 0;
  const cache = new Map<PropertyKey, { original: Function; wrapped: Function }>();

  const record = (member: string, fn: Function): Function => function captured(...args: unknown[]) {
    writer.markActive(); // registered before this call's record exists, so a seal that starts later waits for it
    const t0 = Date.now();
    if (GAP_MEMBERS.has(member) || hasFunctionArg(args)) {
      writer.push({ t0, t1: t0, kind: 'gap', member, reason: GAP_MEMBERS.has(member) ? 'raw' : 'function_arg', tx });
      return fn.apply(engine, args);
    }
    let encoded: unknown;
    let access: unknown;
    try {
      encoded = encodeArgs(args, { left: CAPTURE_BUDGET_BYTES });
      const a = callerAccessRecord();
      access = a ? encodeValue(a) : undefined;
    } catch (err) {
      writer.push({ t0, t1: t0, kind: 'gap', member, reason: err instanceof CaptureTooLargeError ? 'too_large' : 'encode', tx });
      return fn.apply(engine, args);
    }
    const leave = writer.enter(t0);
    const done = (o: { ok: boolean; h?: string; code?: string }) => {
      leave();
      try { writer.push({ t0, t1: Date.now(), kind: 'engine', member, args: encoded, ...(access ? { access } : {}), ...o, ...(tx ? { tx } : {}) }); } catch { /* never fails a call */ }
    };
    let out: unknown;
    try { out = fn.apply(engine, args); } catch (e) { done({ ok: false, code: errorCode(e) }); throw e; }
    if (!isThenable(out)) { done(outcomeOf(out)); return out; }
    return out.then(r => { done(outcomeOf(r)); return r; }, e => { done({ ok: false, code: errorCode(e) }); throw e; });
  };

  const transaction = (member: string, fn: Function): Function => function capturedTx(cb: unknown, ...rest: unknown[]) {
    if (typeof cb !== 'function') return fn.apply(engine, [cb, ...rest]);
    const id = `${writer.proc}:${tx ? `${tx}.` : ''}${++txSeq}`;
    writer.markActive();
    const t0 = Date.now();
    const leave = writer.enter(t0);
    writer.push({ t0, t1: t0, kind: 'tx', phase: 'begin', member, tx: id, ...(tx ? { parent_tx: tx } : {}) });
    const end = (phase: 'committed' | 'rolled_back') => { leave(); writer.push({ t0, t1: Date.now(), kind: 'tx', phase, member, tx: id, ...(tx ? { parent_tx: tx } : {}) }); };
    let out: unknown;
    try { out = fn.apply(engine, [(inner: BrainEngine) => (cb as (e: BrainEngine) => unknown)(inner && typeof inner === 'object' ? wrapCaptureEngine(inner, writer, id) : inner), ...rest]); } catch (e) { leave(); throw e; }
    if (!isThenable(out)) { leave(); return out; }
    return out.then(r => { end('committed'); return r; }, e => { end('rolled_back'); throw e; });
  };

  const proxy = new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      const hit = cache.get(prop);
      if (hit && hit.original === value) return hit.wrapped;
      // Only BrainEngine members are recorded. Any other function-valued property (the callable `sql` handle with its
      // own .unsafe/.reserve/.options, a helper) goes back untouched, so the engine keeps working as it did.
      if (!(prop in RUST_ENGINE_MEMBERS) && !TX_MEMBERS.has(prop)) return value;
      const wrapped = LIFECYCLE.has(prop) || prop.startsWith('_') ? value.bind(target)
        : TX_MEMBERS.has(prop) ? transaction(prop, value) : record(prop, value);
      cache.set(prop, { original: value, wrapped });
      return wrapped;
    },
  });
  return registerEngineView(proxy, viewedEngine(engine));
}

/** The engine factory's entry point: the recording engine, with its exit flush (the factory installs `watchPurges`). */
export function attachCapture<E extends BrainEngine>(engine: E, cap: string): E {
  const writer = new CaptureWriter(cap);
  const onExit = () => writer.flushSync();
  process.once('exit', onExit);
  engine.registerBeforeDisconnect(async () => {
    try { await writer.flush(); } finally { process.removeListener('exit', onExit); }
  });
  return wrapCaptureEngine(engine, writer);
}
