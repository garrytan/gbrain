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
 */
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withoutReadDeadline } from '../core/read-deadline.ts';
import { withRequestSignal } from '../core/request-signal.ts';
import { spawn as defaultSpawn } from '../core/spawn.ts';
import { readEpoch } from './evidence-epoch.ts';
import { appendFault, type ShadowFault } from './ledger.ts';
import type { MirrorTransport } from './mirror.ts';
import { readShadowState } from './state.ts';
import { sentPath } from './write-compare.ts';

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
  /** Bytes of write samples that may be in the pipe, handed to it and not yet flushed, before a new sample is refused (the caller counts it `send_shed`). */
  maxBufferedBytes?: number;
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

/**
 * How many samples a line stands for: 0 when it is not a write sample. Read only from text the sampler wrote itself, never from page content: a sample starts with its own first key
 * (`{"t":"write"`), and the count of earlier losses that could not be recorded is its LAST top-level field (`,"dropped":<n>}` and a newline, the sampler appends it after the event), so a
 * key named `dropped` inside a page ends `}}` and cannot match. Capped at 10,000 (the child's own cap). The child counts the same weight for each sample line it reads (child.ts).
 */
export function sampleWeight(line: string): number {
  if (!line.startsWith('{"t":"write"')) return 0;
  const dropped = /,"dropped":(\d{1,5})\}\n$/.exec(line.length > 40 ? line.slice(-40) : line);
  return 1 + (dropped ? Math.min(Number(dropped[1]), 10_000) : 0);
}

/** Supervisors with a running child: a process that exits with one still unflushed loses lines (Bun drops what its pipe holds), so the exit hook writes each one's sent count for the child to compare. */
const liveSupervisors = new Set<ShadowSupervisor>();
let exitWatched = false;
function watchProcessExit(): void {
  if (exitWatched) return;
  exitWatched = true;
  process.on('exit', recordAllSentAtExit);
}
/** The process-exit hook (and a seam for tests): every live supervisor writes how many write samples it sent its child, synchronously. */
export function recordAllSentAtExit(): void { for (const supervisor of [...liveSupervisors]) supervisor.recordSent(); }

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
  /** Write samples (with the losses they carry) accepted for the current child: written down at stop, so the child can count what its pipe never delivered (`recordSent`). */
  private sentWeight = 0;
  private sentRecorded = ''; // the session and weight `recordSent` wrote (or tried to) already
  private stdinRef: (NodeJS.WritableStream & { writableFinished?: boolean }) | null = null;
  private readonly drainWaiters = new Set<() => void>();
  private readonly o: Required<Omit<ShadowSupervisorOptions, 'spawn' | 'recordFault' | 'stillEnabled' | 'onDirty' | 'onAsk'>> & Pick<ShadowSupervisorOptions, 'spawn' | 'recordFault' | 'stillEnabled' | 'onDirty' | 'onAsk'>;

  constructor(opts: ShadowSupervisorOptions) {
    this.o = {
      now: Date.now, minBackoffMs: 1_000, maxBackoffMs: 60_000, maxRestarts: 5, restartWindowMs: 10 * 60_000,
      hangMs: 60_000, stateCheckMs: 30_000, maxBufferedBytes: 8 * 1024 * 1024, drainMs: 2_000,
      ...opts,
    };
    this.backoffMs = this.o.minBackoffMs;
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
    const entry = { bytes: line.length, weight };
    this.flight.add(entry); if (weight > 0) this.sampleBytes += entry.bytes;
    try { stdin.write(line, () => this.forget(entry)); } catch { this.forget(entry); return false; }
    this.sentWeight += weight;
    return true;
  }

  private forget(entry: { bytes: number; weight: number }): void {
    if (!this.flight.delete(entry)) return;
    if (entry.weight > 0) this.sampleBytes -= entry.bytes;
    if (this.flight.size === 0) for (const wake of [...this.drainWaiters]) wake();
  }

  /**
   * Writes down how many write samples this process sent the current child (`write-sent.<session>.json`, one small atomic file, no lock). The child counts the samples it read; at the end of its
   * input it counts the difference as lost (`pipe_unflushed`), so a sample the pipe never delivered (Bun drops what it still holds when the process exits) is counted once by the child (the receipt stays, and status reads no evidence, when the child cannot write the count down), whether the
   * pipe was slow, the process exited at once or the exit came from anywhere else. A failed write of the sent count is a fault line (except a disk-write failure that also stops the fault line, a known limit in the changelog).
   */
  recordSent(): void {
    if (!this.session || this.sentWeight === 0 || this.sentRecorded === `${this.session}:${this.sentWeight}`) return; // once per session: the child that took the receipt removes it, and one written after that would be counted again
    this.sentRecorded = `${this.session}:${this.sentWeight}`;
    const path = sentPath(this.o.dir, this.session);
    try {
      const epoch_id = readEpoch(this.o.dir)?.epoch_id; // the epoch the samples were sent in: a receipt of an older epoch is never booked into a newer one
      writeFileSync(`${path}.tmp`, JSON.stringify({ session: this.session, sent: this.sentWeight, ...(this.child?.pid ? { pid: this.child.pid } : {}), ...(epoch_id ? { epoch_id } : {}) }) + '\n', { mode: 0o600 });
      renameSync(`${path}.tmp`, path);
    } catch { this.fault('write_samples_unrecorded', `sent_count n=${this.sentWeight}`); }
  }

  /**
   * At disconnect, before `stop()`: the CLI process is about to exit, and Bun drops what its pipe still holds then. Waits up to `ms` (default `drainMs`) for the write callbacks, then ends the
   * child's stdin and waits within the same bound for it to say it finished writing, so a child that is only slightly behind gets everything. Returns at once when nothing is in flight. What
   * is still in the pipe after that is not delivered, and the child counts it from the sent count `stop()` writes down.
   */
  async drain(ms: number = this.o.drainMs): Promise<void> {
    const stdin = this.stdinRef;
    if (!stdin || !this.child || this.flight.size === 0) return;
    const until = Date.now() + ms;
    const wait = (register: (wake: () => void) => () => void): Promise<void> => new Promise<void>((resolve) => {
      let off = (): void => {};
      const wake = (): void => { clearTimeout(timer); off(); this.drainWaiters.delete(wake); resolve(); };
      const timer = setTimeout(wake, Math.max(0, until - Date.now()));
      this.drainWaiters.add(wake); off = register(wake);
    });
    await wait(() => () => {});
    if (this.flight.size > 0 || (stdin as { writableFinished?: boolean }).writableFinished === true) return;
    this.recordSent(); // before the input ends: the child reads it when it sees the end
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
    if (child) this.recordSent(); // before the input ends: the child counts what it was never sent
    this.child = null; liveSupervisors.delete(this);
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
      this.session = session; this.sentWeight = 0;
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
    this.child = null; liveSupervisors.delete(this);
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
