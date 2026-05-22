/**
 * subagent_aggregator handler (v0.15).
 *
 * This is the job that CLAIMS after all subagent children resolve and
 * produces the final aggregated output. Not a polling parent — Lane 1B's
 * queue changes make every terminal child transition (complete/failed/
 * dead/cancelled/timeout) emit a child_done message into this job's
 * inbox, AND flip this job out of waiting-children once all kids are
 * terminal. When we claim, all N child_done messages are already in
 * minion_inbox.
 *
 * The aggregator does NOT re-call Anthropic in v0.15. It reads child
 * results from child_done messages, builds a markdown summary, and
 * returns it as the handler result. If children produced brain pages
 * under wiki/agents/<child_id>/..., those are referenced by slug — not
 * re-embedded into the summary blob.
 *
 * v0.16+ will add an LLM synthesis pass for richer summaries. The v0.15
 * output is deterministic string concatenation so fan-out runs stay
 * reproducible.
 */

import type { MinionJobContext, ChildDoneMessage, ChildOutcome } from '../types.ts';
import type { AggregatorHandlerData } from '../types.ts';

export interface AggregatorResult {
  /** Per-child record in the order children_ids was supplied. */
  children: Array<{
    child_id: number;
    job_name: string;
    outcome: ChildOutcome;
    error: string | null;
    /** JSON-parsed result payload for successful children. null on failure/cancel/timeout. */
    result: unknown;
  }>;
  /** Counts by outcome — quick shape for logs + tests. */
  summary: Record<ChildOutcome, number>;
  /** Rendered markdown, suitable for attaching to the job row or writing as a brain page. */
  markdown: string;
}

/** v0.15 aggregator: synchronous read from inbox, no LLM call. */
export async function subagentAggregatorHandler(ctx: MinionJobContext): Promise<AggregatorResult> {
  const data = (ctx.data ?? {}) as unknown as AggregatorHandlerData;
  const expectedIds = Array.isArray(data.children_ids) ? data.children_ids : [];

  if (expectedIds.length === 0) {
    return {
      children: [],
      summary: emptySummary(),
      markdown: '# Aggregated subagent results\n\n_(no children)_',
    };
  }

  // Read every child_done inbox message addressed to this job. By the time
  // we're claimed, the queue layer has posted one per child terminal
  // transition. The `readInbox` method marks messages as read so future
  // claims don't re-process them.
  const messages = await ctx.readInbox();
  const childDoneByChildId = new Map<number, ChildDoneMessage>();
  for (const m of messages) {
    const payload = parseChildDone(m.payload);
    if (!payload) continue;
    childDoneByChildId.set(payload.child_id, payload);
  }

  const summary = emptySummary();
  const children: AggregatorResult['children'] = expectedIds.map(childId => {
    const msg = childDoneByChildId.get(childId);
    if (!msg) {
      // Missing — shouldn't happen under the v0.15 invariants (every
      // terminal path emits child_done). Surface as a failure row so the
      // aggregator is honest about what it knows.
      summary.failed = (summary.failed ?? 0) + 1;
      return {
        child_id: childId,
        job_name: '',
        outcome: 'failed',
        error: 'no child_done message observed in inbox',
        result: null,
      };
    }
    const outcome: ChildOutcome = msg.outcome ?? 'complete';
    summary[outcome] = (summary[outcome] ?? 0) + 1;
    return {
      child_id: childId,
      job_name: msg.job_name,
      outcome,
      error: msg.error ?? null,
      result: outcome === 'complete' ? msg.result : null,
    };
  });

  const markdown = renderMarkdown(children, summary, data.aggregate_prompt_template);

  await ctx.updateProgress({ total: expectedIds.length, summary });
  await ctx.log(`aggregated ${expectedIds.length} children — ${formatSummary(summary)}`);

  return { children, summary, markdown };
}

// ── internal ────────────────────────────────────────────────

function emptySummary(): Record<ChildOutcome, number> {
  return { complete: 0, failed: 0, dead: 0, cancelled: 0, timeout: 0 };
}

function formatSummary(s: Record<ChildOutcome, number>): string {
  return Object.entries(s)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k}=${n}`)
    .join(', ');
}

function parseChildDone(payload: unknown): ChildDoneMessage | null {
  const obj = typeof payload === 'string' ? safeParse(payload) : payload;
  if (!obj || typeof obj !== 'object') return null;
  const rec = obj as Record<string, unknown>;
  if (rec.type !== 'child_done' || typeof rec.child_id !== 'number') return null;
  return {
    type: 'child_done',
    child_id: rec.child_id,
    job_name: typeof rec.job_name === 'string' ? rec.job_name : '',
    result: rec.result,
    outcome: typeof rec.outcome === 'string' ? rec.outcome as ChildOutcome : undefined,
    error: typeof rec.error === 'string' ? rec.error : null,
  };
}

function safeParse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function renderMarkdown(
  children: AggregatorResult['children'],
  summary: Record<ChildOutcome, number>,
  template?: string,
): string {
  const header = template && template.trim().length > 0
    ? template
    : '# Aggregated subagent results';

  const parts: string[] = [header, ''];
  parts.push(`- total: ${children.length}`);
  for (const [outcome, n] of Object.entries(summary)) {
    if (n > 0) parts.push(`- ${outcome}: ${n}`);
  }
  parts.push('');

  for (const c of children) {
    parts.push(`## child ${c.child_id} (${c.job_name || 'unknown'}) — ${c.outcome}`);
    if (c.error) parts.push(`> error: ${c.error}`);
    if (c.outcome === 'complete' && c.result !== undefined) {
      parts.push('```json', JSON.stringify(c.result, null, 2), '```');
    }
    parts.push('');
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n');
}

// ── Testing surface ─────────────────────────────────────────

export const __testing = {
  emptySummary,
  formatSummary,
  parseChildDone,
  renderMarkdown,
};
