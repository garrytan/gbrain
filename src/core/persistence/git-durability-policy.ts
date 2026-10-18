/**
 * Git-durability policy for a managed worktree (#5182).
 *
 * Whether the persistence owner commits (and pushes) page writes through its
 * Git effect used to be read only from the legacy `sources harden` post-commit
 * hook banner, which an operator cannot install once the brain is managed. The
 * per-host binding now records the operator's explicit setting
 * (`persistence_host_bindings.git_durability`, tri-state):
 *
 *   'enabled'  → durable, no hook needed (the outbox owns durability);
 *   'disabled' → not durable, even where a legacy hook exists;
 *   null       → not recorded: the legacy hook probe decides, as before.
 *
 * Fail-closed: a probe failure under `null` is an error the effect records,
 * never a silent "durable". The resolver takes the probe as a parameter so the
 * effect runner can inject its cached per-root probe and tests can stub it.
 *
 * The catch-up planner lists the Git effects of a worktree that completed as
 * `durability_not_enabled` while the setting was off, and the requeue re-arms
 * exactly those rows: no row is inserted (UNIQUE(request_id,kind) stays
 * untouched), so a request keeps its one Git effect and the worker's ordinary
 * claim runs it.
 */
import { isDurabilityHardenedAsync } from '../brain-repo-durability.ts';
import type { SqlEngine } from './model.ts';
import type { WorktreeBinding } from './ownership.ts';
import { declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';

export const DURABILITY_NOT_ENABLED_REASON = 'durability_not_enabled';

export type GitDurabilityPolicy = { durable: boolean; source: 'binding' | 'legacy_hook' | 'no_hook' };

/** The policy for `root` under `binding`; `probe` is the legacy hook probe, used only when nothing is recorded. */
export async function gitDurabilityPolicy(binding: Pick<WorktreeBinding, 'git_durability'> | null | undefined, root: string,
  probe: (root: string) => Promise<boolean> = isDurabilityHardenedAsync): Promise<GitDurabilityPolicy> {
  if (binding?.git_durability === 'enabled') return { durable: true, source: 'binding' };
  if (binding?.git_durability === 'disabled') return { durable: false, source: 'binding' };
  const hooked = await probe(root);
  return hooked ? { durable: true, source: 'legacy_hook' } : { durable: false, source: 'no_hook' };
}

/** The operator-facing tri-state: what is recorded, before any probe. */
export function gitDurabilityState(binding: Pick<WorktreeBinding, 'git_durability'> | null | undefined): 'on' | 'off' | 'unknown' {
  return binding?.git_durability === 'enabled' ? 'on' : binding?.git_durability === 'disabled' ? 'off' : 'unknown';
}

export interface GitDurabilityCatchUpEffect { id: string; request_id: string; relative_path: string | null; slug: string | null }

/**
 * The Git effects of this worktree (current source incarnation) that completed
 * as skipped because durability was off: one per file, the latest. A page
 * written several times needs one commit of its current file, so earlier
 * skipped effects for the same path are left completed. Source scans and
 * recovered or claimed effects are not catch-up candidates.
 */
export async function planGitDurabilityCatchUp(engine: SqlEngine, binding: Pick<WorktreeBinding, 'worktree_id' | 'source_id' | 'source_incarnation'>): Promise<GitDurabilityCatchUpEffect[]> {
  return engine.executeRaw<GitDurabilityCatchUpEffect>(`
    SELECT DISTINCT ON (e.data->>'relative_path') e.id::text AS id,e.request_id::text AS request_id,e.data->>'relative_path' AS relative_path,e.data->>'slug' AS slug
      FROM persistence_effects e
     WHERE e.worktree_id=$1::uuid AND e.source_id=$2 AND e.source_incarnation=$3::uuid AND e.kind='git' AND e.state='committed'
       AND e.outcome->>'reason'=$4 AND e.recovery IS NULL AND e.execution_token IS NULL
       AND COALESCE((e.data->>'source_scan')::boolean,false)=false AND e.data->>'relative_path' IS NOT NULL
     ORDER BY e.data->>'relative_path',e.id DESC`, [binding.worktree_id, binding.source_id, binding.source_incarnation, DURABILITY_NOT_ENABLED_REASON]);
}

/**
 * Re-arm the planned effects inside the caller's transaction. Every predicate of
 * the plan is repeated, so an effect the worker touched since the plan was read
 * (or that is no longer skipped) is left alone; the returned ids are the rows
 * actually queued.
 */
export async function requeueGitDurabilityCatchUp(tx: SqlEngine, binding: Pick<WorktreeBinding, 'worktree_id' | 'source_incarnation'>, ids: readonly string[]): Promise<string[]> {
  if (!ids.length) return [];
  await declarePersistenceProtocol(tx);
  const rows = await tx.executeRaw<{ id: string }>(`
    UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,error_code=NULL,outcome=NULL,
           next_attempt_at=now(),updated_at=now(),data=data||jsonb_build_object('durability_catch_up',COALESCE((data->>'durability_catch_up')::int,0)+1)
     WHERE id=ANY($1::text[]::bigint[]) AND kind='git' AND state='committed' AND outcome->>'reason'=$4 AND worktree_id=$2::uuid AND source_incarnation=$3::uuid
       AND recovery IS NULL AND execution_token IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE}
     RETURNING id::text AS id`, [[...ids], binding.worktree_id, binding.source_incarnation, DURABILITY_NOT_ENABLED_REASON]);
  return rows.map(row => row.id);
}
