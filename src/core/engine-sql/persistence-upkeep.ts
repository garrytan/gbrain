/**
 * The managed write journal's upkeep statements that ran through `executeRaw`, as one typed engine member,
 * `persistenceUpkeepStore()`: SQL once for both SQL engines, served by the Rust store from its request, effect and
 * counter records (rust/crates/gbrain-store/src/persistence/upkeep.rs, rust/docs/store/persistence.md "Upkeep").
 *
 * - Receipt compaction (persistence/journal.ts `compactReceipt`, `newestSyncReceipt`): the transaction-local waits, the
 *   locked receipt with its open-cursor and open-pass checks, the unfinished-effect probe, the newest sync receipt of a
 *   worktree, the effect bytes, and the two writes.
 * - Effect claim upkeep (persistence/effect-journal.ts `rearmWithheldTargets`, `effectClaimKeeper`): the re-arm's locked
 *   read and update, and the renewal of a claim between the pieces of a long file.
 *
 * Each statement is the text its caller sent, written out (the protocol predicate, `EFFECT_BYTES_SQL`, the open-pass
 * predicate and `REARMABLE_SQL` spliced in), pinned byte for byte by test/engine-sql-caller-raw-sql-pins.test.ts.
 */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

export const PERSISTENCE_UPKEEP_SQL = {
  lockTimeout: `SET LOCAL lock_timeout = '2s'`,
  statementTimeout: `SET LOCAL statement_timeout = '15s'`,
  lockReceipt: `SELECT r.*,
        ($2::timestamptz IS NULL OR r.completed_at < $2::timestamptz) AS eligible_age,
        EXISTS (SELECT 1 FROM op_checkpoints c WHERE r.intent ? 'runId' AND c.op='managed-sync' AND c.completed_keys->0->>'runId'=r.intent->>'runId'
          AND COALESCE(c.completed_keys->0->>'done','false')<>'true') AS open_cursor,
        COALESCE(r.intent ? 'passId' AND EXISTS (SELECT 1 FROM op_checkpoints p
      WHERE p.op='managed-sync-pass' AND p.completed_keys->0->'telemetry'->>'pass_id'=r.intent->>'passId' AND p.completed_keys->0->'telemetry'->>'outcome'='open'), false) AS open_pass
      FROM persistence_requests r WHERE r.id=$1::uuid FOR UPDATE OF r`,
  unfinishedEffect: `SELECT 1 FROM persistence_effects WHERE request_id=$1::uuid AND state<>'committed' LIMIT 1`,
  newestSyncReceipt: `SELECT id FROM persistence_requests WHERE worktree_id=$1::uuid AND state='committed'
    AND COALESCE(intent->>'kind','') LIKE 'managed_sync_%' ORDER BY completed_at DESC, sequence DESC LIMIT 1`,
  effectBytes: `SELECT COALESCE(SUM(octet_length(data::text)+octet_length(kind)+1024),0)::text AS bytes
      FROM persistence_effects WHERE request_id=$1::uuid`,
  markCompacted: `UPDATE persistence_requests SET intent=NULL,compacted=true,error_message=NULL,terminal_reservation=$2 WHERE id=$1::uuid`,
  releaseTerminalBytes: `UPDATE persistence_counters SET terminal_bytes=terminal_bytes-LEAST($2::bigint,terminal_bytes) WHERE key=ANY($1::text[])`,
  lockRearmable: `SELECT e.* FROM persistence_effects e WHERE e.request_id=ANY($1::uuid[])
    AND e.kind IN ('git','embedding') AND e.state IN ('queued','failed') AND e.execution_token IS NULL AND e.recovery IS NULL AND NOT (e.data ? 'settled')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(e.data->'parked','[]'::jsonb)) AS p(target) WHERE p.target->>'error_code'=$2)
    AND EXISTS (SELECT 1 FROM persistence_effects m WHERE m.request_id=e.request_id AND m.kind='withdrawal-mirror' AND m.state='committed')
    ORDER BY e.id FOR UPDATE OF e SKIP LOCKED`,
  rearmEffect: `UPDATE persistence_effects SET state='queued',data=$2::text::jsonb,error_code=NULL,claim_expires_at=NULL,claim_owner=NULL,
      next_attempt_at=now(),updated_at=now() WHERE id=$1 AND execution_token IS NULL AND recovery IS NULL AND set_config('gbrain.persistence_protocol','2',true)='2'`,
  renewHeldClaim: `UPDATE persistence_effects SET claim_expires_at=now()+interval '2 minutes',updated_at=now()
      WHERE id=$1 AND execution_token=$2::uuid AND state='running' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING id`,
} as const;

/** The locked receipt `compactReceipt` rechecks: the request row plus its age and open-run flags. */
export type CompactionReceipt<R> = R & { eligible_age: boolean | null; open_cursor: boolean; open_pass: boolean };

export interface PersistenceUpkeepStore {
  /** Bounds the compaction transaction's lock and statement waits (2 s, 15 s); transaction-local. */
  limitCompactionWaits(): Promise<void>;
  /** Request `id` locked for the transaction with `eligible_age` (completed before `completedBefore`, or no cutoff), `open_cursor` and `open_pass`; null for no such request. */
  lockCompactionReceipt<R = Record<string, unknown>>(id: string, completedBefore: string | null): Promise<CompactionReceipt<R> | null>;
  /** Whether request `requestId` has an effect not yet committed. */
  hasUnfinishedEffect(requestId: string): Promise<boolean>;
  /** The id of worktree `worktreeId`'s newest committed managed-sync request, or null. */
  newestSyncReceiptId(worktreeId: string): Promise<string | null>;
  /** The bytes request `requestId`'s effect rows keep, as bigint text. */
  requestEffectBytes(requestId: string): Promise<string>;
  /** Compacts request `id`: no intent, no error message, compacted, reservation `retained`. */
  markReceiptCompacted(id: string, retained: number): Promise<void>;
  /** Releases `freed` terminal bytes from each counter of `keys`, never below zero. */
  releaseTerminalBytes(keys: readonly string[], freed: number): Promise<void>;
  /** The re-armable Git and embedding effects of `requestIds` (`REARMABLE_SQL`, parked with `code`), locked, in id order. */
  lockRearmableEffects<R = Record<string, unknown>>(requestIds: readonly string[], code: string): Promise<R[]>;
  /** Queues effect `id` again with `dataJson` when no claim and no recovery hold it. */
  rearmEffect(id: number | string, dataJson: string): Promise<void>;
  /** Renews the 2-minute claim on effect `id` while `token` holds it running (a recovery record does not stop it); whether it did. */
  renewHeldEffectClaim(id: number | string, token: string | null): Promise<boolean>;
}

/**
 * The store over `exec`. `direct` runs the claim renewal (Postgres sends it on the direct lane, outside the pooled
 * transactions, as `effectClaimKeeper` did with `executeRawDirect`); it defaults to `exec`.
 */
export async function persistenceUpkeepStore(exec: Raw, direct: Raw = exec): Promise<PersistenceUpkeepStore> {
  const S = PERSISTENCE_UPKEEP_SQL;
  return {
    async limitCompactionWaits() {
      await exec.executeRaw(S.lockTimeout);
      await exec.executeRaw(S.statementTimeout);
    },
    async lockCompactionReceipt<R>(id: string, completedBefore: string | null) {
      const [row] = await exec.executeRaw<CompactionReceipt<R>>(S.lockReceipt, [id, completedBefore]);
      return row ?? null;
    },
    async hasUnfinishedEffect(requestId: string) {
      return (await exec.executeRaw(S.unfinishedEffect, [requestId])).length > 0;
    },
    async newestSyncReceiptId(worktreeId: string) {
      const [newest] = await exec.executeRaw<{ id: string }>(S.newestSyncReceipt, [worktreeId]);
      return newest?.id ?? null;
    },
    async requestEffectBytes(requestId: string) {
      const [effects] = await exec.executeRaw<{ bytes: string }>(S.effectBytes, [requestId]);
      return String(effects?.bytes ?? '0');
    },
    async markReceiptCompacted(id: string, retained: number) {
      await exec.executeRaw(S.markCompacted, [id, retained]);
    },
    async releaseTerminalBytes(keys: readonly string[], freed: number) {
      await exec.executeRaw(S.releaseTerminalBytes, [[...keys], freed]);
    },
    async lockRearmableEffects<R>(requestIds: readonly string[], code: string) {
      return exec.executeRaw<R>(S.lockRearmable, [[...requestIds], code]);
    },
    async rearmEffect(id: number | string, dataJson: string) {
      await exec.executeRaw(S.rearmEffect, [id, dataJson]);
    },
    async renewHeldEffectClaim(id: number | string, token: string | null) {
      return (await direct.executeRaw(S.renewHeldClaim, [id, token])).length === 1;
    },
  };
}
