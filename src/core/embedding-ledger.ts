/**
 * Wave C 1F: exactly-once paid embedding for segmented pages, and the real
 * 24-hour spend ledger (spec §6.2, T-E13, T-E14).
 *
 * Every provider call that embeds rows of a segmented page has a batch
 * identity (`embedding_batches`) written before the call with its row set
 * (chunk index, text md5, recorded input hashes) and a context hash (slug,
 * title, contextual mode, write column, provenance model). The call's spend is
 * reserved in `embedding_spend` in the same transaction, under a per-source
 * lock, against `embed.backfill_max_usd_per_source_24h`: reserved, settled and
 * uncertain rows of the last 24 hours all count, so two pages (or a job and the
 * tail work) competing for the last allowance never both proceed. An explicit
 * approval (`--max-usd`) is booked but not refused by the source cap.
 *
 * The provider's vectors are stored on the batch before the install, and the
 * install deletes the batch in its own transaction, so it happens once: a crash
 * between the response and the install leaves a `returned` batch the next
 * lease holder installs from the stored vectors without calling the provider.
 * A batch still `calling` when another path takes the page's embedding lease
 * belonged to a holder that died during the call: it becomes `uncertain`, its
 * spend counts as uncertain, and its rows are not sent again until the user
 * approves (`gbrain embed <slug> --max-usd N`), because the provider may have
 * billed it.
 *
 * Lock order (one order for the grant, the job and the effect): the page's
 * embedding lease (a gbrain_cycle_locks row) is taken first and held across a
 * batch; then, each in its own transaction, the page budget row (the grant),
 * the source spend lock with the batch and spend rows (this module), and for
 * the install the page key lock, the lease renewal, the effect claim and the
 * batch row. No transaction takes a page budget row after a source spend lock
 * or a page key lock.
 *
 * `page_embedding_progress` is the derived per-page cursor and status the
 * embed-page job, `gbrain pages status` and `gbrain sources status` read.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { parseUsdLimit, resolveSpendPosture } from './spend-posture.ts';
import { withAIInvocationGuard } from './ai/invocation-guard.ts';
import { loadPricingOverrides } from './budget/budget-tracker.ts';
import type { PricingOverrides } from './budget/reservation-cost.ts';
import { actualCents, maximumInvocationCents } from './minions/delegated-spend.ts';

export const PAGE_TAIL_USD_KEY = 'embed.page_tail_usd_per_day';
export const DEFAULT_PAGE_TAIL_USD = 0.25;
export const SOURCE_SPEND_CAP_KEY = 'embed.backfill_max_usd_per_source_24h';
export const DEFAULT_SOURCE_SPEND_CAP_USD = 25;
const USD_EPSILON = 1e-9;

/** Test seams: `beforeCall` runs once a batch is reserved, before the provider call; `afterReturned` once its vectors are stored, before its install. */
export const embeddingBatchProbe: { beforeCall?: (batchId: string) => void | Promise<void>; afterReturned?: (batchId: string) => void | Promise<void> } = {};

/** The tail allowance per capped page per 24 hours: `embed.page_tail_usd_per_day`, default $0.25; `0` or `off` disables it. */
export async function resolvePageTailUsdPerDay(engine: Pick<BrainEngine, 'getConfig'>): Promise<number> {
  const raw = await engine.getConfig(PAGE_TAIL_USD_KEY).catch(() => null);
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_PAGE_TAIL_USD;
  const value = raw.trim().toLowerCase();
  if (value === 'off' || value === 'none' || value === 'disabled') return 0;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PAGE_TAIL_USD;
}

/** The per-source 24-hour embedding cap: `embed.backfill_max_usd_per_source_24h` (default $25); Infinity when `off` or under `spend.posture tokenmax`. */
export async function resolveSourceSpendCapUsd(engine: BrainEngine): Promise<number> {
  if (await resolveSpendPosture(engine).catch(() => 'gated') === 'tokenmax') return Infinity;
  return parseUsdLimit(await engine.getConfig(SOURCE_SPEND_CAP_KEY).catch(() => null), DEFAULT_SOURCE_SPEND_CAP_USD);
}

export interface SourceSpend { total_usd: number; tail_usd: number; uncertain_usd: number; reserved_usd: number }

const WINDOW = "at > now() - interval '24 hours' AND state <> 'released'";

/** The source's embedding spend in the last 24 hours: every reserved, settled and uncertain row, the tail work's share, and the uncertain share. */
export async function sourceSpend24h(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string): Promise<SourceSpend> {
  const [row] = await engine.executeRaw<{ total: number | null; tail: number | null; uncertain: number | null; reserved: number | null }>(
    `SELECT sum(usd) AS total, sum(usd) FILTER (WHERE kind = 'tail') AS tail, sum(usd) FILTER (WHERE state = 'uncertain') AS uncertain,
            sum(usd) FILTER (WHERE state = 'reserved') AS reserved
       FROM embedding_spend WHERE source_id = $1 AND ${WINDOW}`, [sourceId]);
  return { total_usd: Number(row?.total ?? 0), tail_usd: Number(row?.tail ?? 0), uncertain_usd: Number(row?.uncertain ?? 0), reserved_usd: Number(row?.reserved ?? 0) };
}

/** What one page's tail allowance spent in the last 24 hours. */
export async function pageTailSpend24h(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<number> {
  const [row] = await engine.executeRaw<{ usd: number | null }>(
    `SELECT sum(usd) AS usd FROM embedding_spend WHERE page_id = $1 AND kind = 'tail' AND ${WINDOW}`, [pageId]);
  return Number(row?.usd ?? 0);
}

/** One row of a batch: the chunk it embeds, its text's md5, the recorded input it installs and the input the writer read; `embedding` once returned. */
export interface EmbeddingBatchRow { chunk_index: number; text_md5: string; hash: string; expected: string | null; embedding?: string }

export function textMd5(text: string): string {
  return createHash('md5').update(text).digest('hex');
}

/** The identity of what a batch's inputs were built under; an install whose page or write target moved since installs nothing. */
export function embeddingBatchContext(page: { slug: string; title: string; contextual_retrieval_mode: string | null },
  target: { column: { name: string }; provenanceModel: string | null }): string {
  return createHash('sha256').update(JSON.stringify([page.slug, page.title, page.contextual_retrieval_mode, target.column.name, target.provenanceModel])).digest('hex');
}

export type BatchReservation = { ok: true } | { ok: false; spentUsd: number; capUsd: number };

/**
 * Record a batch before its provider call and reserve its spend: under the source's spend lock, refuse when the last
 * 24 hours' reserved, settled and uncertain spend plus this batch would pass the source cap (`enforce`; an explicit
 * approval books without refusing). `pageUsd` is booked as `page` spend, `tailUsd` (the tail allowance's share) as
 * `tail` spend on the same batch.
 */
export async function reserveEmbeddingBatch(engine: BrainEngine, batch: {
  batchId: string; pageId: number; sourceId: string; generation: number; column: string; signature: string | null; context: string;
  rows: readonly EmbeddingBatchRow[]; pageUsd: number; tailUsd: number; enforce: boolean;
}): Promise<BatchReservation> {
  const capUsd = batch.enforce ? await resolveSourceSpendCapUsd(engine) : Infinity;
  const usd = Math.max(0, batch.pageUsd) + Math.max(0, batch.tailUsd);
  return engine.transaction(async tx => {
    await lockSourceSpend(tx, batch.sourceId);
    if (Number.isFinite(capUsd)) {
      const spent = (await sourceSpend24h(tx, batch.sourceId)).total_usd;
      if (spent + usd > capUsd + USD_EPSILON) return { ok: false, spentUsd: spent, capUsd } as const;
    }
    await tx.executeRaw(`INSERT INTO embedding_batches (batch_id, page_id, source_id, generation, column_name, signature, rows, state, usd, context)
      VALUES ($1, $2, $3, $4, $5, $6, $7::text::jsonb, 'calling', $8, $9)`,
    [batch.batchId, batch.pageId, batch.sourceId, batch.generation, batch.column, batch.signature, JSON.stringify(batch.rows), usd, batch.context]);
    await tx.executeRaw("INSERT INTO embedding_spend (batch_id, source_id, page_id, kind, usd, state) VALUES ($1, $2, $3, 'page', $4, 'reserved')",
      [batch.batchId, batch.sourceId, batch.pageId, Math.max(0, batch.pageUsd)]);
    if (batch.tailUsd > 0) {
      await tx.executeRaw("INSERT INTO embedding_spend (batch_id, source_id, page_id, kind, usd, state) VALUES ($1, $2, $3, 'tail', $4, 'reserved')",
        [`${batch.batchId}:tail`, batch.sourceId, batch.pageId, batch.tailUsd]);
    }
    await tx.executeRaw("DELETE FROM embedding_spend WHERE source_id = $1 AND at < now() - interval '7 days'", [batch.sourceId]);
    return { ok: true } as const;
  });
}

const lockSourceSpend = (tx: Pick<BrainEngine, 'executeRaw'>, sourceId: string) =>
  tx.executeRaw("SELECT pg_advisory_xact_lock(hashtext('gbrain:embedding_spend:' || $1)::bigint)", [sourceId]);

const spendIds = (batchId: string) => [batchId, `${batchId}:tail`];

/** Store a batch's returned vectors before its install and settle its spend; idempotent by batch id (an uncertain batch that answered late settles too). */
export async function storeBatchVectors(engine: BrainEngine, batchId: string, rows: readonly EmbeddingBatchRow[]): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw(`UPDATE embedding_batches SET rows = $2::text::jsonb, state = 'returned', updated_at = now()
      WHERE batch_id = $1 AND state IN ('calling','uncertain')`, [batchId, JSON.stringify(rows)]);
    await tx.executeRaw("UPDATE embedding_spend SET state = 'settled' WHERE batch_id = ANY($1::text[]) AND state IN ('reserved','uncertain')", [spendIds(batchId)]);
  });
}

/** No attempt of the call was sent, or the provider refused every attempt unbilled: drop the batch and release its reservation. */
export async function releaseEmbeddingBatch(engine: BrainEngine, batchId: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("DELETE FROM embedding_batches WHERE batch_id = $1 AND state = 'calling'", [batchId]);
    await tx.executeRaw("UPDATE embedding_spend SET state = 'released' WHERE batch_id = ANY($1::text[]) AND state = 'reserved'", [spendIds(batchId)]);
  });
}

/**
 * The call's outcome is unknown (a timeout, a reset or an abort after it was sent): the batch turns uncertain now, its
 * spend counts as uncertain and its rows wait for the user's approval, as a holder that died during the call leaves it.
 */
export async function markBatchUncertain(engine: BrainEngine, batchId: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("UPDATE embedding_batches SET state = 'uncertain', updated_at = now() WHERE batch_id = $1 AND state = 'calling'", [batchId]);
    await tx.executeRaw("UPDATE embedding_spend SET state = 'uncertain' WHERE batch_id = ANY($1::text[]) AND state = 'reserved'", [spendIds(batchId)]);
  });
}

/** The provider answered but the batch is unusable (an incomplete, invalid or refused-vector response): drop it and keep its settled spend. */
export async function discardAnsweredBatch(engine: BrainEngine, batchId: string): Promise<void> {
  await engine.transaction(async tx => {
    await tx.executeRaw("DELETE FROM embedding_batches WHERE batch_id = $1", [batchId]);
    await tx.executeRaw("UPDATE embedding_spend SET state = 'settled' WHERE batch_id = ANY($1::text[]) AND state IN ('reserved','uncertain')", [spendIds(batchId)]);
  });
}

/** A page's open batches, read by the holder of its embedding lease. */
export interface PageBatchRecovery {
  /** Batches whose vectors are stored and not yet installed: install them, never call the provider for them again. */
  returned: string[];
  /** Chunk indexes of uncertain batches: possibly paid, so they wait for the user's approval. */
  uncertain: Set<number>;
  uncertainBatches: number;
}

/**
 * Called with the page's embedding lease held: a batch still `calling` belonged to a holder that died (or lost its
 * lease) during the call, so it becomes `uncertain` and its spend counts as uncertain. Returns the returned batches to
 * install and the rows that wait for approval.
 */
export async function recoverPageBatches(engine: BrainEngine, pageId: number): Promise<PageBatchRecovery> {
  const rows = await engine.transaction(async tx => {
    const marked = await tx.executeRaw<{ batch_id: string }>(`UPDATE embedding_batches SET state = 'uncertain', updated_at = now()
      WHERE page_id = $1 AND state = 'calling' RETURNING batch_id`, [pageId]);
    if (marked.length) {
      await tx.executeRaw("UPDATE embedding_spend SET state = 'uncertain' WHERE batch_id = ANY($1::text[]) AND state = 'reserved'",
        [marked.flatMap(row => spendIds(row.batch_id))]);
    }
    return tx.executeRaw<{ batch_id: string; state: string; indexes: number[] | string }>(
      `SELECT batch_id, state, ARRAY(SELECT (r->>'chunk_index')::int FROM jsonb_array_elements(rows) r) AS indexes
         FROM embedding_batches WHERE page_id = $1 AND state IN ('returned','uncertain') ORDER BY created_at`, [pageId]);
  });
  const uncertain = new Set<number>();
  let uncertainBatches = 0;
  for (const row of rows) {
    if (row.state !== 'uncertain') continue;
    uncertainBatches++;
    for (const index of parseIntArray(row.indexes)) uncertain.add(index);
  }
  return { returned: rows.filter(row => row.state === 'returned').map(row => row.batch_id), uncertain, uncertainBatches };
}

function parseIntArray(value: number[] | string): number[] {
  if (Array.isArray(value)) return value.map(Number);
  return value.replace(/[{}]/g, '').split(',').filter(Boolean).map(Number);
}

/** The user's approval releases a page's uncertain batches so their rows embed again; their spend stays counted as uncertain. */
export async function releaseUncertainBatches(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<number> {
  return (await engine.executeRaw("DELETE FROM embedding_batches WHERE page_id = $1 AND state = 'uncertain' RETURNING batch_id", [pageId])).length;
}

const batchReserved = new AsyncLocalStorage<true>();

/** Run a segmented batch's provider call: its spend is already reserved on its batch, so the source guard below books nothing for it. */
export function withBatchReserved<T>(run: () => Promise<T>): Promise<T> {
  return batchReserved.run(true, run);
}

/** The source's 24-hour embedding cap refused a call before it was sent. */
export class SourceSpendCapped extends Error {
  constructor(readonly spentUsd: number, readonly capUsd: number) {
    super(`${SOURCE_SPEND_CAP_KEY} reached: $${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)} spent in the last 24 hours, so this embedding call was not sent`);
    this.name = 'SourceSpendCapped';
  }
}

/**
 * Run `run` (an embed-backfill drain) with each embedding provider attempt outside a segmented batch reserved in the
 * source's 24-hour ledger before it is sent: its maximum liability, one row per attempt, under the source's spend lock,
 * refused past the cap (`onRefused` runs first, then the attempt throws). An answered attempt settles to its measured
 * cost; one with no reported usage keeps its maximum, and a worker killed mid-call leaves the reservation counted.
 */
export function withSourceSpendLedger<T>(engine: BrainEngine, opts: { sourceId: string; jobId: number; onRefused?: (refusal: SourceSpendCapped) => void },
  run: () => Promise<T>): Promise<T> {
  let pricing: Promise<PricingOverrides | undefined> | undefined;
  return withAIInvocationGuard(async call => {
    if (call.kind !== 'embedding' || batchReserved.getStore()) return { settle: async () => {} };
    const overrides = await (pricing ??= loadPricingOverrides(engine));
    const usd = (maximumInvocationCents(call, overrides) ?? 0) / 100;
    const capUsd = await resolveSourceSpendCapUsd(engine);
    const id = `job:${opts.jobId}:${randomUUID()}`;
    const refused = await engine.transaction(async tx => {
      await lockSourceSpend(tx, opts.sourceId);
      const spent = (await sourceSpend24h(tx, opts.sourceId)).total_usd;
      if (spent + usd > capUsd + USD_EPSILON) return new SourceSpendCapped(spent, capUsd);
      await tx.executeRaw("INSERT INTO embedding_spend (batch_id, source_id, page_id, kind, usd, state) VALUES ($1, $2, NULL, 'job', $3, 'reserved')", [id, opts.sourceId, usd]);
      return null;
    });
    if (refused) { opts.onRefused?.(refused); throw refused; }
    return { settle: async usage => {
      const cents = actualCents(call, usage, overrides);
      await engine.executeRaw("UPDATE embedding_spend SET state = 'settled', usd = $2 WHERE batch_id = $1 AND state = 'reserved'", [id, cents === null ? usd : cents / 100]);
    } };
  }, run, { inherit: true });
}

export type EmbedOrder = 'newest' | 'document';
export type EmbedProgressState = 'running' | 'complete' | 'capped' | 'held' | 'source_capped' | 'uncertain' | 'busy';

export interface EmbedProgress {
  page_id: number; generation: number; embed_order: EmbedOrder;
  cursor_seq: number | null; cursor_ordinal: number | null; cursor_chunk_index: number | null;
  embedded_rows: number; live_rows: number; spent_usd: number; state: EmbedProgressState;
  junk_generation: number | null; next_run_at: string | null; updated_at: string | null;
}

type ProgressRow = Omit<EmbedProgress, 'next_run_at' | 'updated_at'> & { next_run_at: Date | string | null; updated_at: Date | string | null };

function toProgress(row: ProgressRow): EmbedProgress {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());
  return { page_id: Number(row.page_id), generation: Number(row.generation), embed_order: row.embed_order,
    cursor_seq: n(row.cursor_seq), cursor_ordinal: n(row.cursor_ordinal), cursor_chunk_index: n(row.cursor_chunk_index),
    embedded_rows: Number(row.embedded_rows), live_rows: Number(row.live_rows), spent_usd: Number(row.spent_usd), state: row.state,
    junk_generation: n(row.junk_generation), next_run_at: iso(row.next_run_at), updated_at: iso(row.updated_at) };
}

export async function readEmbedProgress(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number): Promise<EmbedProgress | null> {
  const [row] = await engine.executeRaw<ProgressRow>('SELECT * FROM page_embedding_progress WHERE page_id = $1', [pageId]);
  return row ? toProgress(row) : null;
}

/** Write a page's progress row (every field but `junk_generation`, which the grant records). */
export async function saveEmbedProgress(engine: Pick<BrainEngine, 'executeRaw'>, p: Omit<EmbedProgress, 'junk_generation' | 'updated_at'>): Promise<void> {
  await engine.executeRaw(`INSERT INTO page_embedding_progress (page_id, generation, embed_order, cursor_seq, cursor_ordinal, cursor_chunk_index,
      embedded_rows, live_rows, spent_usd, state, next_run_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz, now())
    ON CONFLICT (page_id) DO UPDATE SET generation = EXCLUDED.generation, embed_order = EXCLUDED.embed_order, cursor_seq = EXCLUDED.cursor_seq,
      cursor_ordinal = EXCLUDED.cursor_ordinal, cursor_chunk_index = EXCLUDED.cursor_chunk_index, embedded_rows = EXCLUDED.embedded_rows,
      live_rows = EXCLUDED.live_rows, spent_usd = EXCLUDED.spent_usd, state = EXCLUDED.state, next_run_at = EXCLUDED.next_run_at, updated_at = now()`,
  [p.page_id, p.generation, p.embed_order, p.cursor_seq, p.cursor_ordinal, p.cursor_chunk_index, p.embedded_rows, p.live_rows, p.spent_usd, p.state, p.next_run_at]);
}

/** A segmented page's embedding as `gbrain pages status` and `gbrain sources status` print it (spec §6.2): progress, the page's cap and spend, and today's tail allowance. */
export interface EmbedProgressView extends EmbedProgress { page_spent_usd: number; cap_usd: number | null; tail_usd_today: number; tail_allowance_usd: number }

export async function readEmbedProgressView(engine: BrainEngine, pageId: number): Promise<EmbedProgressView | null> {
  const progress = await readEmbedProgress(engine, pageId);
  if (!progress) return null;
  const [budget] = await engine.executeRaw<{ cap_usd: number | null; spent_usd: number | null }>('SELECT cap_usd, spent_usd FROM page_embedding_budget WHERE page_id = $1', [pageId]);
  const { resolvePageEmbedCapUsd } = await import('./page-embedding-budget.ts');
  const cap = budget?.cap_usd !== null && budget?.cap_usd !== undefined ? Number(budget.cap_usd) : await resolvePageEmbedCapUsd(engine);
  return { ...progress, page_spent_usd: Number(budget?.spent_usd ?? progress.spent_usd), cap_usd: Number.isFinite(cap) ? cap : null,
    tail_usd_today: await pageTailSpend24h(engine, pageId), tail_allowance_usd: await resolvePageTailUsdPerDay(engine) };
}

const STATE_WORDS: Record<EmbedProgressState, string> = { running: 'running', complete: 'complete', capped: 'capped', held: 'held for approval',
  source_capped: "stopped at the source's 24-hour cap", uncertain: 'waiting for approval of a batch the provider may have billed', busy: 'waiting for its lease' };

/** "61,000 of 463,000 chunks embedded, $2.00 of $2.00, capped, newest first, tail allowance $0.04 of $0.25 today, next slice at T". */
export function embedProgressLine(v: EmbedProgressView): string {
  return [
    `${v.embedded_rows.toLocaleString('en-US')} of ${v.live_rows.toLocaleString('en-US')} chunks embedded`,
    `$${v.page_spent_usd.toFixed(2)}${v.cap_usd === null ? '' : ` of $${v.cap_usd.toFixed(2)}`}`,
    STATE_WORDS[v.state],
    v.embed_order === 'newest' ? 'newest first' : 'document order',
    v.tail_allowance_usd > 0 ? `tail allowance $${v.tail_usd_today.toFixed(2)} of $${v.tail_allowance_usd.toFixed(2)} today` : 'tail allowance off',
    ...(v.next_run_at ? [`next slice at ${v.next_run_at}`] : []),
  ].join(', ');
}

/** The segmented pages of a source still embedding, and the source's 24-hour ledger. */
export interface SourceEmbedProgress {
  pages: number; embedded_rows: number; live_rows: number; capped: number; uncertain: number;
  spend_24h: SourceSpend; cap_usd: number | null; tail_allowance_usd: number;
}

/** Null when no segmented page of the source is mid-embedding and the source spent nothing in 24 hours. */
export async function readSourceEmbedProgress(engine: BrainEngine, sourceId: string): Promise<SourceEmbedProgress | null> {
  const [row] = await engine.executeRaw<{ pages: number; embedded: number | string; live: number | string; capped: number; uncertain: number }>(
    `SELECT count(*)::int AS pages, COALESCE(sum(e.embedded_rows), 0)::bigint AS embedded, COALESCE(sum(e.live_rows), 0)::bigint AS live,
        count(*) FILTER (WHERE e.state IN ('capped', 'held'))::int AS capped, count(*) FILTER (WHERE e.state = 'uncertain')::int AS uncertain
       FROM page_embedding_progress e JOIN pages p ON p.id = e.page_id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL AND e.state <> 'complete'`, [sourceId]);
  const spend = await sourceSpend24h(engine, sourceId);
  if (!Number(row?.pages ?? 0) && spend.total_usd <= 0) return null;
  const cap = await resolveSourceSpendCapUsd(engine);
  return { pages: Number(row?.pages ?? 0), embedded_rows: Number(row?.embedded ?? 0), live_rows: Number(row?.live ?? 0), capped: Number(row?.capped ?? 0),
    uncertain: Number(row?.uncertain ?? 0), spend_24h: spend, cap_usd: Number.isFinite(cap) ? cap : null, tail_allowance_usd: await resolvePageTailUsdPerDay(engine) };
}

export function sourceEmbedProgressLine(sourceId: string, v: SourceEmbedProgress): string {
  const pages = v.pages ? `${v.pages} large page(s) mid-embedding, ${v.embedded_rows.toLocaleString('en-US')} of ${v.live_rows.toLocaleString('en-US')} chunks embedded${v.capped ? `, ${v.capped} capped or held` : ''}${v.uncertain ? `, ${v.uncertain} waiting on an uncertain batch` : ''}` : 'no large page mid-embedding';
  const spend = `last 24 h $${v.spend_24h.total_usd.toFixed(2)}${v.cap_usd === null ? '' : ` of $${v.cap_usd.toFixed(2)}`}${v.spend_24h.uncertain_usd > 0 ? ` ($${v.spend_24h.uncertain_usd.toFixed(2)} uncertain)` : ''}`;
  return `${sourceId}: embedding ${pages}; ${spend}; tail allowance ${v.tail_allowance_usd > 0 ? `$${v.spend_24h.tail_usd.toFixed(2)} spent today, $${v.tail_allowance_usd.toFixed(2)} per capped page per day` : 'off'}`;
}
