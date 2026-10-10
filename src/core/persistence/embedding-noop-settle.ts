/**
 * Settles queued embedding effects that have nothing left to do, in bulk.
 *
 * A classic import followed by `gbrain embed --stale` (or a restored or moved
 * brain) can leave tens of thousands of queued page embedding effects whose
 * chunks already carry current vectors. Each one would otherwise take a claim,
 * a guard transaction, a projection read and a completion update before
 * reaching the outcome the effect runner records when nothing is pending.
 *
 * An effect is settled here only when the runner would find nothing to embed:
 * a plain page effect (no targets, scan, retry slugs or parked targets) never
 * attempted, ready and claimable by this host as `claimPersistenceEffect`
 * would claim it, whose source passes `guardEffectSource`, whose page is live
 * at the effect's revision with its text projection sealed there, and whose
 * every chunk passes `readEmbeddingEffectProjection`'s completion test for the
 * current signature, write column and model. The row ends exactly as the
 * runner's own claim and completion leave it (state, outcome, attempts,
 * cleared claim). Every other effect is left for the runner.
 *
 * No effect kind is ordered after a page embedding effect: the claim order is
 * `next_attempt_at, id` across kinds, only Git groups and withdrawal mirrors
 * gate other effects, and an embedding effect gates nothing.
 */
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { embeddingWriteTarget } from '../page-state/projections.ts';
import { quoteIdentifier } from '../search/embedding-column.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { embeddingCompletionModel } from './effects.ts';
import type { PersistenceEffect } from './effect-model.ts';
import { faultPoint } from './fault-points.ts';
import { declarePersistenceProtocol, PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { refreshFenceClear } from './worktree-refresh-schema.ts';

/** At most this many effects settle in one statement. */
export const NOOP_SETTLE_BATCH = 200;

/** Guard failures that leave an effect for the runner, which records them as it does today. */
const LEFT_FOR_RUNNER = new Set(['owner_unavailable', 'source_changed', 'recovery_required']);

type Candidate = Pick<PersistenceEffect, 'id' | 'kind' | 'source_id' | 'source_incarnation' | 'worktree_id'>;

/**
 * How far a process's settle passes have looked, for one write column, model and signature. Effects at or below
 * `through` were each considered once; one that becomes a no-op later (vectors installed while it waited) takes the
 * runner path. Without it, a backlog that cannot settle (stale vectors, an unconfigured provider) would be walked in
 * full on every drain.
 */
export interface NoopSettleCursor { key: string; through: string }
export interface NoopSettlePass { settled: number; cursor: NoopSettleCursor; done: boolean }

/** One settle pass over effects past `after`, in id order; `done` once it reached the newest effect. */
export async function settleNoopEmbeddingEffects(engine: BrainEngine, hostId: string, signature: string,
  after?: NoopSettleCursor, limit = NOOP_SETTLE_BATCH): Promise<NoopSettlePass> {
  const { column } = await embeddingWriteTarget(engine);
  const expectedModel = embeddingCompletionModel(column, signature) ?? null;
  const key = `${column.name}\0${expectedModel ?? ''}\0${signature}`;
  const from = after?.key === key ? after.through : '0';
  // A drain with nothing new to consider costs one indexed read and opens no transaction.
  // Ordered by id so a generic plan (a prepared statement past its first runs) still walks the primary key from `from`.
  const [due] = await engine.executeRaw(`SELECT 1 FROM persistence_effects e WHERE e.id>$1::bigint AND e.kind='embedding' AND e.state='queued'
    AND e.attempts=0 AND e.recovery IS NULL ORDER BY e.id LIMIT 1`, [from]);
  if (!due) return { settled: 0, cursor: { key, through: from }, done: true };
  return engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    const [{ newest }] = await tx.executeRaw<{ newest: string }>('SELECT COALESCE(max(id),0)::text AS newest FROM persistence_effects');
    // The window is the next `limit` unattempted embedding effects by id, read from the primary key and locked;
    // the per-effect tests then run on that window only, so a pass costs at most `limit` effects whatever the
    // backlog holds and whatever the planner estimates for it.
    const rows = await tx.executeRaw<{ id: string; page_id: number | null }>(`SELECT e.id::text AS id, (e.data->>'page_id')::int AS page_id
      FROM persistence_effects e WHERE e.id>$1::bigint AND e.kind='embedding' AND e.state='queued' AND e.attempts=0 AND e.recovery IS NULL
      ORDER BY e.id LIMIT $2 FOR UPDATE SKIP LOCKED`, [from, limit]);
    const window = rows.map(row => row.id);
    // A short window reached the newest effect; a full one continues after its last effect.
    const done = window.length < limit;
    const cursor = { key, through: done ? newest : window[window.length - 1]! };
    if (!window.length) return { settled: 0, cursor, done };
    const vector = quoteIdentifier(column.name);
    const candidates = await tx.executeRaw<Candidate>(`SELECT e.id::text AS id, e.kind, e.source_id, e.source_incarnation, e.worktree_id
      FROM persistence_effects e
      JOIN pages p ON p.id=(e.data->>'page_id')::int AND p.source_id=e.source_id
      WHERE e.id=ANY($4::text[]::bigint[]) AND p.id=ANY($5::int[]) AND e.next_attempt_at<=now()
        AND NOT (e.data ? 'targets') AND NOT (e.data ? 'source_scan') AND NOT (e.data ? 'retry_slugs') AND NOT (e.data ? 'parked')
        AND (e.worktree_id IS NULL OR (EXISTS (SELECT 1 FROM persistence_worktrees w WHERE w.id=e.worktree_id AND w.owner_host_id=$1::uuid)
          AND ${refreshFenceClear('e')}))
        AND NOT EXISTS (SELECT 1 FROM persistence_effects blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_requests blocked WHERE blocked.worktree_id=e.worktree_id AND blocked.recovery IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM persistence_effects mirror
          WHERE mirror.request_id=e.request_id AND mirror.kind='withdrawal-mirror' AND mirror.state<>'committed')
        AND p.deleted_at IS NULL AND p.knowledge_revision=e.revision AND p.text_projection_revision=p.knowledge_revision
        AND p.embedding_signature=$2
        AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id=p.id AND NOT (cc.${vector} IS NOT NULL
          AND cc.embedded_at IS NOT NULL AND cc.embedded_text_hash IS NOT DISTINCT FROM md5(cc.chunk_text) AND cc.model IS NOT DISTINCT FROM $3))
      ORDER BY e.id
      FOR SHARE OF p`, [hostId, signature, expectedModel, window, rows.flatMap(row => row.page_id === null ? [] : [row.page_id])]);
    if (!candidates.length) return { settled: 0, cursor, done };
    const guarded = new Map<string, boolean>();
    const ids: string[] = [];
    for (const effect of candidates) {
      const scope = `${effect.source_id}\0${effect.source_incarnation}\0${effect.worktree_id ?? ''}`;
      if (!guarded.has(scope)) {
        guarded.set(scope, await guardEffectSource(tx, effect as PersistenceEffect, hostId).then(() => true, error => {
          if (error instanceof OperationError && LEFT_FOR_RUNNER.has(error.code)) return false;
          throw error;
        }));
      }
      if (guarded.get(scope)) ids.push(String(effect.id));
    }
    if (!ids.length) return { settled: 0, cursor, done };
    const settled = await tx.executeRaw(`UPDATE persistence_effects SET state='committed', error_code=NULL, attempts=attempts+1,
        data=data-'retry_slugs'-'target_failures'-'failing_target', execution_token=NULL, claim_expires_at=NULL, outcome='{}'::jsonb, updated_at=now()
      WHERE id=ANY($1::text[]::bigint[]) AND state='queued' AND recovery IS NULL AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING id`, [ids]);
    await faultPoint('effect:embedding:settle', { effectId: ids[0] });
    return { settled: settled.length, cursor, done };
  });
}
