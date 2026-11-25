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
  /**
   * The requests of a worktree whose failed, unsettled Git effect is held on one of `codes` (its own code, or a parked
   * target's under `targets_parked`), one row per request, in byte order of source id, request id and journal id.
   */
  parkedPushRequests(worktreeId: string, codes: readonly string[]): Promise<ParkedPushRequestRow[]>;
  /**
   * The aggregate over a source's held, failed Git effects bound to another (former) worktree than `worktreeId`: how many,
   * the lowest held code, the worktrees and up to five public request ids. `effects` is 0 (the rest null) when none.
   */
  formerWorktreeHolds(sourceId: string, worktreeId: string, codes: readonly string[]): Promise<FormerWorktreeHoldsRow>;
  /** Queues a failed effect again with `data`; the row `{ state }` when it was still failed on `errorCode`, unclaimed and without a recovery, else null. */
  requeueParkedEffect(id: string, data: Record<string, unknown>, errorCode: string | null): Promise<{ state: string } | null>;
}

/** One request a parked-push retry covers: its source, journal id, public request id and slug. */
export interface ParkedPushRequestRow { source_id: string; id: string; request_id: string; slug: string }
/** The former-worktree aggregate (`formerWorktreeHolds`). */
export interface FormerWorktreeHoldsRow { effects: number; code: string | null; worktree_ids: string[] | null; requests: string[] | null }

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

/** `parkedPushRequests`: $1 worktree id, $2 the held codes. */
export const PARKED_PUSH_REQUESTS_SQL = `
    SELECT * FROM (SELECT DISTINCT e.source_id,r.id::text AS id,r.request_id::text AS request_id,r.slug FROM persistence_effects e
      JOIN persistence_requests r ON r.id=e.request_id
     WHERE e.worktree_id=$1::uuid AND e.kind='git' AND e.state='failed' AND e.recovery IS NULL AND NOT (e.data ? 'settled') AND (e.error_code=ANY($2::text[]) OR e.error_code='targets_parked'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p WHERE p->>'error_code'=ANY($2::text[])))) d
     ORDER BY source_id COLLATE "C",request_id COLLATE "C",id COLLATE "C"`;

/** `formerWorktreeHolds`: $1 source id, $2 the held codes, $3 the current worktree id. */
export const FORMER_WORKTREE_HOLDS_SQL = `SELECT count(*)::int AS effects,
      min(CASE WHEN e.error_code=ANY($2::text[]) THEN e.error_code ELSE (SELECT min(p->>'error_code') FROM jsonb_array_elements(e.data->'parked') p
        WHERE p->>'error_code'=ANY($2::text[])) END) AS code,
      array_agg(DISTINCT e.worktree_id::text) AS worktree_ids, (array_agg(DISTINCT r.request_id::text))[1:5] AS requests
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE e.source_id=$1 AND e.worktree_id IS DISTINCT FROM $3::uuid AND e.kind='git' AND e.state='failed'
      AND NOT (e.data ? 'settled') AND (e.error_code=ANY($2::text[]) OR e.error_code='targets_parked'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) p WHERE p->>'error_code'=ANY($2::text[])))`;

/** `requeueParkedEffect`: $1 effect id, $2 the new data, $3 the error code it failed on. */
export const REQUEUE_PARKED_EFFECT_SQL = `UPDATE persistence_effects SET state='queued',data=$2::text::jsonb,error_code=NULL,
        next_attempt_at=now(),claim_expires_at=NULL,claim_owner=NULL,updated_at=now() WHERE id=$1 AND state='failed' AND error_code IS NOT DISTINCT FROM $3
        AND execution_token IS NULL AND recovery IS NULL RETURNING state`;

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
    parkedPushRequests: (worktreeId, codes) => exec.executeRaw<ParkedPushRequestRow>(PARKED_PUSH_REQUESTS_SQL, [worktreeId, [...codes]]),
    async formerWorktreeHolds(sourceId, worktreeId, codes) {
      const [row] = await exec.executeRaw<FormerWorktreeHoldsRow>(FORMER_WORKTREE_HOLDS_SQL, [sourceId, [...codes], worktreeId]);
      return row!;
    },
    async requeueParkedEffect(id, data, errorCode) {
      const [row] = await exec.executeRaw<{ state: string }>(REQUEUE_PARKED_EFFECT_SQL, [id, JSON.stringify(data), errorCode]);
      return row ?? null;
    },
  };
}
