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
 *   swap / status builder ──▶ readWriterEvidence(engine, since, ...): one read-only SELECT
 *
 * A failed write is never retried into the caller's path; it leaves a fault record whose time the eligibility source
 * counts as a gap, so a missing row can only make eligibility stricter. The background-work registry drains an
 * in-flight note before the engine disconnects, within its bound. Rows hold no path, argument or query text.
 */
import type { BrainEngine } from '../core/engine.ts';
import { registerBackgroundWorkDrainer } from '../core/background-work.ts';
import { appendFault } from './ledger.ts';
import { effectiveHookSql } from './writer-hooks.ts';

/** A process refreshes its row at most this often; eligibility subtracts the same slack from its window start. */
export const OBSERVATION_REFRESH_MS = 10 * 60_000;

/** The bounds a note runs under (SET LOCAL, so they end with its transaction). */
export const NOTE_LOCK_TIMEOUT_MS = 50;
export const NOTE_STATEMENT_TIMEOUT_MS = 2_000;

/** The one statement a note runs: insert the row, or refresh last_seen when it is older than the refresh interval. */
const NOTE_SQL = `INSERT INTO engine_writer_observations (host_id, application_name, process_kind, gbrain_version, write_protocol)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (host_id, application_name) DO UPDATE SET last_seen = now(), process_kind = EXCLUDED.process_kind, gbrain_version = EXCLUDED.gbrain_version, write_protocol = EXCLUDED.write_protocol
WHERE engine_writer_observations.last_seen < now() - interval '${OBSERVATION_REFRESH_MS / 1000} seconds'`;

/** The write-comparison protocol this build speaks: 2 keeps the per-session obligation of write samples (shadow/write-compare.ts). An observed writer with NULL or less wrote under an older build. */
export const WRITE_PROTOCOL = 2;

/**
 * The eligibility read, one read-only statement: hosts that claimed writes in the window; on a hooked (Postgres)
 * primary also the writing connections no process claimed, the gap rows, the brain tables with no hook, and the login
 * roles that can write a brain table but have no complete way to record evidence. The roles judged are the login roles and
 * every role a non-superuser login can SET ROLE to (the SET option of a membership on PostgreSQL 16 and newer, direct or
 * through a chain; plain membership below 16), because the trigger runs with the rights of the role that is current when
 * it fires; a table privilege or a column privilege on any column is a write. A role is covered only with the gap route:
 * INSERT on engine_writer_coverage_gaps (which has no sequence) and row-level security that lets it in (not enabled, or the
 * role is a superuser, bypasses it, or owns the table and the table does not force it). The session route alone is not
 * enough: a refresh the trigger skips (a row another transaction holds) can only be recorded as a gap. A role's
 * inherited rights count, so a member of pg_write_all_data is judged as itself. A brain table counts as unhooked
 * unless its hook is enabled for ordinary writes, statement-level, unconditional, on all four events and calls gbrain_note_writer().
 * A process claim resolves a session only while the claim is inside the window too: an expired claim cannot hide a current writer.
 * $1 window start, $2 hooks expected, $3 evidence tables, $4 trigger name, $5 where legacy writers count from (the window start, or the epoch start less the refresh slack, whichever is later).
 */
const EVIDENCE_SQL = `WITH brain AS (
  SELECT c.oid, c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relkind IN ('r', 'p') AND c.relname::text <> ALL($3::text[])
), evidence AS (
  SELECT c.oid, c.relname::text AS name, c.relrowsecurity, c.relforcerowsecurity, c.relowner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = current_schema() AND c.relname IN ('engine_writer_sessions', 'engine_writer_coverage_gaps')
)
SELECT
  (SELECT count(DISTINCT host_id) FROM engine_writer_observations WHERE last_seen >= $1::timestamptz)::int AS hosts,
  (SELECT count(*) FROM engine_writer_observations WHERE last_seen >= $5::timestamptz AND (write_protocol IS NULL OR write_protocol < ${WRITE_PROTOCOL}))::int AS legacy_write_writers,
  CASE WHEN $2::boolean THEN (SELECT count(*) FROM (SELECT DISTINCT s.application_name, s.client_addr FROM engine_writer_sessions s
    WHERE s.last_seen >= $1::timestamptz AND NOT EXISTS (SELECT 1 FROM engine_writer_observations o WHERE o.application_name = s.application_name AND o.last_seen >= $1::timestamptz)) u)::int ELSE 0 END AS unresolved,
  (SELECT count(*) FROM engine_writer_coverage_gaps WHERE created_at >= $1::timestamptz)::int AS gaps,
  CASE WHEN $2::boolean THEN (SELECT count(*) FROM brain b WHERE NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = b.oid AND ${effectiveHookSql('$4')}))::int ELSE 0 END AS unhooked,
  CASE WHEN $2::boolean THEN (SELECT count(*) FROM pg_roles r
    WHERE (r.rolcanlogin OR EXISTS (SELECT 1 FROM pg_roles l WHERE l.rolcanlogin AND NOT l.rolsuper
        AND CASE WHEN current_setting('server_version_num')::int >= 160000 THEN pg_has_role(l.oid, r.oid, 'SET') ELSE pg_has_role(l.oid, r.oid, 'MEMBER') END))
      AND EXISTS (SELECT 1 FROM brain b WHERE has_table_privilege(r.oid, b.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
        OR has_any_column_privilege(r.oid, b.oid, 'INSERT') OR has_any_column_privilege(r.oid, b.oid, 'UPDATE'))
      AND NOT EXISTS (SELECT 1 FROM evidence e
        WHERE e.name = 'engine_writer_coverage_gaps' AND has_table_privilege(r.oid, e.oid, 'INSERT')
          AND (NOT e.relrowsecurity OR r.rolsuper OR r.rolbypassrls OR (pg_has_role(r.oid, e.relowner, 'USAGE') AND NOT e.relforcerowsecurity))))::int ELSE 0 END AS uncovered_roles`;

export interface WriterEvidence { hosts: number; unresolved: number; gaps: number; unhooked: number; uncovered_roles: number; legacy_write_writers: number }

/** The eligibility read: one read-only SELECT. Throws what the engine throws; the caller turns that into an omission. */
export async function readWriterEvidence(engine: BrainEngine, since: Date, hooksExpected: boolean, trigger: string, evidenceTables: readonly string[], legacySince: Date = since): Promise<WriterEvidence> {
  const [row] = await engine.executeRaw<Record<keyof WriterEvidence, unknown>>(EVIDENCE_SQL, [since.toISOString(), hooksExpected, [...evidenceTables], trigger, legacySince.toISOString()]);
  const n = (v: unknown): number => { const x = typeof v === 'number' || typeof v === 'bigint' || (typeof v === 'string' && /^\d+$/.test(v)) ? Number(v) : Number.NaN; if (!Number.isInteger(x) || x < 0) throw Object.assign(new Error('writer evidence: bad count'), { code: 'writer_evidence_malformed' }); return x; };
  if (!row) throw Object.assign(new Error('writer evidence: no row'), { code: 'writer_evidence_malformed' });
  return { hosts: n(row.hosts), unresolved: n(row.unresolved), gaps: n(row.gaps), unhooked: n(row.unhooked), uncovered_roles: n(row.uncovered_roles), legacy_write_writers: n(row.legacy_write_writers) };
}

export interface WriterIdentity {
  hostId: string;
  applicationName: string;
  processKind: string;
  gbrainVersion: string;
  /** The write-comparison protocol this row records: this build's `WRITE_PROTOCOL` unless a test names another. */
  writeProtocol?: number;
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
  /** Run once, before the first note (a hooked primary: repair a table whose hook is missing or broken). A failure is recorded. */
  beforeFirstNote?: () => Promise<unknown>;
  /** Whether shadow mode is still on for this brain. Checked before each note and before the first-note repair; a stopped shadow neither notes nor repairs. */
  enabled?: () => boolean;
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

  private firstDone = false;

  private enabledNow(): boolean {
    // silent-read-ok: a state file that cannot be read means the shadow cannot be shown to be on, so this process notes nothing
    try { return this.o.enabled ? this.o.enabled() : true; } catch { return false; }
  }

  private async write(): Promise<void> {
    if (!this.enabledNow()) return;
    if (!this.firstDone && this.o.beforeFirstNote) {
      this.firstDone = true;
      // silent-read-ok: not silent; a failed repair becomes a writer_observation_failed fault that eligibility counts as unknown
      try { await this.o.beforeFirstNote(); } catch (error) { this.fail(`hooks_${errorCode(error)}`); }
    }
    try {
      const id = this.o.identity();
      await this.o.primary.transaction(async (tx) => {
        // A note must never hold a serving connection: a lock or a slow statement ends it in milliseconds, as a recorded failure.
        await tx.executeRaw(`SET LOCAL lock_timeout = '${NOTE_LOCK_TIMEOUT_MS}ms'`);
        await tx.executeRaw(`SET LOCAL statement_timeout = '${NOTE_STATEMENT_TIMEOUT_MS}ms'`);
        await tx.executeRaw(NOTE_SQL, [id.hostId, id.applicationName, id.processKind, id.gbrainVersion, id.writeProtocol ?? WRITE_PROTOCOL]);
      });
    // capability-refusal-ok: a background note on the primary (PGLite or Postgres) must never throw into the caller; any refusal becomes a fault that eligibility counts as unknown
    } catch (error) { // silent-read-ok: not silent; the failure becomes a writer_observation_failed fault that eligibility counts as unknown
      const code = errorCode(error);
      // A lock or statement timeout means the table is busy: wait out the refresh interval instead of holding a connection again on every write.
      if (code !== '55P03' && code !== '57014') this.lastWritten = Number.NEGATIVE_INFINITY;
      this.fail(code);
    }
  }

  private fail(code: string): void {
    try {
      (this.o.recordFailure ?? ((c: string) => appendFault(this.o.dir, { ts: new Date(this.now()).toISOString(), kind: 'writer_observation_failed', detail: `code=${c}` })))(code);
    } catch { /* a full disk loses the record, never the caller */ }
  }

  /** Stops new notes (engine disconnect); an in-flight note still settles through the drainer. */
  stop(): void {
    this.stopped = true;
    if (!this.inFlight) live.delete(this);
    else void this.inFlight.finally(() => live.delete(this));
  }
}
