/**
 * Durable writer observations for swap eligibility (docs/designs/RUST_ENGINE.md "Swap and the way back", plan PR S5).
 *
 * While shadow mode is on for a brain, every process that opens it through the engine factory notes each committed
 * write here: one row per (host id, application_name) in the primary's `engine_writer_observations`, refreshed at most
 * every OBSERVATION_REFRESH_MS. The note runs after the write committed, in its own short transaction on the unwrapped
 * primary, so it never joins, slows or fails the caller's write. A brain with no shadow gets the empty table from the
 * migration and no statement from here: the observer exists only inside the shadow wrapper.
 *
 *   wrapped write commits ──▶ WriterObserver.note() ──▶ (throttled) upsert on the bare primary
 *                                                     └─ failure ──▶ faults.jsonl `writer_observation_failed` (code only)
 *   swap / status builder ──▶ readWriterHosts(engine, since): one read-only SELECT
 *
 * A failed write is never retried into the caller's path; it leaves a fault record whose time the eligibility source
 * counts as a gap, so a missing row can only make eligibility stricter. The background-work registry drains an
 * in-flight note before the engine disconnects, within its bound. Rows hold no path, argument or query text.
 */
import type { BrainEngine } from '../core/engine.ts';
import { registerBackgroundWorkDrainer } from '../core/background-work.ts';
import { appendFault } from './ledger.ts';

/** A process refreshes its row at most this often; eligibility subtracts the same slack from its window start. */
export const OBSERVATION_REFRESH_MS = 10 * 60_000;

/** The one statement a note runs: insert the row, or refresh last_seen when it is older than the refresh interval. */
const NOTE_SQL = `INSERT INTO engine_writer_observations (host_id, application_name, process_kind, gbrain_version)
VALUES ($1, $2, $3, $4)
ON CONFLICT (host_id, application_name) DO UPDATE SET last_seen = now(), process_kind = EXCLUDED.process_kind, gbrain_version = EXCLUDED.gbrain_version
WHERE engine_writer_observations.last_seen < now() - interval '${OBSERVATION_REFRESH_MS / 1000} seconds'`;

/** The eligibility read: distinct hosts with a row seen at or after `since` (database clock), plus the newest time. */
const HOSTS_SQL = `SELECT host_id::text AS host_id, max(last_seen) AS last_seen FROM engine_writer_observations
WHERE last_seen >= $1::timestamptz GROUP BY host_id ORDER BY host_id`;

export interface WriterIdentity {
  hostId: string;
  applicationName: string;
  processKind: string;
  gbrainVersion: string;
}

export interface WriterObserverOptions {
  /** The bare primary engine (never the shadow wrapper, so the note is not observed or followed itself). */
  primary: BrainEngine;
  /** Resolved lazily on the first note: a host id needs a connected engine for embedded opens. */
  identity: () => WriterIdentity;
  /** The shadow directory, for the failure record. */
  dir: string;
  now?: () => number;
  /** Seam for tests: where a failure is recorded. */
  recordFailure?: (code: string) => void;
}

function errorCode(error: unknown): string {
  const rec = (error && typeof error === 'object' ? error : {}) as { code?: unknown };
  return typeof rec.code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(rec.code) ? rec.code : 'unknown';
}

const live = new Set<WriterObserver>();
registerBackgroundWorkDrainer({
  name: 'shadow-writer-observations',
  order: 6,
  async drain(timeoutMs) {
    const pending = [...live].map(o => o.inFlight).filter((p): p is Promise<void> => p !== null);
    if (pending.length === 0) return { unfinished: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); });
    const done = await Promise.race([Promise.allSettled(pending).then(() => 'done' as const), bound]);
    if (timer) clearTimeout(timer);
    return { unfinished: done === 'done' ? 0 : [...live].filter(o => o.inFlight !== null).length };
  },
});

/** Notes committed writes of one process. `note()` is synchronous and never throws. */
export class WriterObserver {
  /** The note being written, if any (the drainer awaits it). */
  inFlight: Promise<void> | null = null;
  private lastWritten = Number.NEGATIVE_INFINITY;
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly o: WriterObserverOptions) {
    this.now = o.now ?? Date.now;
    live.add(this);
  }

  /** Called after a write committed. Starts at most one write per refresh interval; one at a time. */
  note(): void {
    try {
      if (this.stopped || this.inFlight) return;
      const t = this.now();
      if (t - this.lastWritten < OBSERVATION_REFRESH_MS) return;
      // Marked before the write starts, so concurrent notes coalesce; a failure clears it so the next write retries.
      this.lastWritten = t;
      this.inFlight = this.write().finally(() => { this.inFlight = null; });
    } catch { /* the shadow never fails a call */ }
  }

  private async write(): Promise<void> {
    try {
      const id = this.o.identity();
      await this.o.primary.transaction(async (tx) => {
        await tx.executeRaw(NOTE_SQL, [id.hostId, id.applicationName, id.processKind, id.gbrainVersion]);
      });
    } catch (error) {
      this.lastWritten = Number.NEGATIVE_INFINITY;
      const code = errorCode(error);
      try {
        (this.o.recordFailure ?? ((c: string) => appendFault(this.o.dir, { ts: new Date(this.now()).toISOString(), kind: 'writer_observation_failed', detail: `code=${c}` })))(code);
      } catch { /* a full disk loses the record, never the caller */ }
    }
  }

  /** Stops new notes (engine disconnect); an in-flight note still settles through the drainer. */
  stop(): void {
    this.stopped = true;
    if (!this.inFlight) live.delete(this);
    else void this.inFlight.finally(() => live.delete(this));
  }
}

export interface WriterHostRow { host_id: string; last_seen: string }

/** The eligibility read: one read-only SELECT. Throws what the engine throws; the caller turns that into an omission. */
export async function readWriterHosts(engine: BrainEngine, since: Date): Promise<WriterHostRow[]> {
  const rows = await engine.executeRaw<{ host_id: string; last_seen: unknown }>(HOSTS_SQL, [since.toISOString()]);
  return rows.map(r => ({ host_id: String(r.host_id), last_seen: r.last_seen instanceof Date ? r.last_seen.toISOString() : String(r.last_seen) }));
}
