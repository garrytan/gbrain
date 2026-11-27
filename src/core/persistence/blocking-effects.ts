/** Names the queued, running or recovering work that keeps a brain from quiescing (#5629). Read-only. */
import { OperationError } from '../ops/contract.ts';
import { WRITER_INSPECTION_HINT } from './admin-intent.ts';
import type { BrainEngine } from '../engine.ts';

export interface BlockingEffect {
  effect_id: string; kind: string; state: string; recovering: boolean; source_id: string; slug: string;
  request_id: string; attempts: number; next_attempt_at: string | Date | null; inspect: string;
}

const inspect = (sourceId: string) => `gbrain sources writer status ${sourceId} --json`;

/** Effects in state queued or running, or holding a recovery record, oldest first. */
export async function listBlockingEffects(engine: Pick<BrainEngine, 'listBlockingEffectRows'>, opts: { sourceId?: string; limit?: number; recoveringOnly?: boolean } = {}): Promise<BlockingEffect[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 20, 1000));
  const rows = await engine.listBlockingEffectRows(opts.sourceId ?? null, limit, opts.recoveringOnly === true);
  return rows.map(row => ({ ...row, attempts: Number(row.attempts), inspect: inspect(row.source_id) }));
}

export function blockingEffectHint(effect: BlockingEffect): string {
  return `${WRITER_INSPECTION_HINT} Blocking effect ${effect.effect_id} (kind ${effect.kind}, state ${effect.state}${effect.recovering ? ', recovering' : ''}) `
    + `for source ${effect.source_id}, page ${effect.slug}, request ${effect.request_id}. Inspect it with: ${effect.inspect}. `
    + 'The resident owner drains queued and running effects; gbrain sources writer retry-effects re-authorizes failed or parked effects; '
    + `a stuck queued or failed embedding effect is settled by gbrain repair embedding-effects --source ${effect.source_id} (preview first, then --apply).`;
}

export function blockingRequestHint(request: { request_id: string; source_id: string; slug: string; operation: string; state: string }): string {
  return `${WRITER_INSPECTION_HINT} Blocking request ${request.request_id} `
    + `(${request.operation}, ${request.state}) for source ${request.source_id}, page ${request.slug}. Inspect it with: ${inspect(request.source_id)}. `
    + 'Let the resident owner publish or recover it, then retry.';
}

/** The effect a Rust brain's activation names (shared-skills/rust-publication.ts) as listBlockingEffects would. */
export function blockingEffectFrom(effect: { effect_id?: string; effect_kind?: string; state: string; recovering?: boolean; source_id: string; slug: string;
  request_id: string; attempts?: number; next_attempt_at?: string | null }): BlockingEffect {
  return { effect_id: effect.effect_id ?? '', kind: effect.effect_kind ?? '', state: effect.state, recovering: effect.recovering === true, source_id: effect.source_id,
    slug: effect.slug, request_id: effect.request_id, attempts: effect.attempts ?? 0, next_attempt_at: effect.next_attempt_at ?? null, inspect: inspect(effect.source_id) };
}

/** `writer_not_quiesced` naming the first blocking request, else the first blocking effect. */
export async function notQuiescedError(tx: Pick<BrainEngine, 'writerReleaseStore' | 'listBlockingEffectRows'>, message: string, opts: { queuedEffects: boolean }): Promise<OperationError> {
  const [request] = await (await tx.writerReleaseStore()).blockingRequests(1);
  if (request) return new OperationError('writer_not_quiesced', message, `${WRITER_INSPECTION_HINT} Blocking request ${request.request_id} `
    + `(${request.operation}, ${request.state}) for source ${request.source_id}, page ${request.slug}. Inspect it with: ${inspect(request.source_id)}. `
    + 'Let the resident owner publish or recover it, then retry.');
  const [effect] = await listBlockingEffects(tx, { limit: 1, recoveringOnly: !opts.queuedEffects });
  return new OperationError('writer_not_quiesced', message, effect ? blockingEffectHint(effect) : WRITER_INSPECTION_HINT);
}
