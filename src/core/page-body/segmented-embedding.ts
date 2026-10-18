/**
 * Embedding for segmented pages (Wave B, spec 4.4). The inline path
 * (`readProjectionSnapshot` / `installPageEmbeddings`) reads the page body, its
 * fence overlay and every chunk of the page; a segmented page is embedded from
 * its stale chunk rows alone: keyset pages of live, vector-less rows with their
 * text, the page title and the plain tier (the synopsis tier stays off for
 * segmented pages, so no input depends on the rest of the body), metered by the
 * per-page budget and installed by chunk_index and exact text onto rows still
 * in the page's live body generation. It never reads a segment.
 */
import type { BrainEngine } from '../engine.ts';
import type { CRMode } from '../types.ts';
import { jsonRowBatches } from '../batch-rows.ts';
import { wrapChunkTextsForStoredMode } from '../embedding-context.ts';
import { embeddingInputHash, plainEmbeddingTier } from '../embedding-input-hash.ts';
import { meterPageBatch, spendGrant } from '../page-embedding-budget.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../page-state/projections.ts';
import { quoteIdentifier, vectorCastSuffix } from '../search/embedding-column.ts';
import { chunkGenerationFilter, currentTextProjectionFilter } from '../search/safe-chunks.ts';
import { buildSegmentedProjection } from './projection.ts';
import { isSegmentedPage } from './page-shape.ts';
import type { BodyStorage } from './types.ts';

/** Stale rows read and embedded per provider round trip. */
export const SEGMENTED_EMBED_BATCH_ROWS = 500;

/** The page fields a segmented embed reads: metadata only, never the body. */
export interface SegmentedEmbedPage {
  id: number;
  slug: string;
  source_id: string;
  title: string;
  contextual_retrieval_mode: CRMode | null;
  body_storage: 'segmented';
  body_bytes: number;
}

export interface SegmentedStaleRow { chunk_index: number; chunk_text: string; chunk_source: string }

export type SegmentedEmbedFn = (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;

export interface SegmentedEmbedOpts {
  embedFn: SegmentedEmbedFn;
  signal?: AbortSignal;
  signature?: string | null;
  approvedCapUsd?: number;
  /** Runs inside the install transaction after the page guard (ownership, effect claim); throwing installs nothing. */
  beforeInstall?: (tx: BrainEngine) => Promise<void>;
}

/** A segmented page that is live, sealed and in a live source, by id or by source and slug; null otherwise (inline pages included). */
export async function readSegmentedEmbedPage(engine: Pick<BrainEngine, 'executeRaw'>,
  ref: { id: number } | { sourceId: string; slug: string }): Promise<SegmentedEmbedPage | null> {
  const [where, params] = 'id' in ref ? ['p.id = $1', [ref.id]] : ['p.source_id = $1 AND p.slug = $2', [ref.sourceId, ref.slug]];
  const [row] = await engine.executeRaw<{ id: number; slug: string; source_id: string; title: string; contextual_retrieval_mode: CRMode | null; body_bytes: number | string }>(
    `SELECT p.id, p.slug, p.source_id, p.title, p.contextual_retrieval_mode, p.body_bytes
       FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE ${where} AND p.body_storage = 'segmented' AND p.deleted_at IS NULL AND NOT s.archived AND ${currentTextProjectionFilter('p')}`, params);
  return row ? { ...row, id: Number(row.id), body_storage: 'segmented', body_bytes: Number(row.body_bytes) } : null;
}

/**
 * `readSegmentedEmbedPage` for a page row; with `build`, a live segmented page
 * in a live source that is not sealed gets its projection built first (a
 * create whose post-commit projection never ran or failed has no chunk rows
 * to embed). Null for an inline page or one still not sealed.
 */
export async function readSealedSegmentedEmbedPage(engine: BrainEngine,
  page: { slug: string; source_id: string; body_storage?: BodyStorage | null }, build: boolean): Promise<SegmentedEmbedPage | null> {
  const ref = { sourceId: page.source_id, slug: page.slug };
  const sealed = await readSegmentedEmbedPage(engine, ref);
  if (sealed || !build || !isSegmentedPage(page)) return sealed;
  const [unsealed] = await engine.executeRaw(`SELECT 1 FROM pages p JOIN sources s ON s.id = p.source_id
    WHERE p.source_id = $1 AND p.slug = $2 AND p.body_storage = 'segmented' AND p.deleted_at IS NULL AND NOT s.archived`, [ref.sourceId, ref.slug]);
  return unsealed && (await buildSegmentedProjection(engine, ref)).sealed ? readSegmentedEmbedPage(engine, ref) : null;
}

/** A dry run's counts: the page's live rows and those without a vector in the write column. */
export async function countSegmentedEmbedRows(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<{ total: number; stale: number }> {
  const col = quoteIdentifier((await embeddingWriteTarget(engine)).column.name);
  const [row] = await engine.executeRaw<{ total: number; stale: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE cc.${col} IS NULL)::int AS stale
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND ${currentTextProjectionFilter('p')} AND ${chunkGenerationFilter('p', 'cc')}`, [pageId]);
  return { total: Number(row?.total ?? 0), stale: Number(row?.stale ?? 0) };
}

/**
 * Vector-less live rows of a segmented page below `beforeChunkIndex` (null: from the newest), newest first, so a
 * per-page cap spends on the newest rows; `occurrenceIds` limits them to the occurrences a write added,
 * `includeEmbedded` takes rows that already hold a vector too (`gbrain embed --all`).
 */
export async function listSegmentedStaleRows(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, column: string,
  opts: { beforeChunkIndex: number | null; limit: number; occurrenceIds?: readonly number[]; includeEmbedded?: boolean }): Promise<SegmentedStaleRow[]> {
  const col = quoteIdentifier(column);
  return engine.executeRaw<SegmentedStaleRow>(
    `SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND ($5::boolean OR cc.${col} IS NULL) AND ($2::int IS NULL OR cc.chunk_index < $2::int)
        AND ($4::bigint[] IS NULL OR cc.occurrence_id = ANY($4::bigint[]))
        AND ${currentTextProjectionFilter('p')} AND ${chunkGenerationFilter('p', 'cc')}
      ORDER BY cc.chunk_index DESC LIMIT $3`,
    [pageId, opts.beforeChunkIndex, opts.limit, opts.occurrenceIds ? [...opts.occurrenceIds] : null, opts.includeEmbedded ?? false]);
}

/**
 * Embed `rows` of one segmented page: meter them under the per-page budget,
 * call the provider once for the granted rows, and install each vector with
 * its recorded input on the row with the same chunk_index and text while that
 * row is in the live generation and the page's title, mode and write target
 * are unchanged. Returns the rows that took a vector; null when the budget
 * holds the page or the cap left nothing to embed.
 */
export async function embedSegmentedRows(engine: BrainEngine, page: SegmentedEmbedPage, rows: readonly SegmentedStaleRow[],
  opts: SegmentedEmbedOpts): Promise<number | null> {
  if (rows.length === 0) return 0;
  const metered = await meterPageBatch(engine, page, rows, { signature: opts.signature ?? null, approvedCapUsd: opts.approvedCapUsd });
  if (!metered) return null;
  const chunks = metered.chunks;
  const target = await embeddingWriteTarget(engine);
  const vectors = await spendGrant(metered.grant, () => opts.embedFn(wrapChunkTextsForStoredMode(page, chunks), { abortSignal: opts.signal }));
  if (vectors.length !== chunks.length || vectors.some(v => !v?.length || !v.every(Number.isFinite))) {
    throw new Error('Embedding provider returned an incomplete or invalid batch');
  }
  const tier = plainEmbeddingTier(page.contextual_retrieval_mode);
  const provenance = embeddingInputContext(target, page.title, null, []);
  const updates = chunks.map((chunk, i) => ({ chunk_index: chunk.chunk_index, chunk_text: chunk.chunk_text,
    embedding: `[${Array.from(vectors[i]!).join(',')}]`, hash: embeddingInputHash(provenance, tier, chunk) }));
  const col = quoteIdentifier(target.column.name);
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    await opts.beforeInstall?.(tx);
    const current = await readSegmentedEmbedPage(tx, { id: page.id });
    const now = await embeddingWriteTarget(tx);
    if (!current || current.slug !== page.slug || current.title !== page.title
      || current.contextual_retrieval_mode !== page.contextual_retrieval_mode
      || now.column.name !== target.column.name || now.provenanceModel !== target.provenanceModel) return 0;
    let installed = 0;
    for (const batch of jsonRowBatches(updates, update => update)) {
      installed += (await tx.executeRaw(`UPDATE content_chunks cc SET ${col} = v.embedding${vectorCastSuffix(target.column)},
          embedding_input_hash = v.hash, embedded_at = now(), embedded_text_hash = md5(cc.chunk_text), model = COALESCE($3, cc.model),
          embedding_pending_since = NULL
        FROM jsonb_to_recordset($2::text::jsonb) AS v(chunk_index int, chunk_text text, embedding text, hash text), pages p
        WHERE cc.page_id = $1 AND p.id = cc.page_id AND cc.chunk_index = v.chunk_index AND cc.chunk_text = v.chunk_text
          AND ${chunkGenerationFilter('p', 'cc')}
        RETURNING cc.id`, [page.id, batch, target.model])).length;
    }
    return installed;
  });
}

/**
 * Embed every vector-less live row of a segmented page (or only the rows of
 * `occurrenceIds`, the occurrences an append added; every live row with
 * `all`), newest first, one keyset batch at a time, until the rows run out
 * (`complete`), the budget holds the page or leaves no room (`stopped:
 * 'budget'`), or the page moved under an install (`stopped: 'page_moved'`).
 * An approval (`approvedCapUsd`) raises the page's cap once per run: later
 * batches keep the approval's lifted hold but spend under the cap it set.
 */
export async function embedSegmentedPage(engine: BrainEngine, page: SegmentedEmbedPage,
  opts: SegmentedEmbedOpts & { occurrenceIds?: readonly number[]; batchRows?: number; all?: boolean }): Promise<{ embedded: number; complete: boolean; stopped?: 'budget' | 'page_moved' }> {
  const column = (await embeddingWriteTarget(engine)).column.name;
  const limit = opts.batchRows ?? SEGMENTED_EMBED_BATCH_ROWS;
  let embedded = 0;
  for (let before: number | null = null; ;) {
    opts.signal?.throwIfAborted();
    const rows = await listSegmentedStaleRows(engine, page.id, column, { beforeChunkIndex: before, limit, occurrenceIds: opts.occurrenceIds, includeEmbedded: opts.all });
    if (rows.length === 0) return { embedded, complete: true };
    const approvedCapUsd = opts.approvedCapUsd === undefined || before === null ? opts.approvedCapUsd : 0;
    const installed = await embedSegmentedRows(engine, page, rows, { ...opts, approvedCapUsd });
    if (installed === null) return { embedded, complete: false, stopped: 'budget' };
    embedded += installed;
    if (installed === 0) return { embedded, complete: false, stopped: 'page_moved' };
    if (installed < rows.length) return { embedded, complete: false, stopped: 'budget' };
    before = rows[rows.length - 1]!.chunk_index;
  }
}
