/**
 * The per-page embedding spend cap for large pages (`embed.max_usd_per_page`,
 * default $2), with its durable ledger `page_embedding_budget` (migration
 * v246).
 *
 * Scope: pages above `pages.inline_max_bytes` (page-size-policy.ts). A page at
 * or under it costs a few cents at most to embed whole and is not metered.
 *
 * Lifetime: spend accumulates per page for one embedding signature (model and
 * dimensions); a model change starts a new ledger. The cap bounds that
 * lifetime spend, so re-embed churn on a live page (boundary drift, rebuilds)
 * can never spend more than the cap on it.
 *
 * Composition: every paid embedding entrypoint asks `planPageEmbedding` for a
 * grant before it calls the provider. The grant takes the newest stale chunks
 * whose estimated cost fits the page's remaining budget and reserves that
 * estimate under a row lock, so concurrent sweeps never overspend. The run's
 * own caps (the CLI consent cap `--max-usd`, `embed.backfill_max_usd`,
 * `embed.backfill_max_usd_per_source_24h`) still meter the same provider calls
 * through the gateway's budget tracker, so the lowest cap wins.
 *
 * States: `open`; `capped` once the cap stopped a run with stale chunks left
 * (the page stays keyword-searchable and partially embedded); `held` while a
 * page waits for the user's approval (the oversized-page upgrade backfill, or
 * a sampled junk hit). Held and capped pages leave the stale-chunk queue
 * (engine-sql/chunks.ts staleChunkWhere) so the sweep never retries them; an explicit
 * approval (`gbrain embed --held --source S --max-usd N`, or `--slugs <slug>
 * --source S --max-usd N`) passes `approvedCapUsd`, lifts the hold and raises the
 * cap. Every printed approve and its N come from held-embedding-action.ts.
 *
 * Crash safety: a reservation older than an hour (the provider call never
 * settled) is counted as spent, never released, so a crash cannot reopen
 * budget it may already have used.
 */
import type { BrainEngine } from './engine.ts';
import { JUNK_SAMPLE_CHARS, assessJunkWindows, assessSampledJunk } from './content-sanity.ts';
import type { BodyStorage, ManifestRow } from './page-body/types.ts';
import { isSegmentedPage, pageBodyBytes } from './page-body/page-shape.ts';
import { estimateCostFromChars } from './embedding-pricing.ts';
import { PAGE_INLINE_MAX_BYTES, budgetRowAppliesFilter, isLargePageBytes } from './page-size-policy.ts';
import { isEmbedSkipped } from './embed-skip.ts';
import { parseUsdLimit, resolveSpendPosture } from './spend-posture.ts';
import { chunkGenerationFilter } from './search/safe-chunks.ts';
import { quoteIdentifier } from './search/embedding-column.ts';
import { embeddingWriteTarget } from './page-state/projections.ts';
import { approvalAmount, approvalBasis, heldApproveAction, heldPreviewCommand, ledgerPricePerMTok, renderedCommand } from './held-embedding-action.ts';

export const PAGE_EMBED_CAP_KEY = 'embed.max_usd_per_page';
export const DEFAULT_PAGE_EMBED_CAP_USD = 2;

export type PageBudgetState = 'open' | 'held' | 'capped';

/** The configured cap: `embed.max_usd_per_page`, else unlimited under `spend.posture tokenmax`, else $2. `off` is Infinity. */
export async function resolvePageEmbedCapUsd(engine: Pick<BrainEngine, 'getConfig' | 'executeRaw'>): Promise<number> {
  const raw = await engine.getConfig(PAGE_EMBED_CAP_KEY).catch(() => null);
  if (raw === null || raw === undefined || raw === '') {
    return await resolveSpendPosture(engine as BrainEngine).catch(() => 'gated') === 'tokenmax' ? Infinity : DEFAULT_PAGE_EMBED_CAP_USD;
  }
  return parseUsdLimit(raw, DEFAULT_PAGE_EMBED_CAP_USD);
}

export interface PageEmbedGrant {
  /** chunk_index values this run may embed: the newest stale chunks that fit the remaining budget. */
  chunkIndexes: ReadonlySet<number>;
  reservedUsd: number;
  /** Stale chunks left without a vector because the cap was reached. */
  deferred: number;
  capUsd: number;
  /** Book the reservation as spent (`ok`) or release it (the provider call failed before billing). */
  settle(outcome: { ok: boolean }): Promise<void>;
}

export type PageEmbedDecision =
  | { kind: 'unmetered' }
  | { kind: 'held'; reason: string }
  | { kind: 'grant'; grant: PageEmbedGrant };

interface BudgetRow { state: PageBudgetState; reason: string | null; embedding_signature: string | null; spent_usd: number; reserved_usd: number; stale_reservation: boolean; cap_usd: number | null }

/** A segmented page (Wave B) carries `body_bytes` and no body strings; an inline page carries its body. */
type BudgetPage = { id: number; body_storage?: BodyStorage | null; body_bytes?: number | null; compiled_truth?: string; timeline?: string | null };

/**
 * The head, middle and tail sample windows of a segmented page, read one
 * segment at a time from the live manifest (never the whole body): the head
 * window from the first segments, the middle window from the segment at the
 * middle byte on, the tail window from the last segments back.
 */
async function segmentedSampleWindows(engine: BrainEngine, pageId: number): Promise<string[]> {
  const manifest = await engine.readManifest(pageId);
  if (manifest.length === 0) return [''];
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const read = async (row: ManifestRow) => {
    const texts = await engine.readSegmentTexts(row.sourceId, [row.sha256]);
    return decoder.decode(texts.get(Buffer.from(row.sha256).toString('hex')) ?? new Uint8Array());
  };
  const forward = async (from: number) => {
    let text = '';
    for (let i = from; i < manifest.length && text.length < JUNK_SAMPLE_CHARS; i++) text += await read(manifest[i]!);
    return text.slice(0, JUNK_SAMPLE_CHARS);
  };
  let tail = '';
  for (let i = manifest.length - 1; i >= 0 && tail.length < JUNK_SAMPLE_CHARS; i--) tail = await read(manifest[i]!) + tail;
  const totalBytes = manifest.reduce((n, row) => n + row.byteLen, 0);
  const middle = manifest.findIndex(row => row.byteStart + row.byteLen > totalBytes / 2);
  return [await forward(0), await forward(Math.max(0, middle)), tail.slice(-JUNK_SAMPLE_CHARS)];
}

/** Hold a large page's embedding until the user approves it (`reason` names why). Idempotent; never touches open spend. */
export async function holdPageEmbedding(engine: Pick<BrainEngine, 'executeRaw'>, pageId: number, reason: string): Promise<void> {
  await engine.executeRaw(`INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'held', $2)
    ON CONFLICT (page_id) DO UPDATE SET state = 'held', reason = EXCLUDED.reason, updated_at = now()`, [pageId, reason]);
}

/**
 * Decide what one embedding run may spend on `page`. Small pages are
 * unmetered. A held page returns `held` unless the caller carries the user's
 * approval. Otherwise the newest stale chunks that fit the remaining budget are
 * granted and their estimated cost is reserved.
 */
export async function planPageEmbedding(engine: BrainEngine, page: BudgetPage,
  stale: ReadonlyArray<{ chunk_index: number; chunk_text: string }>,
  opts: { signature?: string | null; approvedCapUsd?: number; maxMarkupRatio?: number } = {}): Promise<PageEmbedDecision> {
  if (!isLargePageBytes(pageBodyBytes(page)) || stale.length === 0) return { kind: 'unmetered' };
  const approved = opts.approvedCapUsd !== undefined;
  const configured = await resolvePageEmbedCapUsd(engine);
  const { rate, priced } = ledgerPricePerMTok(opts.signature);
  return engine.transaction(async tx => {
    await tx.executeRaw('INSERT INTO page_embedding_budget (page_id) VALUES ($1) ON CONFLICT (page_id) DO NOTHING', [page.id]);
    const [row] = await tx.executeRaw<BudgetRow>(`SELECT state, reason, embedding_signature, spent_usd, reserved_usd, cap_usd,
        (reserved_usd > 0 AND reserved_at < now() - interval '1 hour') AS stale_reservation
      FROM page_embedding_budget WHERE page_id = $1 FOR UPDATE`, [page.id]);
    if (!row) return { kind: 'unmetered' } as const;
    if (row.state === 'held' && !approved) return { kind: 'held', reason: row.reason ?? 'awaiting_approval' } as const;
    if (!approved && row.state === 'open') {
      const junk = isSegmentedPage(page)
        ? assessJunkWindows(await segmentedSampleWindows(tx, page.id), { max_markup_ratio: opts.maxMarkupRatio })
        : assessSampledJunk(`${page.compiled_truth}\n${page.timeline ?? ''}`, { max_markup_ratio: opts.maxMarkupRatio });
      if (junk.junk) {
        const reason = junk.reasons.join(',');
        await tx.executeRaw(`UPDATE page_embedding_budget SET state = 'held', reason = $2, updated_at = now() WHERE page_id = $1`, [page.id, reason]);
        return { kind: 'held', reason } as const;
      }
    }
    const sameLedger = !row.embedding_signature || !opts.signature || row.embedding_signature === opts.signature;
    const spent = sameLedger ? Number(row.spent_usd) + (row.stale_reservation ? Number(row.reserved_usd) : 0) : 0;
    let reserved = sameLedger && !row.stale_reservation ? Number(row.reserved_usd) : 0;
    const stored = row.cap_usd === null ? configured : Number(row.cap_usd);
    const capUsd = approved ? Math.max(stored, spent + reserved + opts.approvedCapUsd!) : stored;
    const remaining = Math.max(0, capUsd - spent - reserved);
    const chunkIndexes = new Set<number>();
    let reservedUsd = 0;
    for (const chunk of [...stale].sort((a, b) => b.chunk_index - a.chunk_index)) {
      const cost = estimateCostFromChars(chunk.chunk_text.length, rate);
      if (reservedUsd + cost > remaining) break;
      reservedUsd += cost;
      chunkIndexes.add(chunk.chunk_index);
    }
    const deferred = stale.length - chunkIndexes.size;
    reserved += reservedUsd;
    const state: PageBudgetState = deferred > 0 ? 'capped' : 'open';
    await tx.executeRaw(`UPDATE page_embedding_budget SET state = $2, reason = $3, embedding_signature = COALESCE($4, embedding_signature),
        spent_usd = $5::float8, reserved_usd = $6::float8, reserved_at = CASE WHEN $6::float8 > 0 THEN now() ELSE NULL END,
        cap_usd = $7::float8, updated_at = now() WHERE page_id = $1`,
    [page.id, state, deferred > 0 ? 'cap_reached' : null, opts.signature ?? null, spent, reserved,
      approved && Number.isFinite(capUsd) ? capUsd : row.cap_usd]);
    const grant: PageEmbedGrant = {
      chunkIndexes, reservedUsd, deferred, capUsd,
      settle: async ({ ok }) => {
        if (reservedUsd === 0) return;
        await engine.executeRaw(`UPDATE page_embedding_budget SET reserved_usd = GREATEST(0, reserved_usd - $2::float8),
            spent_usd = spent_usd + $3::float8, unpriced_calls = unpriced_calls + $4::int, updated_at = now() WHERE page_id = $1`,
        [page.id, reservedUsd, ok ? reservedUsd : 0, ok && !priced ? 1 : 0]);
      },
    };
    return { kind: 'grant', grant } as const;
  });
}

export interface PageBudgetReport { slug: string; source_id: string; state: Exclude<PageBudgetState, 'open'>; reason: string | null;
  spent_usd: number; cap_usd: number | null; pending_chunks: number; pending_chars: number }

/** Estimated provider cost of embedding `chars` of chunk text with the model in `signature` (unknown models use the conservative rate, free recipes $0). */
export function estimatePageEmbedUsd(chars: number, signature: string | null | undefined): number {
  return estimateCostFromChars(chars, ledgerPricePerMTok(signature).rate);
}

/** Held and capped pages with their stale chunk counts (`gbrain embed --held`); `limit: null` lists every one. */
export async function listBudgetLimitedPages(engine: Pick<BrainEngine, 'executeRaw'>, opts: { state?: 'held' | 'capped'; sourceId?: string; limit?: number | null } = {}): Promise<PageBudgetReport[]> {
  const params: unknown[] = [opts.limit === undefined ? 1000 : opts.limit];
  const filters = [budgetRowAppliesFilter('b', 'p'), 'p.deleted_at IS NULL'];
  if (opts.state) filters.push(`b.state = $${params.push(opts.state)}`);
  if (opts.sourceId) filters.push(`p.source_id = $${params.push(opts.sourceId)}`);
  const pending = `(CASE WHEN p.body_storage = 'segmented' THEN cc.${quoteIdentifier((await embeddingWriteTarget(engine)).column.name)} IS NULL ELSE cc.embedded_at IS NULL END)`;
  const rows = await engine.executeRaw<PageBudgetReport>(`SELECT p.slug, p.source_id, b.state, b.reason, b.spent_usd, b.cap_usd,
      (SELECT count(*)::int FROM content_chunks cc WHERE cc.page_id = p.id AND ${pending} AND ${chunkGenerationFilter('p', 'cc')}) AS pending_chunks,
      (SELECT COALESCE(sum(length(cc.chunk_text)), 0)::bigint FROM content_chunks cc WHERE cc.page_id = p.id AND ${pending} AND ${chunkGenerationFilter('p', 'cc')}) AS pending_chars
    FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id
    WHERE ${filters.join(' AND ')} ORDER BY b.updated_at DESC, p.id LIMIT $1::int`, params);
  return rows.map(row => ({ ...row, spent_usd: Number(row.spent_usd), cap_usd: row.cap_usd === null ? null : Number(row.cap_usd), pending_chunks: Number(row.pending_chunks), pending_chars: Number(row.pending_chars) }));
}

/** Run the provider call under a grant: booked as spent once it returns, released if it throws. */
export async function spendGrant<T>(grant: PageEmbedGrant | undefined, call: () => Promise<T>): Promise<T> {
  if (!grant) return call();
  try {
    const out = await call();
    await grant.settle({ ok: true });
    return out;
  } catch (error) {
    await grant.settle({ ok: false }).catch(() => {});
    throw error;
  }
}

/** The approve command for one page's waiting chunks, with a concrete --max-usd ceiling (held-embedding-action.ts). */
async function pageApproveCommand(page: { slug: string; source_id?: string }, waiting: ReadonlyArray<{ chunk_text: string }>): Promise<string> {
  const basis = await approvalBasis();
  const amount = approvalAmount(waiting.reduce((n, c) => n + c.chunk_text.length, 0), basis);
  return renderedCommand(heldApproveAction({ source_id: page.source_id ?? 'default', slug: page.slug, pending_chunks: waiting.length, ...amount }, basis.free));
}

/**
 * One embedding run's per-page step: meter `candidates` (the page's chunks
 * without a vector) and narrow them to the grant, saying on stderr why chunks
 * wait. Null means embed nothing now (held, or the cap left no chunk);
 * otherwise `chunks` is the batch to embed, every candidate on an unmetered page.
 */
export async function meterPageBatch<C extends { chunk_index: number; chunk_text: string }>(engine: BrainEngine, page: BudgetPage & { slug: string; source_id?: string },
  candidates: readonly C[], opts: { signature?: string | null; approvedCapUsd?: number; announceHeld?: boolean }): Promise<{ grant?: PageEmbedGrant; chunks: C[] } | null> {
  const decision = await planPageEmbedding(engine, page, candidates, opts);
  if (decision.kind === 'unmetered') return { chunks: [...candidates] };
  if (decision.kind === 'held') {
    if (opts.announceHeld) process.stderr.write(`[embed] ${page.slug}: embedding held (${decision.reason}); the page stays keyword-searchable. With the user's approval: ${await pageApproveCommand(page, candidates)}\n`);
    return null;
  }
  const { grant } = decision;
  const chunks = candidates.filter(c => grant.chunkIndexes.has(c.chunk_index));
  if (grant.deferred) {
    const waiting = candidates.filter(c => !grant.chunkIndexes.has(c.chunk_index));
    process.stderr.write(`[embed] ${page.slug}: per-page cap $${grant.capUsd.toFixed(2)} reached; ${grant.deferred} older chunk(s) stay keyword-only until it rises (${await pageApproveCommand(page, waiting)})\n`);
  }
  if (chunks.length) return { grant, chunks };
  await grant.settle({ ok: true });
  return null;
}

/**
 * #6722: what a write left a page's embedding in, for write, sync and
 * remember receipts. Null for an ordinary page (embedded with the write, or by
 * the post-write job). `deferred`: over the inline threshold or stored
 * segmented, embedded after the commit under the per-page cap. `partial`: the cap stopped it with chunks
 * left keyword-only. `held`: it waits for the user's approval. `skipped`: an
 * embed_skip marker (`oversized` when the gate set it because the page is over
 * the operator's bytes_block). Every such page is chunked and keyword-searchable.
 */
export interface PageSizeState { embedding: 'deferred' | 'partial' | 'held' | 'skipped'; reason: string; bytes: number }

export function pageSizeState(bytes: number, frontmatter: Record<string, unknown> | null | undefined,
  budget?: { state: PageBudgetState; reason: string | null } | null, segmented = false): PageSizeState | null {
  if (isEmbedSkipped(frontmatter)) {
    return { embedding: 'skipped', reason: (frontmatter!.embed_skip as { reason?: unknown } | null)?.reason === 'oversized' ? 'oversized' : 'operator_marker', bytes };
  }
  const large = isLargePageBytes(bytes);
  if (large && budget?.state === 'held') return { embedding: 'held', reason: budget.reason ?? 'awaiting_approval', bytes };
  if (large && budget?.state === 'capped') return { embedding: 'partial', reason: 'spend_cap', bytes };
  return large || segmented ? { embedding: 'deferred', reason: 'large_page', bytes } : null;
}

/**
 * pageSizeState for stored pages of one source with a non-null state: the given slugs, or (null) every
 * such page in the source, as a full sync walked them all.
 */
export async function readPageSizeStates(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slugs: readonly string[] | null): Promise<Array<{ slug: string; source_id?: string } & PageSizeState>> {
  if (slugs?.length === 0) return [];
  const bytes = `(CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)`;
  const rows = await engine.executeRaw<{ slug: string; bytes: number; segmented: boolean; frontmatter: Record<string, unknown> | null; state: PageBudgetState | null; reason: string | null }>(
    `SELECT p.slug, ${bytes}::bigint AS bytes, p.body_storage = 'segmented' AS segmented, p.frontmatter, b.state, b.reason
       FROM pages p LEFT JOIN page_embedding_budget b ON b.page_id = p.id
      WHERE p.source_id = $1 AND p.deleted_at IS NULL${slugs ? ' AND p.slug = ANY($3::text[])' : ''}
        AND (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip' OR ${bytes} > $2 OR p.body_storage = 'segmented' OR b.page_id IS NOT NULL) ORDER BY p.slug`,
    slugs ? [sourceId, PAGE_INLINE_MAX_BYTES, [...slugs]] : [sourceId, PAGE_INLINE_MAX_BYTES]);
  return rows.flatMap(row => {
    const state = pageSizeState(Number(row.bytes), row.frontmatter, row.state ? { state: row.state, reason: row.reason } : null, row.segmented === true);
    return state ? [{ slug: row.slug, ...(state.embedding === 'held' ? { source_id: sourceId } : {}), ...state }] : [];
  });
}

/** The receipt field for one written page: `{ size_state }` for a large or embed_skip page, else nothing (no query). */
export async function sizeStateField(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string,
  page: { body_storage?: BodyStorage | null; body_bytes?: number | null; compiled_truth?: string | null; timeline?: string | null; frontmatter?: Record<string, unknown> | null } | null | undefined): Promise<{ size_state?: PageSizeState }> {
  if (!page) return {};
  const bytes = pageBodyBytes(page);
  if (!isLargePageBytes(bytes) && !isSegmentedPage(page) && !isEmbedSkipped(page.frontmatter)) return {};
  const [state] = await readPageSizeStates(engine, sourceId, [slug]);
  return state ? { size_state: { embedding: state.embedding, reason: state.reason, bytes: state.bytes } } : {};
}

/** #6722: the sync receipt's tally of pages a run left large or embed_skip: the total and the first SIZE_STATE_SAMPLE. */
export interface SyncSizeStates { total: number; pages: Array<{ slug: string; path?: string; source_id?: string } & PageSizeState> }
export const SIZE_STATE_SAMPLE = 50;

export function addSizeState(tally: SyncSizeStates | undefined, entry: { slug: string; path?: string; source_id?: string } & PageSizeState): SyncSizeStates {
  const pages = tally?.pages ?? [];
  return { total: (tally?.total ?? 0) + 1, pages: pages.length < SIZE_STATE_SAMPLE ? [...pages, entry] : pages };
}

/** One line per sampled page for the sync output, and the rest as a count. */
export function sizeStateLines(tally: SyncSizeStates | undefined): string[] {
  if (!tally?.total) return [];
  const what = (s: PageSizeState & { source_id?: string }) => s.embedding === 'skipped'
    ? `no vectors (${s.reason === 'oversized' ? 'over the content_sanity.bytes_block limit' : 'embed_skip marker'}); chunks keep it in keyword search`
    : s.embedding === 'held' ? `embedding held (${s.reason}); \`${heldPreviewCommand(s.source_id)}\` previews the cost`
    : s.embedding === 'partial' ? 'partly embedded under embed.max_usd_per_page; the rest stays keyword-only'
    : 'large page; embedding runs after the commit under embed.max_usd_per_page';
  const lines = tally.pages.slice(0, 20).map(p => `  Size ${p.path ?? p.slug} (${p.bytes} bytes): ${what(p)}.`);
  if (tally.total > lines.length) lines.push(`  ... and ${tally.total - lines.length} more large or embed_skip page(s) (--json lists the first ${tally.pages.length}).`);
  return lines;
}
