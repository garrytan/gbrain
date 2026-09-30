import type { BrainEngine } from '../engine.ts';
import { AUDIT_ROW_SOURCES } from './audit-sources.ts';

export const retainedFactEmbedding = `f.expired_at IS NULL AND f.superseded_by IS NULL
  AND (f.valid_until IS NULL OR f.valid_until>now())
  AND NOT (f.source = ANY($2::text[]))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND (w.subject = '*' OR w.subject = f.entity_slug)
    AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v1(f.fact)))`;

export const eligibleFactEmbedding = `${retainedFactEmbedding}
  AND EXISTS (SELECT 1 FROM sources s WHERE s.id=f.source_id AND NOT s.archived)
  AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id
    AND p.slug=f.source_markdown_slug AND p.deleted_at IS NOT NULL)`;

export const staleFactEmbedding = `(f.embedding IS NULL OR f.embedding_model IS DISTINCT FROM $3
  OR f.embedded_text_hash IS DISTINCT FROM md5(f.fact) OR vector_dims(f.embedding)<>$4::int)`;

export async function countStaleFactEmbeddings(engine: Pick<BrainEngine, 'executeRaw'>, model: string, dimensions: number, sourceId?: string) {
  const [row] = await engine.executeRaw<{ count: number; chars: string }>(`SELECT count(*)::int AS count,
    COALESCE(sum(length(f.fact)),0)::text AS chars FROM facts f
    WHERE ($1::text IS NULL OR f.source_id=$1) AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}`,
  [sourceId ?? null, [...AUDIT_ROW_SOURCES], model, dimensions]);
  return { count: Number(row.count), chars: Number(row.chars) };
}
