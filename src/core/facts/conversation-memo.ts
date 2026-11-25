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
import { answersFromCatalog, catalogTableExists } from '../rust-engine/store-members/catalog.ts';
import { CONVERSATION_UNRESOLVED, RELINK_REASONS } from './relink-reasons.ts';

export const PAID_REEXTRACT = 'paid_reextract';

/** The miss reasons a page created at or after the attempt re-arms: every `RELINK_REASONS` entry that is not memoized. */
export const REARMED_REASONS: string[] = Object.entries(RELINK_REASONS).filter(([, r]) => !r.memoized).map(([code]) => code);

const REARMED = REARMED_REASONS.map(code => `'${code}'`).join(', ');

/**
 * SQL (fact alias `f`): the free relink already tried this row, and no page created since has re-armed an unmemoized miss.
 * A page stamped in the attempt's own clock tick counts as created since (`>=`): PGLite's clock moves in whole
 * milliseconds, so a strict `>` left a miss memoized for good when the page landed in that millisecond. At worst the
 * relink tries the row once more.
 */
export const conversationTriedSql = `EXISTS (SELECT 1 FROM fact_relink_attempts a WHERE a.source_id = f.source_id AND a.fact_id = f.id
  AND a.outcome = '${CONVERSATION_UNRESOLVED}'
  AND NOT (a.reason IN (${REARMED}) AND EXISTS (SELECT 1 FROM pages np WHERE np.source_id = f.source_id AND np.deleted_at IS NULL AND np.created_at >= a.attempted_at)))`;

/** SQL (fact alias `f`): an extraction of this row's page completed on the page's current content. */
export const conversationPaidSql = `EXISTS (SELECT 1 FROM fact_relink_attempts pa JOIN pages pp ON pp.source_id = pa.source_id AND pp.slug = pa.target_slug AND pp.deleted_at IS NULL
  WHERE pa.source_id = f.source_id AND pa.tier = '${PAID_REEXTRACT}' AND pa.target_slug = f.source_markdown_slug AND pa.reason = COALESCE(pp.content_hash, ''))`;

/**
 * Whether the brain has the `fact_relink_attempts` table. The Rust engine answers from its `facts` capability
 * (rust-engine/store-members/catalog.ts); PGLite and Postgres ask the catalog.
 */
export async function hasRelinkAttemptsTable(db: BrainEngine): Promise<boolean> {
  if (answersFromCatalog(db)) return catalogTableExists(db, 'fact_relink_attempts');
  return db.factRelinkAttemptsTableExists();
}

/** After a page's extraction completes: its paid-attempt memo for the current content (replacing older ones). */
export async function recordReextractMemo(db: BrainEngine, sourceId: string, slug: string): Promise<void> {
  if (!await hasRelinkAttemptsTable(db)) return;
  const outcome = await db.readReextractOutcomeRow(sourceId, slug);
  if (!outcome) return;
  await db.deleteFactRelinkMemos(sourceId, PAID_REEXTRACT, slug);
  await db.upsertFactRelinkAttempt(sourceId,
    { factId: Number(outcome.id), outcome: PAID_REEXTRACT, reason: outcome.hash, tier: PAID_REEXTRACT, model: null, targetSlug: slug, runId: null },
    { keepModelAndRun: true });
}
