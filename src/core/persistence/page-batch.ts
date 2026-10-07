/**
 * #6007: `put_pages` — many complete-page writes in one call for remote agents.
 *
 * Each page is an ordinary `put_page` write request (same guards, fences,
 * revision checks, receipts and publication), admitted together in one
 * transaction so capacity is reserved for the whole batch or none of it.
 * A child's request_id is derived from the batch request_id and its index,
 * and its stored intent records the batch id, index and size, so a replay of
 * the same batch is idempotent and a changed batch is refused. Calling
 * `put_pages` with only `request_id` reads the batch status without resending
 * any content.
 */
import type { OperationContext } from '../ops/contract.ts';
import { fenceNormalizedNotice, mergeFencesNormalized, type FencesNormalized } from '../fence-repair/report.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { admitWriteGroupInTransaction, type WriteAdmission } from './journal.ts';
import { retryWriteAdmission } from './admission-retry.ts';
import { declareDurablePersistence } from './protocol.ts';
import { digest } from './digest.ts';
import { queueLinksReconcile } from './effect-journal.ts';
import { pageBatchChildRequestId, pageBatchChildRequestIds } from './page-batch-id.ts';

export { pageBatchChildRequestId };
import { isTerminal, type WriteRequest } from './model.ts';
import { estimatedRetryAfterMs, waitForWrites, writeResponse } from './service.ts';
import { initializeLocalPersistence, pageMutationSource, preparePageAdmission, requestPrincipalForContext, withBatchAdmission } from './page-mutations.ts';
import type { PageTypeWarning } from './page-input.ts';
import { parseWriteRequestId } from './preconditions.ts';
import { parseWireWriteWaitMs } from './write-wait.ts';

export const PAGE_BATCH_MAX_PAGES = 50;
export const PAGE_BATCH_MAX_BYTES = 8 * 1024 * 1024;
export const PAGE_BATCH_DEFAULT_WAIT_MS = 25_000;
/** Page preparation reads run this many pages at a time. */
const PREPARE_CONCURRENCY = 8;
/** Batch admission is one transaction over every page; it gets more than a single write's budget. */
const BATCH_ADMISSION_BUDGET_MS = 30_000;
const PAGE_KEYS = new Set(['slug', 'content', 'expected_revision', 'allow_empty']);
interface BatchPage { slug: string; content: string; expected_revision?: unknown; allow_empty?: unknown }
interface PageResult { index: number; slug: string; row?: WriteRequest; refusal?: OperationError; typeWarning?: PageTypeWarning | null }
interface BatchMarker { id: string; index: number; size: number }

const invalid = (message: string, suggestion: string) => new OperationError('invalid_params', message, suggestion);

function parsePages(value: unknown): BatchPage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > PAGE_BATCH_MAX_PAGES) {
    throw invalid(`pages must be an array of 1 to ${PAGE_BATCH_MAX_PAGES} pages; nothing was written.`,
      `Send at most ${PAGE_BATCH_MAX_PAGES} pages per put_pages call, each in its own call with its own request_id. To check an earlier batch, call put_pages with only its request_id.`);
  }
  const seen = new Set<string>();
  let bytes = 0;
  const pages = value.map((page, index) => {
    if (!page || typeof page !== 'object' || Array.isArray(page)) throw invalid(`pages[${index}] must be an object {slug, content}; nothing was written.`, 'Pass each page as {slug, content} with optional expected_revision and allow_empty.');
    const record = page as Record<string, unknown>;
    const extra = Object.keys(record).filter(key => !PAGE_KEYS.has(key));
    if (extra.length) throw invalid(`pages[${index}] has unsupported fields (${extra.join(', ')}); nothing was written.`, 'Each page accepts only slug, content, expected_revision and allow_empty; put frontmatter inside content.');
    if (typeof record.slug !== 'string' || !record.slug) throw invalid(`pages[${index}].slug must be a non-empty string; nothing was written.`, 'Give every page its slug, for example "notes/topic-name".');
    if (typeof record.content !== 'string') throw invalid(`pages[${index}].content must be a string; nothing was written.`, 'Pass the complete markdown page, frontmatter included, as content.');
    const key = record.slug.toLowerCase();
    if (seen.has(key)) throw invalid(`Slug ${record.slug} appears twice in this batch; nothing was written.`, 'Merge the two pages into one, or send the second one in a later put_pages call.');
    seen.add(key);
    bytes += Buffer.byteLength(record.content);
    return record as unknown as BatchPage;
  });
  if (bytes > PAGE_BATCH_MAX_BYTES) {
    throw invalid(`This batch carries ${bytes} bytes of content; the limit is ${PAGE_BATCH_MAX_BYTES} bytes per put_pages call. Nothing was written.`,
      `Split the pages across several put_pages calls of at most ${PAGE_BATCH_MAX_BYTES} bytes each, each with its own request_id.`);
  }
  return pages;
}

function markerOf(row: WriteRequest): BatchMarker | null {
  const marker = row.intent?.page_batch as Partial<BatchMarker> | undefined;
  return marker && typeof marker.index === 'number' && typeof marker.size === 'number' ? marker as BatchMarker : null;
}

async function readBatch(ctx: OperationContext, batchId: string): Promise<WriteRequest[]> {
  const principal = await requestPrincipalForContext(ctx);
  const ids = pageBatchChildRequestIds(batchId, PAGE_BATCH_MAX_PAGES);
  const rows = await ctx.engine.executeRaw<WriteRequest>(`SELECT * FROM persistence_requests
    WHERE principal_kind=$1 AND principal_id=$2 AND request_id=ANY($3::uuid[])`, [principal.kind, principal.id, ids]);
  return rows.filter(row => markerOf(row)?.id === batchId).sort((a, b) => markerOf(a)!.index - markerOf(b)!.index);
}

function pageEntry(result: PageResult): Record<string, unknown> {
  const base = { index: result.index, slug: result.slug };
  if (result.refusal) return { ...base, state: 'refused', error: result.refusal.toJSON() };
  if (!result.row) return { ...base, state: 'not_admitted' };
  const row = result.row;
  const warning = result.typeWarning ? { type_warning: result.typeWarning } : {};
  if (!isTerminal(row)) return { ...base, request_id: row.request_id, state: row.state, ...warning };
  try {
    const receipt = writeResponse(row);
    const outcome = (receipt.outcome ?? {}) as Record<string, unknown>;
    return { ...base, request_id: row.request_id, state: 'committed', revision: receipt.revision ?? outcome.revision ?? null,
      status: outcome.status, ...(typeof outcome.slug === 'string' && outcome.slug !== result.slug ? { duplicate_of: outcome.slug } : {}),
      ...(outcome.embedding_state !== undefined ? { embedding_state: outcome.embedding_state } : {}), ...warning,
      ...(outcome.fences_normalized ? { fences_normalized: outcome.fences_normalized } : {}) };
  } catch (error) {
    if (!(error instanceof OperationError)) throw error;
    return { ...base, request_id: row.request_id, state: row.state, error: error.toJSON(), ...warning };
  }
}

/**
 * Mention links of a finished batch: each page's `links` effect may have run
 * before later pages of the batch existed, so the batch re-arms them once
 * after its last page settles; the receipt reports their combined state.
 */
async function batchLinks(ctx: OperationContext, sourceId: string, results: PageResult[]): Promise<Record<string, unknown>> {
  const rows = results.flatMap(result => result.row ? [result.row] : []);
  const committed = rows.filter(row => row.state === 'committed').map(row => row.id);
  if (committed.length > 1 && rows.every(isTerminal)) await queueLinksReconcile(ctx.engine, { sourceId, requestIds: committed });
  const effects = committed.length ? await ctx.engine.executeRaw<{ state: string; outcome: Record<string, unknown> | null }>(
    "SELECT state,outcome FROM persistence_effects WHERE kind='links' AND request_id=ANY($1::uuid[])", [committed]) : [];
  if (!effects.length && ctx.remote === false) return { state: 'inline', why: 'Trusted local writes build their links during publication.' };
  if (!effects.length) return { state: 'off', why: 'No mention-link pass was queued: links are built only for remote writes while auto_link and mcp.remote_auto_links are on. Add links with add_link if you need them.' };
  const done = effects.filter(effect => effect.state === 'committed');
  return { state: done.length === effects.length ? 'committed' : 'queued', pages: effects.length,
    added: done.reduce((sum, effect) => sum + (Number(effect.outcome?.added) || 0), 0),
    ...(done.length < effects.length ? { why: 'Mention links from [[wikilinks]] to existing pages are built after commit; read this batch again with put_pages {request_id} to see them settle. Do not add them by hand.' } : {}) };
}

function batchReceipt(ctx: OperationContext, batchId: string, sourceId: string, results: PageResult[], links: Record<string, unknown>): Record<string, unknown> {
  const pages = results.map(pageEntry);
  const committed = pages.filter(page => page.state === 'committed').length;
  const pending = pages.filter(page => ['queued', 'running', 'recovering'].includes(String(page.state))).length;
  const failed = pages.length - committed - pending;
  const state = pending ? 'pending' : !failed ? 'committed' : committed ? 'partial' : 'failed';
  const retryAfterMs = pending ? estimatedRetryAfterMs(ctx.engine, pending) ?? 1000 : null;
  const next = pending
    ? { action: 'poll', after_ms: retryAfterMs, call: { tool: 'put_pages', arguments: { request_id: batchId, source_id: sourceId, wait_ms: PAGE_BATCH_DEFAULT_WAIT_MS } },
      why: `${pending} page(s) are accepted and still publishing. Call put_pages with only this request_id (do not resend the pages) to wait for them.` }
    : failed
      ? { action: 'fix_pages', why: `${failed} page(s) did not commit. Each carries its own error with what to change. Resubmit only those pages, corrected, in a new put_pages call with a new request_id; committed pages are done.` }
      : { action: 'done' };
  // #6188 (D12, D21): one `fences_normalized` and one coaching notice for every page whose fence Tier 1 rewrote.
  const fences = mergeFencesNormalized(pages.flatMap(page => page.fences_normalized ? [page.fences_normalized as FencesNormalized] : []));
  if (fences) ctx.emitNotice?.(fenceNormalizedNotice(fences));
  return { batch_request_id: batchId, source_id: sourceId, state, terminal: pending === 0, counts: { total: pages.length, committed, pending, failed },
    ...(retryAfterMs !== null ? { retry_after_ms: retryAfterMs } : {}), next, links, pages, ...(fences ? { fences_normalized: fences } : {}) };
}

/**
 * Every new page of the batch in ONE transaction, so capacity is reserved for
 * all of them or none. Pages whose stored authority differs (for example one
 * page is database-only) are admitted as separate groups inside it.
 */
async function admitBatch(ctx: OperationContext, batchId: string, admissions: WriteAdmission[]): Promise<WriteRequest[]> {
  const groups = new Map<string, number[]>();
  admissions.forEach((admission, index) => {
    const key = digest(admission.authority);
    groups.set(key, [...(groups.get(key) ?? []), index]);
  });
  return retryWriteAdmission(`batch ${batchId}`, remaining => ctx.engine.transaction(async tx => {
    await declareDurablePersistence(tx, `${Math.min(1000, remaining)}ms`, `${remaining}ms`);
    const rows: WriteRequest[] = new Array(admissions.length);
    for (const indexes of groups.values()) {
      const admitted = await admitWriteGroupInTransaction(tx, indexes.map(index => admissions[index]!));
      indexes.forEach((index, position) => { rows[index] = admitted[position]!; });
    }
    return rows;
  }), BATCH_ADMISSION_BUDGET_MS);
}

async function prepareAll(caller: OperationContext, batchId: string, sourceId: string, pages: BatchPage[]) {
  // #6007 (workstream A): one writer verification and one shared-read snapshot per batch (page-mutations.ts withBatchAdmission).
  return withBatchAdmission(caller, (own, shared) => preparePages(own, shared, batchId, sourceId, pages));
}
async function preparePages(own: OperationContext, shared: OperationContext, batchId: string, sourceId: string, pages: BatchPage[]) {
  const prepared: (Awaited<ReturnType<typeof preparePageAdmission>> | OperationError)[] = new Array(pages.length);
  const prepareOne = async (index: number) => {
    const ctx = index === 0 ? own : shared;
    const page = pages[index]!;
    const params: Record<string, unknown> = { slug: page.slug, content: page.content, source_id: sourceId };
    if (page.expected_revision !== undefined) params.expected_revision = page.expected_revision;
    if (page.allow_empty !== undefined) params.allow_empty = page.allow_empty;
    try {
      prepared[index] = await preparePageAdmission(ctx, { operation: 'put_page', params,
        batch: { id: batchId, index, size: pages.length, requestId: pageBatchChildRequestId(batchId, index) } });
    } catch (error) {
      if (!(error instanceof OperationError)) throw error;
      prepared[index] = error;
    }
  };
  // The first page may bind the source's worktree; the rest only read.
  await prepareOne(0);
  let next = 1;
  await Promise.all(Array.from({ length: Math.min(PREPARE_CONCURRENCY, pages.length - 1) }, async () => {
    while (next < pages.length) await prepareOne(next++);
  }));
  return prepared;
}

export async function submitPageBatch(ctx: OperationContext, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const arrived = performance.now();
  const waitMs = parseWireWriteWaitMs(params.wait_ms) ?? PAGE_BATCH_DEFAULT_WAIT_MS;
  const remaining = () => Math.max(0, waitMs - (performance.now() - arrived));
  const batchId = parseWriteRequestId(params.request_id);
  if (!batchId) {
    throw invalid('put_pages requires request_id; nothing was written.',
      'Generate one UUID for this batch, pass it as request_id, and keep it: replaying the same call with it never writes twice, and put_pages with only that request_id reports progress.');
  }
  const sourceId = pageMutationSource(ctx, params, 'put_pages');
  await initializeLocalPersistence(ctx);
  if (params.pages === undefined) {
    const rows = await readBatch(ctx, batchId);
    if (!rows.length) {
      throw opError('not_found', 'No accessible put_pages batch has that request_id.',
        'Check the request_id. A batch whose every page was refused before admission has no receipt: resubmit its pages.');
    }
    const settled = await waitForWrites(ctx.engine, rows, ctx.config, remaining());
    const size = markerOf(rows[0]!)!.size;
    const byIndex = new Map(settled.map(row => [markerOf(row)!.index, row]));
    const results: PageResult[] = Array.from({ length: size }, (_, index) => {
      const row = byIndex.get(index);
      return { index, slug: row?.slug ?? '', ...(row ? { row } : {}) };
    });
    return batchReceipt(ctx, batchId, sourceId, results, await batchLinks(ctx, sourceId, results));
  }
  const pages = parsePages(params.pages);
  const existing = await readBatch(ctx, batchId);
  const resized = existing.find(row => markerOf(row)!.size !== pages.length);
  if (resized) {
    throw opError('idempotency_conflict', `Batch ${batchId} was first submitted with ${markerOf(resized)!.size} pages; this call has ${pages.length}. Nothing new was admitted.`,
      `To check the original batch, call put_pages with only request_id ${batchId}. To write a different set of pages, use a new request_id.`);
  }
  const prepared = await prepareAll(ctx, batchId, sourceId, pages);
  // A grant that may not write here refuses every page alike: answer the call with that one error.
  const first = prepared[0];
  if (first instanceof OperationError && first.code === 'permission_denied'
    && prepared.every(entry => entry instanceof OperationError && entry.code === first.code && entry.message === first.message)) throw first;
  const conflicts = prepared.flatMap((entry, index) => entry instanceof OperationError && entry.code === 'idempotency_conflict' ? [pages[index]!.slug] : []);
  if (conflicts.length) {
    throw opError('idempotency_conflict', `Batch ${batchId} was already accepted with different content for ${conflicts.join(', ')}. Nothing new was admitted.`,
      `Replays must repeat the batch exactly (same pages, same order). To check the original batch, call put_pages with only request_id ${batchId}; to write the changed pages, send them in a new put_pages call with a new request_id.`);
  }
  const results: PageResult[] = pages.map((page, index) => ({ index, slug: page.slug }));
  const admissions: { index: number; admission: WriteAdmission }[] = [];
  const rows: WriteRequest[] = [];
  prepared.forEach((entry, index) => {
    if (entry instanceof OperationError) results[index]!.refusal = entry;
    else if (entry.prior) results[index]!.row = entry.prior;
    else { admissions.push({ index, admission: entry.admission }); results[index]!.typeWarning = entry.typeWarning; }
  });
  if (admissions.length) {
    let admitted: WriteRequest[];
    try {
      admitted = await admitBatch(ctx, batchId, admissions.map(entry => entry.admission));
    } catch (error) {
      if (error instanceof OperationError && error.code === 'queue_capacity') {
        throw new OperationError('queue_capacity', `${error.message} No page of batch ${batchId} was admitted (it needs ${admissions.length} new write slots).`,
          `Wait for this connection's pending writes to finish, or send fewer pages per call; then retry the same put_pages call with the same request_id ${batchId}.`);
      }
      throw error;
    }
    admissions.forEach((entry, position) => { results[entry.index]!.row = admitted[position]!; });
  }
  const journaled = results.filter(result => result.row);
  const settled = await waitForWrites(ctx.engine, journaled.map(result => result.row!), ctx.config, remaining());
  journaled.forEach((result, position) => { result.row = settled[position]!; });
  return batchReceipt(ctx, batchId, sourceId, results, await batchLinks(ctx, sourceId, results));
}

