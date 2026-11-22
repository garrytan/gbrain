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
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statfsSync, statSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { onPurgeIntent, purgeMirrorPath } from '../core/belief/purge-mirror.ts';
import { configDir } from '../core/config.ts';
import { registerEngineView, viewedEngine } from '../core/persistence/switches.ts';
import { callerAccessRecord } from '../core/search/private-visibility.ts';
import { canonicalJson, encodeValue } from './codec.ts';
import { currentOperationId, setOpRecorder } from './op-hook.ts';
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
  kind: 'engine' | 'tx' | 'gap' | 'op';
  member?: string;
  args?: unknown;
  access?: unknown;
  ok?: boolean;
  h?: string;
  code?: string;
  tx?: string;
  parent_tx?: string;
  phase?: 'begin' | 'committed' | 'rolled_back' | 'end';
  /** An operation record's id; an engine record's `parent` names the operation it ran under. */
  id?: string;
  parent?: string;
  call?: unknown;
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
  } catch {
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

/** Deletes an epoch's segments and base copies, and every replay work copy. Returns what it deleted. */
export function deleteEpochData(cap: string, id: string): string[] {
  const gone = [epochDir(cap, id), basesDir(cap, id)].filter(existsSync);
  for (const path of gone) removeTree(path);
  const runs = join(cap, '..', 'replay');
  if (existsSync(runs)) {
    for (const run of readdirSync(runs)) {
      const work = join(runs, run, 'work');
      if (existsSync(work)) { removeTree(work); gone.push(work); }
    }
  }
  return gone;
}

/**
 * Invalidates the current epoch when the purge log changed since it began (or `force`): the pointer flips first, so
 * every recorder stops appending to it, then the data is deleted. Returns true when it invalidated.
 */
export function invalidateIfPurged(cap: string, opts: { home?: string; force?: string } = {}): boolean {
  const pointer = readEpoch(cap);
  if (!pointer || pointer.state === 'invalidated') return false;
  if (!opts.force && !purgeLogChanged(pointer.purge_log, opts.home)) return false;
  setEpochState(cap, pointer, 'invalidated', opts.force ?? 'purge');
  deleteEpochData(cap, pointer.id);
  return true;
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
  private buffer: string[] = [];
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
    this.buffer.push(line);
    this.bytes += line.length + 1;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, CAPTURE_LIMITS.flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  private drop(reason: string): void { this.dropped++; this.dropReason = reason; }

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

  private take(): string {
    const lines = this.buffer;
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
      if ('stop' in t) { this.buffer = []; this.bytes = 0; this.dropped = 0; return; }
      const data = this.take();
      try { await appendFile(t.path, data, { mode: 0o600 }); } catch { this.drop('append_error'); }
    };
    this.flushing = run().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /** Synchronous flush for process exit. */
  flushSync(): void {
    if (!this.buffer.length && !this.dropped) return;
    const t = this.target();
    if ('stop' in t) { this.buffer = []; return; }
    try { appendFileSync(t.path, this.take(), { mode: 0o600 }); } catch { /* exit: nothing left to do */ }
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const LIFECYCLE = new Set(['connect', 'disconnect', 'registerBeforeDisconnect', 'initSchema', 'constructor']);
const GAP_MEMBERS = new Set(['executeRaw', 'executeRawJsonb', 'withReservedConnection', 'reserve']);
const TX_MEMBERS = new Set(['transaction', 'transactionDirect']);

function hasFunctionArg(args: unknown[]): boolean {
  return args.some(a => typeof a === 'function'
    || (!!a && typeof a === 'object' && !Array.isArray(a) && !ArrayBuffer.isView(a)
      && Object.entries(a).some(([k, v]) => k !== 'signal' && typeof v === 'function')));
}

function isThenable(v: unknown): v is Promise<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === 'function';
}

function outcomeOf(result: unknown): { ok: true; h: string } {
  try { return { ok: true, h: sha256(canonicalJson(encodeValue(result))) }; } catch { return { ok: true, h: 'unencodable' }; }
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
      const op = currentOperationId();
      writer.push({ t0, t1: t0, kind: 'gap', member, reason: GAP_MEMBERS.has(member) ? 'raw' : 'function_arg', tx, ...(op ? { parent: op } : {}) });
      return fn.apply(engine, args);
    }
    let encoded: unknown;
    let access: unknown;
    const parent = currentOperationId();
    try {
      encoded = encodeValue(args);
      const a = callerAccessRecord();
      access = a ? encodeValue(a) : undefined;
    } catch {
      writer.push({ t0, t1: t0, kind: 'gap', member, reason: 'encode', tx });
      return fn.apply(engine, args);
    }
    const done = (o: { ok: boolean; h?: string; code?: string }) => {
      try { writer.push({ t0, t1: Date.now(), kind: 'engine', member, args: encoded, ...(access ? { access } : {}), ...o, ...(tx ? { tx } : {}), ...(parent ? { parent } : {}) }); } catch { /* never fails a call */ }
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
    const rel = { ...(tx ? { parent_tx: tx } : {}), ...(currentOperationId() ? { parent: currentOperationId() } : {}) };
    writer.push({ t0, t1: t0, kind: 'tx', phase: 'begin', member, tx: id, ...rel });
    const end = (phase: 'committed' | 'rolled_back') => writer.push({ t0, t1: Date.now(), kind: 'tx', phase, member, tx: id, ...rel });
    const out = fn.apply(engine, [(inner: BrainEngine) => (cb as (e: BrainEngine) => unknown)(inner && typeof inner === 'object' ? wrapCaptureEngine(inner, writer, id) : inner), ...rest]);
    return isThenable(out) ? out.then(r => { end('committed'); return r; }, e => { end('rolled_back'); throw e; }) : out;
  };

  const proxy = new Proxy(engine, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      const hit = cache.get(prop);
      if (hit && hit.original === value) return hit.wrapped;
      const wrapped = LIFECYCLE.has(prop) || prop.startsWith('_') ? value.bind(target)
        : TX_MEMBERS.has(prop) ? transaction(prop, value) : record(prop, value);
      cache.set(prop, { original: value, wrapped });
      return wrapped;
    },
  });
  return registerEngineView(proxy, viewedEngine(engine));
}

/** The engine factory's entry point: the recording engine, with exit flush and the purge listener installed. */
export function attachCapture<E extends BrainEngine>(engine: E, cap: string): E {
  const writer = new CaptureWriter(cap);
  let ops = 0;
  setOpRecorder({
    begin(call) {
      const id = `${writer.proc}:op${++ops}`;
      const t = Date.now();
      writer.push({ t0: t, t1: t, kind: 'op', phase: 'begin', id, call: encodeValue(call) });
      return id;
    },
    end(id, output, threw) {
      const t = Date.now();
      writer.push({ t0: t, t1: t, kind: 'op', phase: 'end', id, ...(threw ? { ok: false, code: threw } : outcomeOf(output)) });
    },
  });
  const stopListening = onPurgeIntent(() => { try { invalidateIfPurged(cap, { force: 'purge' }); } catch { /* fail open */ } });
  const onExit = () => writer.flushSync();
  process.once('exit', onExit);
  engine.registerBeforeDisconnect(async () => {
    try { await writer.flush(); } finally { stopListening(); setOpRecorder(null); process.removeListener('exit', onExit); }
  });
  return wrapCaptureEngine(engine, writer);
}
