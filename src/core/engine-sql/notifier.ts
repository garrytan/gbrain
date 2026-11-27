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
import type { FenceOpts } from './lease-token.ts';

/** The executor the notifier statements need: master's `executeRaw` path. */
type RawExec = Pick<SqlExecutor, 'executeRaw'>;

/** `sync_wanted_markers.intent` CHECK: freshness asks for the checkout HEAD, pull for an upstream pull, full for a full walk. */
export const MARKER_INTENTS = ['freshness', 'pull', 'full'] as const;
export type MarkerIntent = typeof MARKER_INTENTS[number];
export type MarkerRequester = 'sync_trigger' | 'webhook' | 'notifier' | 'delegated_sync' | 'lock_busy' | 'sync_nudge';

/** One `sync_wanted_markers` row (without the source incarnation). */
export interface WantedMarker {
  source_id: string;
  intent: MarkerIntent;
  wanted_head: string | null;
  generation: number;
  first_due_at: string;
  updated_at: string;
  requested_by: string;
  job_id: number | null;
}

/** `upsertWantedMarker(m)`: what the source should reach, who asked, and the queued job when the caller has one. */
export interface WantedMarkerInput { sourceId: string; intent: MarkerIntent; wantedHead: string | null; requestedBy: MarkerRequester; jobId?: number | null }

/** One marker as the sync status notifier block lists it (listSourceWantedMarkers). */
export interface PendingWantedMarker { intent: string; wanted_head: string | null; first_due_at: string; requested_by: string }

/** The host's lease row as a lost claim (or `gbrain sync status`) sees it. */
export interface NotifierLeaseHolder { owner_id: string; fence: number; resident_kind: string; pid: number | null; expires_at: string; live: boolean }

/** `claimNotifierLease(l)`: the resident's host, owner token, kind, pid and lease length in milliseconds. */
/** `fence`: the host fence (multi-user Rust refuses a stale host's claim or renewal lease_lost); the SQL engines ignore it. */
export interface NotifierLeaseClaimInput extends FenceOpts { hostId: string; ownerId: string; kind: string; pid: number; leaseMs: number }

/** The fencing token when the caller owns the lease, else the current holder (null when the row went away). */
export type NotifierLeaseClaim = { owner: true; fence: number } | { owner: false; holder: NotifierLeaseHolder | null };

/** One source as the notifier's host source list reads it. */
export interface NotifierHostSourceRow {
  id: string;
  local_path: string | null;
  last_commit: string | null;
  /** The source is bound to a managed worktree (persistence_source_bindings, this incarnation). */
  bound: boolean;
  /** The worktree's owner host, as text. */
  owner: string | null;
  /** The owner host's checkout root of that worktree. */
  root: string | null;
  /** The host that last advanced a classic source (sync_notifier_sources.syncer_host_id). */
  syncer: string | null;
  config: unknown;
}

export type NotifierState = 'idle' | 'due' | 'running' | 'retry' | 'operator_blocked';
export type DetectionMode = 'watch' | 'poll';

/** One `sync_notifier_sources` row. */
export interface NotifierSourceRow {
  source_id: string;
  syncer_host_id: string | null;
  state: NotifierState;
  reason: string | null;
  first_due_at: string | null;
  attempts: number;
  next_retry_at: string | null;
  last_progress_at: string | null;
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
}

/** One state transition of a source (writeNotifierState). */
export interface StatePatch {
  state: NotifierState;
  reason?: string | null;
  /** 'keep' keeps first_due_at (setting it when null); 'clear' sets it NULL (verified convergence). */
  firstDue: 'keep' | 'clear';
  attempts?: number;
  nextRetryInMs?: number | null;
  progress?: boolean;
  /** null clears the last error; omitted keeps it. */
  error?: { code: string; message: string; tracePath: string | null } | null;
  /** The notifier lease the write is made under (multi-user Rust refuses it lease_lost when lost); the SQL engines ignore it. */
  lease?: NotifierLeaseRef;
}

/** The notifier lease a state or coverage write is made under: this host, this notifier's owner id and its fence. */
export interface NotifierLeaseRef { hostId: string; ownerId: string; fence: number }

/** The coverage record of a source (writeNotifierCoverage). */
export interface Coverage { head: string | null; mode: DetectionMode; ownerHostId: string; ownerKind: string; ownerPid: number; lease?: NotifierLeaseRef }

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
const bool = (v: unknown): boolean => v === true || v === 't';
/** notifier/status.ts's reading of a boolean column. */
const truthy = (v: unknown): boolean => v === true || v === 't' || v === 1;

/** A `sync_notifier_sources` row with its timestamps as ISO strings (the Rust store's member maps its rows here too). */
export function toNotifierSourceRow(row: Record<string, unknown>): NotifierSourceRow {
  return {
    source_id: String(row.source_id), syncer_host_id: optStr(row.syncer_host_id), state: row.state as NotifierState,
    reason: optStr(row.reason), first_due_at: iso(row.first_due_at), attempts: num(row.attempts ?? 0),
    next_retry_at: iso(row.next_retry_at), last_progress_at: iso(row.last_progress_at), last_error_code: optStr(row.last_error_code),
    last_error: optStr(row.last_error), last_error_at: iso(row.last_error_at), trace_path: optStr(row.trace_path),
    observed_head: optStr(row.observed_head), observed_at: iso(row.observed_at), detection_mode: row.detection_mode ? row.detection_mode as DetectionMode : null,
    owner_host_id: optStr(row.owner_host_id), owner_kind: optStr(row.owner_kind), owner_pid: optNum(row.owner_pid), owner_seen_at: iso(row.owner_seen_at),
  };
}

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

/** A marker row with its timestamps as ISO strings (the Rust store's member maps its rows here too). */
export function toWantedMarker(row: Record<string, unknown>): WantedMarker {
  return {
    source_id: String(row.source_id), intent: row.intent as MarkerIntent, wanted_head: optStr(row.wanted_head),
    generation: num(row.generation), first_due_at: iso(row.first_due_at)!, updated_at: iso(row.updated_at)!,
    requested_by: String(row.requested_by), job_id: optNum(row.job_id),
  };
}

/** A pending marker with its first_due_at as an ISO string (the Rust store's member maps its rows here too). */
export function toPendingWantedMarker(row: Record<string, unknown>): PendingWantedMarker {
  return { intent: String(row.intent), wanted_head: optStr(row.wanted_head), first_due_at: iso(row.first_due_at)!, requested_by: String(row.requested_by) };
}

/** Claims or renews the host's notifier lease: the fencing token when this resident owns it, else the current holder. */
export async function claimNotifierLease(exec: RawExec, l: NotifierLeaseClaimInput): Promise<NotifierLeaseClaim> {
  const [won] = await exec.executeRaw<{ fence: unknown }>(
    `INSERT INTO sync_notifier_leases (host_id, owner_id, fence, resident_kind, pid, renewed_at, expires_at)
     VALUES ($1, $2, 1, $3, $4, now(), now() + $5::int * interval '1 millisecond')
     ON CONFLICT (host_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, resident_kind = EXCLUDED.resident_kind, pid = EXCLUDED.pid,
       fence = sync_notifier_leases.fence + CASE WHEN sync_notifier_leases.owner_id = EXCLUDED.owner_id THEN 0 ELSE 1 END,
       renewed_at = now(), expires_at = EXCLUDED.expires_at
     WHERE sync_notifier_leases.owner_id = EXCLUDED.owner_id OR sync_notifier_leases.expires_at <= now()
     RETURNING fence`, [l.hostId, l.ownerId, l.kind, l.pid, Math.max(1, Math.round(l.leaseMs))]);
  if (won) return { owner: true, fence: num(won.fence) };
  return { owner: false, holder: await readNotifierLease(exec, l.hostId) };
}

/** The host's lease row, or null when it has none. */
export async function readNotifierLease(exec: RawExec, hostId: string): Promise<NotifierLeaseHolder | null> {
  const [row] = await exec.executeRaw<Record<string, unknown>>(
    'SELECT owner_id, fence, resident_kind, pid, expires_at, expires_at > now() AS live FROM sync_notifier_leases WHERE host_id = $1', [hostId]);
  return row ? { owner_id: String(row.owner_id), fence: num(row.fence), resident_kind: String(row.resident_kind),
    pid: optNum(row.pid), expires_at: iso(row.expires_at)!, live: bool(row.live) } : null;
}

/** The fencing check before a start: the host's lease is still `ownerId`'s, with the token it claimed, and unexpired. */
export async function holdsNotifierLease(exec: RawExec, hostId: string, ownerId: string, fence: number): Promise<boolean> {
  const rows = await exec.executeRaw<{ host_id: string }>(
    'SELECT host_id FROM sync_notifier_leases WHERE host_id = $1 AND owner_id = $2 AND fence = $3 AND expires_at > now()', [hostId, ownerId, fence]);
  return rows.length > 0;
}

/** Expires the host's lease now, only while `ownerId` still holds it, so a clean stop hands over at once. */
export async function releaseNotifierLease(exec: RawExec, hostId: string, ownerId: string): Promise<void> {
  await exec.executeRaw('UPDATE sync_notifier_leases SET expires_at = now() WHERE host_id = $1 AND owner_id = $2', [hostId, ownerId]);
}

/** Every source that is not archived, in id order, with what the notifier needs to decide whether this host watches it. */
export async function listNotifierHostSourceRows(exec: LegacyUnscopedRead): Promise<NotifierHostSourceRow[]> {
  const rows = await exec.executeRaw<{ id: string; local_path: string | null; last_commit: string | null; bound: boolean; owner: string | null; root: string | null; syncer: string | null; config: unknown }>(
    `SELECT s.id, s.local_path, s.last_commit, (b.source_id IS NOT NULL) AS bound, w.owner_host_id::text AS owner, h.local_path AS root, n.syncer_host_id AS syncer, s.config
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
       LEFT JOIN sync_notifier_sources n ON n.source_id = s.id
      WHERE NOT s.archived ORDER BY s.id COLLATE "C"`);
  return rows.map(r => ({ id: String(r.id), local_path: optStr(r.local_path), last_commit: optStr(r.last_commit), bound: bool(r.bound),
    owner: optStr(r.owner), root: optStr(r.root), syncer: optStr(r.syncer), config: r.config }));
}

/** The `sync_notifier_sources` rows of `sourceIds` (every row when null), in source id order. */
export async function readNotifierSources(exec: RawExec, sourceIds: string[] | null): Promise<NotifierSourceRow[]> {
  // The source order never reaches output: the resident only looks each row up by source id (restoreStates).
  const rows = await exec.executeRaw<Record<string, unknown>>(
    'SELECT * FROM sync_notifier_sources WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY source_id', [sourceIds]);
  return rows.map(toNotifierSourceRow);
}

/** One state transition of a source; nothing when the source does not exist. One write per transition, never per poll. */
export async function writeNotifierState(exec: RawExec, sourceId: string, p: StatePatch): Promise<void> {
  await exec.executeRaw(
    `INSERT INTO sync_notifier_sources (source_id, source_incarnation, state, reason, first_due_at, attempts, next_retry_at, last_progress_at,
        last_error_code, last_error, last_error_at, trace_path, updated_at)
     SELECT s.id, s.incarnation::text, $2, $3, CASE WHEN $4::text = 'keep' THEN now() END, COALESCE($5::int, 0),
        CASE WHEN $6::int IS NULL THEN NULL ELSE now() + $6::int * interval '1 millisecond' END, CASE WHEN $7::boolean THEN now() END,
        $8::text, $9::text, CASE WHEN $8::text IS NULL THEN NULL ELSE now() END, $10::text, now()
       FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET state = EXCLUDED.state, reason = EXCLUDED.reason,
       first_due_at = CASE WHEN $4::text = 'clear' THEN NULL ELSE COALESCE(sync_notifier_sources.first_due_at, now()) END,
       attempts = COALESCE($5::int, sync_notifier_sources.attempts), next_retry_at = EXCLUDED.next_retry_at,
       last_progress_at = CASE WHEN $7::boolean THEN now() ELSE sync_notifier_sources.last_progress_at END,
       last_error_code = CASE WHEN $11::boolean THEN EXCLUDED.last_error_code ELSE sync_notifier_sources.last_error_code END,
       last_error = CASE WHEN $11::boolean THEN EXCLUDED.last_error ELSE sync_notifier_sources.last_error END,
       last_error_at = CASE WHEN $11::boolean THEN EXCLUDED.last_error_at ELSE sync_notifier_sources.last_error_at END,
       trace_path = CASE WHEN $11::boolean THEN EXCLUDED.trace_path ELSE sync_notifier_sources.trace_path END,
       source_incarnation = EXCLUDED.source_incarnation, updated_at = now()`,
    [sourceId, p.state, p.reason ?? null, p.firstDue, p.attempts ?? null, p.nextRetryInMs ?? null, p.progress === true,
      p.error?.code ?? null, p.error?.message?.slice(0, 2000) ?? null, p.error?.tracePath ?? null, p.error !== undefined]);
}

/** The coverage record of a source; nothing when the source does not exist. */
export async function writeNotifierCoverage(exec: RawExec, sourceId: string, c: Coverage): Promise<void> {
  await exec.executeRaw(
    `INSERT INTO sync_notifier_sources (source_id, source_incarnation, observed_head, observed_at, detection_mode, owner_host_id, owner_kind, owner_pid, owner_seen_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), $3, $4, $5, $6, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET observed_head = EXCLUDED.observed_head, observed_at = now(), detection_mode = EXCLUDED.detection_mode,
       owner_host_id = EXCLUDED.owner_host_id, owner_kind = EXCLUDED.owner_kind, owner_pid = EXCLUDED.owner_pid, owner_seen_at = now(),
       source_incarnation = EXCLUDED.source_incarnation, updated_at = now()`,
    [sourceId, c.head, c.mode, c.ownerHostId, c.ownerKind, c.ownerPid]);
}

/** Records the host that advanced a classic source's last_commit; writes nothing when it did not change or the source does not exist. */
export async function recordNotifierSyncerHost(exec: RawExec, sourceId: string, hostId: string): Promise<void> {
  await exec.executeRaw(
    `INSERT INTO sync_notifier_sources (source_id, source_incarnation, syncer_host_id, syncer_recorded_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET syncer_host_id = EXCLUDED.syncer_host_id, syncer_recorded_at = now(), updated_at = now()
     WHERE sync_notifier_sources.syncer_host_id IS DISTINCT FROM EXCLUDED.syncer_host_id`, [sourceId, hostId]);
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

/**
 * Records (or re-records) what a source should reach, or null when the source does not exist. A re-record keeps
 * first_due_at (unless the source was re-created) and bumps generation; `wanted_head` takes the newer value.
 */
export async function upsertWantedMarker(exec: RawExec, m: WantedMarkerInput): Promise<WantedMarker | null> {
  const [row] = await exec.executeRaw<Record<string, unknown>>(
    `INSERT INTO sync_wanted_markers (source_id, intent, source_incarnation, wanted_head, generation, first_due_at, updated_at, requested_by, job_id)
     SELECT s.id, $2, s.incarnation::text, $3, 1, now(), now(), $4, $5 FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id, intent) DO UPDATE SET wanted_head = EXCLUDED.wanted_head, generation = sync_wanted_markers.generation + 1,
       updated_at = now(), requested_by = EXCLUDED.requested_by, job_id = COALESCE(EXCLUDED.job_id, sync_wanted_markers.job_id),
       first_due_at = CASE WHEN sync_wanted_markers.source_incarnation IS DISTINCT FROM EXCLUDED.source_incarnation THEN now() ELSE sync_wanted_markers.first_due_at END,
       source_incarnation = EXCLUDED.source_incarnation
     RETURNING *`,
    [m.sourceId, m.intent, m.wantedHead, m.requestedBy, m.jobId ?? null]);
  return row ? toWantedMarker(row) : null;
}

/** Names the queued job that will drain a marker, only while the marker is still at `generation`. */
export async function attachWantedMarkerJob(exec: RawExec, sourceId: string, intent: MarkerIntent, generation: number, jobId: number): Promise<void> {
  await exec.executeRaw('UPDATE sync_wanted_markers SET job_id = $4 WHERE source_id = $1 AND intent = $2 AND generation = $3', [sourceId, intent, generation, jobId]);
}

/** The markers of `sourceIds` (every marker when null), oldest first_due_at first, at most 1000. */
export async function readWantedMarkers(exec: RawExec, sourceIds: string[] | null): Promise<WantedMarker[]> {
  // The marker order never reaches output: nothing in src reads these rows to print them, and first_due_at sets the order before source_id breaks a tie.
  const rows = await exec.executeRaw<Record<string, unknown>>(
    'SELECT * FROM sync_wanted_markers WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY first_due_at, source_id, intent LIMIT 1000', [sourceIds]);
  return rows.map(toWantedMarker);
}

/**
 * The markers that still ask for work: every pull and full marker, and a freshness marker whose wanted_head is null or
 * differs from the source's last_commit. Oldest first_due_at first, at most 1000.
 */
export async function readDueWantedMarkers(exec: RawExec, sourceIds: string[] | null): Promise<WantedMarker[]> {
  // The marker order never reaches output: the handoff drains these markers in turn, first_due_at sets the order, and source_id breaks a tie only on an equal timestamp.
  const rows = await exec.executeRaw<Record<string, unknown>>(
    `SELECT m.* FROM sync_wanted_markers m JOIN sources s ON s.id = m.source_id
      WHERE ($1::text[] IS NULL OR m.source_id = ANY($1::text[]))
        AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)
      ORDER BY m.first_due_at, m.source_id, m.intent LIMIT 1000`, [sourceIds]);
  return rows.map(toWantedMarker);
}

/** Deletes the freshness and pull markers of `sourceIds` that name the head the source already reached. */
export async function pruneSatisfiedWantedMarkers(exec: RawExec, sourceIds: string[]): Promise<void> {
  await exec.executeRaw(
    `DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = ANY($1::text[])
       AND m.intent IN ('freshness','pull') AND m.wanted_head IS NOT NULL AND m.wanted_head = s.last_commit`, [sourceIds]);
}

/** Deletes the marker only when nobody re-recorded it since `generation` was read; true when a row went. */
export async function clearWantedMarker(exec: RawExec, sourceId: string, intent: MarkerIntent, generation: number): Promise<boolean> {
  const rows = await exec.executeRaw<{ source_id: string }>(
    'DELETE FROM sync_wanted_markers WHERE source_id = $1 AND intent = $2 AND generation = $3 RETURNING source_id', [sourceId, intent, generation]);
  return rows.length > 0;
}

/**
 * Deletes the source's freshness marker at `generation` when a run satisfied it: it named no head, or the head the
 * source's last_commit holds, or the drainer saw the checkout's HEAD (`checkoutHead`) equal last_commit after the run.
 */
export async function settleFreshnessMarker(exec: RawExec, sourceId: string, generation: number, checkoutHead: string | null): Promise<void> {
  await exec.executeRaw(
    `DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = $1 AND m.intent = 'freshness'
           AND m.generation = $2 AND (m.wanted_head IS NULL OR m.wanted_head IS NOT DISTINCT FROM s.last_commit
             OR ($3::text IS NOT NULL AND s.last_commit = $3::text))`, [sourceId, generation, checkoutHead]);
}

/** One source's persisted first due time (`readFirstDue`): the notifier row's observed head and due time. */
export interface FirstDueRow { source_id: string; observed_head: string | null; first_due_at: unknown }

/**
 * Per source of `sourceIds` that exists: the notifier row's observed head, and the earlier of its first_due_at (when
 * the row is not idle) and the oldest due freshness marker's, both of the source's current incarnation only.
 * sync-pending.ts readFirstDue sent this statement through `executeRaw`; the SQL text is its, unchanged.
 */
export async function readFirstDue(exec: RawExec, sourceIds: string[]): Promise<FirstDueRow[]> {
  return exec.executeRaw<FirstDueRow>(
    `SELECT s.id AS source_id, n.observed_head,
              LEAST(CASE WHEN n.state <> 'idle' THEN n.first_due_at END,
                    (SELECT min(m.first_due_at) FROM sync_wanted_markers m WHERE m.source_id = s.id AND m.intent = 'freshness'
                       AND m.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
                       AND (m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit))) AS first_due_at
         FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id AND n.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
        WHERE s.id = ANY($1::text[])`, [sourceIds]);
}

/** The source's markers as the sync status notifier block lists them, oldest first_due_at first. */
export async function listSourceWantedMarkers(exec: RawExec, sourceId: string): Promise<PendingWantedMarker[]> {
  const rows = await exec.executeRaw<Record<string, unknown>>(
    'SELECT intent, wanted_head, first_due_at, requested_by FROM sync_wanted_markers WHERE source_id = $1 ORDER BY first_due_at, intent COLLATE "C"', [sourceId]);
  return rows.map(toPendingWantedMarker);
}

/** One source as a sync request sees it (readSourceSyncShape): its local path, the checkout root on the worktree's owner host, and whether it is bound to a managed worktree. */
export interface SourceSyncShapeRow { local_path: string | null; root: string | null; bound: boolean }

/** The shape of a source that exists and is not archived, or null. notifier/nudge.ts sourceSyncShape. */
export async function readSourceSyncShape(exec: RawExec, sourceId: string): Promise<SourceSyncShapeRow | null> {
  const [row] = await exec.executeRaw<{ local_path: string | null; root: string | null; bound: unknown }>(
    `SELECT s.local_path, h.local_path AS root, (b.source_id IS NOT NULL) AS bound
       FROM sources s
       LEFT JOIN persistence_source_bindings b ON b.source_id = s.id AND b.source_incarnation = s.incarnation
       LEFT JOIN persistence_worktrees w ON w.id = b.worktree_id
       LEFT JOIN persistence_host_bindings h ON h.worktree_id = w.id AND h.host_id = w.owner_host_id
      WHERE s.id = $1 AND NOT s.archived LIMIT 1`, [sourceId]);
  if (!row) return null;
  return { local_path: row.local_path ?? null, root: row.root ?? null, bound: row.bound === true || row.bound === 't' };
}

/** One source's persisted first-due clock (readNotifierFirstDue): the notifier row's observed head and the earlier of its first_due_at (state not idle) and the oldest due freshness marker, current incarnation only. */
export interface NotifierFirstDueRow { source_id: string; observed_head: string | null; first_due_at: string | null }

/** The first-due clock of each of `sourceIds` that exists (archived included), in no set order. sync-pending.ts readFirstDue. */
export async function readNotifierFirstDue(exec: RawExec, sourceIds: string[]): Promise<NotifierFirstDueRow[]> {
  const rows = await exec.executeRaw<{ source_id: string; first_due_at: unknown; observed_head: string | null }>(
      `SELECT s.id AS source_id, n.observed_head,
              LEAST(CASE WHEN n.state <> 'idle' THEN n.first_due_at END,
                    (SELECT min(m.first_due_at) FROM sync_wanted_markers m WHERE m.source_id = s.id AND m.intent = 'freshness'
                       AND m.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
                       AND (m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit))) AS first_due_at
         FROM sources s LEFT JOIN sync_notifier_sources n ON n.source_id = s.id AND n.source_incarnation IS NOT DISTINCT FROM s.incarnation::text
        WHERE s.id = ANY($1::text[])`, [sourceIds]);
  return rows.map(r => ({ source_id: String(r.source_id), observed_head: optStr(r.observed_head), first_due_at: iso(r.first_due_at) }));
}
