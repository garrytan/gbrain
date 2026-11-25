/**
 * The serving process's bounded registry of recent captured samples, keyed by an OPAQUE sample id. A sampled read goes to
 * the child with its sample id; when the child later asks the serving process a question about it (privacy check, stable
 * rerun, vector reference) it names the sample id only, so the read's arguments and the caller's access record (identities,
 * folder rules) never travel back over the control channel. An id the registry no longer holds answers `sample_unknown`
 * and the sample stays unresolved. Bounded by entries and by bytes; the oldest entries go first.
 */
import { randomBytes } from 'node:crypto';
import type { CallerAccess } from '../core/search/private-visibility.ts';

/** One stable rerun of a sample, immutable once made: its own time, write generation, freshness token and encoded answer. The asks about it name its attempt id; two reruns of one sample never share a slot. */
export interface RerunAttempt { at: number; gen?: number; lsn?: string; result?: unknown }
export const RERUN_ATTEMPTS_KEPT = 8;

export interface Sample {
  op: string;
  /** Encoded call arguments. */
  args: unknown;
  access?: CallerAccess;
  /** Epoch milliseconds when the primary call returned. */
  at: number;
  /** The serving process's write generation (follower.published) when the read was captured; undefined without a follower. */
  gen?: number;
  /** The primary's freshness token (the field is called `lsn`) known before the read started (checks.ts `createLsnWatch`); undefined when none was known yet, and then nothing is proven unchanged. */
  lsn?: string;
  /** The primary's encoded answer; the serving process compares the child's rows with it, so it never goes back over the control channel. */
  result?: unknown;
  /** The stable reruns of this sample by attempt id (the last RERUN_ATTEMPTS_KEPT): an id not here, or one dropped, answers `moved`. */
  reruns?: Map<string, RerunAttempt>;
}

export const SAMPLE_REGISTRY_MAX_ENTRIES = 1024;
export const SAMPLE_REGISTRY_MAX_BYTES = 64 * 1024 * 1024;

export class SampleRegistry {
  /** Names this process's ids; an id from another process or run is unknown here. */
  private readonly nonce = randomBytes(6).toString('hex');
  private counter = 0;
  private bytes = 0;
  private readonly entries = new Map<string, { sample: Sample; bytes: number }>();

  constructor(private readonly maxEntries = SAMPLE_REGISTRY_MAX_ENTRIES, private readonly maxBytes = SAMPLE_REGISTRY_MAX_BYTES) {}

  add(sample: Sample, bytes: number): string {
    const id = `${this.nonce}.${++this.counter}`;
    this.entries.set(id, { sample, bytes });
    this.bytes += bytes;
    this.evict(id);
    return id;
  }

  /** Drops the oldest entries, never `keep`, until the registry is within both caps. A single new sample over the byte cap is kept until the next one arrives. */
  private evict(keep: string): void {
    for (const [oldest, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      if (oldest === keep) continue; // the entry being charged stays; every other one, older or newer, can go
      this.entries.delete(oldest);
      this.bytes -= e.bytes;
    }
  }

  /**
   * Charges `bytes` more to an entry (a rerun's answer kept beside the sample); the oldest other entries go first until the total is within the cap.
   * Returns false, and charges nothing, when the entry itself would pass the byte cap with it: the answer is not kept. An entry that is gone holds nothing and answers true.
   */
  charge(id: string, bytes: number): boolean {
    const e = this.entries.get(id);
    if (!e) return true;
    if (e.bytes + bytes > this.maxBytes) return false;
    e.bytes += bytes;
    this.bytes += bytes;
    this.evict(id);
    return true;
  }

  get(id: unknown): Sample | undefined { return typeof id === 'string' ? this.entries.get(id)?.sample : undefined; }

  drop(id: string): void {
    const e = this.entries.get(id);
    if (e) { this.entries.delete(id); this.bytes -= e.bytes; }
  }

  get size(): number { return this.entries.size; }

  /** The bytes charged to every entry held. */
  get totalBytes(): number { return this.bytes; }
}
