/**
 * The shadow replay recorder (docs/guides/shadow-replay.md). Off unless `gbrain engine shadow capture on --yes`.
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
  state: 'recording' | 'sealed' | 'invalidated';
  started_at: string;
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
 * Invalidates the current epoch when the purge log changed since it began (or `force`): the pointer flips first, so
 * every recorder stops appending to it, then the data is deleted. Returns true when it invalidated.
 */
export function invalidateIfPurged(cap: string, opts: { home?: string; force?: string } = {}): boolean {
  const pointer = readEpoch(cap);
  if (!pointer || pointer.state === 'invalidated') return false;
  if (!opts.force && !purgeLogChanged(pointer.purge_log, opts.home)) return false;
  const reason = opts.force ?? 'purge';
  setEpochState(cap, pointer, 'invalidated', reason);
  // A purge deletes everything; a seed failure or an unseeded epoch only that epoch (a retained failed replay stays).
  if (reason === 'purge') deleteAllCaptureData(cap); else deleteEpochData(cap, pointer.id);
  scheduleScratchDrop(cap);
  return true;
}

// ---- the scratch Postgres copy --------------------------------------------------------------------------------
// The seed records where the scratch Postgres copy lives (`scratch-postgres.json`, 0600). Every invalidation writes
// `scratch-drop-pending` and drops the copy's schema at once; the marker goes away only after the drop succeeded, and
// every later replay, status and seed refuses to go on while it is there.

export const scratchRecordPath = (cap: string) => join(cap, 'scratch-postgres.json');
export const scratchPendingPath = (cap: string) => join(cap, 'scratch-drop-pending');
type ScratchSql = { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>; disconnect(): Promise<void> };
type ScratchOpener = (url: string) => Promise<ScratchSql>;
/**
 * The scratch connection for a drop: one plain driver connection to the recorded URL, never an engine, so neither the
 * module connection a Postgres brain holds nor a GBRAIN_DIRECT_DATABASE_URL route can be reached through it.
 */
const openScratch: ScratchOpener = async url => {
  const { default: postgres } = await import('#postgres');
  const sql = postgres(url, { max: 1, onnotice: () => {}, connect_timeout: 10 });
  return {
    async executeRaw<T>(q: string, params: unknown[] = []) { return (await sql.unsafe(q, params as never[])) as unknown as T[]; },
    async disconnect() { await sql.end({ timeout: 5 }); },
  };
};
let scratchOpener: ScratchOpener = openScratch;
/** Test seam: the opener the drop uses. Null restores the real one. */
export function __setScratchOpenerForTests(o: ScratchOpener | null): void { scratchOpener = o ?? openScratch; }
const scratchDrops = new Map<string, Promise<boolean>>();

/** The recorded scratch copy (URL, owning brain, whether the seed verified it), or null. */
export function readScratchRecord(cap: string): { url: string; brain: string; verified?: boolean } | null {
  try { return JSON.parse(readFileSync(scratchRecordPath(cap), 'utf8')); } catch { return null; } // silent-read-ok: no record means no scratch copy to bind or drop
}

/** Drops the scratch Postgres copy's schema now when one is recorded or a drop is pending. True when nothing is left. */
export async function dropScratchPostgres(cap: string): Promise<boolean> {
  const recordPath = scratchRecordPath(cap);
  if (!existsSync(recordPath)) { rmSync(scratchPendingPath(cap), { force: true }); return true; }
  let rec: { url: string; brain: string; verified?: boolean };
  try { rec = JSON.parse(readFileSync(recordPath, 'utf8')); } catch { return false; } // silent-read-ok: not silent; false keeps the drop pending and every replay, status and seed refuses
  let e: ScratchSql | null = null;
  try {
    e = await scratchOpener(rec.url);
    const [marker] = await e.executeRaw<{ present: boolean }>("SELECT to_regclass('public.gbrain_shadow_replay_owner') IS NOT NULL AS present");
    // Drop only a database whose owner marker names this brain right now (the seed writes the marker before any other
    // table). Anything else, a database recreated or reused since, is never touched; its record is just forgotten.
    const owned = marker?.present === true
      && (await e.executeRaw<{ brain: string }>('SELECT brain FROM gbrain_shadow_replay_owner LIMIT 1'))[0]?.brain === rec.brain;
    // Objects in another schema could depend on public (a public.vector column): leave the drop pending, never cascade.
    if (owned) {
      const { objectsOutsidePublic } = await import('./replay-copy.ts');
      if (await objectsOutsidePublic(e) > 0) return false;
    }
    if (!owned) {
      rmSync(recordPath, { force: true });
      rmSync(scratchPendingPath(cap), { force: true });
      return true;
    }
    await e.executeRaw('DROP SCHEMA IF EXISTS public CASCADE');
    await e.executeRaw('CREATE SCHEMA public');
    rmSync(recordPath, { force: true });
    rmSync(scratchPendingPath(cap), { force: true });
    return true;
    // capability-refusal-ok: the scratch copy is always a local Postgres database, never a Rust engine
  } catch { // silent-read-ok: not silent; false keeps the drop pending and every replay, status and seed refuses
    return false;
  } finally {
    await e?.disconnect().catch(() => undefined);
  }
}

/** Marks the scratch copy for dropping and starts the drop; a second call while one runs joins it. */
export function scheduleScratchDrop(cap: string): Promise<boolean> {
  if (!existsSync(scratchRecordPath(cap))) return Promise.resolve(true);
  try { writeFileSync(scratchPendingPath(cap), `${new Date().toISOString()}\n`, { mode: 0o600 }); } catch { /* the record stays; the next run drops it */ }
  let p = scratchDrops.get(cap);
  if (!p) {
    p = dropScratchPostgres(cap).finally(() => scratchDrops.delete(cap));
    scratchDrops.set(cap, p);
  }
  return p;
}

/** Waits for a drop this process started; then, when a drop is still pending, tries it once more. */
export async function scratchCleared(cap: string): Promise<boolean> {
  await scratchDrops.get(cap);
  return existsSync(scratchPendingPath(cap)) ? scheduleScratchDrop(cap) : true;
}

/**
 * Installs the purge listener on an engine of a brain that has a capture directory, whether capture is on, off or
 * killed by the environment: a purge always deletes the epoch and drops the scratch copy. The engine's disconnect
 * waits for a drop it started.
 */
export function watchPurges(engine: BrainEngine, cap: string): void {
  const stop = onPurgeIntent(() => { try { if (!invalidateIfPurged(cap, { force: 'purge' })) scheduleScratchDrop(cap); } catch { /* fail open */ } });
  engine.registerBeforeDisconnect(async () => { stop(); await scratchDrops.get(cap); });
}

/**
 * Finishes the cleanup of an invalidated epoch (a crash or a failed removal can interrupt it): deletes every recording
 * and copy again and drops the scratch copy. Only the nightly run (under its lock) and the capture commands call it,
 * never a recorder, so it cannot race a new epoch's seed. True when nothing is left to clean.
 */
export async function resumeInvalidatedCleanup(cap: string): Promise<boolean> {
  const pointer = readEpoch(cap);
  if (pointer?.state !== 'invalidated') return scratchCleared(cap);
  if (pointer.reason === 'purge') deleteAllCaptureData(cap); else deleteEpochData(cap, pointer.id);
  scheduleScratchDrop(cap);
  return scratchCleared(cap);
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
  private heartbeatFor = '';
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

  private drop(reason: string): void { this.dropped++; this.dropReason = reason; }

  /**
   * Discards the buffer when nothing may be written. Off, a purge or no epoch need no record (nothing is being
   * replayed); a budget stop (low disk, epoch over budget) keeps the count, so the next write that lands is a gap and
   * the replay says its coverage is incomplete.
   */
  private discard(stop: string): void {
    const lost = this.buffer.length;
    this.buffer = [];
    this.bytes = 0;
    if (stop === 'budget') { this.dropped += lost; this.dropReason = 'budget'; } else this.dropped = 0;
  }

  /** The segment path to append to now, or null (and the reason) when nothing may be written. */
  private target(): { path: string; epoch: EpochPointer } | { stop: string } {
    if (!captureIsOn(this.cap, this.env)) return { stop: 'off' };
    if (invalidateIfPurged(this.cap, { home: this.home })) return { stop: 'purged' };
    const epoch = readEpoch(this.cap);
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
    if (this.heartbeatFor !== epoch.id) {
      this.heartbeatFor = epoch.id;
      try { writePrivateJson(join(dir, `proc-${this.proc}.json`), { pid: process.pid, epoch: epoch.id, since: new Date().toISOString() }); } catch { /* best effort */ }
    }
    return { path: join(dir, `${this.proc}.jsonl`), epoch };
  }

  /**
   * The buffered lines for `epoch`: a record whose call started before the epoch began belongs to an earlier one (which
   * a purge may have invalidated since) and is dropped, never written into the new recording.
   */
  private take(epoch: EpochPointer): string {
    const since = Date.parse(epoch.started_at);
    const lines: string[] = [];
    for (const b of this.buffer) { if (b.t0 >= since) lines.push(b.line); else this.drop('earlier_epoch'); }
    this.buffer = [];
    this.bytes = 0;
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
      const t = this.target();
      if ('stop' in t) { this.discard(t.stop); return; }
      const data = this.take(t.epoch);
      try { await appendFile(t.path, data, { mode: 0o600 }); } catch { this.drop('append_error'); }
    };
    this.flushing = run().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Synchronous flush for process exit. */
  flushSync(): void {
    if (!this.buffer.length && !this.dropped) return;
    const t = this.target();
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
    const done = (o: { ok: boolean; h?: string; code?: string }) => {
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
    const t0 = Date.now();
    writer.push({ t0, t1: t0, kind: 'tx', phase: 'begin', member, tx: id, ...(tx ? { parent_tx: tx } : {}) });
    const end = (phase: 'committed' | 'rolled_back') => writer.push({ t0, t1: Date.now(), kind: 'tx', phase, member, tx: id, ...(tx ? { parent_tx: tx } : {}) });
    const out = fn.apply(engine, [(inner: BrainEngine) => (cb as (e: BrainEngine) => unknown)(inner && typeof inner === 'object' ? wrapCaptureEngine(inner, writer, id) : inner), ...rest]);
    return isThenable(out) ? out.then(r => { end('committed'); return r; }, e => { end('rolled_back'); throw e; }) : out;
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
