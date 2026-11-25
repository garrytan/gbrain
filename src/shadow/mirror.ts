/**
 * The bounded, fail-open mirror queue in the serving process (plan PR S1).
 *
 * The engine wrapper `offer`s a sampled read as a capture function and returns at once. When the queue has room it
 * calls the capture function synchronously, before the caller sees the result, so the read is frozen into plain JSON
 * values (codec.ts `encodeValue`) at capture time: a caller that changes the result object afterwards cannot change
 * what the shadow compares. Only sampled reads the queue accepts pay that encode; a full queue sheds the event
 * without encoding it, and the encode itself stops at a 1 MiB budget (counted `too_large`). The queue drains on `setImmediate`, stringifies each event to one NDJSON line there and hands
 * it to the transport (the supervisor's child pipe); a line over the size cap is shed as `too_large`. Every shed, sample miss and in-transaction skip is counted, and the counts travel to the child as a
 * `stats` event so the ledger and the report show what was not observed.
 */
import type { CallerAccess } from '../core/search/private-visibility.ts';
import { CaptureTooLargeError } from './codec.ts';
import type { SampleRegistry } from './samples.ts';

/** One captured primary read, frozen at capture time: `args` and `result` are already `encodeValue` output. */
export interface CapturedRead {
  /** The caller-access record the primary read ran under (private-visibility.ts, frozen), absent when there was none; the child runs Rust under it and the policy check judges rows by it. Never written to the ledger. */
  access?: CallerAccess;
  op: string;
  /** Encoded call arguments (plain JSON). */
  args: unknown;
  /** Encoded primary result (plain JSON). */
  result: unknown;
  /** Primary wall time in milliseconds. */
  primary_ms: number;
  /** Epoch milliseconds when the primary call returned. */
  at: number;
  /** The serving process's write generation before the primary read started (MirrorQueue.token). */
  gen?: number;
  /** The primary's freshness token (checks.ts `createLsnWatch`; the field is still called `lsn`) the serving process knew before the primary read started (MirrorQueue.token). */
  lsn?: string;
}

/** Counters the serving process keeps; sent to the child in `stats` events. Cumulative for the process. */
export interface MirrorCounters {
  offered: number;
  sent: number;
  shed_queue_full: number;
  shed_too_large: number;
  shed_transport: number;
  shed_unmirrorable: number;
  sampled_out: number;
  skipped_in_transaction: number;
  primary_error: number;
  encode_error: number;
}

/** `offered` is every call of the class the wrapper saw while mirroring was active (not mirror.ts's queue counter). */
export interface OpUsage { offered: number; sampled_out: number; shed: number; skipped_in_transaction: number; unmirrorable: number }
export type UsageField = keyof OpUsage;

export const zeroUsage = (): OpUsage => ({ offered: 0, sampled_out: 0, shed: 0, skipped_in_transaction: 0, unmirrorable: 0 });

/** Counts noted under one evidence epoch (null: no epoch was current). */
export interface UsageBucket { epoch_id: string | null; ops: Record<string, OpUsage> }

/**
 * Per-operation call counts, bucketed by the evidence epoch current when each call was noted. The first call of a class
 * under an epoch is also handed to `register` at once (before sampling decides anything), so the class is on disk even
 * if the process dies before its next flush.
 */
export class UsageMeter {
  private buckets = new Map<string | null, Record<string, OpUsage>>();
  private readonly registered = new Set<string>();
  private hooks: { epoch?: () => string | null; register?: (epoch: string | null, op: string) => void } = {};

  /** Sets where the current epoch comes from and where a first use is written. */
  bind(hooks: { epoch?: () => string | null; register?: (epoch: string | null, op: string) => void }): void { this.hooks = hooks; }

  note(op: string, field: UsageField): void {
    const epoch = this.hooks.epoch?.() ?? null;
    const ops = this.buckets.get(epoch) ?? this.buckets.set(epoch, {}).get(epoch)!;
    (ops[op] ??= zeroUsage())[field]++;
    const key = `${epoch}\0${op}`;
    if (this.registered.has(key)) return;
    this.registered.add(key);
    try { this.hooks.register?.(epoch, op); } catch { /* the counts stay in memory for the next flush */ }
  }

  /** The counts since the last take, one bucket per epoch, or null when there are none. */
  take(): UsageBucket[] | null {
    if (this.buckets.size === 0) return null;
    const out = [...this.buckets].map(([epoch_id, ops]) => ({ epoch_id, ops }));
    this.buckets = new Map();
    return out;
  }

  /** Puts counts back after a take whose write failed, so a full disk delays them and never drops a class. */
  restore(taken: UsageBucket[]): void {
    for (const { epoch_id, ops: back } of taken) {
      const ops = this.buckets.get(epoch_id) ?? this.buckets.set(epoch_id, {}).get(epoch_id)!;
      for (const [op, u] of Object.entries(back)) {
        const into = (ops[op] ??= zeroUsage());
        for (const key of Object.keys(u) as UsageField[]) into[key] += u[key];
      }
    }
  }
}

/** Where encoded lines go. `send` returns false when the line was not accepted (no child, pipe backed up). */
export interface MirrorTransport {
  send(line: string): boolean;
}

export interface MirrorQueueOptions {
  bound: number;
  transport: MirrorTransport;
  /** Encoded-line cap in bytes; default 1 MiB. */
  maxLineBytes?: number;
  /** Stats cadence in delivered events; default every 50 events. */
  statsEvery?: number;
  /** Scheduler seam for tests; default setImmediate. */
  schedule?: (fn: () => void) => void;
  /** Where each delivered sample is kept under an opaque id, so the child asks about it by id (samples.ts). */
  samples?: SampleRegistry;
  /** The serving process's write generation, read the moment a read is captured (follower.published). */
  generation?: () => number | undefined;
  /** The primary's freshness token, as last read: never newer than the read it is taken for (checks.ts `createLsnWatch`). */
  lsn?: () => string | undefined;
}

export const DEFAULT_MAX_LINE_BYTES = 1024 * 1024;

export function newMirrorCounters(): MirrorCounters {
  return {
    offered: 0, sent: 0, shed_queue_full: 0, shed_too_large: 0, shed_transport: 0, shed_unmirrorable: 0,
    sampled_out: 0, skipped_in_transaction: 0, primary_error: 0, encode_error: 0,
  };
}

let nextId = 1;

export class MirrorQueue {
  readonly counters: MirrorCounters = newMirrorCounters();
  /** Per-operation call counts; the serving process flushes them to the usage files (usage.ts). */
  readonly meter = new UsageMeter();
  private readonly items: CapturedRead[] = [];
  private scheduled = false;
  private sinceStats = 0;
  private stopped = false;
  private readonly bound: number;
  private readonly transport: MirrorTransport;
  private readonly maxLineBytes: number;
  private readonly statsEvery: number;
  private readonly schedule: (fn: () => void) => void;
  private readonly samples?: SampleRegistry;
  private readonly generation?: () => number | undefined;
  private readonly lsn?: () => string | undefined;

  constructor(opts: MirrorQueueOptions) {
    this.bound = Math.max(1, opts.bound);
    this.transport = opts.transport;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.statsEvery = Math.max(1, opts.statsEvery ?? 50);
    this.schedule = opts.schedule ?? ((fn) => { setImmediate(fn); });
    this.samples = opts.samples;
    this.generation = opts.generation;
    this.lsn = opts.lsn;
  }

  /**
   * What the serving process knew BEFORE a primary read started (its write generation, the primary's freshness token): the wrapper takes it
   * ahead of the call and hands it back in the capture. It is never taken later: a token adopted after the read's snapshot could
   * name a newer corpus than the one the answer came from, and a sample without one is never proven unchanged.
   */
  token(): { gen?: number; lsn?: string } {
    const out: { gen?: number; lsn?: string } = {};
    try { out.gen = this.generation?.(); } catch { /* none: unresolved, never cleared */ }
    try { out.lsn = this.lsn?.(); } catch { /* none: unresolved, never cleared */ }
    return out;
  }

  /** Queued, not yet delivered. */
  get depth(): number { return this.items.length; }

  /**
   * Accepts a read or sheds it. `capture` runs synchronously, only when the queue has room, and must return the read
   * already encoded; a throw counts as `encode_error`. Never throws, never awaits.
   */
  offer(capture: () => CapturedRead, op?: string): void {
    if (this.stopped) return;
    this.counters.offered++;
    if (this.items.length >= this.bound) {
      this.counters.shed_queue_full++;
      if (op) this.meter.note(op, 'shed');
      return;
    }
    let read: CapturedRead;
    try {
      read = capture();
    } catch (error) {
      const tooLarge = error instanceof CaptureTooLargeError;
      this.counters[tooLarge ? 'shed_too_large' : 'encode_error']++;
      if (op) this.meter.note(op, tooLarge ? 'shed' : 'unmirrorable');
      return;
    }
    this.items.push(read);
    this.kick();
  }

  /** Delivers what is queued now (a short-lived process disconnects before the next tick), then stops accepting. */
  stop(): void {
    while (this.items.length > 0) this.drain();
    this.stopped = true;
  }

  /** Sends a stats event now (also used at shutdown). */
  flushStats(): void {
    this.sinceStats = 0;
    try { this.transport.send(JSON.stringify({ t: 'stats', at: Date.now(), pid: process.pid, counters: this.counters }) + '\n'); } catch { /* fail open */ }
  }

  private kick(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    // Bounded per tick so a burst never monopolizes the event loop; the rest drains on the next tick.
    let budget = 64;
    while (this.items.length > 0 && budget-- > 0) {
      const read = this.items.shift()!;
      let line: string;
      let sid: string | undefined;
      try {
        // The child names this sample by `sid` alone when it asks the serving process about it (samples.ts).
        sid = this.samples?.add({ op: read.op, args: read.args, result: read.result, access: read.access, at: read.at, gen: read.gen, lsn: read.lsn }, 1024);
        line = JSON.stringify({
          t: 'read', id: nextId++, sid, at: read.at, op: read.op, primary_ms: read.primary_ms,
          args: read.args, result: read.result, access: read.access,
        }) + '\n';
      } catch {
        if (sid) this.samples?.drop(sid);
        this.counters.encode_error++;
        this.meter.note(read.op, 'unmirrorable');
        continue;
      }
      if (sid) this.samples?.charge(sid, line.length); // the sample keeps the arguments and the answer the line carries
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        if (sid) this.samples?.drop(sid);
        this.counters.shed_too_large++;
        this.meter.note(read.op, 'shed');
        continue;
      }
      let accepted = false;
      try { accepted = this.transport.send(line); } catch { accepted = false; }
      if (accepted) this.counters.sent++;
      else { if (sid) this.samples?.drop(sid); this.counters.shed_transport++; this.meter.note(read.op, 'shed'); }
      if (++this.sinceStats >= this.statsEvery) this.flushStats();
    }
    if (this.items.length > 0) this.kick();
  }
}
