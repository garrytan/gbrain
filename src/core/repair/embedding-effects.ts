/**
 * `gbrain repair embedding-effects` (#5629, #5734): settle embedding effects
 * of committed writes that are stale queued or failed, so compaction and
 * activation stop waiting on them. Each effect ends `reconciled`,
 * `superseded`, `retry_queued` or `blocked` (see
 * persistence/embedding-settlement.ts). `retry_queued` is owner work, not
 * success: doctor's `stale_embedding_effects` stays pending until the effect
 * settles. A retry grant is paid work: the estimate counts the whole bounded
 * retry budget.
 */
import { loadConfigWithEngine } from '../config.ts';
import { existingLocalHostId } from '../persistence/identity.ts';
import { EMBEDDING_RETRY_BUDGET_ATTEMPTS, listEmbeddingCandidates, settleEmbeddingEffect, type EmbeddingCandidate } from '../persistence/embedding-settlement.ts';
import { OperationError } from '../ops/contract.ts';
import type { RepairHandler, RepairItem } from './core.ts';

function localHost(): string {
  const hostId = existingLocalHostId();
  if (!hostId) throw new OperationError('permission_denied', 'Settling embedding effects requires the registered local CLI host.',
    'Run it on the brain host that owns the source.');
  return hostId;
}

export const embeddingEffectsRepair: RepairHandler = {
  kind: 'embedding-effects',
  publication: 'projection',
  // Effect ids order the scan, so a --limit or interrupted run resumes after the last settled effect.
  async plan(engine, scope, after) {
    const candidates = await listEmbeddingCandidates(engine, scope.source_ids);
    const hostId = existingLocalHostId();
    const config = await loadConfigWithEngine(engine);
    const items: RepairItem[] = [];
    const residuals: Record<string, number> = {};
    for (const candidate of candidates) {
      if (after && Number(candidate.effect_id) <= after.id) continue;
      const predicted = hostId ? await settleEmbeddingEffect(engine, candidate, { dryRun: true, config, hostId })
        : { outcome: 'blocked' as const, reason: 'owner_unavailable' };
      if (predicted.outcome === 'blocked' || predicted.outcome === 'changed_since_preview') {
        const key = predicted.outcome === 'blocked' ? `blocked_${predicted.reason}` : predicted.outcome;
        residuals[key] = (residuals[key] ?? 0) + 1;
        continue;
      }
      items.push({ cursor: { phase: 0, id: Number(candidate.effect_id) }, source_id: candidate.source_id, slug: candidate.slug,
        chars: predicted.paid ? candidate.chars * EMBEDDING_RETRY_BUDGET_ATTEMPTS : 0,
        action: `${predicted.outcome}${predicted.reason ? `:${predicted.reason}` : ''}${predicted.paid ? ' (paid)' : ''}`,
        change: { from: JSON.stringify({ effect_id: candidate.effect_id, state: candidate.state, attempts: candidate.attempts } satisfies Pick<EmbeddingCandidate, 'effect_id' | 'state' | 'attempts'>), to: predicted.outcome } });
    }
    return { items, residuals };
  },
  async apply(ctx, item, opts) {
    const settled = await settleEmbeddingEffect(ctx.engine, JSON.parse(item.change!.from!),
      { dryRun: false, config: await loadConfigWithEngine(ctx.engine), hostId: localHost(), runId: opts?.runId });
    return { applied: settled.outcome !== 'blocked' && settled.outcome !== 'changed_since_preview', outcome: settled.outcome, ...(settled.reason ? { reason: settled.reason } : {}) };
  },
};
