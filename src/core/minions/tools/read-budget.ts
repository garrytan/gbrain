/**
 * #6297: a per-job byte budget on a subagent's `get_page` results. Each turn
 * of a CLI-backed model replays the whole transcript, and a dream patterns
 * child that read every existing pattern page in full filled half the model
 * window. Bytes already returned are counted from the job's own
 * tool-execution ledger (so a crash replay keeps its spent budget); a read
 * that would pass the budget comes back as a short summary instead.
 *
 * Sizes are the bytes of the returned result, never a page body read here, so
 * a segmented page (no body string) is sized like any other read; the summary
 * names the body size the result carries: `size.body_bytes`, or a segmented
 * page's read-view `size.total_bytes` for a remote caller, who is never told
 * the stored size (as an inline page reports its privacy-stripped body). The excerpt
 * is a bounded prefix of the rendered `content` (or a window's `text`) the
 * result already holds.
 */
import type { BrainEngine } from '../../engine.ts';
import { boundedRawPrefix } from '../../page-window/bounded-lead.ts';

/** UTF-8 bytes of rendered text a summary keeps, at most (less when the budget has less left). */
export const READ_BUDGET_EXCERPT_BYTES = 400;

/** Bytes of `get_page` output this job has already been given. */
async function spentReadBytes(engine: BrainEngine, jobId: number): Promise<number> {
  const [row] = await engine.executeRaw<{ used: number | string | null }>(
    `SELECT COALESCE(sum(octet_length(output::text)), 0) AS used FROM subagent_tool_executions
      WHERE job_id = $1 AND tool_name = 'brain_get_page' AND status = 'complete'`, [jobId]);
  return Number(row?.used ?? 0);
}

/** The read as returned when it fits the budget, else a summary naming the page, the budget and what to do next. */
export async function budgetedPageRead(engine: BrainEngine, jobId: number, budgetBytes: number, slug: unknown, output: unknown): Promise<unknown> {
  const used = await spentReadBytes(engine, jobId);
  const pageBytes = Buffer.byteLength(JSON.stringify(output) ?? '', 'utf8');
  if (used + pageBytes <= budgetBytes) return output;
  const page = (output && typeof output === 'object' ? output : {}) as Record<string, unknown>;
  const rendered = typeof page.content === 'string' ? page.content : typeof page.text === 'string' ? page.text : '';
  const excerpt = boundedRawPrefix(rendered, Math.max(0, Math.min(READ_BUDGET_EXCERPT_BYTES, budgetBytes - used)));
  const size = page.size as { body_bytes?: unknown; total_bytes?: unknown } | undefined;
  const bodyBytes = size?.body_bytes ?? size?.total_bytes;
  return {
    slug: typeof page.slug === 'string' ? page.slug : slug,
    ...(typeof page.title === 'string' ? { title: page.title } : {}),
    ...(typeof page.type === 'string' ? { type: page.type } : {}),
    ...(typeof page.revision === 'string' ? { revision: page.revision } : {}),
    truncated: true,
    code: 'read_budget_exhausted',
    read_budget: { limit_bytes: budgetBytes, used_bytes: used, page_bytes: pageBytes, ...(typeof bodyBytes === 'number' ? { body_bytes: bodyBytes } : {}) },
    ...(excerpt ? { excerpt } : {}),
    note: 'This job has used its get_page read budget, so the page is summarized. Work from the pages already read; writes still work. To update this page, append with add_timeline_entry instead of rewriting it, or skip it when it already covers what you would add.',
  };
}
