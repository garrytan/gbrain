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
  /** When the seal began (informational: membership comes from the epoch each call saw at its start). */
  sealing_since?: string;
  purge_log: PurgeBaseline;
  reason?: string;
  /** The sealed epoch this one follows: calls that started while it was sealing belong here. */
  after?: string;
  /** Recorders that died uncleanly after acknowledging the previous seal: this epoch may miss their first calls. */
  unverified?: number;
  /** A purge's deletion: `done` once nothing is left; anything else is retried at the next check. */
  cleanup?: 'pending' | 'done';
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
export function startEpoch(cap: string, home = configDir(), now = new Date(), link: { after?: string; unverified?: number } = {}): EpochPointer {
  const baseline = purgeBaseline(home);
  if (baseline === null) throw new ReplayError('shadow_replay_purged', 'the purge log cannot be read, so no epoch starts');
  const id = `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(4).toString('hex')}`;
  mkdirSync(epochDir(cap, id), { recursive: true, mode: 0o700 });
  const pointer: EpochPointer = { version: 1, id, state: 'recording', started_at: now.toISOString(), purge_log: baseline, ...link };
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

/** True while any recording or copy a purge must delete is still on disk. */
function captureDataLeft(cap: string): boolean {
  const bases = join(cap, 'bases');
  return (existsSync(cap) && readdirSync(cap).some(f => f.startsWith('epoch-') || f === 'retry.json'))
    || (existsSync(bases) && readdirSync(bases).length > 0) || runCopies(cap).some(existsSync);
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
 * says: flip it to invalidated (cleanup pending), then delete every epoch, base copy, run copy and retry record, then
 * mark the cleanup done once nothing is left. A pointer that cannot be written never stops the deletion; a deletion
 * that leaves something behind stays pending and purgeIfLogChanged retries it. Safe to repeat.
 */
export function purgeCapture(cap: string): true {
  const pointer = readEpoch(cap);
  let marked: EpochPointer | null = null;
  try {
    if (pointer) { marked = { ...pointer, state: 'invalidated', reason: 'purge', cleanup: 'pending' }; writePrivateJson(epochPointerPath(cap), marked); }
  } catch { marked = null; } // the deletion still runs; the unchanged pointer (or the changed purge log) brings the purge back
  deleteAllCaptureData(cap);
  if (marked && !captureDataLeft(cap)) {
    try { writePrivateJson(epochPointerPath(cap), { ...marked, cleanup: 'done' }); } catch { /* stays pending: retried at the next check */ }
  }
  return true;
}

/**
 * Runs purgeCapture when the purge log changed (or cannot be read) since the current epoch began, or when an earlier
 * purge's deletion did not finish (a crash, a file that could not be removed). True when it ran.
 */
export function purgeIfLogChanged(cap: string, home?: string): boolean {
  const pointer = readEpoch(cap);
  if (!pointer) return false;
  if (pointer.state === 'invalidated') return pointer.reason === 'purge' && pointer.cleanup !== 'done' ? purgeCapture(cap) : false;
  if (!purgeLogChanged(pointer.purge_log, home)) return false;
  return purgeCapture(cap);
}

/** True when a purge's deletion is still unfinished (nothing new may start until it is). */
export function purgePending(cap: string): boolean {
  const pointer = readEpoch(cap);
  return pointer?.state === 'invalidated' && pointer.reason === 'purge' && pointer.cleanup !== 'done';
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

const SEAL_TICK_MS = 100;

/**
 * Seals the recording epoch (a nightly replay's first step). The handshake: the pointer flips to `sealing`. Each call
 * belongs to the epoch the pointer named when the call started: `recording` (this epoch) or `sealing` (the next one).
 * Every recorder registers before it reads the pointer, so every recorder that can hold a call of this epoch is in
 * the registry when the sealer reads it. Each live recorder waits for its calls of this epoch and its pending
 * appends, writes them, and acknowledges; the sealer waits for them, then marks the epoch sealed and starts the next.
 * A clean exit removes its registration; a dead recorder still registered died uncleanly and may have lost records.
 * `unacked`: recorders whose calls of this epoch may be missing (no acknowledgement in time, an incomplete one, or a
 * death before acknowledging), so a replay of this epoch cannot claim complete coverage. A death after acknowledging
 * puts the doubt on the next epoch instead (its `unverified`).
 */
export async function sealEpoch(cap: string, opts: { home?: string; timeoutMs?: number; now?: () => Date } = {}):
  Promise<{ sealed: EpochPointer; next: EpochPointer; unacked: number } | null> {
  const pointer = readEpoch(cap);
  if (!pointer || pointer.state !== 'recording') return null;
  const t = opts.now?.() ?? new Date();
  const sealing: EpochPointer = { ...pointer, state: 'sealing', sealing_since: t.toISOString() };
  writePrivateJson(epochPointerPath(cap), sealing);
  const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
  const dir = epochDir(cap, pointer.id);
  let pending: string[] = [];
  let diedBefore = 0;
  let diedAfter = 0;
  for (;;) {
    if (readEpoch(cap)?.state !== 'sealing') return null; // a purge invalidated it meanwhile
    pending = [];
    const reg = recordersDir(cap);
    for (const f of existsSync(reg) ? readdirSync(reg).filter(f => f.endsWith('.json')) : []) {
      const proc = f.slice(0, -5);
      const acked = existsSync(join(dir, `ack-${proc}`));
      let pid: number | undefined;
      try { pid = (JSON.parse(readFileSync(join(reg, f), 'utf8')) as { pid?: number }).pid; } catch { pid = undefined; } // silent-read-ok: an unreadable registration counts as live until it acknowledges
      if (pid !== undefined && !processAlive(pid)) {
        if (acked) diedAfter++; else diedBefore++; // still registered: it died without its exit flush
        rmSync(join(reg, f), { force: true });
        continue;
      }
      if (!acked) pending.push(proc);
    }
    if (!pending.length || Date.now() >= deadline) break;
    await new Promise(r => setTimeout(r, SEAL_TICK_MS / 2));
  }
  const incomplete = existsSync(dir) ? readdirSync(dir).filter(f => f.startsWith('ack-') && readFileSync(join(dir, f), 'utf8') !== '').length : 0;
  const sealed: EpochPointer = { ...sealing, state: 'sealed' };
  writePrivateJson(epochPointerPath(cap), sealed);
  const next = startEpoch(cap, opts.home, t, { after: pointer.id, ...(diedAfter ? { unverified: diedAfter } : {}) });
  return { sealed, next, unacked: pending.length + diedBefore + incomplete };
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

/**
 * One engine's segment writer. Every call carries a tag, the epoch the pointer named when the call started: its id
 * while recording, `>id` while it was sealing (the call belongs to the epoch that follows it). A record lands only in
 * the epoch its tag names, so a purge, a seal or an off-then-on never moves a record into another epoch.
 */
export class CaptureWriter {
  readonly proc = `${process.pid}-${randomBytes(3).toString('hex')}`;
  private seq = 0;
  private buffer: Array<{ tag: string; line: string }> = [];
  private bytes = 0;
  /** Records lost per tag (full buffer, budget, append error), written as a gap into that tag's epoch. */
  private readonly lost = new Map<string, { count: number; reason: string }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing: Promise<void> | null = null;
  private registered = false;
  private ticker: ReturnType<typeof setInterval> | null = null;
  private closingSince = 0;
  /** Running calls per tag; a seal is acknowledged only when none of its epoch still runs. */
  private readonly inFlight = new Map<string, number>();
  private freeCheckedAt = 0;
  private lowDisk = false;

  constructor(readonly cap: string, readonly home = configDir(), readonly env: Record<string, string | undefined> = process.env,
    readonly hooks: { active?: () => void; retire?: () => void } = {}) {}

  nextSeq(): number { return ++this.seq; }

  /**
   * The tag of a call that starts now, or null when it must not be recorded (capture off, no recording epoch). The
   * recorder registers before it reads the pointer (see sealEpoch).
   */
  begin(): string | null {
    if (!captureIsOn(this.cap, this.env)) return null;
    this.markActive();
    const p = readEpoch(this.cap);
    return p?.state === 'recording' ? p.id : p?.state === 'sealing' ? `>${p.id}` : null;
  }

  push(tag: string, rec: Omit<CaptureRecord, 'v' | 'proc' | 'seq'>): void {
    let line: string;
    try { line = JSON.stringify({ v: 1, proc: this.proc, seq: this.nextSeq(), ...rec }); } catch { return this.lose(tag, 'encode'); }
    if (line.length > CAPTURE_LIMITS.recordBytes) {
      line = JSON.stringify({ v: 1, proc: this.proc, seq: this.seq, t0: rec.t0, t1: rec.t1, kind: 'gap', member: rec.member, reason: 'too_large', tx: rec.tx });
    }
    if (this.bytes + line.length > CAPTURE_LIMITS.bufferBytes) return this.lose(tag, 'buffer_full');
    this.buffer.push({ tag, line });
    this.bytes += line.length + 1;
    if (!this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, CAPTURE_LIMITS.flushMs);
      (this.timer as { unref?: () => void }).unref?.();
    }
  }

  /** Registers this process as a recorder and starts the seal watcher, until close() retires them. */
  markActive(): void {
    this.closingSince = 0;
    if (this.registered && this.ticker) return;
    this.registered = true;
    try { writePrivateJson(join(recordersDir(this.cap), `${this.proc}.json`), { pid: process.pid, since: new Date().toISOString() }); } catch { /* best effort */ }
    // unref'd: an idle resident process still drains and acknowledges a seal, and never stays alive for it.
    this.ticker = setInterval(() => this.tick(), SEAL_TICK_MS);
    (this.ticker as { unref?: () => void }).unref?.();
    this.hooks.active?.();
  }

  private tick(): void {
    try {
      this.drainForSeal();
      if (!this.closingSince) return;
      if ((this.buffer.length || this.lost.size) && !this.flushing) void this.flush();
      this.retireIfIdle();
    } catch { /* a capture fault never reaches the brain process */ }
  }

  /** The engine disconnected: write what is left, then stop the watcher and unregister once nothing is owed. */
  async close(): Promise<void> {
    this.closingSince = Date.now();
    try { await this.flush(); this.drainForSeal(); this.retireIfIdle(); } catch { /* a capture fault never fails a disconnect */ }
  }

  private retireIfIdle(): void {
    if (!this.closingSince || !this.ticker) return;
    const owed = this.buffer.length || this.lost.size || this.flushing || this.inFlight.size || this.sealUnacked();
    // After a minute it stops polling anyway; it stays registered, so a seal reports it unacknowledged.
    if (owed && Date.now() - this.closingSince < 60_000) return;
    clearInterval(this.ticker);
    this.ticker = null;
    if (!owed) {
      try { rmSync(join(recordersDir(this.cap), `${this.proc}.json`), { force: true }); this.registered = false; }
      catch { /* stays registered: a seal then counts this recorder as unverified, never as complete */ }
    }
    this.hooks.retire?.();
  }

  private sealUnacked(): boolean {
    const p = readEpoch(this.cap);
    return p?.state === 'sealing' && !existsSync(join(epochDir(this.cap, p.id), `ack-${this.proc}`));
  }

  /**
   * The recorder's half of the seal handshake: when the epoch is sealing and none of its calls still runs here and no
   * append is pending, write this recorder's records of it (under the same checks as a flush) and acknowledge. An
   * acknowledgement with content says the records are incomplete (capture off, budget, the process exiting mid-call).
   */
  drainForSeal(exiting = false): void {
    const epoch = readEpoch(this.cap);
    if (!epoch || epoch.state !== 'sealing') return;
    const dir = epochDir(this.cap, epoch.id);
    const ack = join(dir, `ack-${this.proc}`);
    if (existsSync(ack)) return;
    // This epoch's calls: those that started while it was recording, and those that started while the epoch before
    // it was sealing (tagged `>previous`).
    const prev = epoch.after ? `>${epoch.after}` : null;
    const mine = (tag: string) => tag === epoch.id || tag === prev;
    const running = [...this.inFlight.keys()].some(mine);
    if (!exiting && (running || this.flushing)) return;
    const later = (tag: string) => tag === `>${epoch.id}`;
    let note = running || this.flushing ? 'exited' : '';
    if (!captureIsOn(this.cap, this.env)) { this.take(() => false, later); note = 'off'; }
    else if (purgeIfLogChanged(this.cap, this.home)) return; // the epoch is gone; the sealer stops
    else {
      if (this.overBudget(dir)) { this.shed(mine, 'budget'); note = 'budget'; }
      const data = this.take(mine, later);
      if (data) appendFileSync(join(dir, `${this.proc}.jsonl`), data, { mode: 0o600 });
    }
    writeFileSync(ack, note, { mode: 0o600 });
  }

  /** Marks a call with `tag` running; the returned function marks it done. */
  enter(tag: string): () => void {
    this.inFlight.set(tag, (this.inFlight.get(tag) ?? 0) + 1);
    return () => { const n = (this.inFlight.get(tag) ?? 1) - 1; if (n > 0) this.inFlight.set(tag, n); else this.inFlight.delete(tag); };
  }

  private lose(tag: string, reason: string, n = 1): void {
    const l = this.lost.get(tag);
    this.lost.set(tag, { count: (l?.count ?? 0) + n, reason });
  }

  /** Moves the buffered records `match` selects into the lost count (their epoch gets a gap). */
  private shed(match: (tag: string) => boolean, reason: string): void {
    const keep = this.buffer.filter(b => { if (!match(b.tag)) return true; this.lose(b.tag, reason); return false; });
    this.buffer = keep;
    this.bytes = keep.reduce((n, b) => n + b.line.length + 1, 0);
  }

  /**
   * The lines (records and gaps) `match` selects, removed from the buffer; records `keep` selects stay buffered; any
   * other record belongs to an epoch that ended, was purged or was recorded before capture went off, and is dropped.
   */
  private take(match: (tag: string) => boolean, keep: (tag: string) => boolean): string {
    const lines: string[] = [];
    const kept: Array<{ tag: string; line: string }> = [];
    for (const b of this.buffer) { if (match(b.tag)) lines.push(b.line); else if (keep(b.tag)) kept.push(b); }
    this.buffer = kept;
    this.bytes = kept.reduce((n, b) => n + b.line.length + 1, 0);
    for (const [tag, l] of [...this.lost]) {
      if (match(tag)) lines.push(JSON.stringify({ v: 1, proc: this.proc, seq: this.nextSeq(), t0: Date.now(), t1: Date.now(), kind: 'gap', reason: l.reason, count: l.count }));
      if (!keep(tag)) this.lost.delete(tag);
    }
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  /** Low disk or the epoch over its byte budget (checked at most every 5 s). */
  private overBudget(dir: string): boolean {
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
    return this.lowDisk;
  }

  /** The segment to append to now and the tags it takes, or why nothing may be written. */
  private target(): { path: string; tag: string; match: (tag: string) => boolean } | { stop: 'off' | 'purged' | 'sealing' | 'no_epoch' | 'budget' } {
    if (!captureIsOn(this.cap, this.env)) return { stop: 'off' };
    if (purgeIfLogChanged(this.cap, this.home)) return { stop: 'purged' };
    const epoch = readEpoch(this.cap);
    if (epoch?.state === 'sealing') return { stop: 'sealing' }; // the seal watcher drains this epoch's records
    if (!epoch || epoch.state !== 'recording') return { stop: 'no_epoch' };
    const dir = epochDir(this.cap, epoch.id);
    if (!existsSync(dir)) return { stop: 'no_epoch' };
    if (this.overBudget(dir)) return { stop: 'budget' };
    const prev = epoch.after ? `>${epoch.after}` : null;
    return { path: join(dir, `${this.proc}.jsonl`), tag: epoch.id, match: tag => tag === epoch.id || tag === prev };
  }

  /**
   * Applies a stop. Off, a purge or no epoch: the buffer goes (nothing is being recorded). Budget or a fault: the
   * records count as lost, so their epoch gets a gap once writing resumes. Sealing: everything stays buffered.
   */
  private apply(stop: string): void {
    if (stop === 'sealing') return;
    if (stop === 'budget' || stop === 'error') { this.shed(() => true, stop); return; }
    this.buffer = [];
    this.bytes = 0;
    this.lost.clear();
  }

  flush(): Promise<void> {
    if (this.flushing) return this.flushing.then(() => this.flush());
    const run = async () => {
      if (!this.buffer.length && !this.lost.size) return;
      let t: ReturnType<CaptureWriter['target']> | { stop: 'error' };
      try { t = this.target(); } catch { t = { stop: 'error' }; } // a capture fault never reaches the brain process
      if ('stop' in t) { this.apply(t.stop); return; }
      const data = this.take(t.match, () => false);
      try { await appendFile(t.path, data, { mode: 0o600 }); } catch { this.lose(t.tag, 'append_error', data.split('\n').length - 1); }
    };
    this.flushing = run().catch(() => { /* target() and take() do not throw; appendFile's failure is counted above */ }).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  /**
   * Synchronous flush for process exit: drains a seal in progress, writes what may be written, and removes this
   * recorder's registration when nothing is left unwritten (a dead recorder still registered died uncleanly).
   */
  flushSync(): void {
    try {
      this.drainForSeal(true);
      if (this.buffer.length || this.lost.size) {
        let t: ReturnType<CaptureWriter['target']> | { stop: 'error' };
        try { t = this.target(); } catch { t = { stop: 'error' }; }
        if ('stop' in t) this.apply(t.stop);
        else appendFileSync(t.path, this.take(t.match, () => false), { mode: 0o600 });
      }
      // Unfinished work (a call still running, an append still pending) keeps the registration: a seal counts it.
      if (!this.buffer.length && !this.lost.size && !this.inFlight.size && !this.flushing && this.registered) rmSync(join(recordersDir(this.cap), `${this.proc}.json`), { force: true });
    } catch { /* exit hook: a capture fault never fails shutdown */ }
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
export function wrapCaptureEngine<E extends BrainEngine>(engine: E, writer: CaptureWriter, tx?: string, txTag?: string): E {
  let txSeq = 0;
  const cache = new Map<PropertyKey, { original: Function; wrapped: Function }>();

  const record = (member: string, fn: Function): Function => function captured(...args: unknown[]) {
    const tag = txTag ?? writer.begin(); // a call inside a transaction belongs to the transaction's epoch
    if (tag === null) return fn.apply(engine, args);
    const t0 = Date.now();
    if (GAP_MEMBERS.has(member) || hasFunctionArg(args)) {
      writer.push(tag, { t0, t1: t0, kind: 'gap', member, reason: GAP_MEMBERS.has(member) ? 'raw' : 'function_arg', tx });
      return fn.apply(engine, args);
    }
    let encoded: unknown;
    let access: unknown;
    try {
      encoded = encodeArgs(args, { left: CAPTURE_BUDGET_BYTES });
      const a = callerAccessRecord();
      access = a ? encodeValue(a) : undefined;
    } catch (err) {
      writer.push(tag, { t0, t1: t0, kind: 'gap', member, reason: err instanceof CaptureTooLargeError ? 'too_large' : 'encode', tx });
      return fn.apply(engine, args);
    }
    const leave = writer.enter(tag);
    const done = (o: { ok: boolean; h?: string; code?: string }) => {
      leave();
      try { writer.push(tag, { t0, t1: Date.now(), kind: 'engine', member, args: encoded, ...(access ? { access } : {}), ...o, ...(tx ? { tx } : {}) }); } catch { /* never fails a call */ }
    };
    let out: unknown;
    try { out = fn.apply(engine, args); } catch (e) { done({ ok: false, code: errorCode(e) }); throw e; }
    if (!isThenable(out)) { done(outcomeOf(out)); return out; }
    return out.then(r => { done(outcomeOf(r)); return r; }, e => { done({ ok: false, code: errorCode(e) }); throw e; });
  };

  const transaction = (member: string, fn: Function): Function => function capturedTx(cb: unknown, ...rest: unknown[]) {
    if (typeof cb !== 'function') return fn.apply(engine, [cb, ...rest]);
    const tag = txTag ?? writer.begin();
    if (tag === null) return fn.apply(engine, [cb, ...rest]);
    const id = `${writer.proc}:${tx ? `${tx}.` : ''}${++txSeq}`;
    const t0 = Date.now();
    const leave = writer.enter(tag);
    writer.push(tag, { t0, t1: t0, kind: 'tx', phase: 'begin', member, tx: id, ...(tx ? { parent_tx: tx } : {}) });
    const end = (phase: 'committed' | 'rolled_back') => { leave(); writer.push(tag, { t0, t1: Date.now(), kind: 'tx', phase, member, tx: id, ...(tx ? { parent_tx: tx } : {}) }); };
    let out: unknown;
    try { out = fn.apply(engine, [(inner: BrainEngine) => (cb as (e: BrainEngine) => unknown)(inner && typeof inner === 'object' ? wrapCaptureEngine(inner, writer, id, tag) : inner), ...rest]); } catch (e) { leave(); throw e; }
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
  const onExit = () => writer.flushSync();
  const onDisconnect = () => writer.close();
  // The exit hook and the disconnect hook live while the writer is active (from a call until it retires with
  // everything written), so a seal pending at disconnect still drains. A reconnect gets both back: an engine that
  // clears its disconnect hooks when it disconnects (Rust) gets the same callback again (the engines keep a Set).
  const writer = new CaptureWriter(cap, undefined, undefined, {
    active: () => { process.removeListener('exit', onExit); process.once('exit', onExit); engine.registerBeforeDisconnect(onDisconnect); },
    retire: () => process.removeListener('exit', onExit),
  });
  engine.registerBeforeDisconnect(onDisconnect);
  return wrapCaptureEngine(engine, writer);
}
