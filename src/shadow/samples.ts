/**
 * The serving process's bounded registry of recent captured samples, keyed by an OPAQUE sample id. A sampled read goes to
 * the child with its sample id; when the child later asks the serving process a question about it (privacy check, stable
 * rerun, vector reference) it names the sample id only, so the read's arguments and the caller's access record (identities,
 * folder rules) never travel back over the control channel. An id the registry no longer holds answers `sample_unknown`
 * and the sample stays unresolved. Bounded by entries and by bytes; the oldest entries go first.
 */
import { randomBytes } from 'node:crypto';
import type { CallerAccess } from '../core/search/private-visibility.ts';

export interface Sample {
  op: string;
  /** Encoded call arguments. */
  args: unknown;
  access?: CallerAccess;
  /** Epoch milliseconds when the primary call returned. */
  at: number;
  /** The serving process's write generation (follower.published) when the read was captured; undefined without a follower. */
  gen?: number;
  /** The policy fingerprint of the primary's data at capture (checks.ts `createPolicyWatch`): the latest the database held before the read returned; undefined when none was known yet, and then nothing is proven unchanged. */
  fp?: string;
  /** The primary's encoded answer; the serving process compares the child's rows with it, so it never goes back over the control channel. */
  result?: unknown;
  /** Set when the stable rerun read the primary again: the time, generation and fingerprint of that read, and its encoded answer once it returned. */
  rerun?: { at: number; gen?: number; fp?: string; result?: unknown };
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

  private evict(keep: string): void {
    for (const [oldest, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      if (oldest === keep) break; // a single sample over the byte cap is kept until the next one arrives
      this.entries.delete(oldest);
      this.bytes -= e.bytes;
    }
  }

  /** Charges `bytes` more to an entry (a rerun's answer kept beside the sample); the oldest entries go first when the cap is passed. */
  charge(id: string, bytes: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    e.bytes += bytes;
    this.bytes += bytes;
    this.evict(id);
  }

  get(id: unknown): Sample | undefined { return typeof id === 'string' ? this.entries.get(id)?.sample : undefined; }

  drop(id: string): void {
    const e = this.entries.get(id);
    if (e) { this.entries.delete(id); this.bytes -= e.bytes; }
  }

  get size(): number { return this.entries.size; }
}
