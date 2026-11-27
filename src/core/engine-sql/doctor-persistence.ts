/**
 * Doctor persistence reads: the statements the persistence checks of `gbrain doctor` (and the reads under them) ran through
 * `executeRaw`, each with the same text and parameters, on the engine's own `executeRaw`; only their home moved
 * (src/commands/doctor/checks/**, src/core/persistence/**, src/core/repair/failed-writes.ts). Every statement is copied byte for
 * byte from its caller (test/doctor-persistence-sql.test.ts pins the composed fragments against the helpers they were built from).
 *
 * The Rust engine answers the members from the store (rust/crates/gbrain-store/src/cli_reads/doctor_persistence.rs,
 * rust/docs/store/cli-reads-doctor-per.md) in three ways:
 * - Served: the store keeps `persistence_requests` and `persistence_counters`, so the request and counter reads are answered
 *   from them, with `now()` and `EXTRACT(EPOCH ...)` read off the store clock.
 * - Empty, no writer: the store keeps no `persistence_effects`, `persistence_consumers`, `persistence_worktrees`,
 *   `persistence_source_bindings`, `persistence_host_bindings`, `persistence_worktree_refreshes`, `page_segment_derivation_purges`,
 *   `page_purges`/`fact_purges`/`take_purges` or request link on a page version, and nothing on the engine writes one, so the TypeScript
 *   store member (src/core/rust-engine/store-members/doctor-persistence.ts) answers the empty result without a store call.
 * - Refused: a read the store holds the data for but cannot answer throws the typed capability refusal (TODOS.md, "Rust engine lane 14
 *   follow-ups").
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { embeddingCandidateWhere } from './persistence-effect-scans.ts';
import type { ParkedTarget } from '../persistence/effect-model.ts';
import type { WriteRequest } from '../persistence/model.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** Every member of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw (BOUNDED_TYPED_READS). */
export const DOCTOR_PERSISTENCE_MEMBERS: readonly string[] = [
  'listCapacityCounters', 'listOutstandingHolders', 'countPersistenceRequestRows', 'listLifetimeCounters', 'readAdmissionSample',
  'listRunningRequestStalls', 'readLiveConsumerSummary', 'readCounterDrift', 'readMaxRequestSequence', 'listRefusalBreakerRows',
  'listRecentDriftReceiptSlugs', 'listOlderDriftReceiptSlugs', 'readPublicationRefusals', 'countParkedEffects', 'listParkedEffects',
  'listGitPushHoldRows', 'listStalledCatchupRows', 'listParkedGroupRows', 'readStaleEmbeddingCounts', 'listStaleEmbeddingEffects',
  'listOrphanBindingRows', 'readPersistenceBrainIdText', 'listWorktreeIds', 'readRequestIndexStates', 'listManagedRoots', 'listUnboundSourcePages',
  'listRecentWriterVersions', 'listRecentPurgeRequests', 'listStuckWorktreeRefreshes',
  'listSourceBindingsForMovement', 'listRunningClaimOwners', 'listOwnerBindings', 'listConsumerOwners', 'listOverwriteCandidates',
  'listCallerRefusalRows', 'countCompactedCallerRefusals', 'listLocalEditAdoptions', 'listDerivationPurgeSweeps',
];

/** A principal's counter key `principal:<kind>:<id>` as the two values the request reads filter on. */
export type RequestPrincipal = readonly [kind: string, id: string];

// ---- persistence-capacity.ts / persistence-requests.ts / persistence-compaction.ts ----------------------------------------------

export interface CapacityCounterRow { key: string; outstanding_count: string; intent_bytes: string; lifetime_ids: string; terminal_bytes: string; recovery_bytes: string }
const CAPACITY_COUNTERS_SQL = `SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,
      terminal_bytes::text,recovery_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key COLLATE "C"`;
/** Every counter row of the brain and of each principal, in key order. */
export async function listCapacityCounters(raw: EngineRawRead): Promise<CapacityCounterRow[]> {
  return raw<CapacityCounterRow>(CAPACITY_COUNTERS_SQL);
}

export interface OutstandingHolderRow { source_id: string; n: number | string; stalled: number | string }
const OUTSTANDING_HOLDERS_SQL = `SELECT source_id,count(*) AS n,count(*) FILTER (WHERE created_at <= now()-interval '600 seconds') AS stalled
        FROM persistence_requests WHERE state IN ('queued','deferred','running','recovering')
        GROUP BY source_id ORDER BY count(*) FILTER (WHERE created_at <= now()-interval '600 seconds') DESC,count(*) DESC,source_id COLLATE "C" LIMIT 3`;
const OUTSTANDING_HOLDERS_PRINCIPAL_SQL = `SELECT source_id,count(*) AS n,count(*) FILTER (WHERE created_at <= now()-interval '600 seconds') AS stalled
        FROM persistence_requests WHERE state IN ('queued','deferred','running','recovering') AND principal_kind=$1 AND principal_id=$2
        GROUP BY source_id ORDER BY count(*) FILTER (WHERE created_at <= now()-interval '600 seconds') DESC,count(*) DESC,source_id COLLATE "C" LIMIT 3`;
/** The three sources holding the most outstanding slots (of one principal when given), most stalled (ten minutes or older) first. */
export async function listOutstandingHolders(raw: EngineRawRead, principal: RequestPrincipal | null): Promise<OutstandingHolderRow[]> {
  return raw<OutstandingHolderRow>(principal ? OUTSTANDING_HOLDERS_PRINCIPAL_SQL : OUTSTANDING_HOLDERS_SQL, principal ? [principal[0], principal[1]] : []);
}

const REQUEST_ROWS_ESTIMATE_SQL = `SELECT GREATEST(reltuples, 0)::bigint::text AS rows FROM pg_class WHERE oid = to_regclass('persistence_requests')`;
const REQUEST_ROWS_EXACT_SQL = `SELECT count(*)::text AS rows FROM persistence_requests`;
/** Rows in `persistence_requests`: the planner's estimate (Postgres, `estimate`) or the exact count. */
export async function countPersistenceRequestRows(raw: EngineRawRead, estimate: boolean): Promise<{ rows: string } | undefined> {
  const [row] = await raw<{ rows: string }>(estimate ? REQUEST_ROWS_ESTIMATE_SQL : REQUEST_ROWS_EXACT_SQL);
  return row;
}

export interface LifetimeCounterRow { key: string; lifetime_ids: string }
const LIFETIME_COUNTERS_SQL = `SELECT key,lifetime_ids::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key COLLATE "C"`;
/** The lifetime request ids of the brain and of each principal, in key order. */
export async function listLifetimeCounters(raw: EngineRawRead): Promise<LifetimeCounterRow[]> {
  return raw<LifetimeCounterRow>(LIFETIME_COUNTERS_SQL);
}

export interface AdmissionSample { admissions: number; oldest: string | null }
const ADMISSION_SAMPLE_SQL = `SELECT count(*)::int AS admissions, min(created_at)::text AS oldest
        FROM (SELECT created_at FROM persistence_requests 
          ORDER BY sequence DESC LIMIT 10000) recent
        WHERE created_at >= now() - interval '7 days'`;
const ADMISSION_SAMPLE_PRINCIPAL_SQL = `SELECT count(*)::int AS admissions, min(created_at)::text AS oldest
        FROM (SELECT created_at FROM persistence_requests WHERE principal_kind=$1 AND principal_id=$2
          ORDER BY sequence DESC LIMIT 10000) recent
        WHERE created_at >= now() - interval '7 days'`;
/** Admissions inside the last 7 days among the newest 10,000 (of one principal when given), and the oldest of those. */
export async function readAdmissionSample(raw: EngineRawRead, principal: RequestPrincipal | null): Promise<AdmissionSample | undefined> {
  const [row] = await raw<AdmissionSample>(principal ? ADMISSION_SAMPLE_PRINCIPAL_SQL : ADMISSION_SAMPLE_SQL, principal ? [principal[0], principal[1]] : []);
  return row;
}

export interface RunningRequestStallRow {
  request_id: string; source_id: string; worktree_id: string | null; operation: string; intent_kind: string | null; state: string; claim_phase: unknown;
  execution_token: string | null; claim_lapsed: boolean | null; publication_started: boolean; request_age_ms: string; no_root_progress: boolean; waiting: number;
}
const RUNNING_STALLS_SQL = `SELECT r.request_id::text,r.source_id,r.worktree_id::text,r.operation,r.intent->>'kind' AS intent_kind,r.state,r.claim_phase,r.execution_token::text,r.claim_expires_at<now() AS claim_lapsed,
        r.publication_started,(EXTRACT(EPOCH FROM (now()-r.created_at))*1000)::bigint::text AS request_age_ms,
        NOT EXISTS (SELECT 1 FROM persistence_requests q WHERE ((r.worktree_id IS NOT NULL AND q.worktree_id=r.worktree_id)
          OR (r.worktree_id IS NULL AND q.worktree_id IS NULL AND q.source_id=r.source_id))
          AND q.state IN ('committed','conflict','failed','cancelled') AND q.completed_at>=now()-($1::double precision*interval '1 millisecond')
          AND q.recovery IS NULL AND NOT q.compacted) AS no_root_progress,
        (SELECT count(*)::int FROM persistence_requests q WHERE q.worktree_id=r.worktree_id AND q.state='queued' AND q.sequence>r.sequence) AS waiting
      FROM persistence_requests r WHERE r.state='running' ORDER BY r.sequence LIMIT 100`;
/** The oldest 100 running requests with their claim state, age, root progress inside `maxClaimMs` and the queue behind them. */
export async function listRunningRequestStalls(raw: EngineRawRead, maxClaimMs: number): Promise<RunningRequestStallRow[]> {
  return raw<RunningRequestStallRow>(RUNNING_STALLS_SQL, [maxClaimMs]);
}

export interface LiveConsumerSummary { live: string; oldest_hours: number | null }
const LIVE_CONSUMERS_SQL = `SELECT count(DISTINCT host_id)::text AS live,
        (EXTRACT(EPOCH FROM now()-min(started_at))/3600)::float8 AS oldest_hours
      FROM persistence_consumers WHERE mode IN ('full','promoted') AND renewed_at > now()-interval '5 minutes'`;
/** Hosts with a live full or promoted consumer heartbeat (renewed in the last 5 minutes) and the age of the oldest. */
export async function readLiveConsumerSummary(raw: EngineRawRead): Promise<LiveConsumerSummary | undefined> {
  const [row] = await raw<LiveConsumerSummary>(LIVE_CONSUMERS_SQL);
  return row;
}

export interface CounterDriftRow { key: string; counter: string; req_rows: string; req_bytes: string; topo_rows: string; topo_bytes: string; clamped: string | null }
const COUNTER_DRIFT_SQL = `WITH u AS (
          SELECT 'principal:'||principal_kind||':'||principal_id AS key,'requests' AS kind,terminal_reservation AS bytes FROM persistence_requests
          UNION ALL SELECT 'principal:local_cli:'||principal_id::text,'topology_changes',terminal_bytes FROM persistence_topology_changes),
      s AS (SELECT key,count(*) FILTER (WHERE kind='requests') AS req_rows,COALESCE(SUM(bytes) FILTER (WHERE kind='requests'),0) AS req_bytes,
          count(*) FILTER (WHERE kind='topology_changes') AS topo_rows,COALESCE(SUM(bytes) FILTER (WHERE kind='topology_changes'),0) AS topo_bytes FROM u GROUP BY key),
      every AS (SELECT * FROM s UNION ALL SELECT 'brain',COALESCE(SUM(req_rows),0),COALESCE(SUM(req_bytes),0),COALESCE(SUM(topo_rows),0),COALESCE(SUM(topo_bytes),0) FROM s)
      SELECT c.key,c.terminal_bytes::text AS counter,COALESCE(e.req_rows,0)::text AS req_rows,COALESCE(e.req_bytes,0)::text AS req_bytes,
        COALESCE(e.topo_rows,0)::text AS topo_rows,COALESCE(e.topo_bytes,0)::text AS topo_bytes,(SELECT value FROM config WHERE key=$1) AS clamped
      FROM persistence_counters c LEFT JOIN every e ON e.key=c.key WHERE c.key='brain' OR c.key LIKE 'principal:%' ORDER BY c.key COLLATE "C"`;
/** Each terminal-bytes counter beside the receipts and topology changes it should equal, and the true-up clamp setting. */
export async function readCounterDrift(raw: EngineRawRead, clampedKey: string): Promise<CounterDriftRow[]> {
  return raw<CounterDriftRow>(COUNTER_DRIFT_SQL, [clampedKey]);
}

// ---- maintenance-drift.ts / refusal-breaker.ts / managed-guard.ts ---------------------------------------------------------------

const MAX_REQUEST_SEQUENCE_SQL = `SELECT max(sequence)::text AS top FROM persistence_requests`;
/** The newest request sequence, or null on an empty journal. */
export async function readMaxRequestSequence(raw: EngineRawRead): Promise<string | null> {
  const [row] = await raw<{ top: string | null }>(MAX_REQUEST_SEQUENCE_SQL);
  return row?.top ?? null;
}

export interface RefusalBreakerRow { slug: string; error_code: string; refusals: string; last_request_id: string; cause: string | null }
const REFUSAL_BREAKER_SQL = `SELECT slug,error_code,
      count(*)::text AS refusals,(array_agg(request_id::text ORDER BY sequence DESC))[1] AS last_request_id,(array_agg(error_detail->>'origin' ORDER BY sequence DESC))[1] AS cause
    FROM persistence_requests WHERE source_id=$1 AND intent IS NOT NULL AND NOT compacted AND operation='submit_job' AND state IN ('failed','conflict')
      AND error_code IS NOT NULL AND completed_at > now()-($2::double precision*interval '1 hour')
    GROUP BY slug,digest,error_code HAVING count(*) >= $3 ORDER BY slug COLLATE "C", digest COLLATE "C", error_code COLLATE "C" LIMIT $4`;
/** Maintenance submit_job slugs refused `threshold` times or more with the same write and code inside `windowHours`. */
export async function listRefusalBreakerRows(raw: EngineRawRead, sourceId: string, windowHours: number, threshold: number, limit: number): Promise<RefusalBreakerRow[]> {
  return raw<RefusalBreakerRow>(REFUSAL_BREAKER_SQL, [sourceId, windowHours, threshold, limit]);
}

const RECENT_DRIFT_SLUGS_SQL = `SELECT slug, count(*) OVER ()::int AS total FROM (
        SELECT DISTINCT r.slug FROM persistence_requests r WHERE r.sequence > $2::bigint AND r.source_id=$1 AND r.state='conflict' AND r.error_code='source_changed' AND r.error_message=$3) d
        ORDER BY slug COLLATE "C" LIMIT 100`;
/** Slugs with a source_changed receipt after sequence `floor` (up to 100), with the total of them. */
export async function listRecentDriftReceiptSlugs(raw: EngineRawRead, sourceId: string, floor: string, message: string): Promise<Array<{ slug: string; total: number }>> {
  return raw<{ slug: string; total: number }>(RECENT_DRIFT_SLUGS_SQL, [sourceId, floor, message]);
}

const OLDER_DRIFT_SLUGS_SQL = `SELECT DISTINCT r.slug COLLATE "C" AS slug FROM persistence_requests r WHERE r.sequence <= $2::bigint AND r.source_id=$1 AND r.state='conflict' AND r.error_code='source_changed' AND r.error_message=$3
            ORDER BY r.slug COLLATE "C" LIMIT 101`;
/** Slugs with a source_changed receipt at or below sequence `floor` (up to 101), under a `timeoutMs` bound. */
export async function listOlderDriftReceiptSlugs(raw: EngineRawRead, sourceId: string, floor: string, message: string, timeoutMs: number): Promise<Array<{ slug: string }>> {
  return raw<{ slug: string }>(OLDER_DRIFT_SLUGS_SQL, [sourceId, floor, message], { timeoutMs });
}

export interface PublicationRefusalRow { guard: number; trigger: number; opaque: number }
const PUBLICATION_REFUSALS_SQL = `SELECT COUNT(*) FILTER (WHERE error_code='writer_coordinator_required' AND error_detail->>'origin'='database_guard')::int AS guard,
              COUNT(*) FILTER (WHERE error_detail->>'origin'='database_trigger')::int AS trigger,
              COUNT(*) FILTER (WHERE error_detail IS NULL AND error_message LIKE 'Publication failed (P0001)%')::int AS opaque
       FROM persistence_requests WHERE state IN ('failed','conflict','recovering') AND COALESCE(completed_at,updated_at) > now()-interval '7 days'`;
/** Writes in the last 7 days the database refused: by the managed-writer guard, by another trigger, and unclassified P0001. */
export async function readPublicationRefusals(raw: EngineRawRead): Promise<PublicationRefusalRow | undefined> {
  const [row] = await raw<PublicationRefusalRow>(PUBLICATION_REFUSALS_SQL);
  return row;
}

// ---- parked-effects.ts / parked-groups.ts / git-push-holds.ts / effect-catchup.ts / stale-embedding-effects.ts ------------------

const PARKED_COUNT_SQL = `SELECT COUNT(*)::int AS count FROM persistence_effects e WHERE e.data ? 'parked' AND NOT (e.data ? 'settled')`;
const PARKED_COUNT_SCOPED_SQL = `SELECT COUNT(*)::int AS count FROM persistence_effects e WHERE e.data ? 'parked' AND e.source_id=ANY($1::text[]) AND NOT (e.data ? 'settled')`;
/** Effects that recorded a parked target and are not settled (of `sourceIds` when given). */
export async function countParkedEffects(raw: EngineRawRead, sourceIds: string[] | null): Promise<number> {
  const [row] = await raw<{ count: number }>(sourceIds ? PARKED_COUNT_SCOPED_SQL : PARKED_COUNT_SQL, sourceIds ? [sourceIds] : []);
  return Number(row?.count ?? 0);
}

export interface ParkedEffectRow { request: WriteRequest; source_id: string; kind: string; state: string; parked: ParkedTarget[]; former_binding: boolean }
const PARKED_ROWS_SQL = `SELECT to_jsonb(r) AS request,e.source_id,e.kind,e.state,e.data->'parked' AS parked,NOT (e.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_source_bindings sb
  WHERE sb.source_id=e.source_id AND sb.worktree_id=e.worktree_id AND sb.source_incarnation::text=e.source_incarnation::text)) AS former_binding FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE e.data ? 'parked' AND NOT (e.data ? 'settled') ORDER BY e.id LIMIT 20`;
const PARKED_ROWS_SCOPED_SQL = `SELECT to_jsonb(r) AS request,e.source_id,e.kind,e.state,e.data->'parked' AS parked,NOT (e.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_source_bindings sb
  WHERE sb.source_id=e.source_id AND sb.worktree_id=e.worktree_id AND sb.source_incarnation::text=e.source_incarnation::text)) AS former_binding FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE e.data ? 'parked' AND e.source_id=ANY($1::text[]) AND NOT (e.data ? 'settled') ORDER BY e.id LIMIT 20`;
/** The first 20 parked effects with their request, and whether the binding they were parked under is gone. */
export async function listParkedEffects(raw: EngineRawRead, sourceIds: string[] | null): Promise<ParkedEffectRow[]> {
  return raw<ParkedEffectRow>(sourceIds ? PARKED_ROWS_SCOPED_SQL : PARKED_ROWS_SQL, sourceIds ? [sourceIds] : []);
}

export interface GitPushHoldRow { source_id: string; root: string | null; former_worktree: boolean; retrying: number; parked: number; codes: string[]; oldest_at: string | Date;
  /** The newest held effect's failed step (`data.last_error`, or the parked entry's), by request time then effect id; null when none recorded one. */
  last_error: unknown }
const GIT_PUSH_HOLDS_SQL = `WITH held AS (
       SELECT e.id, e.source_id, e.worktree_id, e.state, r.created_at,
              CASE WHEN e.error_code='targets_parked' THEN pe.entry->>'error_code' ELSE e.error_code END AS code,
              CASE WHEN e.error_code='targets_parked' THEN pe.entry->'last_error' ELSE e.data->'last_error' END AS last_error
         FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
         LEFT JOIN LATERAL (SELECT p AS entry FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.data->'parked')='array' THEN e.data->'parked' ELSE '[]'::jsonb END) p
                WHERE p->>'error_code'=ANY($1::text[]) LIMIT 1) pe ON e.error_code='targets_parked'
        WHERE e.kind='git' AND e.state IN ('queued','running','failed') AND e.recovery IS NULL AND NOT (e.data ? 'settled')
          AND ($2::text[] IS NULL OR e.source_id=ANY($2::text[])))
     SELECT h.source_id, (SELECT b.local_path FROM persistence_host_bindings b WHERE b.worktree_id=h.worktree_id ORDER BY b.local_path COLLATE "C" LIMIT 1) AS root,
            NOT EXISTS (SELECT 1 FROM persistence_source_bindings s WHERE s.source_id=h.source_id AND s.worktree_id=h.worktree_id) AS former_worktree,
            count(*) FILTER (WHERE h.state<>'failed')::int AS retrying, count(*) FILTER (WHERE h.state='failed')::int AS parked,
            array_agg(DISTINCT h.code COLLATE "C" ORDER BY h.code COLLATE "C") AS codes, min(h.created_at) AS oldest_at,
            (array_agg(h.last_error ORDER BY h.created_at DESC, h.id DESC) FILTER (WHERE jsonb_typeof(h.last_error)='object'))[1] AS last_error
       FROM held h WHERE h.code=ANY($1::text[])
      GROUP BY h.source_id, h.worktree_id ORDER BY h.source_id COLLATE "C"`;
/** Held Git effects per source and worktree: retrying and parked counts, the codes of `codes` that hold them, the oldest request and the newest failed step. */
export async function listGitPushHoldRows(raw: EngineRawRead, codes: string[], sourceIds: string[] | null): Promise<GitPushHoldRow[]> {
  return raw<GitPushHoldRow>(GIT_PUSH_HOLDS_SQL, [codes, sourceIds]);
}

export interface StalledCatchupRow { source_id: string; stalled: number; busy: number; since: string | Date; retries: number }
const STALLED_CATCHUPS_SQL = `SELECT e.source_id,
            count(*) FILTER (WHERE (e.data->>'busy_since')::timestamptz < now() - ($2::double precision * interval '1 millisecond'))::int AS stalled,
            count(*)::int AS busy, min((e.data->>'busy_since')::timestamptz) AS since, COALESCE(max((e.data->>'busy_retries')::int), 0)::int AS retries
       FROM persistence_effects e
      WHERE e.state='queued' AND e.error_code='writer_busy' AND e.data ? 'busy_since' AND ($1::text[] IS NULL OR e.source_id=ANY($1::text[]))
      GROUP BY e.source_id ORDER BY e.source_id COLLATE "C"`;
/** Queued writer_busy effects per source: how many waited longer than `stallMs`, how many are busy, since when, and the most retries. */
export async function listStalledCatchupRows(raw: EngineRawRead, sourceIds: string[] | null, stallMs: number): Promise<StalledCatchupRow[]> {
  return raw<StalledCatchupRow>(STALLED_CATCHUPS_SQL, [sourceIds, stallMs]);
}

export interface ParkedGroupRow {
  source_id: string; code: string; former: 'binding_changed' | 'source_replaced' | null; effects: number; targets: number;
  rule: string | null; worktree_ids: string[]; current_worktree_id: string | null; requests: string[];
}
const PARKED_GROUPS_SQL = `WITH parked AS (
       SELECT e.id, e.source_id, e.worktree_id, r.request_id, p->>'error_code' AS code, p->>'rule' AS rule,
              CASE WHEN (e.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_source_bindings sb
  WHERE sb.source_id=e.source_id AND sb.worktree_id=e.worktree_id AND sb.source_incarnation::text=e.source_incarnation::text)) THEN NULL
                WHEN EXISTS (SELECT 1 FROM sources src WHERE src.id=e.source_id AND NOT src.archived AND src.incarnation::text=e.source_incarnation::text)
                THEN 'binding_changed' ELSE 'source_replaced' END AS former
         FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id CROSS JOIN LATERAL jsonb_array_elements(e.data->'parked') p
        WHERE e.kind='git' AND e.state='failed' AND e.error_code='targets_parked' AND jsonb_typeof(e.data->'parked')='array' AND NOT (e.data ? 'settled')
          AND ($1::text[] IS NULL OR e.source_id=ANY($1::text[])))
     SELECT source_id, code, former, count(DISTINCT id)::int AS effects, count(*)::int AS targets, min(rule) AS rule,
            array_agg(DISTINCT worktree_id::text) AS worktree_ids, (array_agg(DISTINCT request_id::text))[1:5] AS requests,
            (SELECT sb.worktree_id::text FROM persistence_source_bindings sb WHERE sb.source_id=parked.source_id) AS current_worktree_id
       FROM parked GROUP BY source_id, code, former ORDER BY source_id COLLATE "C", code COLLATE "C", former COLLATE "C" NULLS FIRST`;
/** Parked Git targets per source, error code and former binding. */
export async function listParkedGroupRows(raw: EngineRawRead, sourceIds: string[] | null): Promise<ParkedGroupRow[]> {
  return raw<ParkedGroupRow>(PARKED_GROUPS_SQL, [sourceIds]);
}

/** The shared embedding candidate predicate (persistence/embedding-settlement.ts EMBEDDING_CANDIDATE_WHERE): the failed effects a retry does not help are parked targets and a zero-norm refusal. */
/** The codes a failed embedding effect never retries on (the stale-embedding doctor reads). */
const EMBEDDING_NEVER_RETRIED = ['targets_parked', 'embedding_zero_norm'] as const;
const EMBEDDING_CANDIDATE = embeddingCandidateWhere(EMBEDDING_NEVER_RETRIED);

export interface StaleEmbeddingCounts { count: number; failed: number; requeued: number }
const STALE_EMBEDDING_COUNTS_SQL = `SELECT COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE e.state='failed')::int AS failed, COUNT(*) FILTER (WHERE e.state='queued' AND e.data ? 'repair_requeued_at')::int AS requeued
      FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE ${EMBEDDING_CANDIDATE} `;
const staleEmbeddingCountsScoped = (sourceIds: string[]) => renderFragment(sqlFragment`SELECT COUNT(*)::int AS count,
      COUNT(*) FILTER (WHERE e.state='failed')::int AS failed, COUNT(*) FILTER (WHERE e.state='queued' AND e.data ? 'repair_requeued_at')::int AS requeued
      FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE ${trustedSql(embeddingCandidateWhere(EMBEDDING_NEVER_RETRIED))} AND r.source_id=ANY(${sourceIds}::text[])`);
/** Committed writes' stale queued or failed embedding effects: all, the failed, and the retry-queued. */
export async function readStaleEmbeddingCounts(raw: EngineRawRead, sourceIds: string[] | null): Promise<StaleEmbeddingCounts> {
  const scoped = sourceIds ? staleEmbeddingCountsScoped(sourceIds) : null;
  const [row] = await raw<StaleEmbeddingCounts>(scoped ? scoped.text : STALE_EMBEDDING_COUNTS_SQL, scoped ? scoped.params : []);
  return row ?? { count: 0, failed: 0, requeued: 0 };
}

export interface StaleEmbeddingEffectRow { effect_id: string; source_id: string; slug: string | null; request_id: string; state: string; updated_at: string }
const STALE_EMBEDDING_ROWS_SQL = `SELECT e.id::text AS effect_id,r.source_id,r.slug,r.request_id::text AS request_id,e.state,e.updated_at::text AS updated_at FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE ${EMBEDDING_CANDIDATE}  ORDER BY e.id LIMIT 10`;
const staleEmbeddingRowsScoped = (sourceIds: string[]) => renderFragment(sqlFragment`SELECT e.id::text AS effect_id,r.source_id,r.slug,r.request_id::text AS request_id,e.state,e.updated_at::text AS updated_at FROM persistence_effects e
       JOIN persistence_requests r ON r.id=e.request_id WHERE ${trustedSql(embeddingCandidateWhere(EMBEDDING_NEVER_RETRIED))} AND r.source_id=ANY(${sourceIds}::text[]) ORDER BY e.id LIMIT 10`);
/** The first 10 stale embedding effects. */
export async function listStaleEmbeddingEffects(raw: EngineRawRead, sourceIds: string[] | null): Promise<StaleEmbeddingEffectRow[]> {
  const scoped = sourceIds ? staleEmbeddingRowsScoped(sourceIds) : null;
  return raw<StaleEmbeddingEffectRow>(scoped ? scoped.text : STALE_EMBEDDING_ROWS_SQL, scoped ? scoped.params : []);
}

// ---- orphan-bindings.ts (doctor and persistence) / unbound-source.ts ------------------------------------------------------------

export interface OrphanBindingRow { source_id: string; source_incarnation: string; worktree_id: string; reason: 'source_removed' | 'incarnation_replaced'; pending_requests: number }
const ORPHAN_BINDINGS_SQL = `SELECT b.source_id, b.source_incarnation::text AS source_incarnation, b.worktree_id::text AS worktree_id,
    CASE WHEN s.id IS NULL THEN 'source_removed' ELSE 'incarnation_replaced' END AS reason,
    (SELECT COUNT(*)::int FROM persistence_requests r
      WHERE r.source_id = b.source_id AND r.source_incarnation = b.source_incarnation
        AND r.state IN ('queued','deferred','running','recovering')) AS pending_requests
  FROM persistence_source_bindings b
  LEFT JOIN sources s ON s.id = b.source_id
  WHERE s.id IS NULL OR s.incarnation <> b.source_incarnation ORDER BY b.source_id COLLATE "C"`;
/** Source bindings whose source is gone or was re-created, by source id, up to `limit` when given. */
export async function listOrphanBindingRows(raw: EngineRawRead, limit: number | null): Promise<OrphanBindingRow[]> {
  if (limit) {
    const rows = Math.floor(limit);
    if (!Number.isFinite(rows)) throw new Error('listOrphanBindingRows: limit must be a finite number');
    return raw<OrphanBindingRow>(`${ORPHAN_BINDINGS_SQL} LIMIT ${rows}`);
  }
  return raw<OrphanBindingRow>(ORPHAN_BINDINGS_SQL);
}

export interface RequestIndexRow { name: string; valid: boolean | null; phase: string | null; blocks_done: string | null; blocks_total: string | null }
// One statement on both engines (moved from persistence/checkpoint-validation.ts, the Postgres arm, unchanged): PGLite has
// pg_index and an always-empty pg_stat_progress_create_index, so it reads a present index as valid and a dropped one as
// missing, as its former to_regclass probe did.
const REQUEST_INDEX_SQL = `SELECT n.name, i.indisvalid AS valid, p.phase, p.blocks_done::text, p.blocks_total::text
       FROM unnest($1::text[]) WITH ORDINALITY AS n(name, position)
       LEFT JOIN pg_index i ON i.indexrelid = to_regclass(n.name)
       LEFT JOIN LATERAL (SELECT phase, blocks_done, blocks_total FROM pg_stat_progress_create_index p
         WHERE p.relid = i.indrelid AND p.index_relid IN (i.indexrelid, 0) LIMIT 1) p ON true
      ORDER BY n.position`;
/** The online-built request indexes, one row per name in the given order: `valid` null when missing; `phase` set while built. */
export async function readRequestIndexStates(raw: EngineRawRead, names: readonly string[]): Promise<RequestIndexRow[]> {
  return raw<RequestIndexRow>(REQUEST_INDEX_SQL, [[...names]]);
}

const BRAIN_ID_TEXT_SQL = `SELECT brain_id::text AS brain_id FROM persistence_brain WHERE singleton=1`;
/** The persistence identity as text, or null when the schema has no `persistence_brain` row. */
export async function readPersistenceBrainIdText(raw: EngineRawRead): Promise<string | null> {
  const [row] = await raw<{ brain_id: string }>(BRAIN_ID_TEXT_SQL);
  return row ? row.brain_id : null;
}

const WORKTREE_IDS_SQL = `SELECT id::text AS id FROM persistence_worktrees`;
/** Every managed worktree id. */
export async function listWorktreeIds(raw: EngineRawRead): Promise<string[]> {
  return (await raw<{ id: string }>(WORKTREE_IDS_SQL)).map(row => row.id);
}

export interface ManagedRootRow { root: string; source_id: string | null }
const MANAGED_ROOTS_SQL = `
      SELECT DISTINCT local_path AS root,id AS source_id FROM sources WHERE local_path IS NOT NULL AND NOT COALESCE(archived,false)
      UNION SELECT DISTINCT h.local_path,NULL FROM persistence_host_bindings h WHERE h.host_id=$1::uuid`;
/** The local paths of the active sources and of the worktrees `hostId` binds. */
export async function listManagedRoots(raw: EngineRawRead, hostId: string | null): Promise<ManagedRootRow[]> {
  return raw<ManagedRootRow>(MANAGED_ROOTS_SQL, [hostId]);
}

export interface UnboundSourcePageRow { source_id: string; pages: number; bound: boolean; local_path: string | null }
const UNBOUND_SOURCE_PAGES_SQL = `SELECT p.source_id,COUNT(*)::int AS pages,
        EXISTS(SELECT 1 FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
          WHERE b.source_id=p.source_id) AS bound,
        COALESCE((SELECT s.local_path FROM sources s WHERE s.id=p.source_id),
          CASE WHEN p.source_id='default' THEN (SELECT c.value FROM config c WHERE c.key='sync.repo_path') END) AS local_path
       FROM pages p WHERE p.database_only_reason IS NOT DISTINCT FROM 'unbound_source' AND COALESCE(btrim(p.source_path, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '')='' AND COALESCE(btrim(p.source_uri, (E'\\u0020\\u0009\\u000a\\u000b\\u000c\\u000d' || CASE WHEN current_setting('server_encoding') = 'UTF8' THEN convert_from(decode('c2a0e19a80e28080e28081e28082e28083e28084e28085e28086e28087e28088e28089e2808ae280a8e280a9e280afe2819fe38080efbbbf', 'hex'), 'UTF8') ELSE '' END)), '')='' AND p.deleted_at IS NULL
       GROUP BY p.source_id ORDER BY p.source_id COLLATE "C"`;
/** Sources with live database-only pages: the page count, whether the source has a binding, and its local path. */
export async function listUnboundSourcePages(raw: EngineRawRead): Promise<UnboundSourcePageRow[]> {
  return raw<UnboundSourcePageRow>(UNBOUND_SOURCE_PAGES_SQL);
}

// ---- writer-version.ts / writer-versions.ts / purge-mirror.ts / worktree-refresh.ts -----------------------------------------------

export interface RecentWriterVersionRow { role: 'admitter' | 'consumer'; host_id: string | null; principal: string; version: string | null; last_seen: unknown; requests: number }
const RECENT_WRITER_VERSIONS_SQL = `WITH cutoff AS (SELECT writer_version_cutoff AS at FROM persistence_brain WHERE singleton=1 AND writer_version_cutoff IS NOT NULL),
    recent AS (SELECT r.*,COALESCE(r.published_at,r.completed_at) AS publication FROM persistence_requests r
      WHERE r.state='committed' AND COALESCE(r.published_at,r.completed_at)>=now()-($1::double precision*interval '1 day'))
    SELECT 'admitter' AS role,r.admitter_host_id::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.admitter_version AS version,MAX(r.created_at) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r CROSS JOIN cutoff c WHERE r.created_at>=c.at GROUP BY 2,3,4
    UNION ALL
    SELECT 'consumer' AS role,COALESCE(r.consumer_host_id,w.owner_host_id)::text AS host_id,r.principal_kind||':'||r.principal_id AS principal,
      r.consumer_version AS version,MAX(r.publication) AS last_seen,COUNT(*)::integer AS requests
    FROM recent r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id CROSS JOIN cutoff c WHERE r.publication>=c.at GROUP BY 2,3,4
    ORDER BY last_seen DESC`;
/** Committed requests of the last `days`, grouped per role, host, principal and version. */
export async function listRecentWriterVersions(raw: EngineRawRead, days: number): Promise<RecentWriterVersionRow[]> {
  return raw<RecentWriterVersionRow>(RECENT_WRITER_VERSIONS_SQL, [days]);
}

const RECENT_PURGE_REQUESTS_SQL = `SELECT DISTINCT request FROM (
        SELECT request_id::text AS request FROM page_purges WHERE request_id IS NOT NULL AND purged_at > now() - make_interval(days => $1)
        UNION SELECT request_id::text FROM fact_purges WHERE request_id IS NOT NULL AND purged_at > now() - make_interval(days => $1)
        UNION SELECT request_id::text FROM take_purges WHERE request_id IS NOT NULL AND purged_at > now() - make_interval(days => $1)) r LIMIT $2`;
/** Request ids of the page, fact and take purges of the last `days` (up to `cap`). */
export async function listRecentPurgeRequests(raw: EngineRawRead, days: number, cap: number): Promise<string[]> {
  return (await raw<{ request: string }>(RECENT_PURGE_REQUESTS_SQL, [days, cap])).map(row => row.request);
}

export interface StuckWorktreeRefreshRow { id: string; state: string; source_ids: string[]; updated_at: unknown }
const STUCK_WORKTREE_REFRESHES_SQL = `SELECT id,state,source_ids,updated_at FROM persistence_worktree_refreshes
    WHERE state IN ('draining','fenced','merged','syncing','recovery_required') AND created_at < now()-($1::double precision*interval '1 minute') ORDER BY created_at`;
/** Active worktree refreshes older than `minutes`. */
export async function listStuckWorktreeRefreshes(raw: EngineRawRead, minutes: number): Promise<StuckWorktreeRefreshRow[]> {
  return raw<StuckWorktreeRefreshRow>(STUCK_WORKTREE_REFRESHES_SQL, [minutes]);
}

// ---- sync-movement.ts / consumer-diagnostics.ts ------------------------------------------------------------------------------------

export interface MovementBindingRow { source_id: string; worktree_id: string; source_incarnation: string; owner_host_id: string | null }
const SOURCE_BINDINGS_MOVEMENT_SQL = `SELECT b.source_id, b.worktree_id::text AS worktree_id, b.source_incarnation::text AS source_incarnation, w.owner_host_id::text AS owner_host_id
    FROM persistence_source_bindings b JOIN sources s ON s.id=b.source_id AND s.incarnation=b.source_incarnation
    JOIN persistence_worktrees w ON w.id=b.worktree_id WHERE ($1::text[] IS NULL OR b.source_id=ANY($1::text[])) ORDER BY b.source_id COLLATE "C"`;
/** Every active source's binding with its worktree owner (of `sourceIds` when given). */
export async function listSourceBindingsForMovement(raw: EngineRawRead, sourceIds: string[] | null): Promise<MovementBindingRow[]> {
  return raw<MovementBindingRow>(SOURCE_BINDINGS_MOVEMENT_SQL, [sourceIds]);
}

export interface RunningClaimOwnerRow { source_id: string; owner: unknown; lapsed: boolean | null }
const RUNNING_CLAIM_OWNERS_SQL = `SELECT r.source_id,r.claim_phase->'owner' AS owner,r.claim_expires_at<now() AS lapsed FROM persistence_requests r
      LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
      WHERE r.state='running' AND r.claim_phase->'owner' IS NOT NULL AND (r.worktree_id IS NULL OR w.owner_host_id=$1::uuid)
      ORDER BY r.sequence LIMIT 500`;
/** The first 500 running claims that carry an owner, on worktrees `hostId` owns or on no worktree. */
export async function listRunningClaimOwners(raw: EngineRawRead, hostId: string): Promise<RunningClaimOwnerRow[]> {
  return raw<RunningClaimOwnerRow>(RUNNING_CLAIM_OWNERS_SQL, [hostId]);
}

export interface OwnerBindingRow { worktree_id: string; owner_host_id: string; local_path: string; created_at: string; source_ids: string[] | null }
const OWNER_BINDINGS_SQL = `SELECT w.id::text AS worktree_id,w.owner_host_id::text AS owner_host_id,h.local_path,w.created_at::text AS created_at,
      (SELECT array_agg(b.source_id ORDER BY b.source_id COLLATE "C") FROM persistence_source_bindings b WHERE b.worktree_id=w.id) AS source_ids
    FROM persistence_worktrees w JOIN persistence_host_bindings h ON h.worktree_id=w.id AND h.host_id=w.owner_host_id
    WHERE w.owner_host_id IS NOT NULL AND w.owner_host_id<>$1::uuid AND w.state<>'recovering' ORDER BY w.created_at`;
/** Worktree bindings owned by a host other than `hostId`. */
export async function listOwnerBindings(raw: EngineRawRead, hostId: string): Promise<OwnerBindingRow[]> {
  return raw<OwnerBindingRow>(OWNER_BINDINGS_SQL, [hostId]);
}

export interface ConsumerOwnerRow { host_id: string; host_json_path: string; persistence_home: string; minted_under: unknown; renewed_at: string }
const CONSUMER_OWNERS_SQL = `SELECT DISTINCT ON (host_id) host_id::text AS host_id,host_json_path,persistence_home,minted_under,renewed_at::text AS renewed_at
    FROM persistence_consumers WHERE host_id=ANY($1::uuid[]) ORDER BY host_id,renewed_at DESC`;
/** The newest consumer heartbeat of each of `hostIds`. */
export async function listConsumerOwners(raw: EngineRawRead, hostIds: string[]): Promise<ConsumerOwnerRow[]> {
  return raw<ConsumerOwnerRow>(CONSUMER_OWNERS_SQL, [hostIds]);
}

// ---- overwritten-edits.ts / failed-writes.ts / local-edit-adoptions.ts / derivation-purge-sweeps.ts -------------------------------

const OVERWRITE_CANDIDATES_SQL = `SELECT v.id AS version_id, v.page_id, p.source_id, p.slug, v.knowledge_revision::text AS lost_revision,
      w.id::text AS db_request_id, w.operation AS db_operation, s.id::text AS import_request_id, s.completed_at AS imported_at,
      COALESCE(w.outcome->'persistence'->>'mode' = 'database', false) AS db_outcome_known, v.body_storage, v.title, v.type, v.compiled_truth, v.timeline, v.frontmatter, v.tags
    FROM pages p
    JOIN page_versions v ON v.page_id = p.id
    JOIN persistence_requests s ON s.id = v.archived_write_request_id
    JOIN persistence_requests w ON w.id = v.write_request_id
    WHERE p.source_id = $1 AND p.deleted_at IS NULL AND ($3::text[] IS NULL OR p.slug = ANY($3::text[]))
      AND s.state = 'committed' AND s.operation = 'submit_job' AND s.source_id = p.source_id AND (s.intent->>'kind' = 'managed_sync_import'
  OR (s.intent IS NULL AND s.outcome->>'imported_file' = 'true' AND NOT (s.outcome ? 'connector_database')))
      AND w.state = 'committed' AND w.source_id = p.source_id AND NOT (w.operation = 'submit_job' AND COALESCE(w.outcome->>'imported_file', '') = 'true')
      AND (w.outcome->'persistence'->>'mode' = 'database'
        OR (NOT (COALESCE(w.outcome, '{}'::jsonb) ? 'persistence') AND COALESCE(w.outcome->'write_through'->>'written', 'false') <> 'true'))
      AND COALESCE(w.outcome->'write_through'->>'skipped', '') <> 'mirror_read_only' AND COALESCE(w.outcome->>'storage', '') <> 'database_only'
      AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.kind = 'git' AND e.revision = v.knowledge_revision)
    ORDER BY v.id DESC LIMIT $2`;
/** Page versions a managed import archived under a database write, newest first (up to `limit`), narrowed to `slugs` when given. */
export async function listOverwriteCandidates(raw: EngineRawRead, sourceId: string, limit: number, slugs: string[] | null): Promise<Array<Record<string, unknown>>> {
  return raw<Record<string, unknown>>(OVERWRITE_CANDIDATES_SQL, [sourceId, limit, slugs]);
}

export interface CallerRefusalRow {
  id: string; request_id: string; source_id: string; slug: string; operation: string; digest: string; sequence: string;
  reason: 'source_changed' | 'writer_guard'; unpinned: boolean; stale_revision: boolean;
}
const CALLER_REFUSALS_SQL = `SELECT r.id::text, r.request_id::text, r.source_id, r.slug, r.operation, r.digest, r.sequence::text,
        CASE WHEN r.state='conflict' THEN 'source_changed' ELSE 'writer_guard' END AS reason,
        (r.operation='remember' AND jsonb_typeof(r.intent->'entity_slug') IS DISTINCT FROM 'string') AS unpinned,
        (r.operation='put_page' AND jsonb_typeof(r.intent->'expected_revision')='string' AND r.intent->>'expected_revision' IS DISTINCT FROM
          (SELECT p.knowledge_revision::text FROM pages p WHERE p.source_id=r.source_id AND p.slug=r.slug AND p.deleted_at IS NULL)) AS stale_revision
      FROM persistence_requests r
      WHERE r.source_id = ANY($1::text[]) AND NOT r.compacted AND r.intent IS NOT NULL AND ((r.state='failed' AND (r.error_code='writer_coordinator_required'
  OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed')) AND r.operation = ANY($2::text[]) AND NOT (r.operation='put_page' AND r.intent ? 'kind')
      ORDER BY r.sequence`;
/** The caller writes of `sourceIds` a managed-writer guard or a file drift refused, with the intent's pin and revision state, by sequence. */
export async function listCallerRefusalRows(raw: EngineRawRead, sourceIds: string[], operations: string[]): Promise<CallerRefusalRow[]> {
  return raw<CallerRefusalRow>(CALLER_REFUSALS_SQL, [sourceIds, operations]);
}

const COMPACTED_CALLER_REFUSALS_SQL = `SELECT count(*)::int AS count FROM persistence_requests r
      WHERE r.source_id = ANY($1::text[]) AND r.compacted AND ((r.state='failed' AND (r.error_code='writer_coordinator_required'
  OR (r.error_code='storage_error' AND r.error_message LIKE 'Publication failed (P0001)%'))) OR (r.state='conflict' AND r.error_code='source_changed')) AND r.operation = ANY($2::text[])`;
/** The refused receipts of `sourceIds` that compaction already emptied. */
export async function countCompactedCallerRefusals(raw: EngineRawRead, sourceIds: string[], operations: string[]): Promise<number> {
  const [row] = await raw<{ count: number }>(COMPACTED_CALLER_REFUSALS_SQL, [sourceIds, operations]);
  return Number(row?.count ?? 0);
}

export interface LocalEditAdoptionRow { source_id: string; adoptions: number | string; paths: string[] }
const LOCAL_EDIT_ADOPTIONS_SQL = `SELECT source_id, count(*)::int AS adoptions, array_agg(DISTINCT (outcome->'adopted_local_edit'->>'path') COLLATE "C" ORDER BY (outcome->'adopted_local_edit'->>'path') COLLATE "C") AS paths
       FROM persistence_requests WHERE state='committed' AND operation='put_page' AND outcome ? 'adopted_local_edit'
         AND completed_at > now() - interval '24 hours' GROUP BY source_id ORDER BY source_id COLLATE "C"`;
/** Per source, the put_page writes committed in the last 24 hours that adopted a local edit, and the paths. */
export async function listLocalEditAdoptions(raw: EngineRawRead): Promise<LocalEditAdoptionRow[]> {
  return raw<LocalEditAdoptionRow>(LOCAL_EDIT_ADOPTIONS_SQL);
}

export interface DerivationPurgeSweepRow { request_id: string | null; source_id: string; stalled: boolean; reason: string | null; pending_reason: string | null; created_at: string }
const DERIVATION_PURGE_SWEEPS_SQL = `SELECT r.request_id::text AS request_id, x.source_id, x.stalled_at IS NOT NULL AS stalled, x.stalled_reason AS reason, x.pending_reason,
        x.created_at::text AS created_at
      FROM page_segment_derivation_purges x LEFT JOIN persistence_requests r ON r.id = x.request_id ORDER BY x.created_at, x.request_id`;
/** The recorded derivation-result sweeps of fact purges, oldest first. */
export async function listDerivationPurgeSweeps(raw: EngineRawRead): Promise<DerivationPurgeSweepRow[]> {
  return raw<DerivationPurgeSweepRow>(DERIVATION_PURGE_SWEEPS_SQL);
}
