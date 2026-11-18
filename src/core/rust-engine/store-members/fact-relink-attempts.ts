/**
 * Facts relink attempts: the `fact_relink_attempts` members (BrainEngine upsertFactRelinkAttempt, listFactRelinkOutcomes,
 * deleteFactRelinkMemos; src/core/engine-sql/fact-relink-attempts.ts), over rust/crates/gbrain-store/src/facts/relink.rs.
 * `countFactRelinkOutcomes`, the doctor's read of the table, is in facts-doctor.ts. The table has no foreign key, so the
 * store neither checks the source of a write nor removes rows with a source or a fact (rust/docs/store/facts.md).
 *
 * A fact id the store cannot read as the `bigint` PGLite binds (not a safe integer) refuses rather than guess at the
 * cast error.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

function requireFactId(member: string, id: number): void {
  if (!Number.isSafeInteger(id)) refuseMember(member, 'a fact id that is not a safe integer');
}

export const upsertFactRelinkAttempt: Member<'upsertFactRelinkAttempt'> = async (brain, sourceId, attempt, opts = {}) => {
  requireFactId('upsertFactRelinkAttempt', attempt.factId);
  await storeCall({ member: 'upsertFactRelinkAttempt', sourceId }, () => brain.upsertFactRelinkAttempt(sourceId, {
    factId: attempt.factId, outcome: attempt.outcome, reason: attempt.reason, tier: attempt.tier, model: attempt.model,
    targetSlug: attempt.targetSlug, runId: attempt.runId,
  }, { keepModelAndRun: opts.keepModelAndRun === true }));
};

export const listFactRelinkOutcomes: Member<'listFactRelinkOutcomes'> = async (brain, sourceId, factIds, outcomes) => {
  for (const id of factIds) requireFactId('listFactRelinkOutcomes', id);
  const rows: Array<{ fact_id: number; outcome: string }> = await storeCall({ member: 'listFactRelinkOutcomes', sourceId },
    () => brain.listFactRelinkOutcomes(sourceId, factIds, outcomes));
  return rows.map(r => ({ fact_id: Number(r.fact_id), outcome: r.outcome }));
};

export const deleteFactRelinkMemos: Member<'deleteFactRelinkMemos'> = async (brain, sourceId, tier, targetSlug) => {
  await storeCall({ member: 'deleteFactRelinkMemos', sourceId }, () => brain.deleteFactRelinkMemos(sourceId, tier, targetSlug));
};
