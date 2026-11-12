import type { BrainEngine } from '../engine.ts';
import { AUDIT_ROW_SOURCES } from './audit-sources.ts';
import { EMBED_MAX_CHARS } from '../ai/embed-batch-plan.ts';
import { estimateTokens } from '../chunkers/token-estimate.ts';

// GST-2346: the withdrawal subjects that cover a fact (access/member-facts.ts withdrawalCoversFactSql): a fact on a member
// page is covered by its page's own withdrawals alone.
const WITHDRAWAL_SUBJECTS = "CASE WHEN starts_with(COALESCE(f.source_markdown_slug, ''), 'memory/members/') THEN ARRAY[f.source_markdown_slug] ELSE ARRAY['*', f.entity_slug] END";

// #6960: one anti-join per fingerprint, each an equality on fact_hash, so the
// planner hashes or index-probes the fingerprint once per fact. A single
// `fact_hash IN (fp, fp_v1)` left both fingerprints in the join filter,
// recomputed for every (fact, withdrawal) pair.
export const retainedFactEmbedding = `f.expired_at IS NULL AND f.superseded_by IS NULL
  AND (f.valid_until IS NULL OR f.valid_until>now())
  AND NOT (f.source = ANY($2::text[]))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(${WITHDRAWAL_SUBJECTS})
    AND w.fact_hash = gbrain_fact_fingerprint(f.fact))
  AND NOT EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id
    AND w.visibility=f.visibility AND w.subject = ANY(${WITHDRAWAL_SUBJECTS})
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

export interface OversizedFact { id: string; source_id: string; slug: string | null; tokens: number }

const OVERSIZED_SCAN_CAP = 10_000;
export const OVERSIZED_FACT_FIX = 'A skipped fact stays stale, with its text unchanged, until it fits: shorten or split it (edit its row in the page\'s ## Facts fence, then sync), or withdraw it with gbrain forget <fact-id>.';

/**
 * #7211: stale, embeddable facts whose text is over the embedding input limit,
 * which the backfill skips instead of sending or truncating. Bytes bound
 * tokens from above (a cl100k token, and the len/4 fallback, is at least one
 * byte), so only facts longer than `maxTokens` bytes are read and measured,
 * at most OVERSIZED_SCAN_CAP of them.
 */
export async function readOversizedStaleFacts(engine: Pick<BrainEngine, 'executeRaw'>,
  opts: { sourceId?: string; model: string; dims: number; maxTokens: number }): Promise<OversizedFact[]> {
  const rows = await engine.executeRaw<{ id: string; source_id: string; slug: string | null; fact: string }>(
    `SELECT f.id::text, f.source_id, f.source_markdown_slug AS slug, f.fact FROM facts f
      WHERE ($1::text IS NULL OR f.source_id = $1) AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}
        AND octet_length(f.fact) > $5::int ORDER BY f.id LIMIT ${OVERSIZED_SCAN_CAP}`,
    [opts.sourceId ?? null, [...AUDIT_ROW_SOURCES], opts.model, opts.dims, opts.maxTokens]);
  return rows.map(row => ({ id: row.id, source_id: row.source_id, slug: row.slug, tokens: estimateTokens(row.fact) }))
    .filter(row => row.tokens > opts.maxTokens);
}

export function oversizedFactLine(row: OversizedFact, maxTokens: number): string {
  return `fact ${row.id} (${row.slug ? `page ${row.slug}` : 'database-only'}, source ${row.source_id}): about ${row.tokens} tokens, limit ${maxTokens}`;
}
