/**
 * The privacy scans of `gbrain repair visibility` (src/core/repair/visibility.ts) that ran through `executeRaw`: the
 * atom-lineage rows (planLineage), the Life Chronicle event rows (planEvents) and the alias-only private pages
 * (planAliases). Each runs the statement its caller ran, with the same text and parameters; only its home moved.
 */
import { folderRestrictedSql, privacyAliasSql } from '../search/private-visibility.ts';
import { atomMovedOriginPrivateSql, atomOriginSlugSql } from '../persistence/atom-origin.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

/** A derived page with its stored visibility and its body length in characters (null for a segmented page). */
export interface VisibilityDerivedRow { id: number; source_id: string; slug: string; type: string; visibility: string | null; chars: number }
/** An atom, its origin page (by its `source_slug`, else the slug a rename moved it to) and whether a rename moved its origin to a private page. */
export interface VisibilityAtomRow extends VisibilityDerivedRow { source_slug: string | null; origin_id: number | null; origin_type: string | null;
  origin_frontmatter: Record<string, unknown> | null; origin_folder_restricted: boolean; origin_moved_private: boolean }
/** A Life Chronicle event and the live page its `event.depth` names. */
export interface VisibilityEventRow extends VisibilityDerivedRow { origin_id: number | null; origin_type: string | null;
  origin_frontmatter: Record<string, unknown> | null; origin_folder_restricted: boolean }

/** Pages that carry a privacy alias but no `visibility` (derived atoms, concepts and chronicle events have their own phases). */
export function aliasOnlyPagesSql(p: string): string {
  return `(${p}.deleted_at IS NULL AND ${p}.frontmatter->>'visibility' IS NULL AND ${privacyAliasSql(p)}
    AND ${p}.type <> 'atom' AND NOT (${p}.type = 'concept' AND ${p}.frontmatter->>'synthesized_by' IS NOT NULL)
    AND NOT (${p}.type = 'event' AND ${p}.frontmatter->>'captured_via' LIKE 'life-chronicle:%'))`;
}

/** Hand-numbered statement text: the fragment must bind nothing ahead of the parameters the caller passes. */
function handNumbered(member: string, fragment: ReturnType<typeof sqlFragment>): string {
  const { text, params } = renderFragment(fragment);
  if (params.length !== 0) throw new Error(`${member}: a fragment bound a value ahead of the hand-numbered parameters`);
  return text;
}

/** The live atoms of these sources (only `atomIds` when given) with their origin, by id. */
export async function listAtomLineageRows(raw: EngineRawRead, sourceIds: string[], atomIds: number[] | null, timeoutMs: number): Promise<VisibilityAtomRow[]> {
  const text = handNumbered('listAtomLineageRows', sqlFragment`${trustedSql(`SELECT a.id,a.source_id,a.slug,a.type,a.frontmatter->>'visibility' AS visibility,
      length(a.compiled_truth) AS chars, a.frontmatter->>'source_slug' AS source_slug,
      o.id AS origin_id,o.type AS origin_type,o.frontmatter AS origin_frontmatter,
      (o.id IS NOT NULL AND `)}${trustedSql(folderRestrictedSql('o'))}${trustedSql(`) AS origin_folder_restricted, `)}${trustedSql(atomMovedOriginPrivateSql('a'))}${trustedSql(` AS origin_moved_private
    FROM pages a LEFT JOIN pages o ON o.source_id=a.source_id AND o.slug=`)}${trustedSql(atomOriginSlugSql('a'))}${trustedSql(` AND o.deleted_at IS NULL
    WHERE a.type='atom' AND a.deleted_at IS NULL AND a.source_id=ANY($1::text[])
      AND ($2::integer[] IS NULL OR a.id=ANY($2::integer[])) ORDER BY a.id`)}`);
  return raw<VisibilityAtomRow>(text, [sourceIds, atomIds], { timeoutMs });
}

/** The Life Chronicle events of these sources (only `ids` when given) not already private, with their origin, by id. */
export async function listChronicleEventVisibilityRows(raw: EngineRawRead, sourceIds: string[], ids: number[] | null, timeoutMs: number): Promise<VisibilityEventRow[]> {
  const text = handNumbered('listChronicleEventVisibilityRows', sqlFragment`${trustedSql(`SELECT e.id,e.source_id,e.slug,e.type,e.frontmatter->>'visibility' AS visibility,
      length(e.compiled_truth) AS chars,o.id AS origin_id,o.type AS origin_type,o.frontmatter AS origin_frontmatter,
      (o.id IS NOT NULL AND `)}${trustedSql(folderRestrictedSql('o'))}${trustedSql(`) AS origin_folder_restricted
    FROM pages e LEFT JOIN pages o ON o.source_id=e.source_id AND o.slug=e.frontmatter->'event'->>'depth' AND o.deleted_at IS NULL
    WHERE e.type='event' AND e.frontmatter->>'captured_via' LIKE 'life-chronicle:%' AND e.deleted_at IS NULL
      AND COALESCE(e.frontmatter->>'visibility','world')<>'private'
      AND e.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR e.id=ANY($2::integer[])) ORDER BY e.id`)}`);
  return raw<VisibilityEventRow>(text, [sourceIds, ids], { timeoutMs });
}

/** The pages of these sources (only `ids` when given) that a privacy alias alone makes private, by id. */
export async function listAliasOnlyPrivatePages(raw: EngineRawRead, sourceIds: string[], ids: number[] | null, timeoutMs: number): Promise<VisibilityDerivedRow[]> {
  const text = handNumbered('listAliasOnlyPrivatePages', sqlFragment`${trustedSql(`SELECT p.id,p.source_id,p.slug,p.type,NULL::text AS visibility,length(p.compiled_truth) AS chars
    FROM pages p WHERE `)}${trustedSql(aliasOnlyPagesSql('p'))}${trustedSql(` AND p.source_id=ANY($1::text[]) AND ($2::integer[] IS NULL OR p.id=ANY($2::integer[])) ORDER BY p.id`)}`);
  return raw<VisibilityDerivedRow>(text, [sourceIds, ids], { timeoutMs });
}
