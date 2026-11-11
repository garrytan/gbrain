/**
 * GST-2468: `gbrain trust backfill --label-lowerings`, a read-only listing of the `lower_page` proposals whose lowering
 * write changed only a page's privacy labels (visibility, access, confidentiality) and the server's stamps (trust_tier,
 * source_kind, ingested_via, ingested_at): an operator's label change made through put_page, which rates as an agent
 * edit (trust/channel.ts), before label-only repairs had their own door (repair/label-write.ts). For each proposal it
 * compares the version the lowering replaced (`before_state.version_id`) with the page as it is now:
 *   label_only  only label and stamp keys differ, and at least one label key does;
 *   content     the body, timeline, title, type or another frontmatter key differs;
 *   unreadable  the replaced version is gone or stored in segments, or the page was purged.
 * Counts are grouped by proposer (agent_page_edit:put_page, derived_page:submit_job, ...) and class. It changes
 * nothing: raising a tier back is a trust decision (gbrain trust confirm or revert), never made here.
 */
import type { BrainEngine } from '../engine.ts';
import { LABEL_KEYS } from '../persistence/label-edit.ts';
import { digest } from '../persistence/digest.ts';
import { trustProposalRef } from './proposals.ts';
import { storedTrustTier, type TrustTier } from './tier.ts';

/** Keys the server stamps on a write (page-prepare.ts putProvenance, trust/page-write.ts stampPageTrustMarker). */
const STAMP_KEYS = ['trust_tier', 'source_kind', 'ingested_via', 'ingested_at'];

export type LabelLoweringClass = 'label_only' | 'content' | 'unreadable';
export interface LabelLowering {
  ref: string; source_id: string; slug: string | null; proposer: string; status: string; class: LabelLoweringClass;
  prior_tier: TrustTier | null; tier_now: TrustTier | null; proposed_at: string;
  /** label_only: each label key's value before and now (null when absent). */
  labels?: Record<string, { before: unknown; now: unknown }>;
  /** label_only: the stamp keys the write changed. */
  stamps?: string[];
  /** The page changed after the proposal last recorded its revision (a later write that filed no proposal). */
  changed_since?: true;
}
export interface LabelLoweringsReport {
  mode: 'preview'; source_id: string | null;
  counts: { lower_page: number; label_only: number; content: number; unreadable: number; by_proposer: Record<string, Record<LabelLoweringClass, number>> };
  items: LabelLowering[];
  note: string;
}

interface Row {
  id: number; source_id: string; proposer: string; status: string; created_at: Date | string; before_state: Record<string, unknown> | null; after_state: Record<string, unknown> | null;
  slug: string | null; tier: string | null; revision: string | null; frontmatter: Record<string, unknown> | null; v_id: number | null;
  v_frontmatter: Record<string, unknown> | null; readable: boolean; same_body: boolean;
}

const same = (a: unknown, b: unknown) => digest(a ?? null) === digest(b ?? null);

function classify(row: Row): Pick<LabelLowering, 'class' | 'labels' | 'stamps'> {
  if (row.slug === null || row.v_id === null || !row.readable) return { class: 'unreadable' };
  const before = row.v_frontmatter ?? {}, now = row.frontmatter ?? {};
  const changed = [...new Set([...Object.keys(before), ...Object.keys(now)])].filter(key => !same(before[key], now[key]));
  const labels = changed.filter(key => LABEL_KEYS.includes(key));
  if (!row.same_body || !labels.length || changed.some(key => !LABEL_KEYS.includes(key) && !STAMP_KEYS.includes(key))) return { class: 'content' };
  return { class: 'label_only', labels: Object.fromEntries(labels.map(key => [key, { before: before[key] ?? null, now: now[key] ?? null }])),
    stamps: changed.filter(key => STAMP_KEYS.includes(key)) };
}

export async function listLabelLowerings(engine: BrainEngine, opts: { sourceId?: string | null } = {}): Promise<LabelLoweringsReport> {
  const rows = await engine.executeRaw<Row>(`SELECT tp.id, tp.source_id, tp.proposer, tp.status, tp.created_at, tp.before_state, tp.after_state,
      p.slug, p.trust_tier::text AS tier, p.knowledge_revision::text AS revision, p.frontmatter, v.id AS v_id, v.frontmatter AS v_frontmatter,
      (v.compiled_truth IS NOT NULL AND p.compiled_truth IS NOT NULL) AS readable,
      COALESCE(v.compiled_truth = p.compiled_truth AND (v.timeline IS NULL OR v.timeline = COALESCE(p.timeline, ''))
        AND (v.title IS NULL OR v.title = p.title) AND (v.type IS NULL OR v.type::text = p.type::text), false) AS same_body
    FROM trust_proposals tp
      LEFT JOIN pages p ON p.id = tp.target_id
      LEFT JOIN page_versions v ON v.page_id = tp.target_id
        AND v.id = CASE WHEN tp.before_state->>'version_id' ~ '^[0-9]+$' THEN (tp.before_state->>'version_id')::integer END
    WHERE tp.action = 'lower_page' AND tp.target_table = 'pages' AND ($1::text IS NULL OR tp.source_id = $1)
    ORDER BY tp.id`, [opts.sourceId ?? null]);
  const counts: LabelLoweringsReport['counts'] = { lower_page: rows.length, label_only: 0, content: 0, unreadable: 0, by_proposer: {} };
  const items = rows.map((row): LabelLowering => {
    const verdict = classify(row);
    counts[verdict.class]++;
    (counts.by_proposer[row.proposer] ??= { label_only: 0, content: 0, unreadable: 0 })[verdict.class]++;
    const prior = row.before_state?.prior_tier;
    const recorded = row.after_state?.revision;
    return { ref: trustProposalRef(Number(row.id)), source_id: row.source_id, slug: row.slug ?? (typeof row.before_state?.slug === 'string' ? row.before_state.slug : null),
      proposer: row.proposer, status: row.status, ...verdict, prior_tier: typeof prior === 'string' ? storedTrustTier(prior) : null,
      tier_now: row.tier === null ? null : storedTrustTier(row.tier), proposed_at: new Date(row.created_at).toISOString(),
      ...(row.revision !== null && typeof recorded === 'string' && recorded !== row.revision ? { changed_since: true as const } : {}) };
  });
  return { mode: 'preview', source_id: opts.sourceId ?? null, counts, items,
    note: 'Read-only: nothing here changes a tier. Raising a page back is a trust decision for the owner (gbrain trust review).' };
}

export function renderLabelLowerings(report: LabelLoweringsReport): string {
  const { counts } = report;
  const lines = [`Lowered pages by proposal (${counts.lower_page} lower_page proposal(s)${report.source_id ? ` in ${report.source_id}` : ''}): `
    + `${counts.label_only} label-only, ${counts.content} content, ${counts.unreadable} unreadable.`];
  for (const [proposer, by] of Object.entries(counts.by_proposer)) lines.push(`  ${proposer}: label-only ${by.label_only}, content ${by.content}, unreadable ${by.unreadable}`);
  for (const item of report.items.filter(entry => entry.class === 'label_only')) {
    const labels = Object.entries(item.labels ?? {}).map(([key, change]) => `${key} ${String(change.before ?? '(none)')} -> ${String(change.now ?? '(none)')}`).join(', ');
    lines.push(`  ${item.ref} ${item.source_id}:${item.slug} (${item.status}, ${item.proposer}): ${labels}; tier ${item.prior_tier ?? '?'} -> ${item.tier_now ?? '?'}${item.changed_since ? ' (changed since)' : ''}`);
  }
  lines.push(`  ${report.note}`);
  return lines.join('\n');
}
