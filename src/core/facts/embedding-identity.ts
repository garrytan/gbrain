import type { BrainEngine } from '../engine.ts';
import { AUDIT_ROW_SOURCES } from './audit-sources.ts';
import { EMBED_MAX_CHARS } from '../ai/embed-batch-plan.ts';

// #6960: one anti-join per fingerprint, each an equality on fact_hash, so the
// planner hashes or index-probes the fingerprint once per fact. A single
// `fact_hash IN (fp, fp_v1)` left both fingerprints in the join filter,
// recomputed for every (fact, withdrawal) pair.
export const retainedFactEmbedding = `f.expired_at IS NULL AND f.superseded_by IS NULL
  AND (f.valid_until IS NULL OR f.valid_until>now())
  AND NOT (f.source = ANY($2::text[]))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(ARRAY['*', f.entity_slug])
    AND w.fact_hash = gbrain_fact_fingerprint(f.fact))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(ARRAY['*', f.entity_slug])
    AND w.fact_hash = gbrain_fact_fingerprint_v1(f.fact))`;

export const eligibleFactEmbedding = `${retainedFactEmbedding}
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id=f.source_id AND NOT s.archived)
  AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id
    AND p.slug=f.source_markdown_slug AND p.deleted_at IS NOT NULL)`;

export const staleFactEmbedding = `(f.embedding IS NULL OR f.embedding_model IS DISTINCT FROM $3
  OR f.embedded_text_hash IS DISTINCT FROM md5(f.fact) OR vector_dims(f.embedding)<>$4::int)`;

/**
 * #6975: the fact is longer than the text embed() sends (EMBED_MAX_CHARS UTF-16 code units),
 * so its vector covers only a prefix. md5(fact) stays the freshness key: the vector is current
 * and nothing re-embeds or charges for it; doctor reports it as partially embedded. UTF-16
 * length is code points plus one per astral character; octet_length bounds it from above.
 */
export const partiallyEmbeddedFact = `(octet_length(f.fact) > ${EMBED_MAX_CHARS}
  AND length(f.fact) + length(regexp_replace(f.fact, '[^\\U00010000-\\U0010FFFF]', '', 'g')) > ${EMBED_MAX_CHARS})`;

export async function countStaleFactEmbeddings(engine: Pick<BrainEngine, 'executeRaw'>, model: string, dimensions: number, sourceId?: string) {
  const [row] = await engine.executeRaw<{ count: number; chars: string }>(`SELECT count(*)::int AS count,
    COALESCE(sum(length(f.fact)),0)::text AS chars FROM facts f
    WHERE ($1::text IS NULL OR f.source_id=$1) AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}`,
  [sourceId ?? null, [...AUDIT_ROW_SOURCES], model, dimensions]);
  return { count: Number(row.count), chars: Number(row.chars) };
}
