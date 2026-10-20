/**
 * GBRA-133 PR 2a: the commit notifier's durable state (migration v262).
 *
 * - Wanted markers (`sync_wanted_markers`): one row per source and intent class.
 *   `freshness` asks for the checkout's HEAD to become searchable (never pulls);
 *   `pull` asks for an upstream pull; `full` for a full walk. Explicit intents
 *   never coalesce into freshness: each class is its own row. Every upsert bumps
 *   `generation` and keeps `first_due_at`; a drainer deletes a row only WHERE
 *   generation equals the value it read, so a request that lands while the
 *   drainer's run is going survives it and starts one more run.
 * - The notifier lease (`sync_notifier_leases`): one owner per host. A claim
 *   succeeds when the row is free, expired or already ours; a takeover bumps
 *   the fencing token, which the owner re-checks before each start.
 * - Per-source notifier state and coverage (`sync_notifier_sources`): due /
 *   running / retry (next_retry_at) / operator_blocked, first_due_at kept until
 *   verified convergence, the last error with its trace file, the classic
 *   syncer host, and the observation the freshness notice reads.
 *
 * Callers on a brain whose schema predates v262 catch `missingTable` and treat
 * it as "no markers, nothing monitored".
 */
import type { BrainEngine } from '../engine.ts';
import { localHostId } from '../persistence/identity.ts';

type Exec = Pick<BrainEngine, 'executeRaw'>;

export const MARKER_INTENTS = ['freshness', 'pull', 'full'] as const;
export type MarkerIntent = typeof MARKER_INTENTS[number];
export type MarkerRequester = 'sync_trigger' | 'webhook' | 'notifier' | 'delegated_sync' | 'lock_busy' | 'sync_nudge';

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

export type NotifierState = 'idle' | 'due' | 'running' | 'retry' | 'operator_blocked';
export type DetectionMode = 'watch' | 'poll';

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

/** True when the error says a v262 table does not exist yet (a brain mid-upgrade). */
export function missingTable(error: unknown): boolean {
  const e = error as { code?: unknown; message?: unknown } | null;
  return e?.code === '42P01' || /relation "sync_(wanted_markers|notifier_leases|notifier_sources)" does not exist/.test(String(e?.message ?? ''));
}

const iso = (v: unknown): string | null => v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();
const num = (v: unknown): number => typeof v === 'number' ? v : Number(v);
const optNum = (v: unknown): number | null => v === null || v === undefined ? null : num(v);
const optStr = (v: unknown): string | null => v === null || v === undefined ? null : String(v);

function toMarker(row: Record<string, unknown>): WantedMarker {
  return {
    source_id: String(row.source_id), intent: row.intent as MarkerIntent, wanted_head: optStr(row.wanted_head),
    generation: num(row.generation), first_due_at: iso(row.first_due_at)!, updated_at: iso(row.updated_at)!,
    requested_by: String(row.requested_by), job_id: optNum(row.job_id),
  };
}

function toSourceRow(row: Record<string, unknown>): NotifierSourceRow {
  return {
    source_id: String(row.source_id), syncer_host_id: optStr(row.syncer_host_id), state: row.state as NotifierState,
    reason: optStr(row.reason), first_due_at: iso(row.first_due_at), attempts: num(row.attempts ?? 0),
    next_retry_at: iso(row.next_retry_at), last_progress_at: iso(row.last_progress_at), last_error_code: optStr(row.last_error_code),
    last_error: optStr(row.last_error), last_error_at: iso(row.last_error_at), trace_path: optStr(row.trace_path),
    observed_head: optStr(row.observed_head), observed_at: iso(row.observed_at), detection_mode: row.detection_mode ? row.detection_mode as DetectionMode : null,
    owner_host_id: optStr(row.owner_host_id), owner_kind: optStr(row.owner_kind), owner_pid: optNum(row.owner_pid), owner_seen_at: iso(row.owner_seen_at),
  };
}

// ── Wanted markers ───────────────────────────────────────────────────────────

/**
 * Records (or re-records) what a source should reach. A re-record keeps first_due_at (unless the source was re-created)
 * and bumps generation; `wanted_head` takes the newer value (null: whatever the checkout or upstream holds at run time).
 */
export async function upsertMarker(engine: Exec, m: { sourceId: string; intent: MarkerIntent; wantedHead: string | null; requestedBy: MarkerRequester; jobId?: number | null }): Promise<WantedMarker> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    `INSERT INTO sync_wanted_markers (source_id, intent, source_incarnation, wanted_head, generation, first_due_at, updated_at, requested_by, job_id)
     SELECT s.id, $2, s.incarnation::text, $3, 1, now(), now(), $4, $5 FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id, intent) DO UPDATE SET wanted_head = EXCLUDED.wanted_head, generation = sync_wanted_markers.generation + 1,
       updated_at = now(), requested_by = EXCLUDED.requested_by, job_id = COALESCE(EXCLUDED.job_id, sync_wanted_markers.job_id),
       first_due_at = CASE WHEN sync_wanted_markers.source_incarnation IS DISTINCT FROM EXCLUDED.source_incarnation THEN now() ELSE sync_wanted_markers.first_due_at END,
       source_incarnation = EXCLUDED.source_incarnation
     RETURNING *`,
    [m.sourceId, m.intent, m.wantedHead, m.requestedBy, m.jobId ?? null]);
  if (!row) throw new Error(`source ${m.sourceId} does not exist; no wanted marker recorded`);
  return toMarker(row);
}

/** Names the queued job that will drain a marker, only while the marker is still the generation the submitter wrote. */
export async function attachMarkerJob(engine: Exec, sourceId: string, intent: MarkerIntent, generation: number, jobId: number): Promise<void> {
  await engine.executeRaw('UPDATE sync_wanted_markers SET job_id = $4 WHERE source_id = $1 AND intent = $2 AND generation = $3', [sourceId, intent, generation, jobId]);
}

export async function readMarkers(engine: Exec, sourceIds?: string[]): Promise<WantedMarker[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    'SELECT * FROM sync_wanted_markers WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY first_due_at, source_id, intent LIMIT 1000', [sourceIds ?? null]);
  return rows.map(toMarker);
}

/**
 * Markers that still ask for work: every pull/full marker, and a freshness marker whose wanted_head differs from the
 * source's last_commit (a null wanted_head is due until a run drains it). No ancestry assumption.
 */
export async function readDueMarkers(engine: Exec, sourceIds?: string[]): Promise<WantedMarker[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT m.* FROM sync_wanted_markers m JOIN sources s ON s.id = m.source_id
      WHERE ($1::text[] IS NULL OR m.source_id = ANY($1::text[]))
        AND (m.intent <> 'freshness' OR m.wanted_head IS NULL OR m.wanted_head IS DISTINCT FROM s.last_commit)
      ORDER BY m.first_due_at, m.source_id, m.intent LIMIT 1000`, [sourceIds ?? null]);
  return rows.map(toMarker);
}

/**
 * Deletes freshness and pull markers that name a head the source already reached (a CLI sync, a refresh or another
 * resident got there first). State-based, so a newer request naming a newer head is never matched.
 */
export async function pruneSatisfiedMarkers(engine: Exec, sourceIds: string[]): Promise<void> {
  await engine.executeRaw(
    `DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = ANY($1::text[])
       AND m.intent IN ('freshness','pull') AND m.wanted_head IS NOT NULL AND m.wanted_head = s.last_commit`, [sourceIds]);
}

/** Deletes the marker only when nobody re-recorded it since `generation` was read. */
export async function clearMarker(engine: Exec, sourceId: string, intent: MarkerIntent, generation: number): Promise<boolean> {
  const rows = await engine.executeRaw<{ source_id: string }>(
    'DELETE FROM sync_wanted_markers WHERE source_id = $1 AND intent = $2 AND generation = $3 RETURNING source_id', [sourceId, intent, generation]);
  return rows.length > 0;
}

/**
 * After a completed run: clears every marker of the source the run satisfied, generation-checked against `read` (the
 * rows the drainer read before it started), and returns the markers that are still due afterwards.
 *  - freshness clears when last_commit equals its wanted_head (or the marker named no head);
 *  - pull clears when the run pulled (`pulled`), full when the run was a full walk (`full`).
 */
export async function settleMarkers(engine: Exec, sourceId: string, read: WantedMarker[], run: { pulled: boolean; full: boolean }): Promise<WantedMarker[]> {
  for (const m of read) {
    if (m.source_id !== sourceId) continue;
    if (m.intent === 'pull' && !run.pulled) continue;
    if (m.intent === 'full' && !run.full) continue;
    if (m.intent === 'freshness') {
      await engine.executeRaw(
        `DELETE FROM sync_wanted_markers m USING sources s WHERE m.source_id = s.id AND m.source_id = $1 AND m.intent = 'freshness'
           AND m.generation = $2 AND (m.wanted_head IS NULL OR m.wanted_head IS NOT DISTINCT FROM s.last_commit)`, [sourceId, m.generation]);
      continue;
    }
    await clearMarker(engine, sourceId, m.intent, m.generation);
  }
  return readDueMarkers(engine, [sourceId]);
}

// ── Notifier lease ───────────────────────────────────────────────────────────

export interface LeaseHolder { owner_id: string; fence: number; resident_kind: string; pid: number | null; expires_at: string; live: boolean }

/** Claims or renews the host's notifier lease: the fencing token when this resident owns it, else the current holder. */
export async function claimLease(engine: Exec, l: { hostId: string; ownerId: string; kind: string; pid: number; leaseMs: number }): Promise<{ owner: true; fence: number } | { owner: false; holder: LeaseHolder | null }> {
  const [won] = await engine.executeRaw<{ fence: unknown }>(
    `INSERT INTO sync_notifier_leases (host_id, owner_id, fence, resident_kind, pid, renewed_at, expires_at)
     VALUES ($1, $2, 1, $3, $4, now(), now() + $5::int * interval '1 millisecond')
     ON CONFLICT (host_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, resident_kind = EXCLUDED.resident_kind, pid = EXCLUDED.pid,
       fence = sync_notifier_leases.fence + CASE WHEN sync_notifier_leases.owner_id = EXCLUDED.owner_id THEN 0 ELSE 1 END,
       renewed_at = now(), expires_at = EXCLUDED.expires_at
     WHERE sync_notifier_leases.owner_id = EXCLUDED.owner_id OR sync_notifier_leases.expires_at <= now()
     RETURNING fence`, [l.hostId, l.ownerId, l.kind, l.pid, Math.max(1, Math.round(l.leaseMs))]);
  if (won) return { owner: true, fence: num(won.fence) };
  return { owner: false, holder: await readLease(engine, l.hostId) };
}

export async function readLease(engine: Exec, hostId: string): Promise<LeaseHolder | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    'SELECT owner_id, fence, resident_kind, pid, expires_at, expires_at > now() AS live FROM sync_notifier_leases WHERE host_id = $1', [hostId]);
  return row ? { owner_id: String(row.owner_id), fence: num(row.fence), resident_kind: String(row.resident_kind),
    pid: optNum(row.pid), expires_at: iso(row.expires_at)!, live: row.live === true || row.live === 't' } : null;
}

/** The fencing check before a start: still the owner, with the token this resident claimed, and unexpired. */
export async function holdsLease(engine: Exec, hostId: string, ownerId: string, fence: number): Promise<boolean> {
  const rows = await engine.executeRaw<{ host_id: string }>(
    'SELECT host_id FROM sync_notifier_leases WHERE host_id = $1 AND owner_id = $2 AND fence = $3 AND expires_at > now()', [hostId, ownerId, fence]);
  return rows.length > 0;
}

/** Releases the lease only while this resident still holds it, so a clean stop hands over at once. */
export async function releaseLease(engine: Exec, hostId: string, ownerId: string): Promise<void> {
  await engine.executeRaw('UPDATE sync_notifier_leases SET expires_at = now() WHERE host_id = $1 AND owner_id = $2', [hostId, ownerId]);
}

// ── Per-source state and coverage ────────────────────────────────────────────

export async function readNotifierSources(engine: Exec, sourceIds?: string[]): Promise<NotifierSourceRow[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    'SELECT * FROM sync_notifier_sources WHERE ($1::text[] IS NULL OR source_id = ANY($1::text[])) ORDER BY source_id', [sourceIds ?? null]);
  return rows.map(toSourceRow);
}

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
}

/** One write per transition, never per poll. */
export async function writeState(engine: Exec, sourceId: string, p: StatePatch): Promise<void> {
  await engine.executeRaw(
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

export interface Coverage { head: string | null; mode: DetectionMode; ownerHostId: string; ownerKind: string; ownerPid: number }

/** The coverage record, written when HEAD, mode or owner changed (the notifier compares before calling). */
export async function writeCoverage(engine: Exec, sourceId: string, c: Coverage): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sync_notifier_sources (source_id, source_incarnation, observed_head, observed_at, detection_mode, owner_host_id, owner_kind, owner_pid, owner_seen_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), $3, $4, $5, $6, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET observed_head = EXCLUDED.observed_head, observed_at = now(), detection_mode = EXCLUDED.detection_mode,
       owner_host_id = EXCLUDED.owner_host_id, owner_kind = EXCLUDED.owner_kind, owner_pid = EXCLUDED.owner_pid, owner_seen_at = now(),
       source_incarnation = EXCLUDED.source_incarnation, updated_at = now()`,
    [sourceId, c.head, c.mode, c.ownerHostId, c.ownerKind, c.ownerPid]);
}

/** Records the host that advanced a classic source's last_commit; a no-op write when it did not change. */
export async function recordSyncerHost(engine: Exec, sourceId: string, hostId: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sync_notifier_sources (source_id, source_incarnation, syncer_host_id, syncer_recorded_at, updated_at)
     SELECT s.id, s.incarnation::text, $2, now(), now() FROM sources s WHERE s.id = $1
     ON CONFLICT (source_id) DO UPDATE SET syncer_host_id = EXCLUDED.syncer_host_id, syncer_recorded_at = now(), updated_at = now()
     WHERE sync_notifier_sources.syncer_host_id IS DISTINCT FROM EXCLUDED.syncer_host_id`, [sourceId, hostId]);
}

/**
 * Called where a sync advances a source's last_commit (sync-anchor.ts writeSyncAnchor): records this host as the
 * source's syncer, so this host's resident notifier watches it, and clears the markers that head satisfies. Best effort: a sync never fails on it.
 */
export async function recordLocalSyncer(engine: Exec, sourceId: string): Promise<void> {
  try { await recordSyncerHost(engine, sourceId, localHostId()); } catch { /* the notifier reports the source as unrecorded */ }
  // The CLI's re-check (GBRA-133 PR 2a.3): a run that reached a marker's head clears it, whoever ran it.
  try { await pruneSatisfiedMarkers(engine, [sourceId]); } catch { /* the residents' marker scan prunes it */ }
}
