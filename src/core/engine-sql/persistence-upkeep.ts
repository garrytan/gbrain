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
 * - The preparation-attempt counters (persistence/journal.ts `floorPreparationAttempts`, `chargePreparationAttempt`),
 *   a write receipt's health facts (`writeHealthFacts`) and the segment sweep's owned sources (`sweepSegmentStorage`).
 * - An effect attempt's reads and writes (persistence/effects.ts): the next page of a source scan (`selectedEffectPage`),
 *   whether an effect holds a recovery record (`recordFailure`) and a skipped target (`recordSkippedTarget`).
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
  floorPreparationAttempts: `UPDATE persistence_requests SET preparation_attempts=GREATEST(preparation_attempts,$2::integer),updated_at=now()
    WHERE id=$1::uuid AND state IN ('queued','running') AND set_config('gbrain.persistence_protocol','2',true)='2'`,
  chargePreparationAttempt: `UPDATE persistence_requests SET preparation_attempts=preparation_attempts+1,updated_at=now()
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND set_config('gbrain.persistence_protocol','2',true)='2' RETURNING preparation_attempts`,
  healthFacts: `
    WITH roots AS (SELECT unnest($1::text[]) AS root)
    SELECT roots.root,head.sequence::text,head.started_sequence::text,head.started_unlaned::text,COALESCE(head.inspect_owner,false) AS inspect_owner,
      COALESCE(head.recovering,false) OR EXISTS (SELECT 1 FROM persistence_effects e
        WHERE e.worktree_id=w.id AND e.recovery IS NOT NULL)
        OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes f WHERE f.worktree_id=w.id AND f.state='recovery_required') AS recovery_required,
      w.id IS NOT NULL AND (w.state<>'active' OR w.owner_host_id IS NULL) AS owner_unavailable
    FROM roots LEFT JOIN persistence_worktrees w ON w.id::text=roots.root
    LEFT JOIN LATERAL (
      (SELECT r.sequence,(SELECT s.sequence FROM persistence_requests s WHERE s.worktree_id=w.id
          AND (s.state IN ('running','recovering') OR s.recovery IS NOT NULL) ORDER BY s.sequence LIMIT 1) AS started_sequence,
        (SELECT s.sequence FROM persistence_requests s WHERE s.worktree_id=w.id
          AND (s.state IN ('running','recovering') OR s.recovery IS NOT NULL)
          AND NOT (s.state='running' AND s.recovery IS NULL AND s.operation='submit_job') ORDER BY s.sequence LIMIT 1) AS started_unlaned,
        (r.state='recovering' OR (r.recovery IS NOT NULL AND (r.state<>'running' OR r.claim_expires_at<now()))) AS recovering,
        r.blocked_reason IN ('unexpected_file_bytes','unexpected_staging_bytes') AS inspect_owner FROM persistence_requests r
        WHERE r.worktree_id=w.id AND (r.state IN ('queued','running','recovering') OR r.recovery IS NOT NULL OR (r.state='deferred' AND (r.deferred_refresh_id IS NOT NULL OR r.deferred_import_from IS NOT NULL)
        AND (r.deferred_refresh_id IS NULL OR EXISTS (SELECT 1 FROM persistence_worktree_refreshes released
          WHERE released.id=r.deferred_refresh_id AND released.released_at IS NOT NULL))
        AND (r.deferred_import_from IS NULL OR EXISTS (SELECT 1 FROM sources imported
          WHERE imported.id=r.source_id AND COALESCE(imported.last_commit,'')<>r.deferred_import_from))))
        ORDER BY r.sequence LIMIT 1)
      UNION ALL
      (SELECT r.sequence,(SELECT s.sequence FROM persistence_requests s WHERE s.worktree_id IS NULL AND s.source_incarnation=r.source_incarnation
          AND s.state IN ('running','recovering') ORDER BY s.sequence LIMIT 1) AS started_sequence,NULL::bigint AS started_unlaned,
        (r.state='recovering' OR (r.recovery IS NOT NULL AND (r.state<>'running' OR r.claim_expires_at<now()))) AS recovering,
        r.blocked_reason IN ('unexpected_file_bytes','unexpected_staging_bytes') AS inspect_owner FROM persistence_requests r
        WHERE r.worktree_id IS NULL AND r.source_incarnation=CASE WHEN roots.root LIKE 'db:%' THEN substring(roots.root FROM 4)::uuid END
        AND r.state IN ('queued','running','recovering') ORDER BY r.sequence LIMIT 1)
    ) head ON true`,
  nextScanSlug: `SELECT slug FROM pages WHERE source_id=$1 AND ($2::text IS NULL OR slug>$2) ORDER BY slug LIMIT 1`,
  effectRecovering: `SELECT recovery IS NOT NULL AS recovering FROM persistence_effects WHERE id=$1`,
  recordSkippedTarget: `UPDATE persistence_effects SET data=jsonb_set(data,'{skipped}',COALESCE(data->'skipped','[]'::jsonb)||$3::text::jsonb)
    WHERE id=$1 AND execution_token=$2::uuid AND jsonb_array_length(COALESCE(data->'skipped','[]'::jsonb))<$4`,
  ownedBoundSources: `SELECT s.source_id FROM persistence_source_bindings s
    JOIN persistence_worktrees w ON w.id=s.worktree_id WHERE w.owner_host_id=$1::uuid AND w.state='active'`,
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
  /** Raises live request `id`'s preparation attempts to at least `limit`. */
  floorPreparationAttempts(id: string, limit: number): Promise<void>;
  /** Adds one preparation attempt to request `id` while `token` holds it running; the new count, or null when no claim matched. */
  chargePreparationAttempt(id: string, token: string | null): Promise<number | null>;
  /** The health facts of each root (a worktree id, or `db:<source incarnation>`); see `writeHealthFacts`. */
  readHealthFacts(roots: readonly string[], opts?: { signal?: AbortSignal }): Promise<HealthFactRow[]>;
  /** The first slug of source `sourceId` after `afterSlug` (or the first one), in slug order; null past the last. */
  nextScanSlug(sourceId: string, afterSlug: string | null): Promise<string | null>;
  /** Whether effect `id` holds a recovery record; null when no effect has the id. */
  effectRecovering(id: number | string): Promise<boolean | null>;
  /** Adds `targetJson` (a one-element array) to effect `id`'s skipped list while `token` holds it and the list has fewer than `limit`. */
  recordSkippedTarget(id: number | string, token: string | null, targetJson: string, limit: number): Promise<void>;
  /** The sources bound to an active worktree host `hostId` owns. */
  listOwnedBoundSources(hostId: string): Promise<string[]>;
}

/** One root's health facts (`writeHealthFacts`): its head sequence and started sequences as text, and its flags. */
export interface HealthFactRow {
  root: string; sequence: string | null; started_sequence: string | null; started_unlaned: string | null;
  recovery_required: boolean; owner_unavailable: boolean; inspect_owner: boolean;
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
    async floorPreparationAttempts(id: string, limit: number) {
      await exec.executeRaw(S.floorPreparationAttempts, [id, limit]);
    },
    async chargePreparationAttempt(id: string, token: string | null) {
      const [charged] = await exec.executeRaw<{ preparation_attempts: number }>(S.chargePreparationAttempt, [id, token]);
      return charged ? Number(charged.preparation_attempts) : null;
    },
    async readHealthFacts(roots: readonly string[], opts?: { signal?: AbortSignal }) {
      return exec.executeRaw<HealthFactRow>(S.healthFacts, [[...roots]], opts?.signal ? { signal: opts.signal } : undefined);
    },
    async nextScanSlug(sourceId: string, afterSlug: string | null) {
      const [row] = await exec.executeRaw<{ slug: string }>(S.nextScanSlug, [sourceId, afterSlug]);
      return row?.slug ?? null;
    },
    async effectRecovering(id: number | string) {
      const [row] = await exec.executeRaw<{ recovering: boolean }>(S.effectRecovering, [id]);
      return row ? row.recovering : null;
    },
    async recordSkippedTarget(id: number | string, token: string | null, targetJson: string, limit: number) {
      await exec.executeRaw(S.recordSkippedTarget, [id, token, targetJson, limit]);
    },
    async listOwnedBoundSources(hostId: string) {
      return (await exec.executeRaw<{ source_id: string }>(S.ownedBoundSources, [hostId])).map(r => r.source_id);
    },
  };
}
