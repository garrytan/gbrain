/**
 * The head-blocker probe of `src/core/persistence/head-blocker.ts` (#6543): for queued requests, whether a consumer on a host may claim
 * each now and, when it may not, the facts that name the first predicate of `claimableWriteSql` that fails; and the recovery record of a
 * head that is itself recovering. One SQL implementation for both engines; the classification stays with the caller.
 *
 * As in `persistence-claims.ts`, the text is written out in full so this module imports no persistence code;
 * `test/persistence-journal-statements.test.ts` checks it against the statement the journal fragments build. A Rust brain answers the
 * same rows from its records (src/core/rust-engine/store-members/head-blocker.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { claimableWriteFragment, foregroundPriorityFragment } from './persistence-claims.ts';
import { renderFragment, sqlFragment, type SqlFragment } from './fragment.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** What the probe names of a request that holds the head. */
export interface HeadBlockerRowRef { request_id: string; state: string; claim_phase: unknown; execution_token: string | null; claim_lapsed: boolean;
  publication_started: boolean; recovery: boolean; principal_kind: string; principal_id: string }
/** An effect recovery on the head's worktree. */
export interface HeadBlockerEffectRecovery { id: string; request_id: string | null; error_code: string | null; slug: string | null; path: string | null;
  before: string | null; after: string | null; version: unknown }
/** A page or skill-bundle write recovery on the head's worktree (or the recovering head itself). */
export interface HeadBlockerRequestRecovery { request_id: string; state: string; blocked_reason: string | null; slug: string; version: string | null;
  path: string | null; before: string | null; after: string | null; files: Array<{ path: string | null; before: string | null; after: string | null }> | null }
/** One queued request's probe row. */
export interface HeadBlockerRow { id: string; request_id: string; worktree_id: string | null; owner_host_id: string | null; worktree_state: string | null;
  backoff_until: string | Date | null; claimable: boolean; fence: { id: string; state: string } | null; effect_recovery: HeadBlockerEffectRecovery[] | null;
  mirrors: string[] | null; request_recovery: HeadBlockerRequestRecovery[] | null; earlier: HeadBlockerRowRef[] | null; ahead: HeadBlockerRowRef[] | null }
/** A recovering head's recovery record and the host that owns its worktree. */
export interface RecoveringHeadRow { ref: HeadBlockerRequestRecovery; owner_host_id: string | null }
/** `priority` is the `foreground_priority` switch as the environment set it, or null when the brain config row decides. */
export interface HeadBlockerReadOpts { priority?: boolean | null; timeoutMs?: number; signal?: AbortSignal }

/** The probe statement: `$1` host id, `$2` the empty excluded-root list, `$3` the request ids, as the journal-built text binds them. */
export function headBlockerRowsFragment(priority: boolean | null | undefined, hostId: string | null, ids: readonly string[]): SqlFragment {
  const claim = claimableWriteFragment(priority, hostId, []);
  const p = foregroundPriorityFragment(priority);
  return sqlFragment`SELECT r.id::text AS id, r.request_id::text AS request_id, r.worktree_id::text AS worktree_id, w.owner_host_id::text AS owner_host_id, w.state AS worktree_state,
      CASE WHEN NOT (r.next_attempt_at IS NULL OR r.next_attempt_at<=now()) THEN r.next_attempt_at END AS backoff_until,
      (${claim}) AS claimable,
      (SELECT jsonb_build_object('id',f.id::text,'state',f.state) FROM persistence_worktree_refreshes f
        WHERE f.worktree_id=r.worktree_id AND f.state IN ('fenced','merged','recovery_required') LIMIT 1) AS fence,
      (SELECT jsonb_agg(jsonb_build_object('id',e.id::text,'request_id',(SELECT q.request_id::text FROM persistence_requests q WHERE q.id=e.request_id),'error_code',e.error_code,'slug',e.recovery->>'slug','path',e.recovery->>'path',
        'before',e.recovery->>'beforeHash','after',e.recovery->>'afterHash','version',e.recovery->'version') ORDER BY e.id) FROM persistence_effects e WHERE e.worktree_id=r.worktree_id AND e.recovery IS NOT NULL) AS effect_recovery,
      (SELECT array_agg(m.id::text) FROM persistence_effects m WHERE m.worktree_id=r.worktree_id AND m.kind='withdrawal-mirror' AND m.state IN ('queued','running')
        AND (NOT (m.data ? 'targets') OR m.data->'targets' @> jsonb_build_array(jsonb_build_object('slug',r.slug)))) AS mirrors,
      (SELECT jsonb_agg(jsonb_build_object('request_id',b.request_id::text,'state',b.state,'blocked_reason',b.blocked_reason,
  'slug',b.slug,'version',b.recovery->>'version','path',b.recovery->>'path','before',b.recovery->>'beforeHash','after',b.recovery->>'afterHash',
  'files',(SELECT jsonb_agg(jsonb_build_object('path',f->>'path','before',f->>'beforeHash','after',f->>'afterHash'))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(b.recovery->'files')='array' THEN b.recovery->'files' ELSE '[]'::jsonb END) f)) ORDER BY b.sequence) FROM persistence_requests b WHERE b.worktree_id=r.worktree_id AND b.recovery IS NOT NULL) AS request_recovery,
      (SELECT jsonb_agg(jsonb_build_object('request_id',e.request_id::text,'state',e.state,'claim_phase',e.claim_phase,
  'execution_token',e.execution_token::text,'claim_lapsed',COALESCE(e.claim_expires_at<now(),false),'publication_started',COALESCE(e.publication_started,false),
  'recovery',e.recovery IS NOT NULL,'principal_kind',e.principal_kind,'principal_id',e.principal_id) ORDER BY e.sequence) FROM persistence_requests e
        WHERE ((r.worktree_id IS NOT NULL AND e.worktree_id=r.worktree_id) OR (r.worktree_id IS NULL AND e.worktree_id IS NULL AND e.source_incarnation=r.source_incarnation))
        AND (e.sequence<r.sequence
        AND e.state IN ('queued','running','recovering') AND NOT ((${p}) AND NOT COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
  AND (e.state='queued' OR (e.state='running' AND e.intent ? 'lane'
    AND e.worktree_id::text=ANY('{}'::text[])))
  AND e.recovery IS NULL AND COALESCE(e.intent->>'kind','') LIKE 'managed_sync_%' AND NOT (e.source_id=r.source_id AND (e.slug=r.slug
  OR e.page_id=r.page_id OR e.intent->'renameFrom'->>'slug'=r.slug))) OR e.sequence<r.sequence AND (e.state='deferred' AND (e.deferred_refresh_id IS NOT NULL OR e.deferred_import_from IS NOT NULL)
        AND (e.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=e.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (e.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=e.source_id AND COALESCE(imported.last_commit,'')<>e.deferred_import_from))))) AS earlier,
      (SELECT jsonb_agg(jsonb_build_object('request_id',a.request_id::text,'state',a.state,'claim_phase',a.claim_phase,
  'execution_token',a.execution_token::text,'claim_lapsed',COALESCE(a.claim_expires_at<now(),false),'publication_started',COALESCE(a.publication_started,false),
  'recovery',a.recovery IS NOT NULL,'principal_kind',a.principal_kind,'principal_id',a.principal_id) ORDER BY a.sequence) FROM persistence_requests a WHERE (${p}) AND COALESCE(r.intent->>'kind','') LIKE 'managed_sync_%'
        AND a.worktree_id=r.worktree_id AND a.sequence>r.sequence AND a.state IN ('running','recovering') AND NOT COALESCE(a.intent->>'kind','') LIKE 'managed_sync_%') AS ahead
    FROM persistence_requests r LEFT JOIN persistence_worktrees w ON w.id=r.worktree_id
    WHERE r.id=ANY(${ids}::uuid[]) AND r.state='queued'`;
}

/** The probe row of each queued request in `ids` (internal ids); rows for ids that are not queued are absent. */
export async function readHeadBlockerRows(engine: RawSql, ids: readonly string[], hostId: string | null, opts: HeadBlockerReadOpts = {}): Promise<HeadBlockerRow[]> {
  if (!ids.length) return [];
  const { priority, ...query } = opts;
  const { text, params } = renderFragment(headBlockerRowsFragment(priority, hostId, ids));
  return engine.executeRaw<HeadBlockerRow>(text, params, query);
}

/** The recovering-head statement: `$1` the request id. */
export function recoveringHeadFragment(id: string): SqlFragment {
  return sqlFragment`SELECT jsonb_build_object('request_id',r.request_id::text,'state',r.state,'blocked_reason',r.blocked_reason,
  'slug',r.slug,'version',r.recovery->>'version','path',r.recovery->>'path','before',r.recovery->>'beforeHash','after',r.recovery->>'afterHash',
  'files',(SELECT jsonb_agg(jsonb_build_object('path',f->>'path','before',f->>'beforeHash','after',f->>'afterHash'))
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.recovery->'files')='array' THEN r.recovery->'files' ELSE '[]'::jsonb END) f)) AS ref, w.owner_host_id::text AS owner_host_id
    FROM persistence_requests r JOIN persistence_worktrees w ON w.id=r.worktree_id WHERE r.id=${id}::uuid AND r.recovery IS NOT NULL`;
}

/** The recovery record of request `id` when it has one and a worktree; null otherwise. */
export async function readRecoveringHeadRow(engine: RawSql, id: string, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RecoveringHeadRow | null> {
  const { text, params } = renderFragment(recoveringHeadFragment(id));
  const [row] = await engine.executeRaw<RecoveringHeadRow>(text, params, opts);
  return row ?? null;
}
