import type { BrainEngine, FactRow } from '../engine.ts';
import { verbError } from '../ops/contract.ts';
import { isAvailable, embedOne } from '../ai/gateway.ts';
import { cosineSimilarity } from './classify.ts';
import { isFactWithdrawn } from './withdrawal.ts';

export type FactCandidate = FactRow & { source_markdown_slug: string | null; row_num: number | null };
export interface FactDecision { status: 'inserted' | 'duplicate' | 'superseded'; candidate: FactCandidate | null; }
export interface SingleFactIntent {
  fact: string; kind: FactRow['kind']; visibility: FactRow['visibility']; entity_slug: string | null;
}
/** Provider work belongs to preparation, never to a page/source transaction. */
export async function prepareFactEmbedding(fact: string, signal?: AbortSignal): Promise<{ embedding: Float32Array | null; degraded: boolean }> {
  signal?.throwIfAborted();
  if (isAvailable('embedding')) {
    try { return { embedding: await embedOne(fact, { abortSignal: signal }), degraded: false }; } catch { signal?.throwIfAborted(); }
  }
  return { embedding: null, degraded: true };
}
export async function assertFactNotWithdrawn(engine: BrainEngine, sourceId: string, input: SingleFactIntent): Promise<void> {
  if (await isFactWithdrawn(engine, sourceId, input.visibility, input.fact)) {
    throw verbError('invalid_params', 'fact_withdrawn: this exact claim was explicitly forgotten in this source and visibility.',
      'Remember a corrected claim. Repeating the old claim does not restore withdrawn memory.');
  }
}
/** SQL-only, so publication can verify the semantic decision under its guard. */
export async function decideSingleFact(engine: BrainEngine, sourceId: string, input: SingleFactIntent, embedding: Float32Array | null): Promise<FactDecision> {
  const [exact] = await engine.executeRaw<FactCandidate>(`SELECT * FROM facts WHERE source_id=$1
    AND entity_slug IS NOT DISTINCT FROM $2 AND visibility=$3 AND expired_at IS NULL
    AND (valid_until IS NULL OR valid_until>now()) AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($4)
    ORDER BY id LIMIT 1`, [sourceId, input.entity_slug, input.visibility, input.fact]);
  if (exact) return { status: 'duplicate', candidate: { ...exact, id: Number(exact.id) } };
  if (embedding && input.entity_slug) {
    const candidates = await engine.findCandidateDuplicates(sourceId, input.entity_slug, input.fact, { embedding, k: 5 });
    const metadata = await engine.executeRaw<{ id: number; source_markdown_slug: string | null; row_num: number | null }>(
      'SELECT id,source_markdown_slug,row_num FROM facts WHERE source_id=$1 AND id=ANY($2::int[])',
      [sourceId, candidates.map(c => c.id)]);
    let candidate: FactCandidate | null = null;
    let score = -1;
    for (const found of candidates) {
      const fence = metadata.find(m => Number(m.id) === found.id);
      if (!fence) continue;
      const c: FactCandidate = { ...found, ...fence, id: found.id };
      // A private candidate must never affect a world's response or expire as a
      // side effect. Cross-page supersession requires a separate multi-page op.
      if (!c.embedding || c.visibility !== input.visibility || c.expired_at ||
        c.valid_until && new Date(c.valid_until).getTime() <= Date.now() ||
        c.source_markdown_slug && c.source_markdown_slug !== input.entity_slug) continue;
      const next = cosineSimilarity(embedding, c.embedding);
      if (next > score) { score = next; candidate = c; }
    }
    if (candidate && score >= 0.95) return {
      status: candidate.kind === input.kind ? 'superseded' : 'duplicate', candidate,
    };
  }
  return { status: 'inserted', candidate: null };
}
