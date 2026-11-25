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
import type { ChunkInput } from '../types.ts';
import { wrapChunkTextsForStoredMode } from '../embedding-context.ts';
import { embeddingInputHash, plainEmbeddingTier } from '../embedding-input-hash.ts';
import { meterPageBatch, spendGrant } from '../page-embedding-budget.ts';
import { acquirePageEmbeddingLease, vectorlessChunkIndexes } from '../page-embedding-lease.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../page-state/projections.ts';
import { buildSegmentedProjection } from './projection.ts';
import { isSegmentedPage } from './page-shape.ts';
import type { BodyStorage, SegmentedEmbedPage, SegmentedEmbedRef } from './types.ts';

/** Stale rows read and embedded per provider round trip. */
export const SEGMENTED_EMBED_BATCH_ROWS = 500;

export type { SegmentedEmbedPage } from './types.ts';

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

/** A segmented page that is live, sealed and in a live source, by id or by source and slug; null otherwise (inline pages included). The read is the engine's (engine-sql/page-body.ts). */
export function readSegmentedEmbedPage(engine: Pick<BrainEngine, 'readSegmentedEmbedPage'>, ref: SegmentedEmbedRef): Promise<SegmentedEmbedPage | null> {
  return engine.readSegmentedEmbedPage(ref);
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
  const unsealed = await engine.hasLiveSegmentedPage(ref.sourceId, ref.slug);
  return unsealed && (await buildSegmentedProjection(engine, ref)).sealed ? readSegmentedEmbedPage(engine, ref) : null;
}

/** A dry run's counts: the page's live rows and those without a vector in the write column. */
export async function countSegmentedEmbedRows(engine: Pick<BrainEngine, 'countSegmentedEmbedRows' | 'getConfigValues'>, pageId: number): Promise<{ total: number; stale: number }> {
  return engine.countSegmentedEmbedRows(pageId, (await embeddingWriteTarget(engine)).column.name);
}

/**
 * Vector-less live rows of a segmented page below `beforeChunkIndex` (null: from the newest), newest first, so a
 * per-page cap spends on the newest rows; `occurrenceIds` limits them to the occurrences a write added,
 * `includeEmbedded` takes rows that already hold a vector too (`gbrain embed --all`).
 */
export async function listSegmentedStaleRows(engine: Pick<BrainEngine, 'listSegmentedStaleRows'>, pageId: number, column: string,
  opts: { beforeChunkIndex: number | null; limit: number; occurrenceIds?: readonly number[]; includeEmbedded?: boolean }): Promise<SegmentedStaleRow[]> {
  const rows = await engine.listSegmentedStaleRows(pageId, column, opts);
  return rows.map(row => ({ ...row, chunk_index: Number(row.chunk_index) }));
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
async function readChunkInputHashes(engine: Pick<BrainEngine, 'readSegmentChunkInputHashes'>, pageId: number, chunkIndexes: readonly number[]): Promise<Map<number, string | null>> {
  const rows = await engine.readSegmentChunkInputHashes(pageId, chunkIndexes);
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
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    if (await beforeInstall?.(tx) === false) return 0;
    const current = await readSegmentedEmbedPage(tx, { id: page.id });
    const now = await embeddingWriteTarget(tx);
    if (!current || current.slug !== page.slug || current.title !== page.title
      || current.contextual_retrieval_mode !== page.contextual_retrieval_mode
      || now.column.name !== target.column.name || now.provenanceModel !== target.provenanceModel) return 0;
    return tx.installSegmentedVectors(page.id, target.column, target.model, vectors);
  });
}

/** A live segment of a segmented page, newest first: its occurrence, text hash and entry state (manifest metadata only). */
export interface LiveEmbedSegment { occurrenceId: number; sha256: Uint8Array; entryState: unknown }

export async function listLiveEmbedSegments(engine: Pick<BrainEngine, 'listLiveEmbedSegments'>, pageId: number): Promise<LiveEmbedSegment[]> {
  const rows = await engine.listLiveEmbedSegments(pageId);
  return rows.map(row => ({ occurrenceId: Number(row.occurrence_id), sha256: new Uint8Array(row.sha256), entryState: row.entry_state }));
}

export interface SegmentChunkRow { chunk_index: number; chunk_text: string; chunk_source: NonNullable<ChunkInput['chunk_source']>; embedding_input_hash: string | null }

/** The live chunk rows of one segment of a segmented page in text order, with their recorded embedding inputs. */
export async function listSegmentChunkRows(engine: Pick<BrainEngine, 'listSegmentChunkRows'>, pageId: number, occurrenceId: number): Promise<SegmentChunkRow[]> {
  const rows = await engine.listSegmentChunkRows(pageId, occurrenceId);
  return rows.map(row => ({ ...row, chunk_index: Number(row.chunk_index), chunk_source: row.chunk_source as SegmentChunkRow['chunk_source'] }));
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
