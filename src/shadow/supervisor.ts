/**
 * Supervises the shadow child from the serving process (plan PR S1; decision D13 s3).
 *
 * The child is spawned lazily, on the first line to send, as `gbrain engine shadow __child <dir>`, with stdin as the
 * NDJSON pipe and stdout as the control channel (heartbeats, pause). Every handle is unref'd, so the child never keeps
 * a CLI process alive, and nothing here is awaited by a caller.
 *
 * Faults: a child exit is recorded and the next send respawns it after a backoff (1 s doubling to 60 s). A child with
 * no heartbeat for `hangMs` is killed and counts as an exit. After `maxRestarts` exits within `restartWindowMs`
 * mirroring stops for this process, and the reason is recorded in faults.jsonl. A `pause` from the child (a privacy
 * divergence) stops mirroring the same way. The state file is re-read at most every `stateCheckMs`, so
 * `gbrain engine shadow stop` reaches long-running processes too. `send` returns false whenever a line was not
 * accepted (no child yet, backoff, pipe over its byte budget); the queue counts it as shed.
 *
 * Write samples are owed before they are sent: `send()` stages a sample line in memory, and one `setImmediate` flush per event-loop turn first writes `write-owed.<session>.json` (what this process has accepted for the
 * child, durably: file and directory flushed), then hands the staged lines to the pipe in the order they came. The flush never runs inside a caller's request; a failed write keeps the lines staged and is retried.
 */
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, linkSync, openSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { flushDirectory } from '../core/fs-durable.ts';
import { withoutReadDeadline } from '../core/read-deadline.ts';
import { withRequestSignal } from '../core/request-signal.ts';
import { spawn as defaultSpawn } from '../core/spawn.ts';
import { readEpoch } from './evidence-epoch.ts';
import { appendFault, type ShadowFault } from './ledger.ts';
import type { MirrorTransport } from './mirror.ts';
import { readShadowState } from './state.ts';
import { owedPath, pendingPath, sampleWeight, sessionKey, withTallyLock, writeOwed, type OwedRecord } from './write-compare.ts';

export interface ShadowSupervisorOptions {
  dir: string;
  /** argv of the child: `[...gbrain argv, 'engine', 'shadow', '__child', dir]`. */
  argv: string[];
  spawn?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  now?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  maxRestarts?: number;
  restartWindowMs?: number;
  hangMs?: number;
  stateCheckMs?: number;
  /** Bytes of write samples that may be staged or in the pipe, handed to it and not yet flushed, before a new sample is refused (the caller counts it `send_shed`). */
  maxBufferedBytes?: number;
  /** Bytes of lines of every kind that may be staged behind an owed write (default twice `maxBufferedBytes`): past it a new line is refused whatever it is, so a failing owed write cannot grow memory. */
  maxStagedBytes?: number;
  /** Seam for tests: how long a failed owed write waits before its retry (default 100 ms). */
  retryMs?: number;
  /** Seam for tests: writes the owed record (default: `writeOwed`, durable). Throws when it failed. */
  writeOwed?: typeof writeOwed;
  /** How long `drain` waits at disconnect for the pipe to flush what it holds (default 2 s). */
  drainMs?: number;
  /** Seam for tests; default appends to faults.jsonl. */
  recordFault?: (fault: ShadowFault) => void;
  /** Seam for tests; default re-reads state.json. */
  stillEnabled?: () => boolean;
  /** The child's store displaced rows while applying a relation: it is dirty and wants a reconcile pass. */
  onDirty?: (relation: string) => void;
  /** The child asks the serving process a question (privacy check, stable rerun, vector reference; checks.ts); the value goes back as an `answer` line. */
  onAsk?: (ask: { id: number; kind: string; [key: string]: unknown }) => Promise<unknown>;
}

/** The longest one question of the child may hold the serving process (past the 30 s a stable rerun is allowed): its own signal cancels its reads then. */
export const ASK_DEADLINE_MS = 45_000;

/** The only codes an `ask` failure carries back to the child: never an exception message (it can hold content). */
export const ASK_CODES: ReadonlySet<string> = new Set([
  'epoch_changed', 'no_follower', 'not_a_read', 'busy', 'timeout', 'write_after_barrier', 'watermark_invalid', 'child_unavailable',
  'rate_limited', 'unsupported', 'sample_unknown', 'invalidation_pending', 'moved', 'failed', 'too_large',
]);
export const askCode = (error: unknown): string => {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && ASK_CODES.has(code) ? code : 'failed';
};

export { sampleWeight };

/** Supervisors with a running child: a process that exits with one still unflushed loses lines (Bun drops what its pipe holds), so the exit hook closes each one's owed record with the exact count for the child to compare. */
const liveSupervisors = new Set<ShadowSupervisor>();
let exitWatched = false;
function watchProcessExit(): void {
  if (exitWatched) return;
  exitWatched = true;
  process.on('exit', closeAllOwedAtExit);
}
/** The process-exit hook (and a seam for tests): every live supervisor closes its owed record with everything it accepted, synchronously. */
export function closeAllOwedAtExit(): void { for (const supervisor of [...liveSupervisors]) { supervisor.closeOwed(); supervisor.publishKeptNow(); } }

/** How long this process waits for the tally lock when it publishes a kept record or clears a marker (a timeout defers to the next try; it runs in a flush turn, the exit callback, a timer or the exit hook, never inside a caller's request). */
const KEPT_LOCK_WAIT_MS = 200;
/** A record that could not be made durable, kept until it is: the exact record (null once it is durable and only its marker is left to clear), and whether its marker is published (linked and the directory flushed). */
interface Kept { rec: OwedRecord | null; marked: boolean }

export class ShadowSupervisor implements MirrorTransport {
  private child: ChildProcess | null = null;
  private disabledReason: string | null = null;
  private exits: number[] = [];
  private backoffMs: number;
  private nextSpawnAt = 0;
  private lastHeartbeat = 0;
  private lastStateCheck = 0;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private controlBuffer = '';
  /** Names the running child; asks and answers carry it, so an old child's answer can never reach a restarted one. */
  private session = '';
  private nextRequestId = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Lines handed to the pipe whose write callback has not fired (flow control and the drain wait only: Bun fires a callback before and after the bytes are really in the kernel pipe, so it never says what the child received). */
  private readonly flight = new Set<{ bytes: number; weight: number }>();
  private sampleBytes = 0;
  /** Lines accepted but not yet handed to the pipe, in order: a sample waits here for its owed record (and every line behind it, so order holds). */
  private staged: Array<{ line: string; entry: { bytes: number; weight: number } }> = [];
  private stagedBytes = 0;
  private flushScheduled = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Write samples (with the losses they carry) accepted for the current child, sent or staged: the count the owed record states, so the child can settle what its pipe never delivered. */
  private acceptedWeight = 0;
  private owedWritten = ''; // the record `writeOwedRecord` last made durable (session, count and flags)
  private oweDirty = false; // `owe` raised the accepted weight and the record is not durable yet
  private readonly kept = new Map<string, Kept>(); // by session key: what no record on disk states yet, across worker exits, respawns and stops
  private keptTimer: ReturnType<typeof setTimeout> | null = null;
  private keptDelay: number;
  private keptDue = 0; // when the keeper's timer fires (epoch ms)
  private refusal = ''; // the session whose kept record holds the samples refused while no worker ran (`oweRefused`)
  private childExited = false;
  private closedRecord = false; // a closed record was made durable for this session: later records stay closed
  private stdinRef: (NodeJS.WritableStream & { writableFinished?: boolean }) | null = null;
  private readonly drainWaiters = new Set<() => void>();
  private readonly o: Required<Omit<ShadowSupervisorOptions, 'spawn' | 'recordFault' | 'stillEnabled' | 'onDirty' | 'onAsk'>> & Pick<ShadowSupervisorOptions, 'spawn' | 'recordFault' | 'stillEnabled' | 'onDirty' | 'onAsk'>;

  constructor(opts: ShadowSupervisorOptions) {
    this.o = {
      now: Date.now, minBackoffMs: 1_000, maxBackoffMs: 60_000, maxRestarts: 5, restartWindowMs: 10 * 60_000,
      hangMs: 60_000, stateCheckMs: 30_000, maxBufferedBytes: 8 * 1024 * 1024, maxStagedBytes: 0, retryMs: 100, writeOwed, drainMs: 2_000,
      ...opts,
    };
    if (!this.o.maxStagedBytes) this.o.maxStagedBytes = 2 * this.o.maxBufferedBytes;
    this.backoffMs = this.o.minBackoffMs; this.keptDelay = this.o.retryMs;
    this.lastStateCheck = this.o.now();
  }

  /** Mirroring continues in this process. */
  active(): boolean { return this.disabledReason === null; }
  get disabled(): string | null { return this.disabledReason; }
  get childPid(): number | null { return this.child?.pid ?? null; }
  get restarts(): number { return this.exits.length; }

  send(line: string): boolean {
    if (this.disabledReason) return false;
    const now = this.o.now();
    if (now - this.lastStateCheck >= this.o.stateCheckMs) {
      this.lastStateCheck = now;
      const enabled = this.o.stillEnabled ? this.o.stillEnabled() : readShadowState(this.o.dir)?.enabled === true;
      if (!enabled) { this.disable('stopped', 'shadow mode was turned off (state.json)', false); return false; }
    }
    if (!this.child) {
      if (now < this.nextSpawnAt) return false;
      this.start();
      if (!this.child) return false;
    }
    const stdin = this.child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) return false;
    if (stdin.writableLength > this.o.maxBufferedBytes) return false;
    // Under Bun `writableLength` reads 0 and `drain` never fires while megabytes are queued, so the pipe is watched through the write callbacks. A write sample over the budget of samples still in
    // the pipe is refused (the caller counts it `send_shed`); `write()` returning false is "queued", not "refused". Other lines (reads, follower lines, answers) are never refused for size.
    const weight = sampleWeight(line);
    if (weight > 0 && this.sampleBytes > this.o.maxBufferedBytes) return false;
    // Lines wait behind a staged one, whatever they are, so order holds; behind a failing owed write that wait is bounded for lines of every kind, not for samples alone.
    if (this.staged.length > 0 && this.stagedBytes > this.o.maxStagedBytes) return false;
    const entry = { bytes: line.length, weight };
    if (weight === 0 && this.staged.length === 0) {
      this.flight.add(entry);
      try { stdin.write(line, () => this.forget(entry)); } catch { this.forget(entry); return false; }
      return true;
    }
    this.flight.add(entry); if (weight > 0) this.sampleBytes += entry.bytes;
    this.staged.push({ line, entry }); this.stagedBytes += line.length;
    this.acceptedWeight += weight;
    this.scheduleFlush();
    return true;
  }

  /**
   * Makes `n` more samples owed with no line behind them: samples the sampler could not send (a loss-only line the pipe refused) and could not record. The owed record is made durable in a later turn like any other, so status reads the session as unsettled
   * (owed above settled) until the worker books them, as `pipe_unflushed` at the end of its input or as `receipt_orphaned` by the next owner. False when there is no running worker to owe them to.
   */
  owe(n: number): boolean {
    if (!this.session || !this.child || this.disabledReason || !Number.isInteger(n) || n < 1) return false;
    this.acceptedWeight += n; this.oweDirty = true;
    this.scheduleFlush();
    return true;
  }

  /**
   * Makes `n` refused samples owed whose refusal could not be written down (the sampler's lost-line append failed): with a running worker that is `owe(n)`; with none (backoff, a failed spawn) they become a kept record of a session of their own (closed, child gone), published
   * under the tally lock like any record and marked while it cannot be, so no refused sample lives only in memory. The next owner worker books them once, as `receipt_orphaned`.
   */
  oweRefused(n: number): boolean {
    if (!Number.isInteger(n) || n < 1 || this.disabledReason) return false;
    if (this.session && this.child) return this.owe(n);
    const session = this.refusal ||= `r${randomBytes(8).toString('hex')}`;
    const key = sessionKey(session);
    const entry: Kept = this.kept.get(key) ?? { rec: { v: 1, session, serving_pid: process.pid, owed: 0, closed: true, child_exited: true }, marked: false };
    entry.rec!.owed += n; this.kept.set(key, entry);
    this.holdForExit(); this.armKept(true);
    return true;
  }

  /** One flush per event-loop turn, after the caller's synchronous work: the durable owed write never runs inside a request. Not held open for: an exit with lines staged is covered by the exit hook's owed record. */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    (setImmediate(() => { this.flushScheduled = false; this.flushStaged(); }) as { unref?: () => void }).unref?.();
  }

  /**
   * Writes the owed record (everything accepted so far, durable), then hands the staged lines to the pipe in order. A failed record write sends nothing: the lines stay staged and the write is retried, so no sample reaches the child
   * unless the record that owes it is on disk. True when nothing is left staged.
   */
  private flushStaged(closed = false): boolean {
    if (this.staged.length === 0 && !this.oweDirty) return true;
    if (!this.writeOwedRecord(closed)) { this.scheduleRetry(); return false; }
    this.oweDirty = false;
    const stdin = this.child?.stdin;
    const lines = this.staged; this.staged = []; this.stagedBytes = 0;
    for (const { line, entry } of lines) {
      try {
        if (!stdin || stdin.destroyed || !stdin.writable) throw new Error('closed'); // the child is gone: the record owes these samples, and the child that settles the session books them
        stdin.write(line, () => this.forget(entry));
      } catch { this.forget(entry); }
    }
    return true;
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.flushStaged(); }, this.o.retryMs);
    (this.retryTimer as { unref?: () => void }).unref?.();
  }

  /**
   * Makes the owed record for the current session durable (once per distinct content). False when it could not be written: the exact record is then kept (`keep`) and its marker is made, so status blocks and the record is retried until it is on disk, whatever
   * the worker does. `locked`: the write takes the tally lock (a record written after its worker may be gone is one a remover could be judging); it always does when no worker is live, the child has exited or a record is kept for the session.
   */
  private writeOwedRecord(closed = false, childExited = false, locked = false): boolean {
    if (!this.session) return true;
    const kept = this.kept.get(sessionKey(this.session))?.rec; // a retained record's lifecycle flags only ever go up: a later write for the session cannot take back an exit or a close
    const exited = childExited || this.childExited || kept?.child_exited === true;
    closed ||= this.closedRecord || kept?.closed === true;
    const mark = `${this.session}:${this.acceptedWeight}:${closed}:${exited}`;
    if (this.owedWritten === mark) return true;
    locked ||= !this.child || exited || this.kept.has(sessionKey(this.session)); // a record written with no live worker, after the child's exit, or for a session whose record is already kept is one a remover may be judging: every such write takes the lock (a timeout is a failed write: kept and retried). A live worker's own session is settled by that worker, which is why the close at a drain stays unlocked
    const rec: OwedRecord = { v: 1, session: this.session, serving_pid: process.pid, ...(this.child?.pid ? { child_pid: this.child.pid } : {}), owed: this.acceptedWeight, closed, child_exited: exited };
    try {
      if (locked) withTallyLock(this.o.dir, () => this.o.writeOwed(this.o.dir, rec), KEPT_LOCK_WAIT_MS); else this.o.writeOwed(this.o.dir, rec);
      this.owedWritten = mark; this.closedRecord = closed; this.childExited = exited;
      const entry = this.kept.get(sessionKey(this.session));
      if (entry) { entry.rec = null; this.armKept(true); } // the record is durable: only its marker is left to clear
      return true;
    } catch { this.keep(rec); return false; }
  }

  /** Keeps `rec` until it is durable and publishes its marker now (the first failure, live worker or not). */
  private keep(rec: OwedRecord): void {
    const key = sessionKey(rec.session);
    const entry = this.kept.get(key) ?? { rec: null, marked: false };
    entry.rec = rec; entry.marked ||= this.markPending(rec.session); this.kept.set(key, entry);
    this.holdForExit(); this.armKept(true);
  }

  /**
   * Publishes the marker: a hard link, to the session's last record or else any file the shadow directory already holds (a link copies no data; it still needs a directory entry), then the directory flushed. Only a flushed link counts as published
   * (an `EEXIST` after an unconfirmed flush flushes again); false is retried on the keeper's timer. The link syscall itself failing is a named limit.
   */
  private markPending(session: string): boolean {
    for (const target of [owedPath(this.o.dir, session), join(this.o.dir, 'child.log'), join(this.o.dir, 'state.json')]) {
      try { linkSync(target, pendingPath(this.o.dir, session)); } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') continue;
        if (code !== 'EEXIST') return false;
      }
      try { flushDirectory(this.o.dir); return true; } catch { return false; }
    }
    return false;
  }

  /** A supervisor that keeps a record stays reachable by the exit hook until nothing is kept. */
  private holdForExit(): void { liveSupervisors.add(this); watchProcessExit(); }

  /** One try at every kept record: marked if it is not, then (under the tally lock, in one hold) written, and its marker removed. A record already durable only has its marker cleared, never rewritten. True when nothing is kept. */
  private tickKept(): boolean {
    for (const [key, entry] of [...this.kept]) {
      try {
        withTallyLock(this.o.dir, () => {
          if (entry.rec) {
            const rec = entry.rec; this.o.writeOwed(this.o.dir, rec); entry.rec = null; if (key === this.refusal) this.refusal = '';
            if (this.session === rec.session) { this.owedWritten = `${rec.session}:${rec.owed}:${rec.closed}:${rec.child_exited}`; this.closedRecord = rec.closed; this.childExited = rec.child_exited; } // the live session's own record: not written again by its next flush
          }
          rmSync(pendingPath(this.o.dir, key), { force: true }); entry.marked = false; flushDirectory(this.o.dir); // unlinked: if the flush throws the entry is retried, and a later failed write makes its marker again
        }, KEPT_LOCK_WAIT_MS);
        this.kept.delete(key);
      } catch { if (entry.rec && !entry.marked) entry.marked = this.markPending(entry.rec.session); } // kept: the next try (backoff) goes again
    }
    if (this.kept.size === 0 && !this.child) liveSupervisors.delete(this);
    return this.kept.size === 0;
  }

  /** The exit hook's try: now, without waiting for the timer. */
  publishKeptNow(): void { this.tickKept(); }

  /** Arms the keeper's timer. A deadline already set that falls within one retry interval is never pushed back: samples that keep arriving cannot postpone the attempt (`soon` only ever brings it forward). */
  private armKept(soon = false): void {
    if (soon) {
      if (this.keptTimer && this.keptDue <= Date.now() + this.o.retryMs) return;
      this.keptDelay = this.o.retryMs;
    } else if (this.keptTimer) return;
    if (this.keptTimer) clearTimeout(this.keptTimer);
    this.keptDue = Date.now() + this.keptDelay;
    this.keptTimer = setTimeout(() => {
      this.keptTimer = null;
      if (!this.tickKept()) { this.keptDelay = Math.min(this.keptDelay * 2, this.o.retryMs * 50); this.armKept(); } // backoff from retryMs (100 ms) to 5 s while it keeps failing; nothing is ever dropped to bound memory
    }, this.keptDelay);
    (this.keptTimer as { unref?: () => void }).unref?.();
  }

  private forget(entry: { bytes: number; weight: number }): void {
    if (!this.flight.delete(entry)) return;
    if (entry.weight > 0) this.sampleBytes -= entry.bytes;
    if (this.flight.size === 0) for (const wake of [...this.drainWaiters]) wake();
  }

  /**
   * Closes the owed record of the current session with everything this process accepted for the child (`closed: true`), then hands any lines still staged to the pipe. The child counts the samples it read; at the end of its input it books
   * the difference as lost (`pipe_unflushed`), so a sample the pipe never delivered (Bun drops what it still holds when the process exits) is settled once by the child, whether the pipe was slow, the process exited at once or the
   * exit came from anywhere else. A record that cannot be written leaves the older one on disk: the child that settles the session books only what that one owes (a count that is too low, never a hidden mismatch).
   */
  closeOwed(): void {
    if (!this.session || !this.child || this.acceptedWeight === 0) return; // a session whose worker is gone has its record kept (`keep`), not closed again here
    this.flushStaged(true);
    this.writeOwedRecord(true);
  }

  /** Lines that never reached the pipe (the child is gone or stopped) are forgotten here; the owed record already counts them, so the session's child books them as lost. */
  private dropStaged(): void {
    const lines = this.staged; this.staged = []; this.stagedBytes = 0;
    for (const { entry } of lines) this.forget(entry);
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  /**
   * At disconnect, before `stop()`: the CLI process is about to exit, and Bun drops what its pipe still holds then. Waits up to `ms` (default `drainMs`) for the write callbacks, then ends the
   * child's stdin and waits within the same bound for it to say it finished writing, so a child that is only slightly behind gets everything. Returns at once when nothing is in flight. What
   * is still in the pipe after that is not delivered, and the child counts it from the owed record `stop()` closes.
   */
  async drain(ms: number = this.o.drainMs): Promise<void> {
    const stdin = this.stdinRef;
    if (!stdin || !this.child || this.flight.size === 0) return;
    this.flushStaged(); // lines still waiting for their owed record go to the pipe now, in order, so they can drain too
    const until = Date.now() + ms;
    const wait = (register: (wake: () => void) => () => void): Promise<void> => new Promise<void>((resolve) => {
      let off = (): void => {};
      const wake = (): void => { clearTimeout(timer); off(); this.drainWaiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, Math.max(0, until - Date.now()));
      this.drainWaiters.add(wake); off = register(wake);
    });
    await wait(() => () => {});
    if (this.flight.size > 0 || (stdin as { writableFinished?: boolean }).writableFinished === true) return;
    this.closeOwed(); // before the input ends: the child reads it when it sees the end
    try { stdin.end(); } catch { /* already gone */ }
    await wait((wake) => { stdin.once('finish', wake); stdin.once('close', wake); return () => { stdin.off('finish', wake); stdin.off('close', wake); }; });
  }

  /**
   * Calls a follow method in the child (`{t:'rpc'}` out, `{t:'resp'}` back). Rejects with the child's error code, or
   * `child_unavailable` (not accepted, child exit) or `timeout`.
   */
  request<T = unknown>(method: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const id = ++this.nextRequestId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout')); }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      if (!this.send(JSON.stringify({ t: 'rpc', id, method, args }) + '\n')) this.settleRequest(id, null, new Error('child_unavailable'));
    });
  }

  private settleRequest(id: number, value: unknown, error?: Error): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (error) entry.reject(error); else entry.resolve(value);
  }

  private rejectRequests(reason: string): void {
    for (const id of [...this.pending.keys()]) this.settleRequest(id, null, new Error(reason));
  }

  /** Ends the child's stdin (it flushes and exits) without waiting. */
  stop(): void {
    this.disabledReason ??= 'stopped';
    this.rejectRequests('child_unavailable');
    this.clearWatchdog();
    const child = this.child;
    if (child) this.closeOwed(); // before the input ends: the child counts what it was never sent
    this.dropStaged();
    this.child = null; if (this.kept.size === 0) liveSupervisors.delete(this);
    if (child) {
      child.removeAllListeners('exit');
      try { child.stdin?.end(); } catch { /* already gone */ }
      // A child stuck in native work never sees the end of its input: kill it after the hang window, not never.
      const reaper = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, this.o.hangMs);
      (reaper as { unref?: () => void }).unref?.();
      child.once('exit', () => clearTimeout(reaper));
    }
  }

  private fault(kind: ShadowFault['kind'], detail: string): void {
    // The epoch current when the fault happened (evidence-epoch.ts), so the status counts child exits per epoch.
    const epoch_id = readEpoch(this.o.dir)?.epoch_id;
    const fault: ShadowFault = { ts: new Date(this.o.now()).toISOString(), kind, detail, ...(epoch_id ? { epoch_id } : {}) };
    try { (this.o.recordFault ?? ((f: ShadowFault) => appendFault(this.o.dir, f)))(fault); } catch { /* disk */ }
  }

  private disable(reason: string, detail: string, record = true): void {
    if (this.disabledReason) return;
    this.disabledReason = reason;
    if (record) this.fault(reason === 'privacy_diverged' ? 'privacy_pause' : 'mirroring_disabled', `${reason}: ${detail}`);
    this.stop();
  }

  private start(): void {
    const [command, ...args] = this.o.argv;
    let errFd: number | null = null;
    try {
      errFd = openSync(join(this.o.dir, 'child.log'), 'a', 0o600);
      const session = randomBytes(8).toString('hex');
      const child = (this.o.spawn ?? (defaultSpawn as unknown as NonNullable<ShadowSupervisorOptions['spawn']>))(command, args, {
        stdio: ['pipe', 'pipe', errFd],
        detached: false,
        env: { ...process.env, GBRAIN_SHADOW_CHILD: '1', GBRAIN_SHADOW_SESSION: session },
      });
      this.child = child;
      this.stdinRef = child.stdin as never;
      this.dropStaged(); this.oweDirty = false; this.session = session; this.acceptedWeight = 0; this.owedWritten = ''; this.childExited = false; this.closedRecord = false;
      liveSupervisors.add(this); watchProcessExit();
      this.controlBuffer = '';
      this.lastHeartbeat = this.o.now();
      child.unref();
      const stdin = child.stdin as (NodeJS.WritableStream & { unref?: () => void }) | null;
      stdin?.on('error', () => { /* EPIPE: the exit handler restarts */ });
      (stdin as { unref?: () => void } | null)?.unref?.();
      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => this.onControl(chunk, child));
      (child.stdout as { unref?: () => void } | null)?.unref?.();
      child.on('error', (error) => { this.fault('spawn_failed', error instanceof Error ? error.name : 'unknown'); this.onExit(child, null, 'error'); });
      child.on('exit', (code, signal) => this.onExit(child, code, signal));
      this.armWatchdog();
    } catch (error) {
      this.child = null;
      this.fault('spawn_failed', error instanceof Error ? error.name : 'unknown');
      this.onExit(null, null, 'spawn_failed');
    } finally {
      if (errFd !== null) { try { closeSync(errFd); } catch { /* the child holds its own copy */ } }
    }
  }

  private onControl(chunk: string, from: ChildProcess): void {
    if (from !== this.child) return; // a child that was replaced or stopped speaks to nobody
    this.controlBuffer += chunk;
    let nl: number;
    while ((nl = this.controlBuffer.indexOf('\n')) >= 0) {
      const line = this.controlBuffer.slice(0, nl);
      this.controlBuffer = this.controlBuffer.slice(nl + 1);
      let msg: { t?: string; reason?: string; relation?: string; id?: number; kind?: string; session?: string; ok?: boolean; value?: unknown; error?: { code?: string; message?: string } };
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.t === 'hb') this.lastHeartbeat = this.o.now();
      else if (msg.t === 'resp' && typeof msg.id === 'number') {
        const err = msg.ok ? undefined : new Error(msg.error?.message ?? 'rpc failed') as Error & { code?: string }; if (err) err.code = msg.error?.code ?? 'rpc_failed'; this.settleRequest(msg.id, msg.value, err);
      }
      else if (msg.t === 'ask' && typeof msg.id === 'number' && msg.session === this.session) void this.answerAsk(msg as { id: number; kind: string }, from, this.session);
      else if (msg.t === 'dirty' && msg.relation) { try { this.o.onDirty?.(msg.relation); } catch { /* best effort */ } }
      else if (msg.t === 'pause') this.disable('privacy_diverged', msg.reason ?? 'child requested a pause');
    }
    // A `resp` line can carry thousands of digest entries; only a runaway partial line is dropped.
    if (this.controlBuffer.length > 16 * 1024 * 1024) this.controlBuffer = '';
  }

  /** Answers one `ask` line: the handler's value, or its error code. A refused write is the child's timeout. */
  private async answerAsk(ask: { id: number; kind: string }, from: ChildProcess, session: string): Promise<void> {
    let line: Record<string, unknown>;
    try {
      if (!this.o.onAsk) throw Object.assign(new Error('no handler'), { code: 'unsupported' });
      // This callback runs in the context of whichever request spawned the child (its stdout listener was made there): a cancelled request's
      // signal and a preparation's read deadline must not reach a later ask. Each ask gets a signal and a deadline of its own.
      const onAsk = this.o.onAsk;
      line = { t: 'answer', id: ask.id, session, ok: true, value: await withoutReadDeadline(() => withRequestSignal(AbortSignal.timeout(ASK_DEADLINE_MS), () => onAsk(ask))) };
    } catch (error) {
      line = { t: 'answer', id: ask.id, session, ok: false, error: { code: askCode(error) } }; // a code from the allowlist, never an exception message
    }
    if (this.child !== from || this.session !== session) return; // the asking child is gone or replaced: its answer is dropped, never sent to a successor
    try { this.send(JSON.stringify(line) + '\n'); } catch { /* the child times out */ }
  }

  private onExit(child: ChildProcess | null, code: number | null, signal: string | null): void {
    if (child && this.child !== child) return;
    if (child && this.acceptedWeight > 0) this.writeOwedRecord(false, true, true); // durable before anything about this session is reset (or kept, marked and retried): the next owner worker settles what the dead child never did
    this.dropStaged(); this.oweDirty = false; // nothing queued is left for a flush to write: the exit-time record (written or kept) already states everything accepted
    this.child = null; if (this.kept.size === 0) liveSupervisors.delete(this);
    this.clearWatchdog();
    this.rejectRequests('child_unavailable');
    if (this.disabledReason) return;
    const now = this.o.now();
    this.fault('child_exit', `code=${code ?? 'none'} signal=${signal ?? 'none'}`);
    this.exits = [...this.exits.filter((t) => now - t < this.o.restartWindowMs), now];
    if (this.exits.length >= this.o.maxRestarts) {
      this.disable('restart_budget_spent', `${this.exits.length} child exits within ${Math.round(this.o.restartWindowMs / 60_000)} minutes`);
      return;
    }
    this.nextSpawnAt = now + this.backoffMs;
    this.backoffMs = Math.min(this.o.maxBackoffMs, this.backoffMs * 2);
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    const every = Math.max(250, Math.min(5_000, Math.floor(this.o.hangMs / 4)));
    this.watchdog = setInterval(() => this.checkHang(), every);
    (this.watchdog as { unref?: () => void }).unref?.();
  }

  /** Kills a child that sent no heartbeat within hangMs. Public for tests. */
  checkHang(): void {
    const child = this.child;
    if (!child || this.o.now() - this.lastHeartbeat < this.o.hangMs) return;
    this.fault('child_hung', `no heartbeat for ${Math.round((this.o.now() - this.lastHeartbeat) / 1000)}s`);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    this.onExit(child, null, 'SIGKILL');
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearInterval(this.watchdog);
    this.watchdog = null;
  }
}
