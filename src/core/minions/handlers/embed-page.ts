/**
 * `embed-page` minion handler (Wave C 1F, spec §6.2): one bounded slice of
 * one segmented page's embedding.
 *
 * Every segmented page's background embedding runs as this job kind: the
 * embed-backfill job and an `embed` job (one target page, or several without
 * an approval) hand each segmented page here (submitEmbedPageJob) instead of slicing its rows by page_id and
 * chunk_index. A slice embeds at most EMBED_PAGE_SLICE_BATCHES batches (10,000
 * chunks) or runs EMBED_PAGE_SLICE_MS (10 minutes), whichever comes first, in
 * the page's one embedding order (newest first for conversations, document
 * order otherwise), then queues its own continuation; the cursor and counts
 * live on page_embedding_progress, so a killed worker resumes where the last
 * batch landed. Each batch takes the page's embedding lease only for itself,
 * so an append's embed effect waits at most one batch. Spend goes through the
 * per-page cap and the 24-hour source ledger (embedding-ledger.ts); an
 * approval (`approvedCapUsd`, from `gbrain embed <slug> --max-usd N` or
 * `--held --background`) carries the embed job's identity (`approvalId`), so
 * the page's cap rises once however often the job or this slice is retried or
 * reclaimed, and continuations carry none. Every slice and continuation queues
 * under the spend authorization of the command that started it, so the
 * command's `--max-usd` ceiling meters all of them as one group.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../engine.ts';
import type { MinionJobContext } from '../types.ts';
import type { SpendAuthorization } from '../spend-record.ts';
import { UnrecoverableError } from '../errors.ts';
import { embedBackfillWorkerSurface } from '../embed-backfill-admission.ts';
import { keylessEmbedBackfill } from '../../embed-backfill-submit.ts';
import { currentEmbeddingSignature } from '../../embedding.ts';
import { resolveProvenanceStamp, stampIfPageProvenanceComplete } from '../../embed-stale.ts';
import { pageEmbeddingLeaseUnavailable } from '../../page-embedding-lease.ts';
import {
  EMBED_PAGE_SLICE_BATCHES, EMBED_PAGE_SLICE_MS, embedSegmentedPage, readSegmentedEmbedPage, segmentedProviderEmbed, type SegmentedEmbedFn,
} from '../../page-body/segmented-embedding.ts';

export const EMBED_PAGE_JOB_NAME = 'embed-page';

export interface EmbedPageResult {
  status: 'complete' | 'continued' | 'capped' | 'source_capped' | 'uncertain' | 'page_moved' | 'skipped';
  pageId: number;
  embedded: number;
  reason?: string;
  next_job_id?: number | null;
}

/**
 * Queue one slice of `page`'s embedding, under `spendAuthorization` when the producing command has one. Null without a
 * resident worker (PGLite runs segmented pages inline). An automatic submission coalesces per page per 10 minutes, a
 * continuation per predecessor, an approval per approval identity (a re-run of its embed job queues no second slice).
 */
export async function submitEmbedPageJob(engine: BrainEngine, page: { id: number; source_id: string },
  opts: { reason: string; approvedCapUsd?: number; approvalId?: string; continuationOf?: number; spendAuthorization?: SpendAuthorization }): Promise<number | null> {
  if (embedBackfillWorkerSurface(engine).status !== 'worker_backed') return null;
  const { MinionQueue } = await import('../queue.ts');
  const approvalId = opts.approvedCapUsd !== undefined ? opts.approvalId ?? randomUUID() : undefined;
  const key = opts.continuationOf !== undefined ? `embed-page:${page.id}:after:${opts.continuationOf}`
    : approvalId !== undefined ? `embed-page:${page.id}:approved:${approvalId}`
    : `embed-page:${page.id}:${Math.floor(Date.now() / 600_000)}`;
  const job = await new MinionQueue(engine).add(EMBED_PAGE_JOB_NAME, {
    pageId: page.id, sourceId: page.source_id, reason: opts.reason,
    ...(approvalId !== undefined ? { approvedCapUsd: opts.approvedCapUsd, approvalId } : {}),
    ...(opts.continuationOf !== undefined ? { continuation_of: opts.continuationOf } : {}),
  }, { idempotency_key: key, priority: 5 }, opts.spendAuthorization ? { spendAuthorization: opts.spendAuthorization } : undefined);
  return job.id;
}

export function makeEmbedPageHandler(engine: BrainEngine, deps: { embedFn?: SegmentedEmbedFn } = {}) {
  return async function embedPageHandler(job: MinionJobContext): Promise<EmbedPageResult> {
    const pageId = Number(job.data.pageId);
    if (!Number.isSafeInteger(pageId) || pageId <= 0) throw new UnrecoverableError('embed-page: data.pageId is required and must be a positive integer');
    if (await keylessEmbedBackfill(engine)) return { status: 'skipped', reason: 'embedding_disabled', pageId, embedded: 0 };
    const page = await readSegmentedEmbedPage(engine, { id: pageId });
    if (!page) return { status: 'skipped', reason: 'not_segmented', pageId, embedded: 0 };
    const [marker] = await engine.executeRaw<{ skip: boolean }>("SELECT COALESCE(frontmatter, '{}'::jsonb) ? 'embed_skip' AS skip FROM pages WHERE id = $1", [pageId]);
    if (marker?.skip) return { status: 'skipped', reason: 'embed_skip', pageId, embedded: 0 };
    const approvedCapUsd = typeof job.data.approvedCapUsd === 'number' && job.data.approvedCapUsd >= 0 ? job.data.approvedCapUsd : undefined;
    const approvalId = approvedCapUsd === undefined ? undefined : typeof job.data.approvalId === 'string' ? job.data.approvalId : `embed-page-job:${job.id}`;
    const signature = currentEmbeddingSignature() ?? undefined;
    const result = await embedSegmentedPage(engine, page, { embedFn: deps.embedFn ?? segmentedProviderEmbed, signal: job.signal, signature, approvedCapUsd, approvalId,
      maxBatches: EMBED_PAGE_SLICE_BATCHES, deadline: Math.min(Date.now() + EMBED_PAGE_SLICE_MS, job.deadlineAtMs ?? Infinity) });
    await job.updateProgress({ embedded: result.embedded, stopped: result.stopped ?? null }).catch(() => undefined);
    if (result.complete) {
      const stamp = await resolveProvenanceStamp(engine, signature);
      if (stamp) await stampIfPageProvenanceComplete(engine, page.slug, page.source_id, stamp);
      return { status: 'complete', pageId, embedded: result.embedded };
    }
    if (result.stopped === 'busy') throw pageEmbeddingLeaseUnavailable(pageId, false);
    if (result.stopped === 'slice') {
      const next = await submitEmbedPageJob(engine, page, { reason: 'continuation', continuationOf: job.id, spendAuthorization: job.spend?.record });
      return { status: 'continued', pageId, embedded: result.embedded, next_job_id: next };
    }
    return { status: result.stopped === 'budget' ? 'capped' : result.stopped!, pageId, embedded: result.embedded };
  };
}
