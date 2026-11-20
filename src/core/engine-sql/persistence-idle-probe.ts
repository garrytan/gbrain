/**
 * The persistence consumer's idle probe: one SQL implementation for both engines (Rust engine persistence, effect worker
 * lane).
 *
 * `consumer.ts` `hasWork` sends one statement that mirrors the selection predicates of every worker a full tick fans out
 * to: a claimable write, a worktree recovery, an expired unpublished claim, a claimable effect, an effect recovery, a
 * projection job in the resident's window or a segmented one, a topology recovery and an overdue deferred write (and,
 * on PGLite, a claim an exited process left). The statement is the one the consumer has always built, with each value
 * bound where it is read (renderFragment numbers them) instead of the consumer's hand-numbered $1..$9: the fragments it
 * composed from journal.ts, refresh-barrier.ts and page-state/projections.ts are written out here (those modules reach
 * most of the codebase) and test/persistence-journal-statements.test.ts pins the statement to the consumer's, value
 * for value.
 *
 * `exec` is the engine itself or the consumer's reserved idle lane, so the probe reaches the connection it reached
 * before. Decisions stay with the caller: it reads `work` and moves its projection cursor.
 */
import { claimableWriteFragment } from './persistence-claims.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import { projectionRetryReadyFragment, residentWindowCtesFragment } from './persistence-housekeeping.ts';

/** `REFRESH_BARRIER_MAX_WAIT_*` (refresh-barrier.ts `MAX_WAIT_SQL`): the configured refresh-barrier wait limit in ms, else 15 minutes. */
const MAX_WAIT_SQL = "COALESCE((SELECT CASE WHEN value ~ '^[1-9][0-9]{0,14}$' THEN value::double precision END FROM config WHERE key='persistence.refresh_barrier_max_wait_ms'), 900000)";

/** `refreshFenceClear('e')` (worktree-refresh-schema.ts): no refresh fence holds the effect's worktree. */
const EFFECT_FENCE_CLEAR_SQL = `NOT EXISTS (SELECT 1 FROM persistence_worktree_refreshes fence WHERE fence.worktree_id=e.worktree_id
        AND fence.state IN ('fenced','merged','recovery_required'))`;

/** `overdueDeferredWorkSql(host)` (refresh-barrier.ts): a deferred or import-held write of this host past its limit. */
function overdueDeferredFragment(hostId: string): SqlFragment {
  const wait = trustedSql(MAX_WAIT_SQL);
  return sqlFragment`(EXISTS (SELECT 1 FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id
    JOIN persistence_worktree_refreshes f ON f.id=r.deferred_refresh_id
    WHERE w.owner_host_id=${hostId}::uuid AND r.state='deferred' AND f.released_at IS NULL AND r.created_at<now()-(${wait}*interval '1 millisecond'))
  OR EXISTS (SELECT 1 FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id JOIN sources s ON s.id=r.source_id
    WHERE w.owner_host_id=${hostId}::uuid AND r.state='deferred' AND r.deferred_import_from IS NOT NULL AND COALESCE(s.last_commit,'')=r.deferred_import_from
      AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.id=r.deferred_refresh_id AND f.released_at IS NOT NULL))
      AND (r.updated_at<now()-(${wait}*interval '1 millisecond') OR r.created_at<now()-(GREATEST(${wait}*4,14400000)*interval '1 millisecond'))))`;
}

/** PGLite: a write or effect claim last written before `before` (a process that exited left it). */
function abandonedFragment(before: string | null): SqlFragment {
  if (!before) return sqlFragment``;
  return sqlFragment`
      OR EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL AND r.publication_started=false AND r.updated_at<${before}::timestamptz)
      OR EXISTS (SELECT 1 FROM persistence_effects e WHERE e.state='running' AND e.recovery IS NULL AND e.updated_at<${before}::timestamptz)`;
}

/** What the idle probe reads: the consumer's state at this tick. */
export interface IdleProbeSpec {
  hostId: string;
  /** Root keys the consumer skips now (active, barred, retrying). */
  excludedRoots: string[];
  /** Whether a capacity-blocked write counts (publication concurrency above 0). */
  publishing: boolean;
  /** Topology changes that just failed to finish. */
  retryingTopologies: string[];
  /** Worktrees whose lane groups run in this process. */
  laneRoots: string[];
  /** The resident projection window's cursor. */
  cursor: { after: { source_incarnation: string; slug: string }; highWater: string | null };
  /** PGLite: claims last written before this instant (ISO text) count as abandoned; null leaves them out. */
  abandonedBefore: string | null;
  /** The `foreground_priority` environment override, or null when the brain config row decides. */
  foregroundPriority: boolean | null;
}

/** The idle probe's answer: whether any worker has work, and where the projection window stands. */
export interface IdleProbeRow {
  work: boolean;
  projection_work: boolean;
  projection_last: { source_incarnation: string; slug: string } | null;
  high_water: string | null;
}

/** The idle probe statement and its bound values for one tick. */
export function idleProbeStatement(spec: IdleProbeSpec): { sql: string; params: unknown[] } {
  const host = spec.hostId;
  const fragment = sqlFragment`WITH ${residentWindowCtesFragment(spec.cursor, true)},
    pwork AS (SELECT EXISTS (SELECT 1 FROM (SELECT source_incarnation,slug FROM recent UNION ALL SELECT source_incarnation,slug FROM win) j
      CROSS JOIN LATERAL (SELECT s.id FROM sources s WHERE s.incarnation=j.source_incarnation AND NOT s.archived OFFSET 0) s
      CROSS JOIN LATERAL (SELECT 1 FROM (SELECT p.id FROM pages p WHERE p.source_id=s.id AND p.slug=j.slug OFFSET 0) k
        JOIN pages p ON p.id=k.id WHERE p.deleted_at IS NULL AND p.page_kind IN ('markdown','code')) p) AS found)
    SELECT (SELECT found FROM pwork) AS projection_work,
      (SELECT json_build_object('source_incarnation',source_incarnation,'slug',slug) FROM win ORDER BY ord DESC LIMIT 1) AS projection_last,
      (SELECT at FROM high_water) AS high_water, (
      EXISTS (SELECT 1 FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE ${claimableWriteFragment(spec.foregroundPriority, host, spec.excludedRoots, spec.laneRoots)}
        AND (${spec.publishing}::boolean OR r.blocked_reason IS DISTINCT FROM 'writer_pool_capacity'))
      OR EXISTS (SELECT 1 FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id
        WHERE w.owner_host_id=${host}::uuid AND r.recovery IS NOT NULL AND NOT (r.worktree_id::text=ANY(${spec.excludedRoots}::text[])))
      OR EXISTS (SELECT 1 FROM persistence_requests r WHERE r.state='running' AND r.recovery IS NULL
        AND r.publication_started=false AND r.claim_expires_at<now()
        AND (r.worktree_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=r.worktree_id AND w.owner_host_id=${host}::uuid)))
      OR EXISTS (SELECT 1 FROM persistence_effects e LEFT JOIN persistence_worktrees w ON w.id=e.worktree_id
        WHERE (e.state='queued' OR e.state='running' AND e.claim_expires_at<now()) AND e.next_attempt_at<=now()
        AND (e.worktree_id IS NULL OR w.owner_host_id=${host}::uuid) AND (e.worktree_id IS NULL OR ${trustedSql(EFFECT_FENCE_CLEAR_SQL)}) AND e.recovery IS NULL
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND (e.kind='withdrawal-mirror' OR NOT EXISTS (SELECT 1 FROM persistence_effects mirror
          WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')))
      OR EXISTS (SELECT 1 FROM persistence_effects e JOIN persistence_worktrees w ON w.id=e.worktree_id
        WHERE e.recovery IS NOT NULL AND w.owner_host_id=${host}::uuid AND e.next_attempt_at<=now())
      OR (SELECT found FROM pwork)
      OR EXISTS (SELECT 1 FROM page_projection_jobs j JOIN sources s ON s.incarnation=j.source_incarnation AND NOT s.archived
        JOIN pages p ON p.source_id=s.id AND p.slug=j.slug AND p.deleted_at IS NULL AND p.body_storage='segmented'
        WHERE ${projectionRetryReadyFragment()})
      OR EXISTS (SELECT 1 FROM persistence_topology_changes c
        JOIN persistence_worktrees w ON w.id=(c.recovery->>'worktreeId')::uuid
        WHERE c.recovery IS NOT NULL AND w.owner_host_id=${host}::uuid AND NOT (c.id::text=ANY(${spec.retryingTopologies}::text[])))
      OR ${overdueDeferredFragment(host)}${abandonedFragment(spec.abandonedBefore)}
    ) AS work`;
  const { text, params } = renderFragment(fragment);
  return { sql: text, params };
}

/** The connection the probe runs on: the engine, its direct lane, or the consumer's reserved idle lane. */
export interface IdleProbeExec { executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { signal?: AbortSignal }): Promise<T[]> }

/** `probeIdleWork(spec)`: the idle probe's one row (the statement always answers one). */
export async function probeIdleWork(exec: IdleProbeExec, spec: IdleProbeSpec, opts?: { signal?: AbortSignal }): Promise<IdleProbeRow | null> {
  const { sql, params } = idleProbeStatement(spec);
  const [row] = await exec.executeRaw<IdleProbeRow>(sql, params, opts?.signal ? { signal: opts.signal } : undefined);
  return row ?? null;
}
