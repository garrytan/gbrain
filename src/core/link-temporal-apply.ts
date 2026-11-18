/**
 * Temporal typed edges — persist one origin page's temporal evidence inside
 * the transaction that replaces its derived links (src/core/derived-links.ts):
 *
 * 1. stamp `assertion_tense` on the links rows this page owns;
 * 2. replace the page's derived `link_transitions` (producers timeline,
 *    explicit, frontmatter, dream, and inline when `inlineRanges` is on:
 *    validity ranges on typed relation lines, core/link-effective.ts; manual
 *    rows are left alone);
 * 3. refresh `link_relationships` for every relationship the page touched
 *    before or after the change.
 *
 * Zero LLM. Explicit-grammar targets must be live pages in the same source;
 * unusable lines are returned so callers can report them. The evidence is
 * computed here; the rows are written through engine members
 * (engine-sql/link-temporal.ts, or the Rust store).
 */
import type { BrainEngine, LinkBatchInput } from './engine.ts';
import type { Page } from './types.ts';
import { datedLines, deriveTemporalEvidence, narrativeRefs, rowKey, temporalEvidenceFrom, type TemporalEvidence, type TemporalInputs } from './link-temporal-evidence.ts';
import { refreshRelationships, type RelationshipKey, type RelationshipStateStore } from './link-relationships.ts';
import { inlineTransitions, inlineTransitionsFrom, rangedRelationLines, type RangedRelationLine } from './link-effective.ts';

/** The engine members one origin's temporal evidence is written and refreshed through. */
export type TemporalTx = Pick<BrainEngine, 'applyLinkTemporalRows' | 'writeManualLinkTransitions' | 'removeManualLinkTransitions'>
  & RelationshipStateStore;
type Tx = TemporalTx;

/** What the evidence reads from the page body, collected outside the transaction (a segmented page's body is not read here). */
export interface TemporalBody extends TemporalInputs { ranged: RangedRelationLine[] }

/** The TemporalBody of a body held as strings. */
export function temporalBodyOf(page: { compiled_truth: string; timeline?: string | null }): TemporalBody {
  const content = `${page.compiled_truth}\n${page.timeline ?? ''}`;
  return { lines: datedLines(content), narrative: narrativeRefs(page.compiled_truth), ranged: rangedRelationLines(content) };
}

export interface TemporalApplyResult {
  transitions: number;
  refreshed: number;
  unmatched: TemporalEvidence['unmatched'];
}

/** Relationship keys whose evidence this origin page owns (links rows + derived transitions + state rows it starts). */
export function relationshipKeysForOrigin(tx: Pick<BrainEngine, 'linkRelationshipKeysForOrigin'>, pageId: number): Promise<RelationshipKey[]> {
  return tx.linkRelationshipKeysForOrigin(pageId);
}

export async function applyTemporalEvidence(
  tx: Tx,
  page: Pick<Page, 'id' | 'slug' | 'source_id' | 'compiled_truth' | 'timeline' | 'frontmatter'>,
  rows: readonly LinkBatchInput[],
  keysBefore: readonly RelationshipKey[],
  opts: { inlineRanges?: boolean; body?: TemporalBody } = {},
): Promise<TemporalApplyResult> {
  const pageId = Number(page.id);
  const sourceId = page.source_id ?? 'default';
  const owned = rows.map(r => ({ from_slug: r.from_slug, to_slug: r.to_slug, link_type: r.link_type, link_source: r.link_source ?? 'markdown', origin_field: r.origin_field ?? null }));
  const frontmatter = (page.frontmatter ?? {}) as Record<string, unknown>;
  const evidence = opts.body ? temporalEvidenceFrom({ slug: page.slug, frontmatter }, opts.body, owned)
    : deriveTemporalEvidence({ slug: page.slug, compiled_truth: page.compiled_truth ?? '', timeline: page.timeline ?? '', frontmatter }, owned);
  const bodyRows = rows.filter(r => (r.link_source ?? 'markdown') !== 'frontmatter');
  const inline = !opts.inlineRanges ? { transitions: [], unmatched: [] }
    : opts.body ? inlineTransitionsFrom(page.slug, opts.body.ranged, bodyRows)
    : inlineTransitions(page.slug, `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`, bodyRows);
  const transitions = [...evidence.transitions, ...inline.transitions];

  const tenseRows = rows.filter(r => evidence.tense.has(rowKey(r))).map(r => ({
    from_slug: r.from_slug, to_slug: r.to_slug, link_type: r.link_type ?? '', link_source: r.link_source ?? 'markdown',
    from_source_id: r.from_source_id ?? sourceId, to_source_id: r.to_source_id ?? sourceId,
    tense: evidence.tense.get(rowKey(r)) === 'past' ? 'past' as const : null,
  }));
  const unmatched = [...evidence.unmatched, ...inline.unmatched];
  const explicitTargets = [...new Set(evidence.transitions.filter(t => t.producer === 'explicit' || t.producer === 'dream').map(t => t.to_slug))];
  const { inserted, liveTargets, keysAfter } = await tx.applyLinkTemporalRows({ pageId, sourceId, tenseRows, transitions, explicitTargets });
  if (explicitTargets.length) {
    const live = new Set(liveTargets);
    for (const t of evidence.transitions) {
      if ((t.producer === 'explicit' || t.producer === 'dream') && !live.has(t.to_slug)) {
        unmatched.push({ line: `${t.kind === 'start' ? 'Started' : 'Ended'} ${t.link_type} [[${t.to_slug}]]`, reason: 'no_target' });
      }
    }
  }
  const refreshed = await refreshRelationships(tx, [...keysBefore, ...keysAfter]);
  return { transitions: inserted.length, refreshed, unmatched };
}

/**
 * Manual (database-only) dated statements for one relationship, from add_link
 * valid_from / valid_until. Runs in the caller's transaction (coordinated or
 * maintenance). Returns the number of transitions written.
 */
export async function writeManualTransitions(
  tx: Tx,
  rel: { from: string; to: string; linkType: string; sourceId: string },
  dates: { validFrom?: string; validUntil?: string },
): Promise<number> {
  const rows = [
    ...(dates.validFrom ? [{ kind: 'start' as const, occurred_on: dates.validFrom }] : []),
    ...(dates.validUntil ? [{ kind: 'end' as const, occurred_on: dates.validUntil }] : []),
  ];
  if (!rows.length) return 0;
  const { inserted, key } = await tx.writeManualLinkTransitions(rel, rows);
  if (key) await refreshRelationships(tx, [key]);
  return inserted;
}

/**
 * remove_link companion: drop manual dated statements for the removed relationship(s). `databaseOnly` keeps the
 * statements a links fence projected (origin_page_id set), which belong to the fence's rows, not to a database-only edge.
 */
export async function removeManualTransitions(tx: Tx, rel: { from: string; to: string; linkType?: string; sourceId: string; databaseOnly?: boolean }): Promise<void> {
  const keys = await tx.removeManualLinkTransitions(rel);
  if (keys.length) await refreshRelationships(tx, keys);
}
