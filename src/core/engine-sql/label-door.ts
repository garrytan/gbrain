/**
 * The reads and the one write of `delete_page`'s derived-origin carry (repair/origin-carry.ts) and of the label door
 * (repair/label-write.ts, trust/page-write.ts `raisePageLabelGuard`): whether a page is a privacy origin, the pages its
 * removal would open, the recorded files of pages in a checkout, a page's stored labels and its label guard.
 *
 * The privacy rules are `privacyPartSql`, which reads the process's alias-honoring setting (`readHonorAliases`): the
 * caller reads it first. A Rust brain answers the same rows from its records (src/core/rust-engine/store-members/label-door.ts).
 */
import type { BrainEngine } from '../engine.ts';
import { dependentsSql } from '../repair/dependents-sql.ts';
import { privacyPartSql } from '../search/private-visibility.ts';
import type { TrustTier } from '../trust/tier.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type RawSql = Pick<BrainEngine, 'executeRaw'>;

const bounded = { timeoutMs: 120_000, jitOff: true, prepare: false };

/** A page whose removal can open another: an atom, or a page the privacy rules hide. */
export interface PrivacyOriginRow { id: number; deleted: boolean }
/** One page about to be removed. */
export interface OriginRefInput { id: number; source_id: string; slug: string }
/** One page the removal of `cleared_id` would open, as stored now. */
export interface OriginDependentRow { id: number; cleared_id: number; source_id: string; slug: string; deleted: boolean }
/** One page with a recorded file, with its source's checkout. */
export interface CheckoutFileRow { id: number; source_id: string; source_path: string; local_path: string | null }
/** A page's id and stored frontmatter. */
export interface PageLabelRow { id: number; frontmatter: Record<string, unknown> | null }

/** The page at (sourceId, slug), soft-deleted or not, when it is a privacy origin; else null. */
export async function readPrivacyOrigin(engine: RawSql, sourceId: string, slug: string): Promise<PrivacyOriginRow | null> {
  const { text, params } = renderFragment(sqlFragment`SELECT p.id, p.deleted_at IS NOT NULL AS deleted FROM pages p
    WHERE p.source_id = ${sourceId} AND p.slug = ${slug} AND (p.type = 'atom' OR NOT ${trustedSql(privacyPartSql('p'))})`);
  const [row] = await engine.executeRaw<{ id: number; deleted: boolean }>(text, params, bounded);
  return row ? { id: Number(row.id), deleted: row.deleted === true } : null;
}

/** private-labels.ts dependentsSql('remove') over `origins`, each with its page as stored, by (id, cleared_id). */
export async function listOriginDependents(engine: RawSql, origins: readonly OriginRefInput[]): Promise<OriginDependentRow[]> {
  if (!origins.length) return [];
  const rows = await engine.executeRaw<{ id: number; cleared_id: number; source_id: string; slug: string; deleted: boolean }>(
    `SELECT d.id, d.cleared_id, p.source_id, p.slug, p.deleted_at IS NOT NULL AS deleted FROM (${dependentsSql('remove')}) d
      JOIN LATERAL (SELECT pages.source_id, pages.slug, pages.deleted_at FROM pages WHERE pages.id = d.id OFFSET 0) p ON true ORDER BY d.id, d.cleared_id`,
    [origins.map(o => o.id), origins.map(o => o.source_id), origins.map(o => o.slug), origins.map(() => '')], bounded);
  return rows.map(row => ({ id: Number(row.id), cleared_id: Number(row.cleared_id), source_id: row.source_id, slug: row.slug, deleted: row.deleted === true }));
}

/** Each page among `pageIds` with a recorded file (`source_path`), with its source's `local_path`, by id. */
export async function listCheckoutFiles(engine: RawSql, pageIds: readonly number[]): Promise<CheckoutFileRow[]> {
  if (!pageIds.length) return [];
  const rows = await engine.executeRaw<{ id: number; source_id: string; source_path: string; local_path: string | null }>(`SELECT p.id, p.source_id, p.source_path, s.local_path
    FROM pages p JOIN sources s ON s.id = p.source_id WHERE p.id = ANY($1::integer[]) AND p.source_path IS NOT NULL ORDER BY p.id`, [[...pageIds]], { timeoutMs: 120_000 });
  return rows.map(row => ({ id: Number(row.id), source_id: row.source_id, source_path: row.source_path, local_path: row.local_path ?? null }));
}

/** The page at (sourceId, slug), soft-deleted or not: its id and stored frontmatter. */
export async function readPageLabelRow(engine: RawSql, sourceId: string, slug: string): Promise<PageLabelRow | null> {
  const [row] = await engine.executeRaw<{ id: number; frontmatter: Record<string, unknown> | null }>('SELECT id, frontmatter FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]);
  return row ? { id: Number(row.id), frontmatter: row.frontmatter ?? null } : null;
}

/** The tiers a label guard over a page raises to (trust/page-write.ts `labelGuardTier`). */
export interface LabelGuardTiers { owner_set: string | null; priors: (string | null)[] | null }

/**
 * The page's label guard tier (`owner_set`, GST-2521) and the prior tier of every `lower_page` proposal of the page since
 * the owner last accepted one that was not a labels-only accept (`priors`, GST-2518), as `labelGuardTier` reads them.
 */
export async function readLabelGuardTiers(engine: RawSql, pageId: number): Promise<LabelGuardTiers> {
  const [guard] = await engine.executeRaw<LabelGuardTiers>(`SELECT
      (SELECT tier FROM page_label_guards WHERE page_id = $1) AS owner_set,
      ARRAY(SELECT before_state->>'prior_tier' FROM trust_proposals WHERE target_table = 'pages' AND target_id = $1 AND action = 'lower_page' AND status <> 'accepted'
        AND id > COALESCE((SELECT max(id) FROM trust_proposals WHERE target_table = 'pages' AND target_id = $1 AND action = 'lower_page' AND status = 'accepted'
          AND after_state->>'resolution' IS DISTINCT FROM 'labels_applied'), 0)) AS priors`,
    [pageId]);
  return { owner_set: guard?.owner_set ?? null, priors: guard?.priors ?? [] };
}

/** Sets the page's label guard to `tier`, stamped now, or with null removes it. */
export async function writePageLabelGuard(engine: RawSql, pageId: number, tier: TrustTier | null): Promise<void> {
  if (tier === null) {
    await engine.executeRaw('DELETE FROM page_label_guards WHERE page_id = $1', [pageId]);
    return;
  }
  await engine.executeRaw(`INSERT INTO page_label_guards (page_id, tier) VALUES ($1, $2)
    ON CONFLICT (page_id) DO UPDATE SET tier = EXCLUDED.tier, set_at = now()`, [pageId, tier]);
}
