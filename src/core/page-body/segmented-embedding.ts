/**
 * Embedding for segmented pages (Wave B, spec 4.4). The inline path
 * (`readProjectionSnapshot` / `installPageEmbeddings`) reads the page body, its
 * fence overlay and every chunk of the page; a segmented page is embedded from
 * its stale chunk rows alone: keyset pages of live, vector-less rows with their
 * text, the page title and the plain tier (no input depends on the rest of the
 * body; per-chunk synopsis on a segmented page, whose input is the lead and one
 * window of the chunk's segment, is the contextual retrieval service's, spec
 * 8.6, and installs through installSegmentedVectors), metered by the
 * per-page budget and installed by chunk_index and exact text onto rows still
 * in the page's live body generation. It never reads a segment.
 */
import type { BrainEngine } from '../engine.ts';
import type { ChunkInput, CRMode } from '../types.ts';
import { jsonRowBatches } from '../batch-rows.ts';
import { wrapChunkTextsForStoredMode } from '../embedding-context.ts';
import { embeddingInputHash, plainEmbeddingTier } from '../embedding-input-hash.ts';
import { meterPageBatch, spendGrant } from '../page-embedding-budget.ts';
import { acquirePageEmbeddingLease, vectorlessChunkIndexes } from '../page-embedding-lease.ts';
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
  /** Runs before each wait for the page's embedding lease (page-embedding-lease.ts); an effect renews its claim there. */
  whileWaiting?: () => Promise<void>;
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
 * Embed `listed` rows of one segmented page under the page's embedding lease
 * (page-embedding-lease.ts): keep the rows still without a vector once the
 * lease is held (every row with `includeEmbedded`), meter them under the
 * per-page budget, call the provider once for the granted rows, and install
 * each vector with its recorded input on the row with the same chunk_index and
 * text while that row is in the live generation and the page's title, mode and
 * write target are unchanged. Returns how many rows were still pending and how
 * many took a vector; null when the budget holds the page or the cap left
 * nothing to embed.
 */
export async function embedSegmentedRows(engine: BrainEngine, page: SegmentedEmbedPage, listed: readonly SegmentedStaleRow[],
  opts: SegmentedEmbedOpts & { includeEmbedded?: boolean }): Promise<{ pending: number; installed: number; busy?: true } | null> {
  if (listed.length === 0) return { pending: 0, installed: 0 };
  await using lease = await acquirePageEmbeddingLease(engine, page.id, { signal: opts.signal, whileWaiting: opts.whileWaiting });
  if (lease.busy) return { pending: listed.length, installed: 0, busy: true };
  const target = await embeddingWriteTarget(engine);
  const missing = opts.includeEmbedded ? null : await vectorlessChunkIndexes(engine, page.id, target.column.name);
  const rows = missing ? listed.filter(row => missing.has(row.chunk_index)) : listed;
  if (rows.length === 0) return { pending: 0, installed: 0 };
  const asRead = await readChunkInputHashes(engine, page.id, rows.map(row => row.chunk_index));
  const metered = await meterPageBatch(engine, page, rows, { signature: opts.signature ?? null, approvedCapUsd: opts.approvedCapUsd });
  if (!metered) return null;
  const chunks = metered.chunks;
  const vectors = await spendGrant(metered.grant, () => opts.embedFn(wrapChunkTextsForStoredMode(page, chunks), { abortSignal: opts.signal }));
  if (vectors.length !== chunks.length || vectors.some(v => !v?.length || !v.every(Number.isFinite))) {
    throw new Error('Embedding provider returned an incomplete or invalid batch');
  }
  const tier = plainEmbeddingTier(page.contextual_retrieval_mode);
  const provenance = embeddingInputContext(target, page.title, null, []);
  return { pending: rows.length, installed: await installSegmentedVectors(engine, page, target, chunks.map((chunk, i) => ({ chunk_index: chunk.chunk_index,
    chunk_text: chunk.chunk_text, vector: vectors[i]!, hash: embeddingInputHash(provenance, tier, chunk), expected: asRead.get(chunk.chunk_index) ?? null })),
    async tx => { await lease.assertHeld(tx); await opts.beforeInstall?.(tx); }) };
}

/** The recorded embedding input of a segmented page's live rows at `chunkIndexes`, as read now (null: none recorded). */
async function readChunkInputHashes(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, chunkIndexes: readonly number[]): Promise<Map<number, string | null>> {
  const rows = await engine.executeRaw<{ chunk_index: number; embedding_input_hash: string | null }>(
    `SELECT cc.chunk_index, cc.embedding_input_hash FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND cc.chunk_index = ANY($2::int[]) AND ${chunkGenerationFilter('p', 'cc')}`, [pageId, [...chunkIndexes]]);
  return new Map(rows.map(row => [Number(row.chunk_index), row.embedding_input_hash]));
}

/**
 * One vector to install on a segmented page: the row's chunk_index and exact text, the recorded embedding input, and
 * `expected`, the row's recorded input as the writer read it before building the vector (null: none).
 */
export interface SegmentedVectorUpdate { chunk_index: number; chunk_text: string; vector: Float32Array; hash: string; expected: string | null }

/**
 * Install vectors with their recorded inputs on the live rows of a segmented page with the same chunk_index and text,
 * under the page lock, while the page's slug, title and contextual mode and the write target (column, provenance
 * model) are those the inputs were built under; 0 when any moved. A row whose recorded input is no longer `expected`
 * (another writer installed since the read) is left as it is: a stale install is a no-op. `beforeInstall` runs after
 * the lock; throwing or returning false installs nothing. Returns the rows that took a vector.
 */
export async function installSegmentedVectors(engine: BrainEngine, page: SegmentedEmbedPage, target: Awaited<ReturnType<typeof embeddingWriteTarget>>,
  vectors: readonly SegmentedVectorUpdate[], beforeInstall?: (tx: BrainEngine) => Promise<void | boolean>): Promise<number> {
  const updates = vectors.map(v => ({ chunk_index: v.chunk_index, chunk_text: v.chunk_text, embedding: `[${Array.from(v.vector).join(',')}]`, hash: v.hash, expected: v.expected }));
  const col = quoteIdentifier(target.column.name);
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    if (await beforeInstall?.(tx) === false) return 0;
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
        FROM jsonb_to_recordset($2::text::jsonb) AS v(chunk_index int, chunk_text text, embedding text, hash text, expected text), pages p
        WHERE cc.page_id = $1 AND p.id = cc.page_id AND cc.chunk_index = v.chunk_index AND cc.chunk_text = v.chunk_text
          AND cc.embedding_input_hash IS NOT DISTINCT FROM v.expected AND ${chunkGenerationFilter('p', 'cc')}
        RETURNING cc.id`, [page.id, batch, target.model])).length;
    }
    return installed;
  });
}

/** A live segment of a segmented page, newest first: its occurrence, text hash and entry state (manifest metadata only). */
export interface LiveEmbedSegment { occurrenceId: number; sha256: Uint8Array; entryState: unknown }

export async function listLiveEmbedSegments(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<LiveEmbedSegment[]> {
  const rows = await engine.executeRaw<{ occurrence_id: number | string; sha256: Uint8Array; entry_state: unknown }>(
    `SELECT m.occurrence_id, m.sha256, m.entry_state FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
      WHERE m.page_id = $1 AND m.staging_id IS NULL AND m.gen_from <= p.body_generation AND (m.gen_to IS NULL OR m.gen_to > p.body_generation)
      ORDER BY m.seq DESC`, [pageId]);
  return rows.map(row => ({ occurrenceId: Number(row.occurrence_id), sha256: new Uint8Array(row.sha256), entryState: row.entry_state }));
}

export interface SegmentChunkRow { chunk_index: number; chunk_text: string; chunk_source: NonNullable<ChunkInput['chunk_source']>; embedding_input_hash: string | null }

/** The live chunk rows of one segment of a segmented page in text order, with their recorded embedding inputs. */
export async function listSegmentChunkRows(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, occurrenceId: number): Promise<SegmentChunkRow[]> {
  const rows = await engine.executeRaw<SegmentChunkRow>(
    `SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source, cc.embedding_input_hash
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND cc.occurrence_id = $2 AND ${currentTextProjectionFilter('p')} AND ${chunkGenerationFilter('p', 'cc')}
      ORDER BY cc.chunk_index`, [pageId, occurrenceId]);
  return rows.map(row => ({ ...row, chunk_index: Number(row.chunk_index) }));
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
  opts: SegmentedEmbedOpts & { occurrenceIds?: readonly number[]; batchRows?: number; all?: boolean }): Promise<{ embedded: number; complete: boolean; stopped?: 'budget' | 'page_moved' | 'busy' }> {
  const column = (await embeddingWriteTarget(engine)).column.name;
  const limit = opts.batchRows ?? SEGMENTED_EMBED_BATCH_ROWS;
  let embedded = 0;
  for (let before: number | null = null; ;) {
    opts.signal?.throwIfAborted();
    const rows = await listSegmentedStaleRows(engine, page.id, column, { beforeChunkIndex: before, limit, occurrenceIds: opts.occurrenceIds, includeEmbedded: opts.all });
    if (rows.length === 0) return { embedded, complete: true };
    const approvedCapUsd = opts.approvedCapUsd === undefined || before === null ? opts.approvedCapUsd : 0;
    const done = await embedSegmentedRows(engine, page, rows, { ...opts, approvedCapUsd, includeEmbedded: opts.all });
    if (done === null) return { embedded, complete: false, stopped: 'budget' };
    if (done.busy) return { embedded, complete: false, stopped: 'busy' };
    embedded += done.installed;
    if (done.pending > 0 && done.installed === 0) return { embedded, complete: false, stopped: 'page_moved' };
    if (done.installed < done.pending) return { embedded, complete: false, stopped: 'budget' };
    before = rows[rows.length - 1]!.chunk_index;
  }
}
