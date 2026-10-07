/**
 * The mention pass as a phase of `gbrain extract --stale` and the managed
 * stale path: preview counts for `--dry-run`, the cycle's budget split, and
 * the report lines. The pass itself is `pass.ts`.
 */

import type { BrainEngine } from '../engine.ts';
import { countIndexDuePages, countMentionDuePages, type MentionPassResult } from './pass.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy } from './policy.ts';

export interface MentionPreview {
  due: number;
  last_pass_at: string | null;
  enabled: boolean;
}

/**
 * Index-due pages (mention-due pages plus linkable entity pages with stale
 * derived aliases) and the newest pass time, for `extract --stale --dry-run`,
 * doctor and post-upgrade.
 */
export async function previewMentionPass(engine: BrainEngine, sourceId?: string): Promise<MentionPreview> {
  const policy = await readMentionPolicy(engine);
  const [row] = await engine.executeRaw<{ last: string | null }>(
    `SELECT to_char(max(last_pass_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS last FROM mention_index_status
      WHERE ($1::text IS NULL OR source_id = $1)`, [sourceId ?? null]);
  let due = 0;
  if (policy.enabled) {
    const sources = sourceId ? [sourceId] : (await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')).map(r => r.id);
    for (const id of sources) due += await countIndexDuePages(engine, id, linkableTypesFor(await loadSourcePack(engine, id), policy));
  }
  return { due, last_pass_at: row?.last ?? null, enabled: policy.enabled };
}

/**
 * Deadline for the link phase of a budgeted sweep: half the budget while
 * mention-due pages exist, so a link backlog cannot starve the mention pass
 * across cycles. Unbudgeted (catch-up) sweeps get no deadline.
 */
export async function linkPhaseDeadline(engine: BrainEngine, sourceId: string | undefined, startMs: number, budgetMs: number | undefined): Promise<number> {
  if (budgetMs === undefined) return Infinity;
  const policy = await readMentionPolicy(engine);
  const due = policy.enabled ? await countMentionDuePages(engine, sourceId) : 0;
  return startMs + (due > 0 ? budgetMs / 2 : budgetMs);
}

/** One report line, or null when the pass did nothing worth reporting. */
export function formatMentionSummary(r: MentionPassResult): string | null {
  if (r.state === 'failed') {
    return `Mentions: not indexed (${r.error ?? 'unknown error'}); nothing was changed. Fix the cause, then re-run 'gbrain extract --stale'.`;
  }
  if (r.state === 'disabled') {
    return r.removed ? `Mentions: linking is off (auto_link or mentions.auto_link); removed ${r.removed} mention link(s).` : null;
  }
  if (!r.pages && !r.removed && !r.remaining && !r.aliasPages) return null;
  return `Mentions: ${r.created} link(s) added, ${r.removed} removed from ${r.pages} page(s)` +
    (r.aliasPages ? `; derived names refreshed on ${r.aliasPages} entity page(s)` : '') +
    (r.remaining ? `; ${r.remaining} page(s) still due — re-run 'gbrain extract --stale' (or pass --catch-up) to continue.` : '.');
}

export function mentionJsonFields(r: MentionPassResult): Record<string, unknown> {
  return {
    mention_pages: r.pages, mention_links_created: r.created, mention_links_removed: r.removed,
    mention_alias_pages: r.aliasPages, mention_due_remaining: r.remaining, mention_state: r.state,
    ...(r.error ? { mention_error: r.error } : {}),
  };
}
