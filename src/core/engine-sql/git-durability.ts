/**
 * The managed Git durability statements (`gitDurabilityStore()`): the catch-up plan and re-queue of a worktree's Git
 * effects that completed skipped while durability was off, and the host binding's recorded setting. The text each one
 * has always sent from persistence/git-durability-policy.ts and git-durability-administration.ts, moved unchanged.
 *
 * - `bound()` bounds the caller's transaction (a 2 s lock wait, a synchronous commit), as the administration verb did.
 * - `planCatchUp` reads; `requeueCatchUp` repeats every predicate of the plan, so an effect the worker touched since is
 *   left alone and the returned ids are the rows actually queued.
 * - `setHostBindingDurability` records `enabled`, `disabled` or null on one host binding; null when no binding matched.
 *
 * The Rust store answers the same calls from its effect and host-binding records
 * (rust/crates/gbrain-store/src/persistence/git_durability.rs).
 */
import type { BrainEngine } from '../engine.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

export type GitDurabilitySetting = 'enabled' | 'disabled' | null;

/** One effect the catch-up re-queues: the latest skipped Git effect of one file. */
export interface GitDurabilityCatchUpEffect { id: string; request_id: string; relative_path: string | null; slug: string | null }

/** Which worktree, source and incarnation a catch-up covers, and the skip reason it looks for. */
export interface GitDurabilityCatchUpKey { worktreeId: string; sourceId: string; sourceIncarnation: string; reason: string }

export interface GitDurabilityStore {
  bound(): Promise<void>;
  planCatchUp(key: GitDurabilityCatchUpKey): Promise<GitDurabilityCatchUpEffect[]>;
  requeueCatchUp(key: Omit<GitDurabilityCatchUpKey, 'sourceId'>, ids: readonly string[]): Promise<string[]>;
  setHostBindingDurability(worktreeId: string, hostId: string, setting: GitDurabilitySetting): Promise<{ git_durability: GitDurabilitySetting } | null>;
}

/** `bound()`: the administration verb's transaction settings. */
export const GIT_DURABILITY_BOUND_SQL = "SELECT set_config('lock_timeout','2000ms',true),set_config('synchronous_commit','on',true)";

/** `planCatchUp`: $1 worktree id, $2 source id, $3 incarnation, $4 the skip reason. */
export const GIT_DURABILITY_PLAN_SQL = `
    SELECT DISTINCT ON ((e.data->>'relative_path') COLLATE "C") e.id::text AS id,e.request_id::text AS request_id,e.data->>'relative_path' AS relative_path,e.data->>'slug' AS slug
      FROM persistence_effects e
     WHERE e.worktree_id=$1::uuid AND e.source_id=$2 AND e.source_incarnation=$3::uuid AND e.kind='git' AND e.state='committed'
       AND e.outcome->>'reason'=$4 AND e.recovery IS NULL AND e.execution_token IS NULL
       AND COALESCE((e.data->>'source_scan')::boolean,false)=false AND e.data->>'relative_path' IS NOT NULL
     ORDER BY (e.data->>'relative_path') COLLATE "C",e.id DESC`;

/** `requeueCatchUp`: $1 effect ids, $2 worktree id, $3 incarnation, $4 the skip reason (the protocol predicate written out). */
export const GIT_DURABILITY_REQUEUE_SQL = `
    UPDATE persistence_effects SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,error_code=NULL,outcome=NULL,
           next_attempt_at=now(),updated_at=now(),data=data||jsonb_build_object('durability_catch_up',COALESCE((data->>'durability_catch_up')::int,0)+1)
     WHERE id=ANY($1::text[]::bigint[]) AND kind='git' AND state='committed' AND outcome->>'reason'=$4 AND worktree_id=$2::uuid AND source_incarnation=$3::uuid
       AND recovery IS NULL AND execution_token IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'
     RETURNING id::text AS id`;

/** `setHostBindingDurability`: $1 worktree id, $2 host id, $3 the setting. */
export const GIT_DURABILITY_SET_SQL = `UPDATE persistence_host_bindings SET git_durability=$3
      WHERE worktree_id=$1::uuid AND host_id=$2::uuid RETURNING git_durability`;

/** `gitDurabilityStore()` on PGLite and Postgres: the store over `exec` (a transaction engine runs every call in it). */
export async function gitDurabilityStore(exec: RawSql): Promise<GitDurabilityStore> {
  return {
    async bound() { await exec.executeRaw(GIT_DURABILITY_BOUND_SQL); },
    planCatchUp: key => exec.executeRaw<GitDurabilityCatchUpEffect>(GIT_DURABILITY_PLAN_SQL, [key.worktreeId, key.sourceId, key.sourceIncarnation, key.reason]),
    async requeueCatchUp(key, ids) {
      const rows = await exec.executeRaw<{ id: string }>(GIT_DURABILITY_REQUEUE_SQL, [[...ids], key.worktreeId, key.sourceIncarnation, key.reason]);
      return rows.map(row => row.id);
    },
    async setHostBindingDurability(worktreeId, hostId, setting) {
      const [row] = await exec.executeRaw<{ git_durability: GitDurabilitySetting }>(GIT_DURABILITY_SET_SQL, [worktreeId, hostId, setting]);
      return row ?? null;
    },
  };
}
