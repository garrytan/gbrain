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
 * unusable lines are returned so callers can report them.
 */
import type { BrainEngine, LinkBatchInput } from './engine.ts';
import type { Page } from './types.ts';
import { executeRawJsonb } from './sql-query.ts';
import { deriveTemporalEvidence, rowKey, type TemporalEvidence } from './link-temporal-evidence.ts';
import { refreshRelationships, type RelationshipKey } from './link-relationships.ts';
import { temporalLinkTypes } from './link-validity.ts';
import { inlineTransitions } from './link-effective.ts';
import { pipelined } from './page-state/transactions.ts';

type Tx = Pick<BrainEngine, 'executeRaw'>;

const DERIVED_PRODUCERS = ['timeline', 'explicit', 'frontmatter', 'dream', 'inline'];

export interface TemporalApplyResult {
  transitions: number;
  refreshed: number;
  unmatched: TemporalEvidence['unmatched'];
}

/** Relationship keys whose evidence this origin page owns (links rows + derived transitions + state rows it starts). */
export async function relationshipKeysForOrigin(tx: Tx, pageId: number): Promise<RelationshipKey[]> {
  const rows = await tx.executeRaw<RelationshipKey>(
    `SELECT from_page_id, to_page_id, link_type FROM links
      WHERE (origin_page_id = $1 OR (origin_page_id IS NULL AND from_page_id = $1)) AND link_type = ANY($2::text[])
     UNION
     SELECT from_page_id, to_page_id, link_type FROM link_transitions WHERE origin_page_id = $1
     UNION
     SELECT from_page_id, to_page_id, link_type FROM link_relationships WHERE from_page_id = $1 AND scope = 'all'`,
    [pageId, temporalLinkTypes()]);
  return rows.map(r => ({ from_page_id: Number(r.from_page_id), to_page_id: Number(r.to_page_id), link_type: r.link_type }));
}

export async function applyTemporalEvidence(
  tx: Tx,
  page: Pick<Page, 'id' | 'slug' | 'source_id' | 'compiled_truth' | 'timeline' | 'frontmatter'>,
  rows: readonly LinkBatchInput[],
  keysBefore: readonly RelationshipKey[],
  opts: { inlineRanges?: boolean } = {},
): Promise<TemporalApplyResult> {
  const pageId = Number(page.id);
  const sourceId = page.source_id ?? 'default';
  const evidence = deriveTemporalEvidence({
    slug: page.slug, compiled_truth: page.compiled_truth ?? '', timeline: page.timeline ?? '',
    frontmatter: (page.frontmatter ?? {}) as Record<string, unknown>,
  }, rows.map(r => ({ from_slug: r.from_slug, to_slug: r.to_slug, link_type: r.link_type, link_source: r.link_source ?? 'markdown', origin_field: r.origin_field ?? null })));
  const inline = opts.inlineRanges
    ? inlineTransitions(page.slug, `${page.compiled_truth ?? ''}\n${page.timeline ?? ''}`, rows.filter(r => (r.link_source ?? 'markdown') !== 'frontmatter'))
    : { transitions: [], unmatched: [] };
  const transitions = [...evidence.transitions, ...inline.transitions];

  const tenseRows = rows.filter(r => evidence.tense.has(rowKey(r))).map(r => ({
    from_slug: r.from_slug, to_slug: r.to_slug, link_type: r.link_type ?? '', link_source: r.link_source ?? 'markdown',
    from_source_id: r.from_source_id ?? sourceId, to_source_id: r.to_source_id ?? sourceId,
    tense: evidence.tense.get(rowKey(r)) === 'past' ? 'past' : null,
  }));
  // The tense update, the transition replacement, the target check and the after-read are sent together, in this order.
  const tense = tenseRows.length ? () => executeRawJsonb(tx,
      `UPDATE links l SET assertion_tense = v.tense
         FROM jsonb_to_recordset(($2::jsonb)->'rows') AS v(from_slug text, to_slug text, link_type text, link_source text,
           from_source_id text, to_source_id text, tense text)
         JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
         JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
        WHERE l.from_page_id = f.id AND l.to_page_id = t.id AND l.link_type = v.link_type AND l.link_source = v.link_source
          AND (l.origin_page_id = $1 OR (l.origin_page_id IS NULL AND l.from_page_id = $1))
          AND l.assertion_tense IS DISTINCT FROM v.tense`,
      [pageId], [{ rows: tenseRows }]) : async () => undefined;
  const insert = transitions.length ? () => executeRawJsonb<RelationshipKey>(tx,
      `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, date_precision, producer, origin_page_id, line_hash)
       SELECT $2, f.id, t.id, v.link_type, v.kind, v.occurred_on::date, v.date_precision, v.producer, $1, v.line_hash
         FROM jsonb_to_recordset(($3::jsonb)->'rows') AS v(from_slug text, to_slug text, link_type text, kind text,
           occurred_on text, date_precision text, producer text, line_hash text)
         JOIN pages f ON f.slug = v.from_slug AND f.source_id = $2 AND f.deleted_at IS NULL
         JOIN pages t ON t.slug = v.to_slug AND t.source_id = $2 AND t.deleted_at IS NULL
       ON CONFLICT DO NOTHING
       RETURNING from_page_id, to_page_id, link_type`,
      [pageId, sourceId], [{ rows: transitions }]) : async () => [] as RelationshipKey[];
  const unmatched = [...evidence.unmatched, ...inline.unmatched];
  const explicitTargets = [...new Set(evidence.transitions.filter(t => t.producer === 'explicit' || t.producer === 'dream').map(t => t.to_slug))];
  const [, , inserted, liveTargets, keysAfter] = await pipelined(tx, [
    tense,
    () => tx.executeRaw(`DELETE FROM link_transitions WHERE origin_page_id = $1 AND producer = ANY($2::text[])`, [pageId, DERIVED_PRODUCERS]),
    insert,
    () => explicitTargets.length ? tx.executeRaw<{ slug: string }>(
      `SELECT slug FROM pages WHERE source_id = $1 AND slug = ANY($2::text[]) AND deleted_at IS NULL`, [sourceId, explicitTargets]) : Promise.resolve([]),
    () => relationshipKeysForOrigin(tx, pageId),
  ]) as [unknown, unknown, RelationshipKey[], Array<{ slug: string }>, RelationshipKey[]];
  if (explicitTargets.length) {
    const live = new Set(liveTargets.map(r => r.slug));
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
    ...(dates.validFrom ? [{ kind: 'start', occurred_on: dates.validFrom }] : []),
    ...(dates.validUntil ? [{ kind: 'end', occurred_on: dates.validUntil }] : []),
  ];
  if (!rows.length) return 0;
  const inserted = await executeRawJsonb<RelationshipKey>(tx,
    `INSERT INTO link_transitions (source_id, from_page_id, to_page_id, link_type, kind, occurred_on, producer, origin_page_id)
     SELECT $1, f.id, t.id, $4, v.kind, v.occurred_on::date, 'manual', NULL
       FROM jsonb_to_recordset(($5::jsonb)->'rows') AS v(kind text, occurred_on text)
       JOIN pages f ON f.slug = $2 AND f.source_id = $1 AND f.deleted_at IS NULL
       JOIN pages t ON t.slug = $3 AND t.source_id = $1 AND t.deleted_at IS NULL
     ON CONFLICT DO NOTHING
     RETURNING from_page_id, to_page_id, link_type`,
    [rel.sourceId, rel.from, rel.to, rel.linkType], [{ rows }]);
  const [key] = await tx.executeRaw<RelationshipKey>(
    `SELECT f.id AS from_page_id, t.id AS to_page_id, $4::text AS link_type FROM pages f, pages t
      WHERE f.slug = $2 AND f.source_id = $1 AND t.slug = $3 AND t.source_id = $1`, [rel.sourceId, rel.from, rel.to, rel.linkType]);
  if (key) await refreshRelationships(tx, [key]);
  return inserted.length;
}

/** remove_link companion: drop manual dated statements for the removed relationship(s). */
export async function removeManualTransitions(tx: Tx, rel: { from: string; to: string; linkType?: string; sourceId: string }): Promise<void> {
  const keys = await tx.executeRaw<RelationshipKey>(
    `DELETE FROM link_transitions lt USING pages f, pages t
      WHERE f.id = lt.from_page_id AND t.id = lt.to_page_id AND f.slug = $1 AND t.slug = $2
        AND f.source_id = $3 AND t.source_id = $3 AND lt.producer = 'manual'
        AND ($4::text IS NULL OR lt.link_type = $4)
      RETURNING lt.from_page_id, lt.to_page_id, lt.link_type`, [rel.from, rel.to, rel.sourceId, rel.linkType ?? null]);
  if (keys.length) await refreshRelationships(tx, keys);
}
