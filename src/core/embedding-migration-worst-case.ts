/**
 * #5680: the worst-case authorization of an embedding migration — the sum of
 * each planned provider request's maximum input, computed with the gateway's
 * own request plan (embed-batch-plan.ts) over the texts the run will send:
 * the provider probes, every stale chunk grouped per page, split as the
 * drain's oversize heal splits it (a split re-indexes the whole page, so every
 * healed chunk of that page is counted) and wrapped as the drain wraps it, the
 * chunks projection recovery and the chunkless heal will create (replayed
 * through the same projection preparation at the current chunk size then the
 * drain's target-size heal, and directly at the target size, keeping the
 * larger), every stale fact in the fact backfill's batches, the
 * completion smoke-check queries, and the reranker probe when the run
 * switches rerankers. Stale chunks include the drain's content drift (a
 * stored text hash that no longer matches the chunk text). The per-request
 * ceiling is additive over texts, and a provider token-limit rejection settles
 * unbilled, so the gateway's split of the same texts settles from the
 * parent's headroom.
 * An unpriced reranker is left out of `usd` and listed in `unpriced_models`:
 * its probe refuses without dispatch and the switch is reported as failed,
 * while the known embedding bound is still enforced.
 */
import type { BrainEngine } from './engine.ts';
import { embedRequestCeilings, rerankRequestMaxInputTokens } from './ai/embed-batch-plan.ts';
import { wrapChunkTextsForStoredMode } from './embedding-context.ts';
import type { ChunkInput, CRMode } from './types.ts';
import { readContentChunksEmbeddingDim } from './embedding-dim-check.ts';
import { falseStampPageWhere } from './embedding-invalidation.ts';
import { resolveActiveEmbeddingColumnFromEngine, quoteIdentifier } from './search/embedding-column.ts';
import { eligibleFactEmbedding, staleFactEmbedding } from './facts/embedding-identity.ts';
import { AUDIT_ROW_SOURCES } from './facts/audit-sources.ts';
import { EMBED_PROBE_TEXT } from './embed-stale.ts';
import { healOversizedChunks } from './embed-oversize-heal.ts';
import { resolveMaxChunkTokens } from './embedding-input-limit.ts';
import { preparePageProjection, readProjectionSnapshot } from './page-state/projections.ts';
import { QUARANTINE_FILTER_FRAGMENT } from './quarantine.ts';
import { loadPricingOverrides } from './budget/budget-tracker.ts';
import { usageCostUsd } from './budget/reservation-cost.ts';
import type { EmbeddingMigrationPlan } from './embedding-migration.ts';
import type { MigrationWorstCase } from './embedding-migration-budget.ts';

export const MIGRATION_PROBE_TEXT = 'gbrain embedding migration probe';
export const RERANKER_PROBE = {
  query: 'gbrain reranker migration probe',
  documents: ['gbrain reranker migration probe document a', 'gbrain reranker migration probe document b'],
} as const;
/** The drain's projection-readiness probe and its signature-drift probe. */
const DRAIN_PROBES = 2;
/** verifySearchRoundTrip embeds up to 3 sample queries: the page title (≤ 160 UTF-16 units), a newline and the chunk (≤ 512), at ≤ 3 UTF-8 bytes per unit. */
const SMOKE_QUERIES = 3;
export const SMOKE_QUERY_TITLE_UNITS = 160;
export const SMOKE_QUERY_CHUNK_UNITS = 512;
const SMOKE_QUERY_MAX_TOKENS = (SMOKE_QUERY_TITLE_UNITS + 1 + SMOKE_QUERY_CHUNK_UNITS) * 3;
/** embedStaleFacts' default batch size. */
const FACT_BATCH = 100;
const SCAN_PAGE = 2000;

interface ChunkRow { page_id: number; chunk_index: number; chunk_text: string; chunk_source: string | null; title: string | null; contextual_retrieval_mode: CRMode | null; stale: boolean }
interface FactRow { id: string; source_id: string; fact: string }
interface ChunkSizes { current: number; target: number }

/** Pages whose chunks are (re)built before embedding: unsealed projections, and contentful pages with no chunks. */
const REPROJECTED_PAGE = `(p.text_projection_revision IS DISTINCT FROM p.knowledge_revision
  OR ((p.compiled_truth <> '' OR p.timeline <> '') AND ${QUARANTINE_FILTER_FRAGMENT}
    AND NOT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id=p.id)))`;

/** The drain's whole-page oversize split; it reads only text, source and token count, which the planner's rows carry. */
const healAtTarget = (chunks: ReadonlyArray<Pick<ChunkInput, 'chunk_index' | 'chunk_text'> & { chunk_source?: string | null }>, sizes: ChunkSizes) =>
  healOversizedChunks(chunks as unknown as Parameters<typeof healOversizedChunks>[0], sizes.target);

async function eachReprojectedPage(engine: BrainEngine, sizes: ChunkSizes, weigh: (texts: string[]) => number, visit: (texts: string[]) => void): Promise<void> {
  let after = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number; slug: string; source_id: string }>(`SELECT p.id, p.slug, p.source_id
      FROM pages p JOIN sources s ON s.id=p.source_id
      WHERE NOT s.archived AND p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')
        AND ${REPROJECTED_PAGE} AND p.id > $1
      ORDER BY p.id LIMIT ${SCAN_PAGE}`, [after]);
    for (const row of rows) {
      const candidates: string[][] = [];
      for (const limit of new Set([sizes.current, sizes.target])) {
        const prepared = await readProjectionSnapshot(engine, row.slug, row.source_id, { allowUnsealed: true, maxChunkTokens: limit });
        if (!prepared) continue;
        try { candidates.push(wrapChunkTextsForStoredMode(prepared.snapshot.page, healAtTarget((await preparePageProjection(prepared)).chunks, sizes).chunks)); }
        catch { continue; }
      }
      if (candidates.length) visit(candidates.reduce((a, b) => weigh(b) > weigh(a) ? b : a));
    }
    if (rows.length < SCAN_PAGE) break;
    after = rows[rows.length - 1].id;
  }
}

async function eachStalePage(engine: BrainEngine, plan: EmbeddingMigrationPlan, sizes: ChunkSizes, visit: (texts: string[]) => void): Promise<void> {
  const column = (await readContentChunksEmbeddingDim(engine)).exists
    ? quoteIdentifier((await resolveActiveEmbeddingColumnFromEngine(engine, { fallbackToLegacy: true })).name)
    : null;
  const staleChunk = (c: string) => column === null ? 'true' : `(${c}.${column} IS NULL OR p.embedding_signature IS NULL OR p.embedding_signature <> $1
      OR (${c}.embedded_text_hash IS NOT NULL AND ${c}.embedded_text_hash <> md5(${c}.chunk_text))
      OR (${c}.${column} IS NOT NULL AND ${falseStampPageWhere(column, 1, 2)}))`;
  const livePage = column === null ? 'true' : `p.deleted_at IS NULL AND NOT (COALESCE(p.frontmatter,'{}'::jsonb) ? 'embed_skip')`;
  let page: ChunkRow[] = [];
  const flush = () => {
    if (!page.length) return;
    const healed = healAtTarget(page, sizes);
    visit(wrapChunkTextsForStoredMode(page[0], healed.changed ? healed.chunks : page.filter(row => row.stale)));
    page = [];
  };
  let after = { page: 0, chunk: -1 };
  for (;;) {
    const rows = await engine.executeRaw<ChunkRow>(`SELECT cc.page_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
        p.title, p.contextual_retrieval_mode, ${staleChunk('cc')} AS stale
      FROM content_chunks cc JOIN pages p ON p.id=cc.page_id
      WHERE ($1::text IS NOT NULL AND $2::text IS NOT NULL) AND ${livePage} AND NOT ${REPROJECTED_PAGE}
        AND EXISTS (SELECT 1 FROM content_chunks cs WHERE cs.page_id=p.id AND ${staleChunk('cs')})
        AND (cc.page_id > $3 OR (cc.page_id = $3 AND cc.chunk_index > $4))
      ORDER BY cc.page_id, cc.chunk_index LIMIT ${SCAN_PAGE}`,
    [`${plan.to_model}:${plan.to_dims}`, plan.to_model, after.page, after.chunk]);
    for (const row of rows) {
      if (page.length && page[0].page_id !== row.page_id) flush();
      page.push(row);
    }
    if (rows.length < SCAN_PAGE) break;
    after = { page: rows[rows.length - 1].page_id, chunk: rows[rows.length - 1].chunk_index };
  }
  flush();
}

async function eachStaleFactBatch(engine: BrainEngine, plan: EmbeddingMigrationPlan, visit: (texts: string[]) => void): Promise<void> {
  let batch: FactRow[] = [];
  const flush = () => { if (batch.length) visit(batch.map(row => row.fact)); batch = []; };
  let after = { source: '', id: '0' };
  for (;;) {
    const rows = await engine.executeRaw<FactRow>(`SELECT f.id::text AS id, f.source_id, f.fact FROM facts f
      WHERE ($1::text IS NULL OR f.source_id=$1) AND ${eligibleFactEmbedding} AND ${staleFactEmbedding}
        AND (f.source_id > $5 OR (f.source_id = $5 AND f.id > $6::bigint))
      ORDER BY f.source_id, f.id LIMIT ${SCAN_PAGE}`,
    [null, [...AUDIT_ROW_SOURCES], plan.to_model, plan.to_dims, after.source, after.id]);
    for (const row of rows) {
      if (batch.length && (batch[0].source_id !== row.source_id || batch.length === FACT_BATCH)) flush();
      batch.push(row);
    }
    if (rows.length < SCAN_PAGE) break;
    after = { source: rows[rows.length - 1].source_id, id: rows[rows.length - 1].id };
  }
  flush();
}

export async function planMigrationWorstCase(engine: BrainEngine, plan: EmbeddingMigrationPlan, opts: { rerankerModel?: string } = {}): Promise<MigrationWorstCase> {
  const envCap = Number.parseInt(process.env.GBRAIN_EMBED_MAX_BATCH_TOKENS ?? '', 10);
  const ceilings: number[] = [];
  const ceilingsOf = (texts: string[]) => texts.length
    ? embedRequestCeilings(texts, plan.to_model, Number.isFinite(envCap) && envCap > 0 ? envCap : undefined) : [];
  const add = (texts: string[]) => { ceilings.push(...ceilingsOf(texts)); };
  add([MIGRATION_PROBE_TEXT]);
  for (let i = 0; i < DRAIN_PROBES; i++) add([EMBED_PROBE_TEXT]);
  for (let i = 0; i < SMOKE_QUERIES; i++) ceilings.push(SMOKE_QUERY_MAX_TOKENS);
  const target = resolveMaxChunkTokens(process.env, plan.to_model);
  const sizes = { current: resolveMaxChunkTokens(), target };
  await eachStalePage(engine, plan, sizes, add);
  await eachReprojectedPage(engine, sizes, texts => ceilingsOf(texts).reduce((sum, n) => sum + n, 0), add);
  await eachStaleFactBatch(engine, plan, add);
  const embedTokens = ceilings.reduce((sum, n) => sum + n, 0);
  const rerankTokens = opts.rerankerModel ? rerankRequestMaxInputTokens(RERANKER_PROBE.query, RERANKER_PROBE.documents) : 0;
  const overrides = await loadPricingOverrides(engine);
  const embedUsd = usageCostUsd(plan.to_model, embedTokens, 0, 'embed', overrides);
  const rerankUsd = opts.rerankerModel ? usageCostUsd(opts.rerankerModel, rerankTokens, 0, 'rerank', overrides) : 0;
  const unpriced = [...(embedUsd === null ? [plan.to_model] : []), ...(rerankUsd === null ? [opts.rerankerModel!] : [])];
  return {
    requests: ceilings.length + (opts.rerankerModel ? 1 : 0),
    input_tokens: embedTokens + rerankTokens,
    usd: embedUsd === null ? null : embedUsd + (rerankUsd ?? 0),
    unpriced_models: unpriced,
  };
}
