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
import { CaptureTooLargeError } from './codec.ts';

/** One captured primary read, frozen at capture time: `args` and `result` are already `encodeValue` output. */
export interface CapturedRead {
  op: string;
  /** Encoded call arguments (plain JSON). */
  args: unknown;
  /** Encoded primary result (plain JSON). */
  result: unknown;
  /** Primary wall time in milliseconds. */
  primary_ms: number;
  /** Epoch milliseconds when the primary call returned. */
  at: number;
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
  private readonly items: CapturedRead[] = [];
  private scheduled = false;
  private sinceStats = 0;
  private stopped = false;
  private readonly bound: number;
  private readonly transport: MirrorTransport;
  private readonly maxLineBytes: number;
  private readonly statsEvery: number;
  private readonly schedule: (fn: () => void) => void;

  constructor(opts: MirrorQueueOptions) {
    this.bound = Math.max(1, opts.bound);
    this.transport = opts.transport;
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
    this.statsEvery = Math.max(1, opts.statsEvery ?? 50);
    this.schedule = opts.schedule ?? ((fn) => { setImmediate(fn); });
  }

  /** Queued, not yet delivered. */
  get depth(): number { return this.items.length; }

  /**
   * Accepts a read or sheds it. `capture` runs synchronously, only when the queue has room, and must return the read
   * already encoded; a throw counts as `encode_error`. Never throws, never awaits.
   */
  offer(capture: () => CapturedRead): void {
    if (this.stopped) return;
    this.counters.offered++;
    if (this.items.length >= this.bound) {
      this.counters.shed_queue_full++;
      return;
    }
    let read: CapturedRead;
    try {
      read = capture();
    } catch (error) {
      this.counters[error instanceof CaptureTooLargeError ? 'shed_too_large' : 'encode_error']++;
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
      try {
        line = JSON.stringify({
          t: 'read', id: nextId++, at: read.at, op: read.op, primary_ms: read.primary_ms,
          args: read.args, result: read.result,
        }) + '\n';
      } catch {
        this.counters.encode_error++;
        continue;
      }
      if (Buffer.byteLength(line) > this.maxLineBytes) {
        this.counters.shed_too_large++;
        continue;
      }
      let accepted = false;
      try { accepted = this.transport.send(line); } catch { accepted = false; }
      if (accepted) this.counters.sent++;
      else this.counters.shed_transport++;
      if (++this.sinceStats >= this.statsEvery) this.flushStats();
    }
    if (this.items.length > 0) this.kick();
  }
}
