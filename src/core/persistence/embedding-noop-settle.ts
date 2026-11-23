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
import { trueUpRequests } from './receipt-true-up.ts';
import type { BrainEngine } from '../engine.ts';
import { OperationError } from '../ops/contract.ts';
import { embeddingWriteTarget } from '../page-state/projections.ts';
import { guardEffectSource } from './effect-recovery.ts';
import { embeddingCompletionModel } from './effects.ts';
import type { PersistenceEffect } from './effect-model.ts';
import { faultPoint } from './fault-points.ts';
import { declarePersistenceProtocol } from './protocol.ts';

/**
 * At most this many effects settle in one statement. A pass and its reservation true-up hold the event loop on PGLite,
 * so the batch bounds how long a request waits behind the drain.
 */
export const NOOP_SETTLE_BATCH = 50;

/** Guard failures that leave an effect for the runner, which records them as it does today. */
const LEFT_FOR_RUNNER = new Set(['owner_unavailable', 'source_changed', 'recovery_required', 'owner_marker_missing']);

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
  const due = await engine.probeNoopEmbeddingSettle(from);
  if (!due) return { settled: 0, cursor: { key, through: from }, done: true };
  const requestIds: string[] = [];
  const pass = await engine.transaction(async tx => {
    await declarePersistenceProtocol(tx);
    // The window is the next `limit` unattempted embedding effects by id, read from the primary key and locked;
    // the per-effect tests then run on that window only, so a pass costs at most `limit` effects whatever the
    // backlog holds and whatever the planner estimates for it.
    const { newest, rows } = await tx.lockNoopEmbeddingWindow({ from, limit });
    const window = rows.map(row => row.id);
    // A short window reached the newest effect; a full one continues after its last effect.
    const done = window.length < limit;
    const cursor = { key, through: done ? newest : window[window.length - 1]! };
    if (!window.length) return { settled: 0, cursor, done };
    const candidates = await tx.readNoopEmbeddingCandidates({ hostId, signature, expectedModel, column: column.name, window,
      pageIds: rows.flatMap(row => row.page_id === null ? [] : [row.page_id]) });
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
    const settled = await tx.settleNoopEmbeddingRows(ids);
    await faultPoint('effect:embedding:settle', { effectId: ids[0] });
    for (const row of settled) requestIds.push(row.request_id);
    return { settled: settled.length, cursor, done };
  });
  // #6696 (A1): the settled requests give back their unused reservation, outside the settle transaction.
  await trueUpRequests(engine, requestIds);
  return pass;
}
