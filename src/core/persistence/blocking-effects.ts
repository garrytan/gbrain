/** Names the queued, running or recovering work that keeps a brain from quiescing (#5629). Read-only. */
import { OperationError } from '../ops/contract.ts';
import { WRITER_INSPECTION_HINT } from './admin-intent.ts';
import type { SqlEngine } from './model.ts';

export interface BlockingEffect {
  effect_id: string; kind: string; state: string; recovering: boolean; source_id: string; slug: string;
  request_id: string; attempts: number; next_attempt_at: string | Date | null; inspect: string;
}

const inspect = (sourceId: string) => `gbrain sources writer status ${sourceId} --json`;

/** Effects in state queued or running, or holding a recovery record, oldest first. */
export async function listBlockingEffects(engine: SqlEngine, opts: { sourceId?: string; limit?: number; recoveringOnly?: boolean } = {}): Promise<BlockingEffect[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 1000));
  const rows = await engine.executeRaw<Omit<BlockingEffect, 'inspect'>>(`SELECT e.id::text AS effect_id,e.kind,e.state,(e.recovery IS NOT NULL) AS recovering,
    COALESCE(e.source_id,r.source_id) AS source_id,r.slug,r.request_id::text AS request_id,e.attempts,e.next_attempt_at
    FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id
    WHERE (e.recovery IS NOT NULL OR (NOT $3::boolean AND e.state IN ('queued','running')))
      AND ($1::text IS NULL OR COALESCE(e.source_id,r.source_id)=$1)
    ORDER BY e.id LIMIT $2`, [opts.sourceId ?? null, limit, opts.recoveringOnly === true]);
  return rows.map(row => ({ ...row, attempts: Number(row.attempts), inspect: inspect(row.source_id) }));
}

export function blockingEffectHint(effect: BlockingEffect): string {
  return `${WRITER_INSPECTION_HINT} Blocking effect ${effect.effect_id} (kind ${effect.kind}, state ${effect.state}${effect.recovering ? ', recovering' : ''}) `
    + `for source ${effect.source_id}, page ${effect.slug}, request ${effect.request_id}. Inspect it with: ${effect.inspect}. `
    + 'The resident owner drains queued and running effects; gbrain sources writer retry-effects re-authorizes failed or parked effects; '
    + `a stuck queued or failed embedding effect is settled by gbrain repair embedding-effects --source ${effect.source_id} (preview first, then --apply).`;
}

/** `writer_not_quiesced` naming the first blocking request, else the first blocking effect. */
export async function notQuiescedError(tx: SqlEngine, message: string, opts: { queuedEffects: boolean }): Promise<OperationError> {
  const [request] = await tx.executeRaw<{ request_id: string; source_id: string; slug: string; operation: string; state: string }>(
    `SELECT request_id::text AS request_id,source_id,slug,operation,state FROM persistence_requests
     WHERE state IN ('queued','running','recovering') OR recovery IS NOT NULL ORDER BY sequence LIMIT 1`);
  if (request) return new OperationError('writer_not_quiesced', message, `${WRITER_INSPECTION_HINT} Blocking request ${request.request_id} `
    + `(${request.operation}, ${request.state}) for source ${request.source_id}, page ${request.slug}. Inspect it with: ${inspect(request.source_id)}. `
    + 'Let the resident owner publish or recover it, then retry.');
  const [effect] = await listBlockingEffects(tx, { limit: 1, recoveringOnly: !opts.queuedEffects });
  return new OperationError('writer_not_quiesced', message, effect ? blockingEffectHint(effect) : WRITER_INSPECTION_HINT);
}
