/**
 * The Wave A oversized-page backfill (`gbrain reindex --oversized`, and a
 * time-boxed pass in `gbrain post-upgrade`).
 *
 * Before the 24 MiB page ceiling, the import gate stored any page over
 * `content_sanity.bytes_block` (500 KB) with a gate-written
 * `embed_skip: { reason: oversized }` marker and zero chunks, so it was
 * invisible to keyword and vector search. Removing the marker alone does not
 * help: import returns early on an unchanged content hash, so the page would
 * stay chunkless. This backfill rewrites each such page through the normal
 * write path (the canonical owner on a managed brain, exactly like
 * `gbrain quarantine clear`) with the marker and its `content_flag: oversized`
 * removed and a forced re-chunk. That is CPU-only and runs with embeddings
 * disabled: chunks land with NULL vectors and become keyword-searchable at
 * once; the embedding sweep fills vectors later.
 *
 * Limits are preserved: a page still above the effective `bytes_block`
 * (env `GBRAIN_PAGE_BLOCK_BYTES`, file or DB `content_sanity.bytes_block`)
 * keeps its marker and gets no vectors, and only the gate-written marker shape
 * (`reason: oversized`) is touched. A chunkless one is still re-chunked with
 * the marker kept (#6722), so every page up to the ceiling is keyword-searchable. A large page (over `pages.inline_max_bytes`) is held in
 * `page_embedding_budget` before its rewrite, so no paid embedding starts
 * until the user approves the previewed cost (`gbrain embed --held --source S --max-usd N`).
 *
 * Idempotent and resumable: the work list is recomputed from the markers on
 * every run, so a page done is never redone and an interrupted run continues.
 */
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from './engine.ts';
import { EMBED_SKIP_KEY } from './embed-skip.ts';
import { CONTENT_FLAG_KEY } from './quarantine.ts';
import { serializeMarkdown } from './markdown.ts';
import { importFromContent } from './import-file.ts';
import { loadConfig } from './config.ts';
import type { OperationContext } from './ops/contract.ts';
import { managedPersistenceEnabled } from './persistence/ownership.ts';
import { submitPageMutation } from './persistence/page-mutations.ts';
import { resolveCliWriteWaitMs } from './persistence/write-wait.ts';
import { effectiveBytesBlock } from './import-screen.ts';
import { PAGE_MAX_BYTES, isLargePageBytes } from './page-size-policy.ts';
import { estimatePageEmbedUsd, holdPageEmbedding } from './page-embedding-budget.ts';
import { currentEmbeddingSignature } from './embedding.ts';
import { budgetLimitedReport } from './held-embedding.ts';
import type { PageType } from './types.ts';
import { materializedSnapshot } from './persistence/segmented-apply.ts';

/** The `page_embedding_budget.reason` a backfilled large page waits under. */
export const BACKFILL_HOLD_REASON = 'upgrade_backfill';

const OVERSIZED_MARKER_SQL = `p.deleted_at IS NULL AND p.frontmatter->'${EMBED_SKIP_KEY}'->>'reason' = 'oversized'`;
/** A segmented page (Wave B) has no body columns: its size is `body_bytes`. */
const PAGE_BYTES_SQL = `(CASE WHEN p.body_storage = 'segmented' THEN p.body_bytes ELSE octet_length(p.compiled_truth) + octet_length(COALESCE(p.timeline, '')) END)`;
/** Under the block (marker removed), or over it, under the ceiling and chunkless (re-chunked, marker kept). $1 is the block. */
const CANDIDATE_SQL = `(${PAGE_BYTES_SQL} <= $1 OR (${PAGE_BYTES_SQL} <= ${PAGE_MAX_BYTES} AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)))`;

export interface OversizedBackfillReceipt {
  dry_run: boolean;
  /** The bytes_block in effect: pages at or under it (and the ceiling) are re-indexed. */
  block_bytes: number;
  /** Size-skipped pages under the block when the run started. */
  candidates: number;
  reindexed: number;
  /** Large pages whose embedding waits for approval. */
  held_for_approval: number;
  failed: Array<{ slug: string; source_id: string; error: string }>;
  /** Candidates this run did not reach (limit or time budget); the same command continues. */
  remaining: number;
  /** Size-skipped pages still over the block: they keep the marker and get no vectors. */
  over_block: number;
  /** Chunkless pages over the block this run re-chunked for keyword search, marker kept (#6722). */
  rechunked_over_block: number;
  chunks_pending_embedding: number;
  /** null when embeddings are off on this brain. */
  estimated_usd: number | null;
  embedding_enabled: boolean;
  /** Exact commands: finish the backfill; preview held embedding; approve it for the source with the most waiting chunks (null until a run holds pages). */
  commands: { finish: string[]; approve: string[] | null; preview: string[] };
  /** Every source's approve command (a concrete --max-usd ceiling), one approval per source (#6803). */
  approvals: string[];
}

interface Candidate { id: number; slug: string; source_id: string; bytes: number }

async function listCandidates(engine: BrainEngine, block: number, opts: { sourceId?: string; afterId: number; limit: number }): Promise<Candidate[]> {
  const params: unknown[] = [block, opts.afterId, opts.limit];
  const source = opts.sourceId ? ` AND p.source_id = $${params.push(opts.sourceId)}` : '';
  const rows = await engine.executeRaw<Candidate>(`SELECT p.id, p.slug, p.source_id, ${PAGE_BYTES_SQL}::bigint AS bytes FROM pages p
    WHERE ${OVERSIZED_MARKER_SQL} AND ${CANDIDATE_SQL} AND p.id > $2${source} ORDER BY p.id LIMIT $3`, params);
  return rows.map(row => ({ ...row, id: Number(row.id), bytes: Number(row.bytes) }));
}

async function countMarked(engine: BrainEngine, block: number, sourceId: string | undefined): Promise<{ candidates: number; over: number }> {
  const params: unknown[] = [block];
  const source = sourceId ? ` AND p.source_id = $${params.push(sourceId)}` : '';
  const [row] = await engine.executeRaw<{ candidates: number; over: number }>(`SELECT
      COUNT(*) FILTER (WHERE ${CANDIDATE_SQL})::int AS candidates, COUNT(*) FILTER (WHERE ${PAGE_BYTES_SQL} > $1)::int AS over
    FROM pages p WHERE ${OVERSIZED_MARKER_SQL}${source}`, params);
  return { candidates: Number(row?.candidates ?? 0), over: Number(row?.over ?? 0) };
}

/** Rewrite one page re-chunked with no embedding: without its size-gate markers under the block, with them kept over it. */
async function reindexPage(engine: BrainEngine, page: Candidate, managed: boolean, overBlock: boolean): Promise<void> {
  // Every candidate is within the single-string ceiling, so a segmented body is read back whole and rewritten through the segmented write path.
  const snapshot = await materializedSnapshot(engine, await engine.readPageSnapshot(page.slug, { sourceId: page.source_id }));
  if (!snapshot || snapshot.page.id !== page.id) return;
  const fm = { ...((snapshot.page.frontmatter ?? {}) as Record<string, unknown>) };
  if ((fm[EMBED_SKIP_KEY] as { reason?: unknown } | undefined)?.reason !== 'oversized') return;
  if (!overBlock) {
    delete fm[EMBED_SKIP_KEY];
    if ((fm[CONTENT_FLAG_KEY] as { reason?: unknown } | undefined)?.reason === 'oversized') delete fm[CONTENT_FLAG_KEY];
    if (isLargePageBytes(page.bytes)) await holdPageEmbedding(engine, page.id, BACKFILL_HOLD_REASON);
  }
  const markdown = serializeMarkdown(fm, snapshot.page.compiled_truth ?? '', snapshot.page.timeline ?? '', {
    type: (snapshot.page.type as PageType) ?? 'note', title: snapshot.page.title ?? '', tags: snapshot.tags,
  });
  if (!managed) {
    await importFromContent(engine, page.slug, markdown, { sourceId: page.source_id, noEmbed: true, forceRechunk: true, preserveGateMarkers: true });
    return;
  }
  const config = loadConfig() ?? { engine: engine.kind };
  const ctx = { engine, config, remote: false, dryRun: false, sourceId: page.source_id, writeWaitMs: resolveCliWriteWaitMs({ config }),
    logger: { info: () => {}, warn: (m: string) => console.error(m), error: (m: string) => console.error(m) } } as unknown as OperationContext;
  await submitPageMutation(ctx, { operation: 'put_page', managedFileImport: true, params: { slug: page.slug, source_id: page.source_id, content: markdown,
    kind: 'managed_quarantine_clear', expected_revision: snapshot.revision, request_id: randomUUID() } });
}

export async function runOversizedBackfill(engine: BrainEngine, opts: {
  dryRun?: boolean; sourceId?: string; limit?: number; deadlineMs?: number; now?: () => number;
  onPage?: (page: { slug: string; source_id: string; bytes: number }) => void;
} = {}): Promise<OversizedBackfillReceipt> {
  const now = opts.now ?? Date.now;
  const started = now();
  const block = await effectiveBytesBlock(engine);
  const before = await countMarked(engine, block, opts.sourceId);
  const embeddingEnabled = loadConfig()?.embedding_disabled !== true;
  const scope = opts.sourceId ? ['--source', opts.sourceId] : [];
  const receipt: OversizedBackfillReceipt = {
    dry_run: opts.dryRun === true, block_bytes: block, candidates: before.candidates, reindexed: 0, held_for_approval: 0, failed: [],
    remaining: before.candidates, over_block: before.over, rechunked_over_block: 0, chunks_pending_embedding: 0, estimated_usd: null, embedding_enabled: embeddingEnabled,
    commands: { finish: ['gbrain', 'reindex', '--oversized', ...scope], approve: null,
      preview: ['gbrain', 'embed', '--held', ...scope, '--dry-run'] }, approvals: [],
  };
  const managed = !receipt.dry_run && await managedPersistenceEnabled(engine);
  const touched: number[] = [];
  let pendingChars = 0;
  let afterId = 0;
  let attempted = 0;
  while (opts.limit === undefined || attempted < opts.limit) {
    const batch = await listCandidates(engine, block, { sourceId: opts.sourceId, afterId, limit: Math.min(100, (opts.limit ?? Infinity) - attempted) });
    if (batch.length === 0) break;
    for (const page of batch) {
      if (attempted > 0 && opts.deadlineMs !== undefined && now() - started >= opts.deadlineMs) break;
      afterId = page.id;
      attempted++;
      opts.onPage?.(page);
      const overBlock = page.bytes > block;
      if (receipt.dry_run) {
        if (overBlock) { receipt.rechunked_over_block++; continue; }
        if (isLargePageBytes(page.bytes)) receipt.held_for_approval++;
        pendingChars += page.bytes;
        continue;
      }
      try {
        await reindexPage(engine, page, managed, overBlock);
        receipt.reindexed++;
        if (overBlock) { receipt.rechunked_over_block++; continue; }
        touched.push(page.id);
        if (isLargePageBytes(page.bytes)) receipt.held_for_approval++;
      } catch (error) {
        receipt.failed.push({ slug: page.slug, source_id: page.source_id, error: (error instanceof Error ? error.message : String(error)).split('\n')[0].slice(0, 300) });
      }
    }
    if (opts.deadlineMs !== undefined && now() - started >= opts.deadlineMs) break;
  }
  if (touched.length) {
    const [pending] = await engine.executeRaw<{ chunks: number; chars: number }>(`SELECT COUNT(*)::int AS chunks, COALESCE(SUM(length(chunk_text)), 0)::bigint AS chars
      FROM content_chunks WHERE page_id = ANY($1::int[]) AND embedded_at IS NULL`, [touched]);
    receipt.chunks_pending_embedding = Number(pending?.chunks ?? 0);
    pendingChars = Number(pending?.chars ?? 0);
  }
  receipt.remaining = receipt.dry_run ? before.candidates : (await countMarked(engine, block, opts.sourceId)).candidates;
  if (embeddingEnabled) receipt.estimated_usd = estimatePageEmbedUsd(pendingChars, currentEmbeddingSignature());
  const found = embeddingEnabled && receipt.held_for_approval && !receipt.dry_run
    ? await budgetLimitedReport(engine, { ...(opts.sourceId ? { sourceId: opts.sourceId } : {}), signature: currentEmbeddingSignature() }) : null;
  if (found) {
    receipt.commands.approve = found.report.by_source[0]!.fix.argv!;
    receipt.approvals = found.report.by_source.map(s => s.fix.command!);
  }
  return receipt;
}

/** Human lines for a receipt (stdout of `gbrain reindex --oversized` and post-upgrade). */
export function formatOversizedBackfillReceipt(r: OversizedBackfillReceipt): string[] {
  const lines = [`[reindex --oversized] ${r.dry_run ? 'Would re-index' : 'Re-indexed'} ${r.dry_run ? r.candidates : r.reindexed} size-skipped page(s)`
    + `${r.dry_run ? '' : `; ${r.chunks_pending_embedding} chunk(s) are keyword-searchable now and wait for embedding`}.`];
  if (r.failed.length) lines.push(`  ${r.failed.length} page(s) failed (first: ${r.failed[0].source_id}/${r.failed[0].slug}: ${r.failed[0].error}); rerun: ${r.commands.finish.join(' ')}`);
  if (!r.dry_run && r.remaining > r.failed.length) lines.push(`  ${r.remaining} page(s) remain; continue with: ${r.commands.finish.join(' ')}`);
  if (r.over_block) lines.push(`  ${r.over_block} page(s) get no vectors: they are over content_sanity.bytes_block (${r.block_bytes} bytes)`
    + `${r.rechunked_over_block ? `; ${r.rechunked_over_block} of them ${r.dry_run ? 'would be' : 'were'} re-chunked for keyword search` : ''}. Chunks keep them in keyword search.`);
  if (!r.embedding_enabled) lines.push('  Embeddings are off on this brain, so keyword search is the whole result; nothing is spent.');
  else if (r.held_for_approval) {
    lines.push(`  ${r.held_for_approval} large page(s) wait for approval before embedding (about $${(r.estimated_usd ?? 0).toFixed(2)} in total). `
      + `Preview: ${r.commands.preview.join(' ')}${r.approvals.length ? `; with the user's agreement, approve one source at a time: ${r.approvals.join('; ')}` : ''}`);
  } else if (r.estimated_usd !== null && r.chunks_pending_embedding) {
    lines.push(`  The embedding sweep embeds them under the existing caps (about $${r.estimated_usd.toFixed(2)}).`);
  }
  return lines;
}

/**
 * `gbrain post-upgrade`: a two-minute backfill pass, then the receipt. When
 * large pages wait for paid embedding, an [AGENT] block asks the user with the
 * previewed cost before anything is spent. Best-effort: never blocks upgrade.
 */
export async function printOversizedBackfillUpgradeNotice(engine: BrainEngine): Promise<void> {
  try {
    const block = await effectiveBytesBlock(engine);
    if ((await countMarked(engine, block, undefined)).candidates === 0) return;
    const receipt = await runOversizedBackfill(engine, { deadlineMs: 120_000 });
    const lines = ['', ...formatOversizedBackfillReceipt(receipt)];
    if (receipt.embedding_enabled && receipt.held_for_approval > 0) {
      const { agentBlock } = await import('./agent-markers.ts');
      lines.push(...agentBlock({
        ask: `Embed the ${receipt.held_for_approval} large page(s) that are searchable by keyword now?`,
        why: 'Pages an older gbrain skipped for size are re-indexed and keyword-searchable. Embedding them adds semantic search and calls the paid embedding provider.',
        risk: `About $${(receipt.estimated_usd ?? 0).toFixed(2)} in total; each page is capped by embed.max_usd_per_page and the run by --max-usd (the lowest cap wins).`,
        consent: 'paid, egress',
        actor: 'user',
        next: 'ask_user',
        if_yes: `Preview: ${receipt.commands.preview.join(' ')}. Then, one source at a time, run ${receipt.approvals.join('; ') || 'the approve command the preview prints'}.`,
        if_no: 'Nothing to do: the pages stay keyword-searchable and doctor lists them under partial_embedding.',
        verify: 'gbrain doctor --only partial_embedding --json',
      }, {
        showUser: `${receipt.held_for_approval} large page(s) that older gbrain skipped are searchable by keyword now. `
          + `Embedding them for semantic search costs about $${(receipt.estimated_usd ?? 0).toFixed(2)}. Embed them?`,
      }).trimEnd().split('\n'));
    }
    for (const line of lines) console.log(line);
  } catch (error) {
    console.error(`[gbrain] The oversized-page backfill did not finish (${error instanceof Error ? error.message.split('\n')[0] : String(error)}); run gbrain reindex --oversized.`);
  }
}
