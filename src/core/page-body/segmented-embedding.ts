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
import { estimatePageEmbedUsd, meterPageBatch } from '../page-embedding-budget.ts';
import { acquirePageEmbeddingLease, vectorlessChunkIndexes } from '../page-embedding-lease.ts';
import {
  discardAnsweredBatch, embeddingBatchContext, embeddingBatchProbe, markBatchUncertain, readEmbedProgress, recoverPageBatches, releaseEmbeddingBatch,
  releaseUncertainBatches, reserveEmbeddingBatch, resolvePageTailUsdPerDay, saveEmbedProgress, storeBatchVectors, textMd5, withBatchReserved,
  type EmbedOrder, type EmbedProgress, type EmbeddingBatchRow,
} from '../embedding-ledger.ts';
import { withAIInvocationGuard, withAIInvocationMeter } from '../ai/invocation-guard.ts';
import { embedBatch } from '../embedding.ts';
import { abortableSleep, detect429FromCause, MAX_RATE_LIMIT_RETRIES, rateLimitDelayMs } from '../embed-retry.ts';
import { pageApprovalApplied } from '../page-embedding-budget.ts';
import { randomUUID } from 'node:crypto';
import { embeddingInputContext, embeddingWriteTarget } from '../page-state/projections.ts';
import { quoteIdentifier, vectorCastSuffix } from '../search/embedding-column.ts';
import { chunkGenerationFilter, currentTextProjectionFilter } from '../search/safe-chunks.ts';
import { buildSegmentedProjection } from './projection.ts';
import { isSegmentedPage } from './page-shape.ts';
import type { BodyStorage } from './types.ts';

/** Stale rows read and embedded per provider round trip. */
export const SEGMENTED_EMBED_BATCH_ROWS = 500;
/** One embed-page slice (spec §6.2): at most this many batches or this long, whichever comes first. */
export const EMBED_PAGE_SLICE_BATCHES = 20;
export const EMBED_PAGE_SLICE_MS = 10 * 60_000;
/** Page kinds embedded newest first; any other page is too when its last APPEND_HISTORY writes only touched its end. */
const CONVERSATION_KINDS: ReadonlySet<string> = new Set(['conversation', 'transcript']);
const APPEND_HISTORY = 10;

/** The page fields a segmented embed reads: metadata only, never the body. */
export interface SegmentedEmbedPage {
  id: number;
  slug: string;
  source_id: string;
  title: string;
  type: string;
  body_generation: number;
  contextual_retrieval_mode: CRMode | null;
  body_storage: 'segmented';
  body_bytes: number;
}

export interface SegmentedStaleRow { chunk_index: number; chunk_text: string; chunk_source: string; seq?: number | null; local_ordinal?: number | null }

export type SegmentedEmbedFn = (texts: string[], opts: { abortSignal?: AbortSignal }) => Promise<Float32Array[]>;

/**
 * The provider call of one batch: one attempt, no retry inside it, so each attempt is one the batch can account for
 * (embedSegmentedRows retries a rate-limited attempt itself).
 */
export const segmentedProviderEmbed: SegmentedEmbedFn = (texts, o) => embedBatch(texts, { maxRetries: 0, ...(o.abortSignal ? { abortSignal: o.abortSignal } : {}) });

export interface SegmentedEmbedOpts {
  /** Defaults to segmentedProviderEmbed. */
  embedFn?: SegmentedEmbedFn;
  signal?: AbortSignal;
  signature?: string | null;
  approvedCapUsd?: number;
  /** A durable identity for the approval (an embed job's), so a retried or reclaimed job raises the cap once. */
  approvalId?: string;
  /** Runs inside the install transaction after the page guard (ownership, effect claim); throwing installs nothing. */
  beforeInstall?: (tx: BrainEngine) => Promise<void>;
  /** Runs before each wait for the page's embedding lease (page-embedding-lease.ts); an effect renews its claim there. */
  whileWaiting?: () => Promise<void>;
  /** An append's own rows on a capped page: granted from the tail allowance (embed.page_tail_usd_per_day) once the cap leaves them out. */
  tail?: boolean;
}

/** A segmented page that is live, sealed and in a live source, by id or by source and slug; null otherwise (inline pages included). */
export async function readSegmentedEmbedPage(engine: Pick<BrainEngine, 'executeRaw'>,
  ref: { id: number } | { sourceId: string; slug: string }): Promise<SegmentedEmbedPage | null> {
  const [where, params] = 'id' in ref ? ['p.id = $1', [ref.id]] : ['p.source_id = $1 AND p.slug = $2', [ref.sourceId, ref.slug]];
  const [row] = await engine.executeRaw<{ id: number; slug: string; source_id: string; title: string; type: string; contextual_retrieval_mode: CRMode | null; body_bytes: number | string; body_generation: number | string }>(
    `SELECT p.id, p.slug, p.source_id, p.title, p.type, p.contextual_retrieval_mode, p.body_bytes, p.body_generation
       FROM pages p JOIN sources s ON s.id = p.source_id
      WHERE ${where} AND p.body_storage = 'segmented' AND p.deleted_at IS NULL AND NOT s.archived AND ${currentTextProjectionFilter('p')}`, params);
  return row ? { ...row, id: Number(row.id), body_storage: 'segmented', body_bytes: Number(row.body_bytes), body_generation: Number(row.body_generation) } : null;
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

/** Where a walk of a segmented page's rows stands: the last row done, by chunk_index (newest first) or by (manifest seq, local ordinal, chunk_index) (document order). */
export interface SegmentedEmbedCursor { chunkIndex: number; seq: number | null; ordinal: number | null }

/**
 * The page's one embedding order (spec §6.2), used by the grant, the embed-page job and the effect alike: newest first
 * (chunk_index descending) for a conversation or transcript, or a page whose last 10 writes only touched its end (the
 * live manifest rows those generations opened are a suffix of the page); document order otherwise, so a book embeds
 * from its start. Reads live manifest metadata only.
 */
export async function segmentedEmbedOrder(engine: Pick<BrainEngine, 'executeRaw'>, page: Pick<SegmentedEmbedPage, 'id' | 'type' | 'body_generation'>): Promise<EmbedOrder> {
  if (CONVERSATION_KINDS.has(String(page.type).toLowerCase())) return 'newest';
  if (page.body_generation < APPEND_HISTORY) return 'document';
  const [row] = await engine.executeRaw<{ first: number | null; older_after: number | string | null }>(
    `WITH live AS (SELECT m.seq, m.gen_from FROM page_body_manifest m
                     WHERE m.page_id = $1 AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.gen_from <= $2),
          recent AS (SELECT min(seq) AS first FROM live WHERE gen_from > $3)
     SELECT r.first, (SELECT count(*) FROM live l WHERE l.seq >= r.first AND l.gen_from <= $3) AS older_after FROM recent r`,
    [page.id, page.body_generation, page.body_generation - APPEND_HISTORY]);
  return row?.first !== null && row?.first !== undefined && Number(row.older_after) === 0 ? 'newest' : 'document';
}

/**
 * Vector-less live rows of a segmented page after `after` (null: from the start) in the page's embedding order:
 * newest first by chunk_index, or document order by (manifest seq, local ordinal, chunk_index), the cursor 1E's
 * get_chunks walk keys on. `occurrenceIds` limits them to the occurrences a write added, `includeEmbedded` takes rows
 * that already hold a vector too (`gbrain embed --all`).
 */
export async function listSegmentedStaleRows(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, column: string,
  opts: { order?: EmbedOrder; after?: SegmentedEmbedCursor | null; beforeChunkIndex?: number | null; limit: number; occurrenceIds?: readonly number[]; includeEmbedded?: boolean }): Promise<SegmentedStaleRow[]> {
  const col = quoteIdentifier(column);
  const occurrences = opts.occurrenceIds ? [...opts.occurrenceIds] : null;
  if ((opts.order ?? 'newest') === 'newest') {
    const before = opts.after ? opts.after.chunkIndex : opts.beforeChunkIndex ?? null;
    return engine.executeRaw<SegmentedStaleRow>(
      `SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
        WHERE cc.page_id = $1 AND ($5::boolean OR cc.${col} IS NULL) AND ($2::int IS NULL OR cc.chunk_index < $2::int)
          AND ($4::bigint[] IS NULL OR cc.occurrence_id = ANY($4::bigint[]))
          AND ${currentTextProjectionFilter('p')} AND ${chunkGenerationFilter('p', 'cc')}
        ORDER BY cc.chunk_index DESC LIMIT $3`,
      [pageId, before, opts.limit, occurrences, opts.includeEmbedded ?? false]);
  }
  const after = opts.after ?? null;
  const rows = await engine.executeRaw<SegmentedStaleRow>(
    `SELECT cc.chunk_index, cc.chunk_text, cc.chunk_source, m.seq, COALESCE(cc.local_ordinal, 0) AS local_ordinal
       FROM page_body_manifest m JOIN pages p ON p.id = m.page_id
       JOIN content_chunks cc ON cc.page_id = m.page_id AND cc.occurrence_id = m.occurrence_id
      WHERE m.page_id = $1 AND m.gen_to IS NULL AND m.staging_id IS NULL AND m.gen_from <= p.body_generation
        AND ($2::int IS NULL OR m.seq >= $2::int)
        AND ($2::int IS NULL OR (m.seq, COALESCE(cc.local_ordinal, 0), cc.chunk_index) > ($2::int, $3::int, $4::int))
        AND ($7::boolean OR cc.${col} IS NULL) AND ($6::bigint[] IS NULL OR cc.occurrence_id = ANY($6::bigint[]))
        AND ${currentTextProjectionFilter('p')} AND ${chunkGenerationFilter('p', 'cc')}
      ORDER BY m.seq, COALESCE(cc.local_ordinal, 0), cc.chunk_index LIMIT $5`,
    [pageId, after?.seq ?? null, after?.ordinal ?? 0, after?.chunkIndex ?? 0, opts.limit, occurrences, opts.includeEmbedded ?? false]);
  return rows.map(row => ({ ...row, chunk_index: Number(row.chunk_index), seq: Number(row.seq), local_ordinal: Number(row.local_ordinal) }));
}

function cursorAfter(row: SegmentedStaleRow): SegmentedEmbedCursor {
  return { chunkIndex: Number(row.chunk_index), seq: row.seq ?? null, ordinal: row.local_ordinal ?? null };
}

/** What one batch did: rows still pending once the lease was held, rows that took a vector (a recovered batch's included), the spend reserved. */
export interface SegmentedBatchResult {
  pending: number;
  installed: number;
  usd?: number;
  busy?: true;
  /** The source's 24-hour ledger refused the batch (embed.backfill_max_usd_per_source_24h). */
  sourceCapped?: true;
  /** Listed rows of an uncertain batch (a holder died during its provider call): they wait for the user's approval. */
  uncertain?: number;
}

/**
 * Embed `listed` rows of one segmented page under the page's embedding lease
 * (page-embedding-lease.ts). With the lease held it first settles what an
 * earlier holder left (embedding-ledger.ts recoverPageBatches): a batch whose
 * vectors were stored is installed from them, a batch still calling becomes
 * uncertain and its rows wait for approval (an approval releases them). Then
 * it re-checks only the listed rows (`chunk_index = ANY(listed) AND <col> IS
 * NULL`, every listed row with `includeEmbedded`), meters them under the
 * per-page budget in the order they were listed (and the tail allowance with
 * `tail`), records the batch and reserves its spend in the 24-hour ledger
 * before the call, stores the returned vectors before the install, and
 * installs each vector with its recorded input on the row with the same
 * chunk_index and text while that row is in the live generation and the
 * page's title, mode and write target are unchanged. Null when the budget
 * holds the page or the cap left nothing to embed.
 */
export async function embedSegmentedRows(engine: BrainEngine, page: SegmentedEmbedPage, listed: readonly SegmentedStaleRow[],
  opts: SegmentedEmbedOpts & { includeEmbedded?: boolean }): Promise<SegmentedBatchResult | null> {
  if (listed.length === 0) return { pending: 0, installed: 0 };
  await using lease = await acquirePageEmbeddingLease(engine, page.id, { signal: opts.signal, whileWaiting: opts.whileWaiting });
  if (lease.busy) return { pending: listed.length, installed: 0, busy: true };
  const guard = async (tx: BrainEngine) => { await lease.assertHeld(tx); await opts.beforeInstall?.(tx); };
  const target = await embeddingWriteTarget(engine);
  const recovered = await recoverPageBatches(engine, page.id);
  let replayed = 0;
  for (const batchId of recovered.returned) replayed += await installEmbeddingBatch(engine, page, target, batchId, guard);
  if (opts.approvedCapUsd !== undefined && recovered.uncertain.size && !await pageApprovalApplied(engine, page.id, opts.approvalId)) {
    await releaseUncertainBatches(engine, page.id);
    recovered.uncertain.clear();
  }
  const missing = opts.includeEmbedded ? null : await vectorlessChunkIndexes(engine, page.id, target.column.name, listed.map(row => row.chunk_index));
  const open = missing ? listed.filter(row => missing.has(row.chunk_index)) : listed;
  const rows = open.filter(row => !recovered.uncertain.has(row.chunk_index));
  const uncertain = open.length - rows.length;
  if (rows.length === 0) return { pending: 0, installed: replayed, ...(uncertain ? { uncertain } : {}) };
  const asRead = await readChunkInputHashes(engine, page.id, rows.map(row => row.chunk_index));
  const tailUsdPerDay = opts.tail ? await resolvePageTailUsdPerDay(engine) : 0;
  const metered = await meterPageBatch(engine, page, rows, { signature: opts.signature ?? null, approvedCapUsd: opts.approvedCapUsd, approvalId: opts.approvalId, preordered: true,
    ...(tailUsdPerDay > 0 ? { tailUsdPerDay } : {}), junkGeneration: page.body_generation });
  if (!metered) return null;
  const chunks = metered.chunks;
  const tier = plainEmbeddingTier(page.contextual_retrieval_mode);
  const provenance = embeddingInputContext(target, page.title, null, []);
  const batchRows: EmbeddingBatchRow[] = chunks.map(chunk => ({ chunk_index: chunk.chunk_index, text_md5: textMd5(chunk.chunk_text),
    hash: embeddingInputHash(provenance, tier, chunk), expected: asRead.get(chunk.chunk_index) ?? null }));
  const grant = metered.grant;
  const tailUsd = grant?.tailUsd ?? 0;
  const pageUsd = grant ? grant.reservedUsd : estimatePageEmbedUsd(chunks.reduce((n, chunk) => n + chunk.chunk_text.length, 0), opts.signature);
  const batchId = randomUUID();
  const reserved = await reserveEmbeddingBatch(engine, { batchId, pageId: page.id, sourceId: page.source_id, generation: page.body_generation,
    column: target.column.name, signature: opts.signature ?? null, context: embeddingBatchContext(page, target), rows: batchRows,
    pageUsd, tailUsd, enforce: opts.approvedCapUsd === undefined });
  if (!reserved.ok) {
    await grant?.settle({ ok: false });
    return { pending: rows.length, installed: replayed, sourceCapped: true };
  }
  await embeddingBatchProbe.beforeCall?.(batchId);
  const call = await callBatchProvider(opts.embedFn ?? segmentedProviderEmbed, wrapChunkTextsForStoredMode(page, chunks), opts.signal);
  if ('error' in call) {
    if (call.billed === 'no') await releaseEmbeddingBatch(engine, batchId).catch(() => {});
    else if (call.billed === 'answered') await discardAnsweredBatch(engine, batchId).catch(() => {});
    else await markBatchUncertain(engine, batchId).catch(() => {});
    await grant?.settle({ ok: call.billed !== 'no' }).catch(() => {});
    throw call.error;
  }
  const vectors = call.vectors;
  if (vectors.length !== chunks.length || vectors.some(v => !v?.length || !v.every(Number.isFinite))) {
    await discardAnsweredBatch(engine, batchId);
    await grant?.settle({ ok: true });
    throw new Error('Embedding provider returned an incomplete or invalid batch');
  }
  await storeBatchVectors(engine, batchId, batchRows.map((row, i) => ({ ...row, embedding: `[${Array.from(vectors[i]!).join(',')}]` })));
  await grant?.settle({ ok: true });
  await embeddingBatchProbe.afterReturned?.(batchId);
  const installed = await installEmbeddingBatch(engine, page, target, batchId, guard);
  return { pending: rows.length, installed: installed + replayed, usd: pageUsd + tailUsd, ...(uncertain ? { uncertain } : {}) };
}

/**
 * One batch's provider call, with what it cost when it failed. Every provider attempt inside `embedFn` (the gateway
 * sends a long batch as sequential sub-batches) passes an AI invocation guard that counts it and lets a further attempt
 * out only while every earlier one answered or was refused unbilled (the gateway's proof), so an attempt that may have
 * been billed without an answer is never followed by another under the same reservation. A failure is `unknown` (an
 * attempt was sent and never answered: the batch turns uncertain and waits for approval), `answered` (attempts
 * answered and the response was refused: their spend stands) or `no` (nothing was sent, or each attempt was refused
 * unbilled or rate limited: the batch is released). A rate-limited batch with nothing answered is retried here with
 * the rate-limit backoff, at most MAX_RATE_LIMIT_RETRIES times.
 */
async function callBatchProvider(embedFn: SegmentedEmbedFn, texts: string[], signal?: AbortSignal):
  Promise<{ vectors: Float32Array[] } | { error: unknown; billed: 'no' | 'answered' | 'unknown' }> {
  for (let retry = 0; ; retry++) {
    const attempts = { sent: 0, unbilled: 0, answered: 0 };
    try {
      return { vectors: await withBatchReserved(() => withAIInvocationMeter(event => {
        if (event.call.kind === 'embedding' && event.outcome === 'ok') attempts.answered++;
      }, () => withAIInvocationGuard(async () => {
        if (attempts.sent > attempts.unbilled + attempts.answered) throw new Error('An earlier attempt of this embedding batch may have been billed without an answer, so the batch is not sent again without approval.');
        attempts.sent++;
        return { settle: async usage => { if (usage && usage.inputTokens === 0 && usage.outputTokens === 0) attempts.unbilled++; } };
      }, () => embedFn(texts, { abortSignal: signal }), { inherit: true }))) };
    } catch (error) {
      const open = attempts.sent - attempts.unbilled - attempts.answered;
      const limited = open === 1 && detect429FromCause(error);
      if (open > 0 && !limited) return { error, billed: 'unknown' };
      if (attempts.answered > 0) return { error, billed: 'answered' };
      if (!limited || retry >= MAX_RATE_LIMIT_RETRIES || signal?.aborted) return { error, billed: 'no' };
      await abortableSleep(rateLimitDelayMs(error instanceof Error ? error.message : String(error), retry), signal);
    }
  }
}

/**
 * Install one returned batch from its stored vectors, once: under the page lock and `guard` (lease renewal, effect
 * claim), read the batch row; none (already installed) installs nothing; a page or write target that moved since the
 * batch's inputs were built (its context hash) installs nothing. Rows install by chunk_index and text md5 while their
 * recorded input is the one read before the call. The batch row is deleted in the same transaction, so a replay is a
 * no-op; a throwing guard rolls back and leaves the batch for the next lease holder.
 */
export async function installEmbeddingBatch(engine: BrainEngine, page: SegmentedEmbedPage, target: Awaited<ReturnType<typeof embeddingWriteTarget>>,
  batchId: string, guard: (tx: BrainEngine) => Promise<void>): Promise<number> {
  const col = quoteIdentifier(target.column.name);
  return engine.transaction(async tx => {
    await tx.lockPageKeys([{ sourceId: page.source_id, slug: page.slug }]);
    await guard(tx);
    const [batch] = await tx.executeRaw<{ rows: unknown; context: string; column_name: string }>(
      "SELECT rows, context, column_name FROM embedding_batches WHERE batch_id = $1 AND page_id = $2 AND state = 'returned' FOR UPDATE", [batchId, page.id]);
    if (!batch) return 0;
    await tx.executeRaw('DELETE FROM embedding_batches WHERE batch_id = $1', [batchId]);
    const current = await readSegmentedEmbedPage(tx, { id: page.id });
    const now = await embeddingWriteTarget(tx);
    if (!current || batch.column_name !== target.column.name || embeddingBatchContext(current, now) !== batch.context) return 0;
    const rows = (typeof batch.rows === 'string' ? JSON.parse(batch.rows) : batch.rows) as EmbeddingBatchRow[];
    let installed = 0;
    for (const chunk of jsonRowBatches(rows, row => row)) {
      installed += (await tx.executeRaw(`UPDATE content_chunks cc SET ${col} = v.embedding${vectorCastSuffix(now.column)},
          embedding_input_hash = v.hash, embedded_at = now(), embedded_text_hash = v.text_md5, model = COALESCE($3, cc.model),
          embedding_pending_since = NULL
        FROM jsonb_to_recordset($2::text::jsonb) AS v(chunk_index int, text_md5 text, embedding text, hash text, expected text), pages p
        WHERE cc.page_id = $1 AND p.id = cc.page_id AND cc.chunk_index = v.chunk_index AND md5(cc.chunk_text) = v.text_md5
          AND cc.embedding_input_hash IS NOT DISTINCT FROM v.expected AND ${chunkGenerationFilter('p', 'cc')}
        RETURNING cc.id`, [page.id, chunk, now.model])).length;
    }
    return installed;
  });
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

/** Why a run of `embedSegmentedPage` stopped before every row had a vector. */
export type SegmentedEmbedStop = 'budget' | 'page_moved' | 'busy' | 'source_capped' | 'uncertain' | 'slice';

/**
 * Embed every vector-less live row of a segmented page (or only the rows of
 * `occurrenceIds`, the occurrences an append added; every live row with
 * `all`) in the page's one embedding order (segmentedEmbedOrder), one keyset
 * batch at a time, until the rows run out (`complete`) or it stops: the
 * budget holds the page or leaves no room (`budget`), the source's 24-hour
 * ledger is full (`source_capped`), only rows of an uncertain batch are left
 * (`uncertain`), the page moved under an install (`page_moved`), the lease
 * stayed busy (`busy`), or a bounded slice ended (`slice`: `maxBatches` or
 * `deadline`, the embed-page job's unit of work).
 *
 * A stale run (no `occurrenceIds`, no `all`) keeps its cursor and counts on
 * the page's progress row (embedding-ledger.ts), so a restart resumes where it
 * stopped; a pass that resumed mid-page wraps to the start once before it
 * reports `complete`, which is the one rescan a lost cursor costs. An approval
 * (`approvedCapUsd`) raises the page's cap once per run: later batches keep
 * the approval's lifted hold but spend under the cap it set.
 */
export async function embedSegmentedPage(engine: BrainEngine, page: SegmentedEmbedPage,
  opts: SegmentedEmbedOpts & { occurrenceIds?: readonly number[]; batchRows?: number; all?: boolean; maxBatches?: number; deadline?: number }):
  Promise<{ embedded: number; complete: boolean; stopped?: SegmentedEmbedStop }> {
  const column = (await embeddingWriteTarget(engine)).column.name;
  const limit = opts.batchRows ?? SEGMENTED_EMBED_BATCH_ROWS;
  const order = await segmentedEmbedOrder(engine, page);
  const tracked = !opts.occurrenceIds && !opts.all;
  let progress = tracked ? await openProgress(engine, page, order, column) : undefined;
  let cursor: SegmentedEmbedCursor | null = progress && progress.cursor_chunk_index !== null
    ? { chunkIndex: progress.cursor_chunk_index, seq: progress.cursor_seq, ordinal: progress.cursor_ordinal } : null;
  let wrapped = cursor === null;
  let embedded = 0;
  let batches = 0;
  let approvedCapUsd = opts.approvedCapUsd;
  let uncertainLeft = false;
  const finish = async (stopped: SegmentedEmbedStop | undefined) => {
    if (progress) {
      progress = { ...progress, state: progressState(stopped), cursor_chunk_index: cursor?.chunkIndex ?? null, cursor_seq: cursor?.seq ?? null,
        cursor_ordinal: cursor?.ordinal ?? null, ...(stopped === undefined ? { embedded_rows: progress.live_rows, cursor_chunk_index: null, cursor_seq: null, cursor_ordinal: null } : {}),
        next_run_at: stopped === 'slice' ? new Date().toISOString() : null };
      await saveEmbedProgress(engine, progress);
    }
    return { embedded, complete: stopped === undefined, ...(stopped ? { stopped } : {}) };
  };
  for (;;) {
    opts.signal?.throwIfAborted();
    if (batches >= (opts.maxBatches ?? Infinity) || Date.now() >= (opts.deadline ?? Infinity)) return finish('slice');
    const rows = await listSegmentedStaleRows(engine, page.id, column, { order, after: cursor, limit, occurrenceIds: opts.occurrenceIds, includeEmbedded: opts.all });
    if (rows.length === 0) {
      if (wrapped) return finish(uncertainLeft ? 'uncertain' : undefined);
      wrapped = true;
      cursor = null;
      continue;
    }
    const done = await embedSegmentedRows(engine, page, rows, { ...opts, approvedCapUsd, includeEmbedded: opts.all });
    batches++;
    if (approvedCapUsd !== undefined) approvedCapUsd = 0;
    if (done === null) return finish('budget');
    if (done.busy) return finish('busy');
    embedded += done.installed;
    if (progress) progress = { ...progress, embedded_rows: Math.min(progress.live_rows, progress.embedded_rows + done.installed), spent_usd: progress.spent_usd + (done.usd ?? 0) };
    if (done.sourceCapped) return finish('source_capped');
    if (done.pending > 0 && done.installed === 0) return finish('page_moved');
    if (done.installed < done.pending) return finish('budget');
    cursor = cursorAfter(rows[rows.length - 1]!);
    if (progress) await saveEmbedProgress(engine, { ...progress, cursor_chunk_index: cursor.chunkIndex, cursor_seq: cursor.seq, cursor_ordinal: cursor.ordinal });
    if (done.uncertain) uncertainLeft = true;
  }
}

function progressState(stopped: SegmentedEmbedStop | undefined): EmbedProgress['state'] {
  switch (stopped) {
    case undefined: return 'complete';
    case 'budget': return 'capped';
    case 'source_capped': return 'source_capped';
    case 'uncertain': return 'uncertain';
    case 'busy': return 'busy';
    default: return 'running';
  }
}

/**
 * The page's progress row for a stale run: kept while the generation and order are the ones it was written for (the
 * cursor stays valid as a keyset position); otherwise restarted with the live and embedded row counts read once for
 * the new generation.
 */
async function openProgress(engine: BrainEngine, page: SegmentedEmbedPage, order: EmbedOrder, column: string): Promise<EmbedProgress> {
  const prior = await readEmbedProgress(engine, page.id);
  if (prior && prior.generation === page.body_generation && prior.embed_order === order) return { ...prior, state: 'running' };
  const col = quoteIdentifier(column);
  const [counts] = await engine.executeRaw<{ total: number; embedded: number }>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE cc.${col} IS NOT NULL)::int AS embedded
       FROM content_chunks cc JOIN pages p ON p.id = cc.page_id
      WHERE cc.page_id = $1 AND ${currentTextProjectionFilter('p')} AND ${chunkGenerationFilter('p', 'cc')}`, [page.id]);
  const keep = prior && prior.embed_order === order;
  const fresh: EmbedProgress = { page_id: page.id, generation: page.body_generation, embed_order: order,
    cursor_chunk_index: keep ? prior.cursor_chunk_index : null, cursor_seq: keep ? prior.cursor_seq : null, cursor_ordinal: keep ? prior.cursor_ordinal : null,
    embedded_rows: Number(counts?.embedded ?? 0), live_rows: Number(counts?.total ?? 0), spent_usd: prior?.spent_usd ?? 0, state: 'running',
    junk_generation: prior?.junk_generation ?? null, next_run_at: null, updated_at: null };
  await saveEmbedProgress(engine, fresh);
  return fresh;
}
