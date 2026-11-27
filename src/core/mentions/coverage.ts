/**
 * `coverage` on entity cards, entity misses and get_backlinks: whether every
 * page in the caller's permitted sources has been scanned for recognized
 * names. Read from the per-source status row the mention pass maintains plus
 * the due pages written since its last count (an indexed read over recent
 * pages per source), never a whole-brain scan, and never another source's
 * state. A row counted by a binary with other extractor versions (its
 * version stamp differs) is recounted once and the count saved on the row,
 * so a version bump shows every version-behind page as pending, whatever its
 * `updated_at`, until the sweep reaches it.
 *
 * States: `complete`; `pending` (pages written or invalidated since the last
 * pass, pages behind the binary's mention or alias version, or no pass yet);
 * `disabled` (auto_link or mentions.auto_link is off);
 * `type_not_linkable` (cards only: nothing links to this page type by
 * mention); `failed` (the last pass could not build the index). Any state but
 * `complete` carries `degraded: true` and a `[gbrain notice mention_index]`.
 */

import type { BrainEngine } from '../engine.ts';
import type { Notice } from '../agent-output.ts';
import { linkableTypesFor, loadSourcePack, readMentionPolicy } from './policy.ts';
import { INDEX_VERSION_STAMP, MENTION_EXTRACTOR_VERSION, countIndexDuePages, splitStoredFingerprint } from './pass.ts';

export type CoverageState = 'complete' | 'pending' | 'disabled' | 'type_not_linkable' | 'failed';

export interface MentionCoverage {
  state: CoverageState;
  pending_pages: number;
  last_pass_at: string | null;
  degraded?: true;
}

const toIso = (v: unknown): string | null => {
  if (v == null) return null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(String(v));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/** Coverage over `sourceIds` (the caller's permitted sources). */
export async function readMentionCoverage(engine: Pick<BrainEngine, 'executeRaw' | 'getConfig' | 'countPagesDueForMentions' | 'readMentionIndexStatus' | 'countLivePagesInSource' | 'countMentionDueSince' | 'recountMentionIndexStatus'>, sourceIds: string[]): Promise<MentionCoverage> {
  const policy = await readMentionPolicy(engine);
  const rows = await engine.readMentionIndexStatus(sourceIds);
  const bySource = new Map(rows.map(r => [r.source_id, r]));
  let pending = 0;
  let failed = false;
  let unsettled = false;
  let last: string | null = null;
  for (const sourceId of sourceIds) {
    const row = bySource.get(sourceId);
    const lastPass = toIso(row?.last_pass_at);
    if (lastPass && (!last || lastPass > last)) last = lastPass;
    if (!policy.enabled) continue;
    if (!row || row.state === 'disabled') {
      pending += await engine.countLivePagesInSource(sourceId);
      continue;
    }
    if (row.state === 'failed') failed = true;
    // A pass that had no time to save a changed name list leaves the row pending with no page counted due yet.
    if (row.state === 'pending') unsettled = true;
    const stored = splitStoredFingerprint(row.policy_fingerprint);
    if (stored.versions !== INDEX_VERSION_STAMP) {
      // Counted by another binary: recount once (pages behind this binary's versions are due whatever their updated_at) and save it.
      const due = await countIndexDuePages(engine, sourceId, linkableTypesFor(await loadSourcePack(engine, sourceId), policy));
      await engine.recountMentionIndexStatus(sourceId, { pending: due, fingerprint: `${stored.hash ?? ''};${INDEX_VERSION_STAMP}`, expectedFingerprint: row.policy_fingerprint })
        .catch(() => undefined);
      pending += due;
      continue;
    }
    // Pages written at or after the last count that are not scanned at their current content (the index on updated_at keeps it small).
    const since = await engine.countMentionDueSince(sourceId, toIso(row.counted_at) ?? '-infinity', MENTION_EXTRACTOR_VERSION);
    pending += Number(row.pending ?? 0) + since;
  }
  const state: CoverageState = !policy.enabled ? 'disabled' : failed ? 'failed' : pending > 0 || unsettled ? 'pending' : 'complete';
  return { state, pending_pages: policy.enabled ? pending : 0, last_pass_at: last, ...(state === 'complete' ? {} : { degraded: true as const }) };
}

const WHY: Record<Exclude<CoverageState, 'complete'>, (c: MentionCoverage) => string> = {
  pending: c => (c.pending_pages > 0
    ? `${c.pending_pages} page(s) have not been scanned for entity names yet, so references from them are missing; `
    : 'The entity name list changed and pages have not been checked against it yet, so references may be missing; ') +
    'a short or empty list is not proof that nothing else mentions this entity.',
  disabled: () => 'Mention linking is off (auto_link or mentions.auto_link is false), so only explicit links are listed, not pages that name this entity.',
  type_not_linkable: () => 'This page type is not a linkable entity type, so pages that only name it are not listed; explicit links are. ' +
    'Add the type with `gbrain config set mentions.entity_types +<type>` to link it.',
  failed: () => 'The last mention pass could not build the name index, so references may be missing or stale.',
};

/**
 * The model-visible notice for a degraded coverage; null when complete.
 * Pending and failed indexes name the free catch-up sweep; a policy state
 * (disabled, type not linkable) names the setting the user controls.
 */
export function mentionCoverageNotice(coverage: MentionCoverage, entityType?: string | null): Notice | null {
  if (coverage.state === 'complete') return null;
  const why = WHY[coverage.state](coverage);
  if (coverage.state === 'disabled') {
    return { code: 'mention_index', kind: 'degraded', why, fix: { argv: ['gbrain', 'config', 'set', 'mentions.auto_link', 'true'], consent: [],
      actor: 'user', requires_exclusive: false, why: 'Turns mention linking back on; the next `gbrain extract --stale` links every page.',
      verify: { argv: ['gbrain', 'config', 'get', 'mentions.auto_link'] } } };
  }
  if (coverage.state === 'type_not_linkable') {
    return { code: 'mention_index', kind: 'degraded', why, fix: { argv: ['gbrain', 'config', 'set', 'mentions.entity_types', `+${entityType ?? '<type>'}`],
      consent: [], actor: 'user', requires_exclusive: false, why: 'Makes this page type linkable; the next `gbrain extract --stale` links pages that name it.',
      verify: { argv: ['gbrain', 'config', 'get', 'mentions.entity_types'] } } };
  }
  return {
    code: 'mention_index', kind: 'degraded', why,
    fix: { argv: ['gbrain', 'extract', '--stale', '--catch-up'], consent: [], actor: 'agent', requires_exclusive: false,
      verify: { argv: ['gbrain', 'doctor', '--only', 'links_extraction_lag', '--json'] },
      why: 'Scans the pending pages for entity names and links them; free (no model calls). Then call entity again.' },
  };
}
