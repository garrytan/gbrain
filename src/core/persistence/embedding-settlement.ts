/**
 * `gbrain repair embedding-effects` settlement (#5629, #5734). A committed
 * write can keep an embedding effect that never finishes: queued with no owner
 * run for over an hour, or failed after its retry allowance. Either one blocks
 * receipt compaction and activation (`writer_not_quiesced`). Each candidate
 * ends in exactly one outcome and no obligation is dropped without one:
 *
 * - `reconciled`: the page's current chunks pass the effect projection
 *   verifier (sealed revision, selected column, model and hashes), so the
 *   effect commits with no provider work.
 * - `superseded`: the page was deleted, or a newer revision of the same page
 *   (same page id) owns its own embedding effect; the effect commits with
 *   `{ embedding: 'superseded' }`, as the owner's own run would.
 * - `retry_queued`: the owner embeds it. A stale queued effect is re-queued;
 *   a failed one gets the `retry-effects` allowance, or, when that allowance
 *   is consumed (`embedding_retry_exhausted`), one new bounded retry cycle
 *   under a durable authorization id bound to this repair run, so a resumed
 *   run replays it instead of granting another. Not success: doctor keeps the
 *   effect pending until it settles.
 * - `blocked`: nothing changed; `reason` says why (`owner_unavailable`,
 *   `embedding_disabled`, `embedding_unconfigured`, `projection_pending`,
 *   `no_replacement_obligation`).
 *
 * Every state change is a compare-and-set on state, attempts, execution token
 * and recovery. A candidate that changed since planning is `changed_since_preview`.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { opError, OperationError } from '../ops/contract.ts';
import { EmbeddingDisabledError } from '../embedding-dim-check.ts';
import { MAX_RATE_LIMIT_RETRIES } from '../embed-retry.ts';
import { digest } from './digest.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { assertEmbeddingEffectEnabled, readEmbeddingEffectProjection, selectedEffectPage } from './effects.ts';
import { targetedWithdrawalEffect } from './effect-targets.ts';
import type { PersistenceEffect } from './effect-model.ts';

export type EmbeddingSettlementOutcome = 'reconciled' | 'superseded' | 'retry_queued' | 'blocked' | 'changed_since_preview';

export interface EmbeddingSettlement {
  outcome: EmbeddingSettlementOutcome;
  reason?: string;
  /** A retry grant that lets the owner spend on the provider. */
  paid?: boolean;
  /** Pending chunks the verifier rejected (missing or signature-mismatched vectors). */
  pending_chunks?: number;
}

export interface EmbeddingCandidate {
  effect_id: string; source_id: string; slug: string; request_id: string; state: 'queued' | 'failed'; attempts: number; chars: number;
}

/** Stale queued (over an hour, or re-queued by this repair and not yet settled) and failed embedding effects of committed writes. */
export const EMBEDDING_CANDIDATE_WHERE = `e.kind='embedding' AND r.state='committed' AND e.recovery IS NULL AND e.execution_token IS NULL
  AND (e.state='failed' OR e.state='queued' AND (e.updated_at < now() - interval '1 hour' OR e.data ? 'repair_requeued_at'))`;

export async function listEmbeddingCandidates(engine: Pick<BrainEngine, 'executeRaw'>, sourceIds: string[]): Promise<EmbeddingCandidate[]> {
  const rows = await engine.executeRaw<EmbeddingCandidate>(`SELECT e.id::text AS effect_id, r.source_id, r.slug, r.request_id::text AS request_id,
      e.state, e.attempts, COALESCE(CASE
        WHEN e.data ? 'page_id' THEN (SELECT length(p.compiled_truth) + length(COALESCE(p.timeline,'')) FROM pages p WHERE p.id = (e.data->>'page_id')::int)
        WHEN e.data ? 'targets' THEN (SELECT SUM(length(p.compiled_truth) + length(COALESCE(p.timeline,''))) FROM pages p
          JOIN jsonb_array_elements(e.data->'targets') t ON p.id = (t->>'page_id')::int)
        ELSE (SELECT SUM(length(p.compiled_truth) + length(COALESCE(p.timeline,''))) FROM pages p WHERE p.source_id = e.source_id AND p.deleted_at IS NULL)
      END, 0)::bigint AS chars
    FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id
    WHERE ${EMBEDDING_CANDIDATE_WHERE} AND (r.source_id = ANY($1::text[])
      OR NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = r.source_id AND s.incarnation = r.source_incarnation)) ORDER BY e.id`, [sourceIds]);
  return rows.map(row => ({ ...row, attempts: Number(row.attempts), chars: Number(row.chars) }));
}

function configuredSignature(config: GBrainConfig | null): string | null {
  return config?.embedding_model && config.embedding_dimensions ? `${config.embedding_model}:${config.embedding_dimensions}` : null;
}

/** The authorization id of one repair run's grant for one effect. */
export function embeddingGrantId(runId: string, effectId: string | number): string {
  return digest(['embedding-effects-grant-v1', runId, String(effectId)]);
}

/**
 * Settle one candidate. With `dryRun` it only predicts the outcome. `runId`
 * binds an exhausted-retry grant to the repair run that authorized it.
 */
export async function settleEmbeddingEffect(engine: BrainEngine, candidate: Pick<EmbeddingCandidate, 'effect_id' | 'state' | 'attempts'>,
  opts: { dryRun: boolean; config: GBrainConfig | null; hostId: string; runId?: string }): Promise<EmbeddingSettlement> {
  return engine.transaction(async tx => {
    const [effect] = await tx.executeRaw<PersistenceEffect & { request_state: string }>(`SELECT e.*, r.state AS request_state
      FROM persistence_effects e JOIN persistence_requests r ON r.id = e.request_id WHERE e.id = $1 FOR UPDATE OF e`, [candidate.effect_id]);
    if (!effect || effect.kind !== 'embedding' || effect.request_state !== 'committed' || effect.state !== candidate.state
      || Number(effect.attempts) !== candidate.attempts || effect.execution_token !== null || effect.recovery) {
      return { outcome: 'changed_since_preview' };
    }
    const commit = async (outcome: Record<string, unknown>): Promise<boolean> => {
      if (opts.dryRun) return true;
      const rows = await tx.executeRaw(`UPDATE persistence_effects SET state='committed', error_code=NULL, claim_expires_at=NULL,
          outcome=$3::text::jsonb, data=data-'repair_requeued_at', updated_at=now()
        WHERE id=$1 AND state=$2 AND attempts=$4 AND execution_token IS NULL AND recovery IS NULL RETURNING id`,
      [effect.id, effect.state, JSON.stringify(outcome), effect.attempts]);
      return rows.length > 0;
    };
    // The obligation of a removed (or replaced) source incarnation is moot: nothing can read those vectors.
    const [source] = await tx.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR SHARE', [effect.source_id]);
    if (!source || source.incarnation !== effect.source_incarnation) {
      return await commit({ embedding: 'superseded', reason: 'source_removed' }) ? { outcome: 'superseded', reason: 'source_removed' } : { outcome: 'changed_since_preview' };
    }
    try { await guardEffectSource(tx, effect, opts.hostId); }
    catch (error) {
      if (error instanceof OperationError && ['owner_unavailable', 'source_changed'].includes(error.code)) return { outcome: 'blocked', reason: 'owner_unavailable' };
      throw error;
    }
    const scanning = targetedWithdrawalEffect(effect) || effect.data.source_scan === true;
    const snapshot = await selectedEffectPage(tx, effect);
    let pendingChunks: number | undefined;
    if (scanning) {
      // A finished scan has nothing left to embed; one with pages left needs a configured model like a page effect.
      if (!snapshot) return await commit({ embedding: 'reconciled' }) ? { outcome: 'reconciled' } : { outcome: 'changed_since_preview' };
      if (!configuredSignature(opts.config)) return { outcome: 'blocked', reason: 'embedding_unconfigured' };
    } else {
      if (!snapshot || snapshot.page.deleted_at || snapshot.page.id !== effect.data.page_id || snapshot.revision !== effect.revision) {
        const deleted = !snapshot || snapshot.page.deleted_at || snapshot.page.id !== effect.data.page_id;
        const [replacement] = deleted ? [] : await tx.executeRaw<{ id: string }>(`SELECT id::text FROM persistence_effects
          WHERE kind='embedding' AND source_id=$1 AND source_incarnation=$2::uuid AND revision=$3::uuid AND (data->>'page_id')::int=$4 AND id<>$5 LIMIT 1`,
        [effect.source_id, effect.source_incarnation, snapshot!.revision, snapshot!.page.id, effect.id]);
        if (!deleted && !replacement) return { outcome: 'blocked', reason: 'no_replacement_obligation' };
        const settled = await commit(deleted ? { embedding: 'superseded', reason: 'page_deleted' }
          : { embedding: 'superseded', reason: 'revision_changed', replaced_by: replacement.id });
        return settled ? { outcome: 'superseded', reason: deleted ? 'page_deleted' : 'revision_changed' } : { outcome: 'changed_since_preview' };
      }
      const signature = configuredSignature(opts.config);
      if (!signature) return { outcome: 'blocked', reason: 'embedding_unconfigured' };
      let pending: unknown[];
      try { pending = (await readEmbeddingEffectProjection(tx, effect, snapshot, opts.hostId, signature)).pending; }
      catch (error) {
        if (error instanceof OperationError && error.code === 'projection_pending') return { outcome: 'blocked', reason: 'projection_pending' };
        throw error;
      }
      if (pending.length === 0) {
        return await commit({ embedding: 'reconciled' }) ? { outcome: 'reconciled' } : { outcome: 'changed_since_preview' };
      }
      pendingChunks = pending.length;
    }
    await tx.executeRaw("SELECT key FROM config WHERE key='embedding_disabled' FOR SHARE");
    try { await assertEmbeddingEffectEnabled(tx, opts.config); }
    catch (error) {
      if (error instanceof EmbeddingDisabledError) return { outcome: 'blocked', reason: 'embedding_disabled' };
      throw error;
    }
    return queueRetry(tx, effect, opts, pendingChunks);
  });
}

async function queueRetry(tx: BrainEngine, effect: PersistenceEffect, opts: { dryRun: boolean; runId?: string }, pendingChunks: number | undefined): Promise<EmbeddingSettlement> {
  const base = { outcome: 'retry_queued' as const, ...(pendingChunks !== undefined ? { pending_chunks: pendingChunks } : {}) };
  const exhausted = effect.state === 'failed' && effect.data.embedding_retry_base !== undefined;
  const grants: string[] = (effect.data as { repair_authorizations?: string[] }).repair_authorizations ?? [];
  // Every retry this run authorizes for a failed effect is recorded, the first one included.
  const paid = effect.state === 'failed';
  const grantId = paid && opts.runId ? embeddingGrantId(opts.runId, effect.id) : null;
  if (grantId && grants.includes(grantId)) return { ...base, reason: 'grant_replayed' };
  if (opts.dryRun) return { ...base, paid, ...(exhausted ? { reason: 'grant_new_retry_cycle' } : {}) };
  if (paid && !grantId) {
    throw opError('invalid_params', 'An embedding retry grant needs a repair run id.',
      'Paid embedding retries run only through gbrain repair embedding-effects, which supplies the run id. Preview it with gbrain repair embedding-effects --json and apply it after the user approves the cost.');
  }
  const now = new Date().toISOString();
  const data = { ...effect.data, repair_requeued_at: now,
    ...(effect.state === 'failed' ? { embedding_attempt_base: effect.attempts, embedding_retry_base: effect.attempts } : {}),
    ...(grantId ? { repair_authorizations: [...grants, grantId] } : {}) };
  const rows = await tx.executeRaw(`UPDATE persistence_effects SET state='queued', data=$3::text::jsonb, error_code=NULL, claim_expires_at=NULL,
      next_attempt_at=now(), outcome=NULL, updated_at=now()
    WHERE id=$1 AND state=$2 AND attempts=$4 AND execution_token IS NULL AND recovery IS NULL RETURNING id`,
  [effect.id, effect.state, JSON.stringify(data), effect.attempts]);
  if (!rows.length) return { outcome: 'changed_since_preview' };
  return { ...base, paid, ...(exhausted ? { reason: 'granted_new_retry_cycle' } : {}) };
}

/** The retry budget one grant authorizes, for the `--max-usd` estimate. */
export const EMBEDDING_RETRY_BUDGET_ATTEMPTS = MAX_RATE_LIMIT_RETRIES;
