/**
 * #6333 shadow counter, shared by both fact writers. The unmanaged backstop
 * counts `would_dedup_same_page` inline (its candidate loop already holds the
 * nearest row); the managed preparer (`facts-prepare.ts`) scores its
 * candidate through `decideSingleFact`, which exposes a candidate only on a
 * duplicate verdict, so the mirror re-reads the nearest live candidate here.
 * The counter measures; it never drops a fact (see capture-dedup.ts).
 */
import type { BrainEngine, FactAttribution, FactVisibility } from '../engine.ts';
import { cosineSimilarity } from './classify.ts';
import { listSupersessionCandidates } from './single-prepare.ts';
import { wouldDedupSamePage } from './capture-dedup.ts';

export interface SamePageShadowFact {
  entity_slug: string | null;
  fact: string;
  visibility: FactVisibility;
  source: string;
  source_session?: string | null;
  embedding_model?: string | null;
  attributed_to?: FactAttribution | null;
}

/**
 * The entity's nearest live candidate under the fact's visibility when the
 * same-page rule would have called the fact a rewording of it, else null.
 * The candidate pool and the visibility/expiry filters match
 * `decideSingleFact`'s cosine pass; the fence-page check it adds is for
 * supersession and does not apply to a measurement.
 */
export async function samePageRewording(engine: BrainEngine, sourceId: string, fact: SamePageShadowFact, embedding: Float32Array | null): Promise<{ id: number; score: number } | null> {
  if (!embedding || !fact.entity_slug || !fact.source_session) return null;
  const candidates = await listSupersessionCandidates(engine, sourceId, fact.entity_slug, fact.fact, embedding, fact.embedding_model, undefined, fact.attributed_to ?? null);
  let top: { row: typeof candidates[number]; score: number } | null = null;
  for (const row of candidates) {
    if (!row.embedding || row.expired_at || row.visibility !== fact.visibility) continue;
    const score = cosineSimilarity(embedding, row.embedding);
    if (!top || score > top.score) top = { row, score };
  }
  if (!top || !wouldDedupSamePage({ source: fact.source, sessionId: fact.source_session, visibility: fact.visibility }, top.row, top.score, fact.fact)) return null;
  return { id: top.row.id, score: top.score };
}

/** The one stderr spelling of a counted rewording; the evidence line the measurement collects. */
export function warnSamePageShadow(sessionId: string | null, matchedId: number, score: number): void {
  // eslint-disable-next-line no-console
  console.warn(`[facts-backstop] #6333 shadow: new fact in session ${sessionId} rewords fact ${matchedId} (cosine ${score.toFixed(3)}); both kept`);
}
