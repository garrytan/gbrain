import type { BrainEngine, FactAttribution, FactRow } from '../engine.ts';
import { verbError } from '../ops/contract.ts';
import { isAvailable, embedOne, getEmbeddingModel } from '../ai/gateway.ts';
import { cosineSimilarity } from './classify.ts';
import { isFactWithdrawn } from './withdrawal.ts';
import { assertFactNotPurged } from './withdrawal.ts';
import { cosineVerdict } from './capture-dedup.ts';

export type FactCandidate = FactRow & { source_markdown_slug: string | null; row_num: number | null };
export interface FactDecision { status: 'inserted' | 'duplicate' | 'superseded'; candidate: FactCandidate | null; }
export interface SingleFactIntent {
  fact: string; kind: FactRow['kind']; visibility: FactRow['visibility']; entity_slug: string | null;
  /** Speaker of the new claim; a fact another known speaker asserted is never its duplicate. */
  attributed_to?: FactAttribution | null;
}
/** Provider work belongs to preparation, never to a page/source transaction. `disabled`: the brain opted out of embedding. */
export async function prepareFactEmbedding(fact: string, signal?: AbortSignal, disabled = false): Promise<{ embedding: Float32Array | null; embedding_model: string | null; degraded: boolean }> {
  signal?.throwIfAborted();
  if (!disabled && isAvailable('embedding')) {
    try {
      const model = getEmbeddingModel();
      return { embedding: await embedOne(fact, { abortSignal: signal, embeddingModel: model, inputType: 'document' }), embedding_model: model, degraded: false };
    } catch { signal?.throwIfAborted(); }
  }
  return { embedding: null, embedding_model: null, degraded: true };
}
export async function assertFactNotWithdrawn(engine: BrainEngine, sourceId: string, input: SingleFactIntent): Promise<void> {
  await assertFactNotPurged(engine, sourceId, input);
  if (await isFactWithdrawn(engine, sourceId, input.visibility, input.fact, input.entity_slug)) {
    throw verbError('invalid_params', 'fact_withdrawn: this exact claim was explicitly forgotten in this source and visibility.',
      'Remember a corrected claim. Repeating the old claim does not restore withdrawn memory.');
  }
}
/**
 * SQL-only, so publication can verify the semantic decision under its guard.
 * `lane` is the writer's `facts.source`: capture lanes never drop by cosine (#5888).
 */
export async function decideSingleFact(engine: BrainEngine, sourceId: string, input: SingleFactIntent, embedding: Float32Array | null, embeddingModel?: string | null, lane?: string | null): Promise<FactDecision> {
  const [exact] = await engine.executeRaw<FactCandidate>(`SELECT * FROM facts WHERE source_id=$1
    AND entity_slug IS NOT DISTINCT FROM $2 AND visibility=$3 AND expired_at IS NULL
    AND (valid_until IS NULL OR valid_until>now()) AND gbrain_fact_fingerprint(fact)=gbrain_fact_fingerprint($4)
    AND ($5::text IS NULL OR attributed_to IS NULL OR attributed_to=$5)
    ORDER BY id LIMIT 1`, [sourceId, input.entity_slug, input.visibility, input.fact, input.attributed_to ?? null]);
  if (exact) return { status: 'duplicate', candidate: { ...exact, id: Number(exact.id) } };
  if (embedding && input.entity_slug) {
    const candidates = await engine.findCandidateDuplicates(sourceId, input.entity_slug, input.fact, { embedding, embeddingModel, k: 5, attributedTo: input.attributed_to ?? null });
    const metadata = await engine.executeRaw<{ id: number; source_markdown_slug: string | null; row_num: number | null; trust_tier: FactRow['trust_tier'] }>(
      'SELECT id,source_markdown_slug,row_num,trust_tier FROM facts WHERE source_id=$1 AND id=ANY($2::int[])',
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
    if (candidate && cosineVerdict(lane, score, input.fact, candidate.fact) === 'duplicate') return {
      status: candidate.kind === input.kind ? 'superseded' : 'duplicate', candidate,
    };
  }
  return { status: 'inserted', candidate: null };
}

/**
 * `remember.replaces`: the caller names the fact the new one replaces. Checked,
 * zero-model: the target must be an active fact in this source with the same
 * visibility and entity, and on the same entity page; equal text is a no-op
 * duplicate. `lock` takes the target row lock inside the publishing transaction.
 */
export async function decideReplacement(engine: BrainEngine, sourceId: string, input: SingleFactIntent, targetId: number,
  opts: { pageSlug: string; remote: boolean; lock?: boolean }): Promise<FactDecision> {
  const notFound = () => verbError('not_found', `No fact with id "${targetId}" to replace.`,
    'Pass the fact_id of an active fact from recall (facts[].fact_id) about the same entity, or omit replaces to save a new fact.');
  const [target] = await engine.executeRaw<FactCandidate & { withdrawn: boolean }>(`SELECT f.*,
      EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v1(f.fact))
        AND (w.subject='*' OR w.subject=COALESCE(f.entity_slug,'*'))) AS withdrawn
    FROM facts f WHERE f.id=$1 AND f.source_id=$2${opts.lock ? ' FOR UPDATE OF f' : ''}`, [targetId, sourceId]);
  if (!target || (opts.remote && target.visibility !== 'world')) throw notFound();
  if (target.visibility !== input.visibility) throw notFound();
  const candidate: FactCandidate = { ...target, id: Number(target.id) };
  if (target.withdrawn) {
    throw verbError('invalid_params', `target_withdrawn: fact #${targetId} was forgotten, so it cannot be replaced.`,
      'Remember the new claim without replaces; the forgotten claim stays withdrawn.');
  }
  if (target.expired_at || (target.valid_until && new Date(target.valid_until).getTime() <= Date.now())) {
    if (target.superseded_by != null) {
      throw verbError('invalid_params', `target_superseded: fact #${targetId} was already replaced by fact #${target.superseded_by}.`,
        `Recall the entity to check the current fact, then pass replaces: "${target.superseded_by}" if the new claim replaces that one.`);
    }
    throw verbError('invalid_params', `target_expired: fact #${targetId} is no longer active.`,
      'Remember the new claim without replaces.');
  }
  if ((target.entity_slug ?? null) !== (input.entity_slug ?? null)) {
    throw verbError('invalid_params', `replaces_entity_mismatch: fact #${targetId} is about ${target.entity_slug ?? 'no entity'}, not ${input.entity_slug ?? 'no entity'}.`,
      'Pass the same entity as the fact being replaced, or forget the old fact and remember the new one separately.');
  }
  if (candidate.source_markdown_slug && candidate.source_markdown_slug !== opts.pageSlug) {
    throw verbError('invalid_params', `replaces_cross_page: fact #${targetId} lives on page ${candidate.source_markdown_slug}.`,
      'Forget the old fact, then remember the new one.');
  }
  const exact = await decideSingleFact(engine, sourceId, input, null);
  if (exact.status === 'duplicate') {
    if (exact.candidate!.id === candidate.id) return { status: 'duplicate', candidate };
    throw verbError('invalid_params', `replaces_duplicate: an active fact (#${exact.candidate!.id}) already states this claim.`,
      `Forget fact #${targetId} if it is no longer true; the existing fact #${exact.candidate!.id} already says the new claim.`);
  }
  return { status: 'superseded', candidate };
}
