/**
 * #7013: atoms a managed re-extraction retired that `gbrain repair atoms-restore` can bring back, as one SQL rule
 * shared by the repair (preview, apply recheck and coordinated preparer), the `atom_retirements_restorable` doctor
 * check and the purge hold. Static strings only, so `engine-sql/pages.ts` may import it.
 *
 * `atomRetirementsSql(scope)` returns one row per re-extraction retirement in scope: a soft-deleted, non-imported
 * atom stamped `retired_by: managed-reextract`, with its origin (`source_slug` page, else `source_path` transcript),
 * stripped source hash (a `pending:` prefix removed) and three verdicts:
 *   - `origin_live`: a page origin is a live page of the same source (a transcript cannot be checked in SQL);
 *   - `replaced`: a live, non-imported atom of the same source and origin carries a different hash, so a later
 *     generation replaced it;
 *   - `latest`: its hash is the hash of the origin's most recently retired `managed-reextract` atom, so an older
 *     generation that a later extraction replaced is never revived.
 * `restorable` is `origin_live AND NOT replaced AND latest`. GBRA-161 PR 1b: `ledger_generation` is the live atom generation
 * whose ledger records the retirement (null for a legacy stamp alone); doctor reports a covered atom once, through the
 * ledger (`generation_retirements`), and `atoms-restore` still restores it on a managed brain. The query is set-based (each CTE reads `pages` once,
 * joined on source and origin), so its cost grows linearly with the atoms in scope.
 *
 * The purge (engine bulk delete and preview, the belief-ledger expiry, the managed selection) holds a restorable
 * atom for `ATOM_RESTORE_HOLD_DAYS` after its `deleted_at` (`atomRetirementPurgeHold`); an explicit
 * `gbrain delete --purge` is not held.
 */

/** The stamp `prepareManagedAtomMutation` writes on a re-extraction retirement (`ATOM_RETIRED_BY_REEXTRACT`). */
export const ATOM_REEXTRACT_RETIRED_BY = 'managed-reextract';

/** Days after `deleted_at` that the purge keeps a restorable atom. */
export const ATOM_RESTORE_HOLD_DAYS = 30;

const strippedHash = (alias: string) => `regexp_replace(COALESCE(${alias}.frontmatter->>'source_hash',''),'^pending:','')`;
const originKey = (alias: string) => `CASE WHEN NULLIF(${alias}.frontmatter->>'source_slug','') IS NOT NULL THEN 'slug:'||(${alias}.frontmatter->>'source_slug')
      WHEN NULLIF(${alias}.frontmatter->>'source_path','') IS NOT NULL THEN 'path:'||(${alias}.frontmatter->>'source_path') END`;
const notImported = (alias: string) => `NULLIF(${alias}.frontmatter->>'imported_from','') IS NULL`;

/**
 * SQL: every re-extraction retirement whose page `p` satisfies `scope` (a predicate over the `pages` alias `p`; it
 * also narrows the live atoms the replacement check reads, so scope by source or by origin, never by atom), with
 * columns id, source_id, slug, origin_kind, origin, origin_page_id, hash, retired_at, origin_live, replaced, latest,
 * restorable and ledger_generation.
 */
export function atomRetirementsSql(scope = 'true'): string {
  return `WITH retired AS (
      SELECT p.id, p.source_id, p.slug, ${originKey('p')} AS okey, NULLIF(p.frontmatter->>'source_slug','') AS origin_slug,
             COALESCE(NULLIF(p.frontmatter->>'source_slug',''), p.frontmatter->>'source_path') AS origin,
             ${strippedHash('p')} AS hash, p.frontmatter->>'retired_at' AS retired_at
        FROM pages p
       WHERE p.type='atom' AND p.deleted_at IS NOT NULL AND p.frontmatter->>'retired_by'='${ATOM_REEXTRACT_RETIRED_BY}' AND ${notImported('p')}
         AND (${scope})
    ), latest AS (
      SELECT DISTINCT ON (source_id, okey) source_id, okey, hash FROM retired WHERE okey IS NOT NULL
       ORDER BY source_id, okey, retired_at DESC NULLS LAST, id DESC
    ), live AS (
      SELECT p.source_id, ${originKey('p')} AS okey, array_agg(DISTINCT ${strippedHash('p')}) AS hashes
        FROM pages p WHERE p.type='atom' AND p.deleted_at IS NULL AND ${notImported('p')} AND (${scope})
       GROUP BY 1, 2
    )
    SELECT r.id, r.source_id, r.slug, CASE WHEN r.origin_slug IS NOT NULL THEN 'page' ELSE 'transcript' END AS origin_kind, r.origin,
           o.id AS origin_page_id, r.hash, r.retired_at,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL)) AS origin_live,
           (lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash])) AS replaced,
           COALESCE(l.hash = r.hash, false) AS latest,
           (r.okey IS NOT NULL AND (r.origin_slug IS NULL OR o.id IS NOT NULL) AND NOT COALESCE(lv.hashes IS NOT NULL AND NOT (lv.hashes <@ ARRAY[r.hash]), false)
             AND COALESCE(l.hash = r.hash, false)) AS restorable,
           (SELECT g.id FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
             WHERE g.source_id=r.source_id AND g.kind='atom' AND g.state='live' AND i.item_key=r.slug AND i.action='retired' ORDER BY g.id DESC LIMIT 1) AS ledger_generation
      FROM retired r
      LEFT JOIN pages o ON o.source_id=r.source_id AND o.slug=r.origin_slug AND o.deleted_at IS NULL
      LEFT JOIN live lv ON lv.source_id=r.source_id AND lv.okey=r.okey
      LEFT JOIN latest l ON l.source_id=r.source_id AND l.okey=r.okey`;
}

/** SQL predicate over `pages` aliased `p`: the page shares its source and origin with the page whose id is `atomIdSql`. */
export function atomOriginScopeSql(atomIdSql: string): string {
  return `p.source_id=(SELECT x.source_id FROM pages x WHERE x.id=${atomIdSql}) AND p.frontmatter @> (SELECT CASE
      WHEN NULLIF(x.frontmatter->>'source_slug','') IS NOT NULL THEN jsonb_build_object('source_slug',x.frontmatter->'source_slug')
      ELSE jsonb_build_object('source_path',x.frontmatter->'source_path') END FROM pages x WHERE x.id=${atomIdSql})`;
}

/** SQL predicate for a purge scan over `pages` aliased `alias`: the page is not a restorable atom inside its hold. */
export function atomRetirementPurgeHold(alias: string): string {
  return `NOT (${alias}.type='atom' AND ${alias}.frontmatter->>'retired_by'='${ATOM_REEXTRACT_RETIRED_BY}'
    AND ${alias}.deleted_at > now() - interval '${ATOM_RESTORE_HOLD_DAYS} days'
    AND ${alias}.id IN (SELECT held.id FROM (${atomRetirementsSql()}) held WHERE held.restorable))`;
}
