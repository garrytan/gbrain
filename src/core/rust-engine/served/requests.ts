/**
 * Server-wide request ids of protocol v3 (interface I-7; decision 6 of the L3 plan). A client puts a `req` (UUID v7)
 * on every call and resends the same `req` with `retry: true` when it lost the answer. The state machine:
 *
 *   fresh `req`                          -> runs
 *   retry, same principal, still running -> attaches: answered with the running call's outcome
 *   retry, same principal, finished      -> the stored outcome, nothing runs
 *   retry, no record (restart, eviction) -> a read runs again; a journaled operation runs again with its journal
 *                                           request id bound to `req`, so the write journal answers with its recorded
 *                                           receipt and never writes twice; any other write ends `outcome_unknown`
 *                                           and never runs again
 *   same `req`, other arguments          -> `idempotency_conflict`, nothing runs
 *
 * A call refused before it ran (`owner_busy`, a protocol or credential refusal) leaves no record, so its retry is fresh.
 * Records are kept per authenticated principal, bounded by count, bytes and age; memory is only an acceleration cache
 * of the durable answer for journaled operations.
 */
import type { Wire } from '../owner-ipc/codec.ts';

export interface StoredOutcome { ok: boolean; value?: Wire; error?: Wire; position?: Wire }

interface Entry {
  key: string;
  ph: string;
  member: string;
  done: boolean;
  outcome?: StoredOutcome;
  waiters: Array<(outcome: StoredOutcome | null) => void>;
  at: number;
  bytes: number;
}

export type Admission =
  | { kind: 'fresh'; entry: Entry }
  | { kind: 'replay'; entry: Entry }
  | { kind: 'attach'; outcome: Promise<StoredOutcome | null> }
  | { kind: 'stored'; outcome: StoredOutcome }
  | { kind: 'conflict' }
  | { kind: 'busy' }
  | { kind: 'unknown' };

export interface RequestTableOptions { maxEntries?: number; maxBytes?: number; ttlMs?: number; now?: () => number }

/** Retries that may wait on one running request at once; one more is refused `owner_busy` (review G6). */
export const MAX_REQUEST_WAITERS = 8;

export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RequestTable {
  private readonly entries = new Map<string, Entry>();
  private bytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: RequestTableOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.maxBytes = opts.maxBytes ?? 64 * 1024 * 1024;
    this.ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number { return this.entries.size; }

  /**
   * Admits `req` for `principal`. `rerunnable` is true for a read, or for a journaled operation whose journal request
   * id the caller binds to `req`.
   */
  begin(principal: string, req: string, ph: string, member: string, retry: boolean, rerunnable: boolean): Admission {
    this.expire();
    const key = `${principal}\u0000${req}`;
    const found = this.entries.get(key);
    if (found) {
      if (found.ph !== ph || found.member !== member) return { kind: 'conflict' };
      if (found.done) return { kind: 'stored', outcome: found.outcome! };
      if (found.waiters.length >= MAX_REQUEST_WAITERS) return { kind: 'busy' };
      return { kind: 'attach', outcome: new Promise(resolve => found.waiters.push(resolve)) };
    }
    if (retry && !rerunnable) return { kind: 'unknown' };
    const entry: Entry = { key, ph, member, done: false, waiters: [], at: this.now(), bytes: 0 };
    this.entries.set(key, entry);
    return { kind: retry ? 'replay' : 'fresh', entry };
  }

  /** The call ended: its outcome answers later retries and every attached waiter. */
  finish(entry: Entry, outcome: StoredOutcome): void {
    if (this.entries.get(entry.key) !== entry) { for (const w of entry.waiters.splice(0)) w(outcome); return; }
    entry.done = true;
    entry.outcome = outcome;
    entry.at = this.now();
    entry.bytes = JSON.stringify(outcome).length;
    this.bytes += entry.bytes;
    for (const w of entry.waiters.splice(0)) w(outcome);
    this.evict();
  }

  /** The call never ran (refused before start): forget it, so a retry runs fresh. Waiters learn nothing. */
  abandon(entry: Entry): void {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    for (const w of entry.waiters.splice(0)) w(null);
  }

  private lastExpire = 0;

  /** Drops finished records older than the age bound; at most one sweep a second. Running calls always stay. */
  private expire(): void {
    const now = this.now();
    if (now - this.lastExpire < 1000) return;
    this.lastExpire = now;
    const cutoff = now - this.ttlMs;
    for (const [key, entry] of this.entries) {
      if (!entry.done || entry.at >= cutoff) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
  }

  private evict(): void {
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) return;
      if (!entry.done) continue;
      this.entries.delete(key);
      this.bytes -= entry.bytes;
    }
  }
}
