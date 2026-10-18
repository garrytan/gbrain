/**
 * #6764: what doctor `unlinked_facts` and `gbrain facts relink --conversation`
 * remember about a conversation page's unlinked derived rows, so the free
 * pass, then the paid fallback, then the manual route converge instead of
 * cycling. All of it lives in `fact_relink_attempts` (no new table):
 *
 * - Free outcome, per fact row (`outcome = conversation_unresolved`, `reason`
 *   the subject-inference miss). Only the reasons `RELINK_REASONS` memoizes
 *   (`ambiguous`, `unverified_match`: the user has to act) stay tried for
 *   good. Any other miss (`no_page`, `no_mention`, `withdrawn`) is re-armed
 *   by a page created in the source after the attempt, since a new entity page
 *   can resolve it for free; until then the paid fallback is next.
 * - Paid attempt, per page and content (`tier = paid_reextract`, `target_slug`
 *   the page, `reason` its `content_hash`, `fact_id` the page's completion
 *   outcome row): written whenever an extraction of the page completes,
 *   because the extractor already ran with entity hints and write-time
 *   inference on that content. While it matches the page's current content,
 *   rows still unresolved there are informational (link by hand); a content
 *   change re-arms the paid fallback.
 */
import type { BrainEngine } from '../engine.ts';
import { TERMINAL_AUDIT_SOURCE } from './audit-sources.ts';
import { CONVERSATION_UNRESOLVED, RELINK_REASONS } from './relink-reasons.ts';

export const PAID_REEXTRACT = 'paid_reextract';

const REARMED = Object.entries(RELINK_REASONS).filter(([, r]) => !r.memoized).map(([code]) => `'${code}'`).join(', ');

/** SQL (fact alias `f`): the free relink already tried this row, and no page created since has re-armed an unmemoized miss. */
export const conversationTriedSql = `EXISTS (SELECT 1 FROM fact_relink_attempts a WHERE a.source_id = f.source_id AND a.fact_id = f.id
  AND a.outcome = '${CONVERSATION_UNRESOLVED}'
  AND NOT (a.reason IN (${REARMED}) AND EXISTS (SELECT 1 FROM pages np WHERE np.source_id = f.source_id AND np.deleted_at IS NULL AND np.created_at > a.attempted_at)))`;

/** SQL (fact alias `f`): an extraction of this row's page completed on the page's current content. */
export const conversationPaidSql = `EXISTS (SELECT 1 FROM fact_relink_attempts pa JOIN pages pp ON pp.source_id = pa.source_id AND pp.slug = pa.target_slug AND pp.deleted_at IS NULL
  WHERE pa.source_id = f.source_id AND pa.tier = '${PAID_REEXTRACT}' AND pa.target_slug = f.source_markdown_slug AND pa.reason = COALESCE(pp.content_hash, ''))`;

/** After a page's extraction completes: its paid-attempt memo for the current content (replacing older ones). */
export async function recordReextractMemo(db: BrainEngine, sourceId: string, slug: string): Promise<void> {
  const [table] = await db.executeRaw<{ t: string | null }>(`SELECT to_regclass('fact_relink_attempts')::text AS t`);
  if (!table?.t) return;
  const [outcome] = await db.executeRaw<{ id: number | string; hash: string }>(
    `SELECT f.id, COALESCE(p.content_hash, '') AS hash FROM facts f JOIN pages p ON p.source_id = f.source_id AND p.slug = f.source_markdown_slug AND p.deleted_at IS NULL
      WHERE f.source_id = $1 AND f.source_markdown_slug = $2 AND f.source = $3 AND f.expired_at IS NULL ORDER BY f.id DESC LIMIT 1`, [sourceId, slug, TERMINAL_AUDIT_SOURCE]);
  if (!outcome) return;
  await db.executeRaw(`DELETE FROM fact_relink_attempts WHERE source_id = $1 AND tier = $2 AND target_slug = $3`, [sourceId, PAID_REEXTRACT, slug]);
  await db.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, model, target_slug, run_id, attempted_at)
    VALUES ($1, $2, $3, $4, $3, NULL, $5, NULL, now())
    ON CONFLICT (source_id, fact_id) DO UPDATE SET outcome = EXCLUDED.outcome, reason = EXCLUDED.reason, tier = EXCLUDED.tier, target_slug = EXCLUDED.target_slug, attempted_at = EXCLUDED.attempted_at`,
  [sourceId, Number(outcome.id), PAID_REEXTRACT, outcome.hash, slug]);
}
