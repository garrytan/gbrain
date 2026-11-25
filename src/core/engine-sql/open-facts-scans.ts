/**
 * The preview scans of `gbrain repair open-facts` (src/core/repair/open-facts.ts) that ran through `executeRaw`: one
 * keyset window of eligible private facts (listOpenFactsWindow) and the reason counts (countOpenFactReasons), with the
 * class and reason builders they share with the locked apply (moved unchanged). Each runs the statement its caller ran,
 * with the same text and parameters; only its home moved.
 */
import { factOnMemberPageSql, factPageReasons, unpagedFactSql } from '../facts/private-fact-pages.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** A fact's class: unpaged:<lane> (no holding page, or a transcript lane), fenced, or unfenced. */
export const openFactClassSql = (f: string) => `(CASE WHEN ${unpagedFactSql(f)} THEN 'unpaged:' || COALESCE(NULLIF(${f}.source, ''), 'unknown')
  WHEN ${f}.row_num IS NOT NULL THEN 'fenced' ELSE 'unfenced' END)`;

/**
 * Why a private fact `f` stays private, or NULL when it may open: the one exclusion expression the preview, the reason
 * counts and the locked apply share. A trust contest is any pending proposal on the row (a hold, a forget, a supersession)
 * or a widening (`before_state.visibility`) the owner rejected or undid: an owner's decision is never overridden.
 */
export function openFactsReasonSql(f: string): string {
  return `(CASE
    WHEN ${f}.expired_at IS NOT NULL THEN 'expired'
    WHEN ${f}.superseded_by IS NOT NULL THEN 'superseded'
    WHEN ${f}.valid_until IS NOT NULL AND ${f}.valid_until <= now() THEN 'lapsed'
    WHEN ${factOnMemberPageSql(f)} THEN 'member_page'
    WHEN EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = ${f}.source_id
        AND w.fact_hash IN (gbrain_fact_fingerprint(${f}.fact), gbrain_fact_fingerprint_v2(${f}.fact), gbrain_fact_fingerprint_v1(${f}.fact)) AND (w.subject = '*' OR w.subject = ${f}.entity_slug))
      OR EXISTS (SELECT 1 FROM fact_purges x WHERE x.source_id = ${f}.source_id AND x.fact_hash IN (gbrain_fact_fingerprint(${f}.fact), gbrain_fact_fingerprint_v2(${f}.fact))
        AND (x.subject = '*' OR x.subject = ${f}.entity_slug)) THEN 'withdrawn'
    WHEN EXISTS (SELECT 1 FROM trust_proposals tp WHERE ((tp.target_table = 'facts' AND tp.target_id = ${f}.id) OR (tp.related_table = 'facts' AND tp.related_id = ${f}.id))
        AND (tp.status = 'pending' OR (tp.action IN ('supersede_fact', 'confirm') AND tp.status IN ('rejected', 'undone') AND tp.before_state->'visibility' IS NOT NULL))) THEN 'contested'
    ${factPageReasons(f).map(([reason, condition]) => `WHEN ${condition} THEN '${reason}'`).join('\n    ')}
    ELSE NULL END)`;
}

/** The selection's private facts, before reasons: one source, created before the cut, the named ids (over the facts alias f). */
const BASE_F = `f.source_id = $1 AND f.visibility = 'private' AND f.created_at < $2::timestamptz AND ($3::bigint[] IS NULL OR f.id = ANY($3::bigint[]))`;

/** An open-facts selection: one source, the creation cut and the named ids (null for every id). */
export interface OpenFactsSelection { sourceId: string; createdBefore: string | null; ids: number[] | null }
/** One eligible fact of a window, with its class. */
export interface OpenFactsWindowRow { id: number; row_num: number | null; fact: string; source_markdown_slug: string | null; cls: string }

/** Hand-numbered statement text: the fragment must bind nothing ahead of the parameters the caller passes. */
function handNumbered(member: string, fragment: ReturnType<typeof sqlFragment>): string {
  const { text, params } = renderFragment(fragment);
  if (params.length !== 0) throw new Error(`${member}: a fragment bound a value ahead of the hand-numbered parameters`);
  return text;
}

/** One keyset window of eligible facts: ids in (after, upper], the selected classes, every exclusion in the statement. */
export async function listOpenFactsWindow(raw: EngineRawRead, sel: OpenFactsSelection, after: number, upper: number | null, classes: readonly string[],
  limit: number, timeoutMs: number): Promise<OpenFactsWindowRow[]> {
  const text = handNumbered('listOpenFactsWindow', sqlFragment`${trustedSql(`SELECT f.id, f.row_num, f.fact, f.source_markdown_slug, `)}${trustedSql(openFactClassSql('f'))}${trustedSql(` AS cls
    FROM facts f WHERE `)}${trustedSql(BASE_F)}${trustedSql(` AND f.id > $4 AND ($5::bigint IS NULL OR f.id <= $5::bigint)
      AND `)}${trustedSql(openFactClassSql('f'))}${trustedSql(` = ANY($6::text[]) AND `)}${trustedSql(openFactsReasonSql('f'))}${trustedSql(` IS NULL
    ORDER BY f.id LIMIT $7`)}`);
  return raw<OpenFactsWindowRow>(text, [sel.sourceId, sel.createdBefore, sel.ids, after, upper, [...classes], limit], { timeoutMs });
}

/** Every private fact of the selection (any class, any id) counted by class and by the reason it stays private (`eligible` when none). */
export async function countOpenFactReasons(raw: EngineRawRead, sel: OpenFactsSelection, timeoutMs: number): Promise<Array<{ cls: string; reason: string; n: number }>> {
  const text = handNumbered('countOpenFactReasons', sqlFragment`${trustedSql(`SELECT cls, reason, count(*)::int AS n FROM (SELECT `)}${trustedSql(openFactClassSql('f'))}${trustedSql(` AS cls, COALESCE(`)}${trustedSql(openFactsReasonSql('f'))}${trustedSql(`, 'eligible') AS reason
      FROM facts f WHERE `)}${trustedSql(BASE_F)}${trustedSql(`) x GROUP BY cls, reason ORDER BY cls COLLATE "C", reason COLLATE "C"`)}`);
  return raw<{ cls: string; reason: string; n: number }>(text, [sel.sourceId, sel.createdBefore, sel.ids], { timeoutMs });
}
