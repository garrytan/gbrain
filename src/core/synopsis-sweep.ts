/**
 * #8744: the per-chunk synopsis sweep for brains whose configured contextual
 * retrieval tier is `per_chunk_synopsis` (search.mode tokenmax, or a source or
 * page override). Import and sync embed those pages at the free title tier and
 * leave the synopsis tier to the `contextual_reindex_per_chunk` job, which no
 * automatic path submits; `gbrain reindex --synopsis` is the explicit,
 * operator-run sweep. This module holds the reads shared by that command, the
 * doctor check `synopsis_tier_coverage` and the `gbrain search modes` line:
 * which pages resolve to the synopsis tier (the SQL twin of
 * resolveContextualRetrievalMode), how many of their chunks carry synopsis
 * vectors, and what the sweep would cost. Database reads only, so a repo-less
 * brain behaves exactly like a repo brain.
 *
 * Coverage is counted per chunk by the page's stamped mode: a page is stamped
 * `per_chunk_synopsis` only once every chunk is settled. Inline pages over the
 * large-page threshold stay on the title tier by design (contextual-retrieval
 * service, plan B8), so they leave the denominator and are reported apart.
 */
import type { BrainEngine } from './engine.ts';
import { loadSearchModeConfig, resolveSearchMode } from './search/mode.ts';
import { largePageBodyFilter } from './page-size-policy.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';
import {
  SEGMENT_SYNOPSIS_LEAD_BYTES,
  SEGMENT_SYNOPSIS_WINDOW_BYTES,
  SYNOPSIS_DOC_MAX_CHARS,
  SYNOPSIS_MAX_TOKENS,
  SYNOPSIS_PROMPT_OVERHEAD_CHARS,
} from './page-summary.ts';
import { reservationCostUsd } from './budget/reservation-cost.ts';
import type { CRMode } from './types.ts';

export const SYNOPSIS_SWEEP_JOB = 'contextual_reindex_per_chunk';
export const SYNOPSIS_SWEEP_ARGV = ['gbrain', 'reindex', '--synopsis'] as const;
/** Below this share of eligible chunks on the synopsis tier, the configured tier is "missing from most chunks". */
export const SYNOPSIS_COVERAGE_WARN_PCT = 50;
/** Embedding-input chars a synopsis adds to a chunk at most (contextual-retrieval-service SYNOPSIS_WRAPPER_CHARS). */
const SYNOPSIS_WRAPPER_CHARS = 320;

export interface SynopsisTierConfig {
  /** The brain-level tier (search.mode bundle or search.contextual_retrieval override). */
  global_tier: CRMode;
  kill_switch: boolean;
  /** Sources whose own contextual_retrieval_mode is per_chunk_synopsis. */
  synopsis_sources: string[];
  /** True when any page can resolve to the synopsis tier (page frontmatter overrides aside). */
  configured: boolean;
}

export async function readSynopsisTierConfig(engine: BrainEngine): Promise<SynopsisTierConfig> {
  const knobs = resolveSearchMode(await loadSearchModeConfig(engine));
  const rows = await engine.executeRaw<{ id: string }>(
    `SELECT id FROM sources WHERE contextual_retrieval_mode = 'per_chunk_synopsis' AND NOT archived ORDER BY id`);
  const synopsisSources = rows.map(r => r.id);
  const killSwitch = knobs.contextual_retrieval_disabled === true;
  return {
    global_tier: knobs.contextual_retrieval,
    kill_switch: killSwitch,
    synopsis_sources: synopsisSources,
    configured: !killSwitch && (knobs.contextual_retrieval === 'per_chunk_synopsis' || synopsisSources.length > 0),
  };
}

/**
 * Markdown pages whose resolved tier is per_chunk_synopsis, with their stamped
 * mode, large-inline flag and chunk counts. Mirrors resolveContextualRetrievalMode:
 * a valid frontmatter value wins on the host source or a trusted mount, then a
 * valid source-row mode, then the global tier. `$1` is the global tier.
 */
function eligiblePagesSql(opts: { sourceParam?: string; withChars: boolean }): string {
  return `
    WITH chunk_stats AS (
      SELECT c.page_id, count(*)::bigint AS chunks${opts.withChars ? ', COALESCE(sum(length(c.chunk_text)), 0)::bigint AS chunk_chars' : ''}
        FROM content_chunks c
        JOIN pages p ON p.id = c.page_id
       WHERE c.chunk_source <> 'image_asset' AND ${chunkGenerationFilter('p', 'c')}
       GROUP BY c.page_id
    ), resolved AS (
      SELECT p.id, p.slug, p.source_id, p.contextual_retrieval_mode AS stamped,
             p.text_projection_revision AS revision,
             p.body_storage = 'segmented' AS segmented,
             (COALESCE(p.body_storage, 'inline') <> 'segmented' AND ${largePageBodyFilter('p')}) AS large_inline,
             CASE
               WHEN p.frontmatter ? 'contextual_retrieval'
                    AND (p.source_id = 'default' OR COALESCE(s.trust_frontmatter_overrides, false))
                    AND p.frontmatter->>'contextual_retrieval' IN ('none', 'title', 'per_chunk_synopsis')
                 THEN p.frontmatter->>'contextual_retrieval'
               WHEN s.contextual_retrieval_mode IN ('none', 'title', 'per_chunk_synopsis') THEN s.contextual_retrieval_mode
               ELSE $1::text
             END AS effective
        FROM pages p
        LEFT JOIN sources s ON s.id = p.source_id
       WHERE p.deleted_at IS NULL AND p.page_kind = 'markdown' AND p.type <> 'extract_receipt'
         AND NOT (p.frontmatter ? 'embed_skip')
         AND NOT COALESCE(s.archived, false)
         ${opts.sourceParam ? `AND p.source_id = ANY(${opts.sourceParam}::text[])` : ''}
    )
    SELECT r.*, cs.chunks${opts.withChars ? ', cs.chunk_chars' : ''}
      FROM resolved r
      JOIN chunk_stats cs ON cs.page_id = r.id
     WHERE r.effective = 'per_chunk_synopsis'`;
}

export interface SynopsisCoverage {
  config: SynopsisTierConfig;
  eligible_pages: number;
  eligible_chunks: number;
  synopsis_pages: number;
  synopsis_chunks: number;
  /** Chunks of eligible pages on the synopsis tier, as a percentage (0..100, one decimal); null with no eligible chunks. */
  coverage_pct: number | null;
  /** Inline pages over the large-page threshold: the title tier by design, outside the denominator. */
  large_title_pages: number;
  large_title_chunks: number;
}

/** Synopsis-tier coverage. `sourceIds` confines every count to those sources (the remote doctor's grant). */
export async function readSynopsisCoverage(engine: BrainEngine, opts: { sourceIds?: string[]; config?: SynopsisTierConfig } = {}): Promise<SynopsisCoverage> {
  const config = opts.config ?? await readSynopsisTierConfig(engine);
  const empty = { eligible_pages: 0, eligible_chunks: 0, synopsis_pages: 0, synopsis_chunks: 0, coverage_pct: null, large_title_pages: 0, large_title_chunks: 0 };
  if (!config.configured) return { config, ...empty };
  const rows = await engine.executeRaw<Record<string, string | number>>(
    `SELECT
       count(*) FILTER (WHERE NOT large_inline)::bigint AS eligible_pages,
       COALESCE(sum(chunks) FILTER (WHERE NOT large_inline), 0)::bigint AS eligible_chunks,
       count(*) FILTER (WHERE NOT large_inline AND stamped = 'per_chunk_synopsis')::bigint AS synopsis_pages,
       COALESCE(sum(chunks) FILTER (WHERE NOT large_inline AND stamped = 'per_chunk_synopsis'), 0)::bigint AS synopsis_chunks,
       count(*) FILTER (WHERE large_inline)::bigint AS large_title_pages,
       COALESCE(sum(chunks) FILTER (WHERE large_inline), 0)::bigint AS large_title_chunks
     FROM (${eligiblePagesSql({ sourceParam: opts.sourceIds ? '$2' : undefined, withChars: false })}) eligible`,
    opts.sourceIds ? [config.global_tier, opts.sourceIds] : [config.global_tier]);
  const n = (key: string) => Number(rows[0]?.[key] ?? 0);
  const eligibleChunks = n('eligible_chunks');
  return {
    config,
    eligible_pages: n('eligible_pages'),
    eligible_chunks: eligibleChunks,
    synopsis_pages: n('synopsis_pages'),
    synopsis_chunks: n('synopsis_chunks'),
    coverage_pct: eligibleChunks > 0 ? Math.floor((n('synopsis_chunks') / eligibleChunks) * 1000) / 10 : null,
    large_title_pages: n('large_title_pages'),
    large_title_chunks: n('large_title_chunks'),
  };
}

export interface SynopsisSweepPage {
  id: number;
  slug: string;
  source_id: string;
  revision: string | null;
  chunks: number;
}

export interface SynopsisSweepPlan {
  config: SynopsisTierConfig;
  synopsis_model: string;
  pages: SynopsisSweepPage[];
  chunks: number;
  /** Ceiling: every synopsis prompt uncached (the prompt cache usually serves all but a page's first call). */
  est_input_tokens: number;
  /** Ceiling: every synopsis at the output-token cap. */
  est_output_tokens: number;
  /** Null when the synopsis model has no known price. */
  est_synopsis_usd: number | null;
  /** Null when the embedding model has no known price (or embedding is not configured). */
  est_embedding_usd: number | null;
  est_usd: number | null;
  /** Pending pages beyond `limit` that this run leaves for the next one. */
  remaining_pages: number;
}

/**
 * The pages a sweep would queue (eligible, not large-inline, not yet stamped
 * per_chunk_synopsis), oldest id first, with the token and dollar estimate on
 * the configured synopsis model. A page's synopsis document is its chunks joined
 * (synopsisDocument) capped at SYNOPSIS_DOC_MAX_CHARS (a segmented page: its lead plus one segment window),
 * sent once per chunk with the chunk and the prompt overhead, at 4 chars per
 * token (estimateSynopsisCallUsd's rate).
 */
export async function planSynopsisSweep(engine: BrainEngine, opts: {
  synopsisModel: string;
  synopsisMaxTokens?: number;
  sourceId?: string;
  limit?: number;
  embeddingPricePerMTok?: number | null;
}): Promise<SynopsisSweepPlan> {
  const config = await readSynopsisTierConfig(engine);
  const base = { config, synopsis_model: opts.synopsisModel, pages: [], chunks: 0, est_input_tokens: 0, est_output_tokens: 0,
    est_synopsis_usd: 0, est_embedding_usd: 0, est_usd: 0, remaining_pages: 0 };
  if (!config.configured) return base;
  const rows = await engine.executeRaw<{ id: number | string; slug: string; source_id: string; revision: string | null; segmented: boolean | null;
    chunks: number | string; chunk_chars: number | string }>(
    `SELECT id, slug, source_id, revision, segmented, chunks, chunk_chars
       FROM (${eligiblePagesSql({ sourceParam: opts.sourceId ? '$2' : undefined, withChars: true })}) eligible
      WHERE NOT large_inline AND stamped IS DISTINCT FROM 'per_chunk_synopsis'
      ORDER BY id`,
    opts.sourceId ? [config.global_tier, [opts.sourceId]] : [config.global_tier]);
  const selected = opts.limit ? rows.slice(0, opts.limit) : rows;
  const maxTokens = opts.synopsisMaxTokens ?? SYNOPSIS_MAX_TOKENS;
  const segmentedDocChars = Math.min(SEGMENT_SYNOPSIS_LEAD_BYTES + SEGMENT_SYNOPSIS_WINDOW_BYTES, SYNOPSIS_DOC_MAX_CHARS);
  let chunks = 0;
  let inputTokens = 0;
  let embeddedChars = 0;
  for (const row of selected) {
    const pageChunks = Number(row.chunks);
    const chunkChars = Number(row.chunk_chars);
    const documentChars = chunkChars + 2 * Math.max(0, pageChunks - 1);
    const docChars = Math.min(documentChars, row.segmented ? segmentedDocChars : SYNOPSIS_DOC_MAX_CHARS);
    chunks += pageChunks;
    inputTokens += Math.ceil((pageChunks * (docChars + SYNOPSIS_PROMPT_OVERHEAD_CHARS) + chunkChars) / 4);
    embeddedChars += chunkChars + pageChunks * SYNOPSIS_WRAPPER_CHARS;
  }
  const outputTokens = chunks * maxTokens;
  const synopsisUsd = chunks === 0 ? 0 : reservationCostUsd(opts.synopsisModel, 'chat', inputTokens, outputTokens);
  const embeddingUsd = opts.embeddingPricePerMTok == null ? null : (Math.ceil(embeddedChars / 3.5) / 1_000_000) * opts.embeddingPricePerMTok;
  return {
    ...base,
    pages: selected.map(r => ({ id: Number(r.id), slug: r.slug, source_id: r.source_id, revision: r.revision ?? null, chunks: Number(r.chunks) })),
    chunks,
    est_input_tokens: inputTokens,
    est_output_tokens: outputTokens,
    est_synopsis_usd: synopsisUsd,
    est_embedding_usd: embeddingUsd,
    est_usd: synopsisUsd === null || embeddingUsd === null ? null : synopsisUsd + embeddingUsd,
    remaining_pages: rows.length - selected.length,
  };
}

/** The newest finished sweep job and how many ever ran (null when the queue table is unreadable). */
export async function readLastSynopsisSweep(engine: BrainEngine): Promise<{ jobs: number; last_finished_at: string | null } | null> {
  try {
    const rows = await engine.executeRaw<{ jobs: number | string; last: string | Date | null }>(
      `SELECT count(*)::bigint AS jobs, max(finished_at) AS last FROM minion_jobs WHERE name = $1`, [SYNOPSIS_SWEEP_JOB]);
    const last = rows[0]?.last ?? null;
    return { jobs: Number(rows[0]?.jobs ?? 0), last_finished_at: last === null ? null : new Date(last).toISOString() };
  } catch {
    return null;
  }
}

/** One line for `gbrain search modes` and the doctor message: the configured tier's chunk coverage. */
export function formatSynopsisCoverageLine(c: SynopsisCoverage): string {
  if (c.eligible_chunks === 0) return 'Synopsis tier: configured (per_chunk_synopsis); no chunked pages resolve to it yet.';
  const large = c.large_title_pages ? ` ${c.large_title_pages} large page(s) (${c.large_title_chunks} chunk(s)) stay on the title tier by design.` : '';
  const pending = c.eligible_chunks - c.synopsis_chunks;
  return `Synopsis tier: ${c.coverage_pct}% of chunks (${c.synopsis_chunks}/${c.eligible_chunks}) and ${c.synopsis_pages}/${c.eligible_pages} page(s) carry per-chunk synopsis vectors`
    + (pending > 0 ? `; ${pending} chunk(s) search on title-tier vectors. Preview the sweep: ${SYNOPSIS_SWEEP_ARGV.join(' ')}` : '')
    + `.${large}`;
}
