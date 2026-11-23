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
  /** Set when the stable rerun read the primary again: the time and generation of that read. */
  rerun?: { at: number; gen?: number };
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
    for (const [oldest, e] of this.entries) {
      if (this.entries.size <= this.maxEntries && this.bytes <= this.maxBytes) break;
      if (oldest === id) break; // a single sample over the byte cap is kept until the next one arrives
      this.entries.delete(oldest);
      this.bytes -= e.bytes;
    }
    return id;
  }

  get(id: unknown): Sample | undefined { return typeof id === 'string' ? this.entries.get(id)?.sample : undefined; }

  drop(id: string): void {
    const e = this.entries.get(id);
    if (e) { this.entries.delete(id); this.bytes -= e.bytes; }
  }

  get size(): number { return this.entries.size; }
}
