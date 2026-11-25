/**
 * The managed Git effect runner's statements (`gitEffectStore()`): the checks a Git group makes against its worktree's
 * requests before it commits, the yield to publications still queued, and the plain outcome of a group whose root has
 * no durability. The text each one has always sent from persistence/effects.ts, moved unchanged (the protocol
 * predicate written out).
 *
 * Every update names its effects by id and by the claim's execution token, so an effect whose claim moved changes
 * nothing. The Rust store answers the same calls from its request and effect records
 * (rust/crates/gbrain-store/src/persistence/git_effects.rs).
 */
import type { BrainEngine } from '../engine.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

/** One claimed effect an update names: its id and its claim's token. */
export interface GitEffectClaimRef { id: string; token: string | null }

export interface GitEffectStore {
  /** Whether a request on the worktree is still queued or running (a group yields to it). */
  publicationsPending(worktreeId: string): Promise<boolean>;
  /** Requeues the claimed effects `publication_pending`, due again after `delayMs`. */
  yieldToPublications(claims: readonly GitEffectClaimRef[], delayMs: number): Promise<void>;
  /**
   * The worktree's requests that hold a recovery record: null when none does, else whether every one of them is a
   * publication in flight (running under a live claim, or settled with its record not yet cleared).
   */
  recoveringPublications(worktreeId: string): Promise<{ publishing: boolean | null } | null>;
  /** Whether any request on the worktree holds a recovery record. */
  worktreeRecovering(worktreeId: string): Promise<boolean>;
  /** Settles the claimed effects (no recovery) with `outcomeJson`: committed, or failed `targets_parked` when they parked targets. */
  recordPlainOutcome(claims: readonly GitEffectClaimRef[], outcomeJson: string): Promise<void>;
}

/** `publicationsPending`: $1 worktree id. */
export const GIT_PUBLICATIONS_PENDING_SQL = `SELECT EXISTS(SELECT 1 FROM persistence_requests
        WHERE worktree_id=$1::uuid AND state IN ('queued','running')) AS pending`;

/** `yieldToPublications`: $1 the claims as JSON, $2 the delay in ms. */
export const GIT_YIELD_SQL = `UPDATE persistence_effects e SET state='queued',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,error_code='publication_pending',
          next_attempt_at=now()+($2::double precision*interval '1 millisecond'),updated_at=now()
          FROM jsonb_to_recordset($1::text::jsonb) AS t(id bigint,token uuid)
          WHERE e.id=t.id AND e.execution_token=t.token AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `recoveringPublications`: $1 worktree id. */
export const GIT_RECOVERING_PUBLICATIONS_SQL = `SELECT bool_and(state='running' AND claim_expires_at>now()
            OR state IN ('committed','conflict','failed','cancelled')) AS publishing FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL`;

/** `worktreeRecovering`: $1 worktree id. */
export const GIT_WORKTREE_RECOVERING_SQL = 'SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND recovery IS NOT NULL LIMIT 1';

/** `recordPlainOutcome`: $1 the claims as JSON, $2 the outcome as JSON. */
export const GIT_PLAIN_OUTCOME_SQL = `UPDATE persistence_effects e SET
        state=CASE WHEN jsonb_array_length(COALESCE(e.data->'parked','[]'::jsonb))>0 THEN 'failed' ELSE 'committed' END,
        error_code=CASE WHEN jsonb_array_length(COALESCE(e.data->'parked','[]'::jsonb))>0 THEN 'targets_parked' END,
        data=e.data-'retry_slugs'-'target_failures'-'failing_target'-'busy_retries'-'busy_since'-'busy_at',execution_token=NULL,claim_expires_at=NULL,claim_owner=NULL,
        outcome=$2::text::jsonb,updated_at=now()
        FROM jsonb_to_recordset($1::text::jsonb) AS t(id bigint,token uuid)
        WHERE e.id=t.id AND e.execution_token=t.token AND e.recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`;

/** `gitEffectStore()` on PGLite and Postgres: the store over `exec` (a transaction engine runs every call in it). */
export async function gitEffectStore(exec: RawSql): Promise<GitEffectStore> {
  return {
    async publicationsPending(worktreeId) {
      const [row] = await exec.executeRaw<{ pending: boolean }>(GIT_PUBLICATIONS_PENDING_SQL, [worktreeId]);
      return row?.pending === true;
    },
    async yieldToPublications(claims, delayMs) {
      await exec.executeRaw(GIT_YIELD_SQL, [JSON.stringify(claims.map(c => ({ id: c.id, token: c.token }))), delayMs]);
    },
    async recoveringPublications(worktreeId) {
      const [row] = await exec.executeRaw<{ publishing: boolean | null }>(GIT_RECOVERING_PUBLICATIONS_SQL, [worktreeId]);
      return row ?? null;
    },
    async worktreeRecovering(worktreeId) {
      return (await exec.executeRaw(GIT_WORKTREE_RECOVERING_SQL, [worktreeId])).length > 0;
    },
    async recordPlainOutcome(claims, outcomeJson) {
      await exec.executeRaw(GIT_PLAIN_OUTCOME_SQL, [JSON.stringify(claims.map(c => ({ id: c.id, token: c.token }))), outcomeJson]);
    },
  };
}
