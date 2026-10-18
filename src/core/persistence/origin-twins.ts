/**
 * #6948: duplicate-origin twins. Two or more live pages of one source recording the same origin (`source_id`,
 * `source_path`) used to make managed sync refuse the whole source. This module holds the one rule that decides what
 * happens to such a group, shared by sync discovery (src/core/persistence/sync-discovery.ts), the sync-time heal and
 * `gbrain repair origin-twins`, so the three never disagree.
 *
 * A group resolves on its own only when the claimants are positively verified duplicates: exactly one claimant's slug is
 * the slug the file's path gives (`resolveSlugForPath`, the canonical page), every claimant holds the same inline body
 * (`compiled_truth` and `timeline`; frontmatter may differ, a segmented body is unknown), the file is present and its frontmatter readable, no two explicit frontmatter ids among the file and
 * the claimants differ, all claimants share one visibility and one trust tier, no twin has slug-keyed fact withdrawals or purges, and no
 * twin has a file of its own at its slug path. Anything else is a decision for a
 * person, and sync holds only that file (`origin_conflict`). Missing evidence never counts as agreement.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveSlugForPath } from '../sync.ts';
import { explicitIdVeto } from '../sync-rename-identity.ts';
import type { BrainEngine } from '../engine.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';

/** The kill switch for the sync-time auto-resolve (default on), modelled on `sync.slug_conflicts.auto_remove`. */
export const ORIGIN_TWINS_AUTO_RESOLVE_KEY = 'sync.origin_twins.auto_resolve';

/** `pages.database_only_reason` of a page that gave its origin up to a duplicate: it never writes or removes a file again (restore, purge). */
export const ORIGIN_TWIN_REASON = 'origin_twin';

/** Whether a page carries the `origin_twin` marker (file-target preparation honours it). */
export async function isOriginTwinPage(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, slug: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ database_only_reason: string | null }>('SELECT database_only_reason FROM pages WHERE source_id=$1 AND slug=$2', [sourceId, slug]);
  return row?.database_only_reason === ORIGIN_TWIN_REASON;
}

/** The read-only preview of every twin group of a source (`gbrain repair origin-twins`). */
export const originTwinsPreviewArgv = (sourceId: string) => ['gbrain', 'repair', 'origin-twins', '--source', sourceId];

/** One live page recording the origin. */
export interface OriginClaimant { id: number; slug: string; revision: string; body_hash: string | null; fm_id: string | null;
  /** Remote readers cannot see the page (the read-side private rule). */
  private: boolean;
  /** Fact withdrawals or purges are keyed to the page's slug: moving its facts could bring a forgotten claim back. */
  restricted: boolean;
  /** The page's memory trust tier; a merge never raises or lowers one, so differing tiers hold. */
  trust_tier: string | null }

/**
 * The verdict inputs of live pages, by id: the inline body digest (`compiled_truth` and `timeline`; NULL for a segmented
 * body, so unknown never matches), the explicit frontmatter id, privacy and slug-keyed withdrawals or purges.
 */
export async function readOriginClaimants(engine: Pick<BrainEngine, 'executeRaw'>, sourceId: string, ids: readonly number[]): Promise<OriginClaimant[]> {
  const rows = await engine.executeRaw<{ id: number; slug: string; revision: string; body_hash: string | null; fm_id: string | null; private: boolean; restricted: boolean; trust_tier: string | null }>(
    `SELECT p.id, p.slug, p.knowledge_revision::text AS revision,
       CASE WHEN p.compiled_truth IS NULL THEN NULL ELSE md5(p.compiled_truth) || md5(COALESCE(p.timeline, '')) END AS body_hash,
       p.frontmatter->>'id' AS fm_id, p.trust_tier::text AS trust_tier, (${privatePagesFilterFragment('p')}) AS private,
       (EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=p.source_id AND w.subject=p.slug)
         OR EXISTS (SELECT 1 FROM fact_purges f WHERE f.source_id=p.source_id AND f.subject=p.slug)) AS restricted
     FROM pages p WHERE p.source_id=$1 AND p.id=ANY($2::bigint[]) AND p.deleted_at IS NULL ORDER BY p.id`, [sourceId, [...ids]]);
  return rows.map(row => ({ id: Number(row.id), slug: row.slug, revision: String(row.revision), body_hash: row.body_hash, fm_id: row.fm_id,
    private: row.private === true, restricted: row.restricted === true, trust_tier: row.trust_tier ?? null }));
}

export type OriginConflictReason = 'no_canonical_claimant' | 'content_differs' | 'file_unreadable' | 'explicit_id_conflict' | 'visibility_differs'
  | 'trust_tier_differs' | 'twin_has_withdrawals' | 'twin_slug_path_occupied'
  /** A twin holds a link, relationship date, timeline entry or raw payload its survivor holds differently (persistence/twin-merge.ts). */
  | 'twin_evidence_conflicts';

export type OriginTwinVerdict =
  | { verdict: 'resolve'; canonical: string; survivor: OriginClaimant; twins: OriginClaimant[] }
  | { verdict: 'hold'; canonical: string; reason: OriginConflictReason; claimants: OriginClaimant[] };

export interface OriginTwinInput {
  /** The origin, in the form sync records it. */
  sourcePath: string;
  /** Every live page recording the origin (two or more). */
  claimants: readonly OriginClaimant[];
  /** The file's explicit frontmatter id (null: it has none); undefined when the file is missing or cannot be read. */
  fileId: string | null | undefined;
  /** Whether a file exists at a claimant's own slug path (it would be another document's page); omitted means none. */
  slugPathOccupied?: (slug: string) => boolean;
}

/** What discovery records on an entry several live pages claim; the freeze holds it `origin_conflict`. No `reason`: the group resolves on its own. */
export interface OriginConflict { canonical: string; claimants: OriginClaimant[]; reason?: OriginConflictReason }

/** Whether a Markdown file exists at a page's own slug path in the source's checkout (origin form: under the slug root). */
export function slugPathOccupied(context: { root: string; gitRoot: string; slugMode: 'git-root' | 'source-root' }): (slug: string) => boolean {
  const base = context.slugMode === 'source-root' ? context.root : context.gitRoot;
  return slug => ['.md', '.mdx'].some(ext => existsSync(join(base, `${slug}${ext}`)));
}

/** The verdict for one group of live pages recording one origin. Pure: callers read the rows and the file. */
export function decideOriginTwins(input: OriginTwinInput): OriginTwinVerdict {
  const canonical = resolveSlugForPath(input.sourcePath);
  const claimants = [...input.claimants].sort((a, b) => Number(a.id) - Number(b.id));
  const hold = (reason: OriginConflictReason): OriginTwinVerdict => ({ verdict: 'hold', canonical, reason, claimants });
  const survivors = claimants.filter(page => page.slug === canonical);
  if (survivors.length !== 1) return hold('no_canonical_claimant');
  const survivor = survivors[0]!;
  const twins = claimants.filter(page => page !== survivor);
  if (survivor.body_hash === null || twins.some(page => page.body_hash !== survivor.body_hash)) return hold('content_differs');
  if (input.fileId === undefined) return hold('file_unreadable');
  const ids = [input.fileId, ...claimants.map(page => page.fm_id)];
  if (ids.some(a => ids.some(b => explicitIdVeto(a, b)))) return hold('explicit_id_conflict');
  if (twins.some(page => page.private !== survivor.private)) return hold('visibility_differs');
  if (twins.some(page => page.trust_tier !== survivor.trust_tier)) return hold('trust_tier_differs');
  if (twins.some(page => page.restricted)) return hold('twin_has_withdrawals');
  if (twins.some(page => input.slugPathOccupied?.(page.slug))) return hold('twin_slug_path_occupied');
  return { verdict: 'resolve', canonical, survivor, twins };
}
