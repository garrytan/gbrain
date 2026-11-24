/**
 * The commit notifier's host lease, host source list, per-source state and coverage, and the freshness status rows
 * (migration v262 tables). notifier/store.ts (the lease, readNotifierSources, writeState, writeCoverage,
 * recordSyncerHost), notifier/resident.ts listHostSources and notifier/status.ts (readRows, freshnessReported) sent
 * these statements through `executeRaw`; the SQL text is theirs, unchanged.
 *
 * - The lease (`sync_notifier_leases`): one owner per host. A claim wins when the row is free, expired or already the
 *   caller's; a takeover bumps the fencing token. A lost claim reads the current holder. The owner re-checks its token
 *   before each start (holdsNotifierLease) and expires the row on a clean stop (releaseNotifierLease).
 * - The host source list: every source that is not archived, in id order, with its managed binding, the worktree's
 *   owner host and checkout root, and the classic syncer host. notifier/resident.ts decides what the host watches.
 * - Per-source state and coverage (`sync_notifier_sources`): one row per source, written only for a source that exists.
 *   A state write is one transition (writeNotifierState); a coverage write records the observed HEAD, the detection
 *   mode and the owner (writeNotifierCoverage); the syncer write records the host that advanced a classic source and
 *   writes nothing when it did not change (recordNotifierSyncerHost).
 * - The status rows (readNotifierStatusRows): each source that is not archived, with its notifier row, whether the
 *   owner host's lease is live, and how many wanted markers are still due. The freshness notice and the sync status
 *   notifier block read them.
 * - Wanted markers (`sync_wanted_markers`): one row per source and intent class, written only for a source that exists.
 *   An upsert bumps `generation` and keeps `first_due_at` unless the source was re-created; a drainer deletes a row only
 *   at the generation it read (clearWantedMarker, settleFreshnessMarker). A freshness marker is due while its
 *   wanted_head is null or differs from the source's last_commit; pull and full markers are due until a run clears them.
 *   notifier/store.ts (upsertMarker, attachMarkerJob, readMarkers, readDueMarkers, pruneSatisfiedMarkers, clearMarker,
 *   settleMarkers) and notifier/status.ts readNotifierBlock sent these statements through `executeRaw`.
 */
import type { SqlExecutor } from './executor.ts';
import type { LegacyUnscopedRead } from './brands.ts';

/** The executor the notifier statements need: master's `executeRaw` path. */
type RawExec = Pick<SqlExecutor, 'executeRaw'>;

export type NotifierState = 'idle' | 'due' | 'running' | 'retry' | 'operator_blocked';
export type DetectionMode = 'watch' | 'poll';

/** One source as the freshness notice and the sync status notifier block read it (readNotifierStatusRows). */
export interface NotifierStatusRow {
  id: string;
  last_commit: string | null;
  state: NotifierState | null;
  reason: string | null;
  first_due_at: string | null;
  attempts: number | null;
  next_retry_at: string | null;
  last_error_code: string | null;
  last_error: string | null;
  last_error_at: string | null;
  trace_path: string | null;
  observed_head: string | null;
  observed_at: string | null;
  detection_mode: DetectionMode | null;
  owner_host_id: string | null;
  owner_kind: string | null;
  owner_pid: number | null;
  owner_seen_at: string | null;
  /** The owner host's notifier lease has not expired. */
  lease_live: boolean;
  lease_expires_at: string | null;
  /** Wanted markers of the source that still ask for work. */
  due_markers: number;
}

const iso = (v: unknown): string | null => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const num = (v: unknown): number => typeof v === 'number' ? v : Number(v);
const optNum = (v: unknown): number | null => v === null || v === undefined ? null : num(v);
const optStr = (v: unknown): string | null => v === null || v === undefined ? null : String(v);
/** notifier/status.ts's reading of a boolean column. */
const truthy = (v: unknown): boolean => v === true || v === 't' || v === 1;

/** A status row with its timestamps as ISO strings and its counts as numbers (the Rust store's member maps its rows here too). */
export function toNotifierStatusRow(row: Record<string, unknown>): NotifierStatusRow {
  return {
    id: String(row.id), last_commit: optStr(row.last_commit), state: row.state ? row.state as NotifierState : null, reason: optStr(row.reason),
    first_due_at: iso(row.first_due_at), attempts: optNum(row.attempts), next_retry_at: iso(row.next_retry_at),
    last_error_code: optStr(row.last_error_code), last_error: optStr(row.last_error), last_error_at: iso(row.last_error_at),
    trace_path: optStr(row.trace_path), observed_head: optStr(row.observed_head), observed_at: iso(row.observed_at),
    detection_mode: row.detection_mode ? row.detection_mode as DetectionMode : null, owner_host_id: optStr(row.owner_host_id),
    owner_kind: optStr(row.owner_kind), owner_pid: optNum(row.owner_pid), owner_seen_at: iso(row.owner_seen_at),
    lease_live: truthy(row.lease_live), lease_expires_at: iso(row.lease_expires_at), due_markers: num(row.due_markers ?? 0),
  };
}

/** Each source of `sourceIds` (every source when null) that is not archived, in id order, at most 200, with its notifier status. */
export async function readNotifierStatusRows(exec: LegacyUnscopedRead, sourceIds: string[] | null): Promise<NotifierStatusRow[]> {
  const rows = await exec.executeRaw<Record<string, unknown>>(
    `SELECT s.id, s.last_commit, n.state, n.reason, n.first_due_at, n.attempts, n.next_retry_at, n.last_error_code, n.last_error, n.last_error_at,
            n.trace_path, n.observed_head, n.observed_at, n.detection_mode, n.owner_host_id, n.owner_kind, n.owner_pid, n.owner_seen_at,
            EXISTS (SELECT 1 FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id AND l.expires_at > now()) AS lease_live,
            (SELECT l.expires_at FROM sync_notifier_leases l WHERE l.host_id = n.owner_host_id) AS lease_expires_at,
            (SELECT count(*) FROM sync_wanted_markers m WHERE m.source_id = s.id
               AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)) AS due_markers
       FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived AND ($1::text[] IS NULL OR s.id = ANY($1::text[]))
      ORDER BY s.id COLLATE "C" LIMIT 200`, [sourceIds]);
  return rows.map(toNotifierStatusRow);
}

/** Whether a resident has recorded coverage for any source (the freshness notice turns on with it). */
export async function hasNotifierCoverage(exec: RawExec): Promise<boolean> {
  const [row] = await exec.executeRaw<{ covered: unknown }>('SELECT EXISTS (SELECT 1 FROM sync_notifier_sources WHERE observed_at IS NOT NULL) AS covered');
  return truthy(row?.covered);
}
