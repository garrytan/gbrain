/**
 * The two reads of the admin operations (src/core/ops/admin.ts) that ran through `executeRaw`: which of the
 * `most_connected` slugs a remote caller may see, and the live pages the version history of a page belongs to.
 * The text and binds are the ones the operations built inline; the page policy part is picked by the caller
 * (`resolveExcludePrivatePages`) and rendered here in the caller's access record (search/private-visibility.ts).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { PagePolicyPart } from './page-visibility.ts';
import { callerAccessAllowedSql, privatePagesFilterForCaller } from '../search/private-visibility.ts';

export type { EngineRawRead, PagePolicyPart };

/** The statement up to the page policy; `$1` is the slugs and `$2` the source scope, which the text uses twice. */
const VISIBLE_SLUGS_HEAD = `SELECT DISTINCT p.slug FROM pages p
    WHERE p.slug = ANY($1::text[]) AND p.deleted_at IS NULL AND ($2::text[] IS NULL OR p.source_id = ANY($2::text[]))
      AND `;

/**
 * The slugs among `slugs` that name a live page the caller's policy part admits, within the source scope when one is given
 * (`null` admits every source). Call inside the caller's access record.
 */
export async function listVisiblePageSlugs(raw: EngineRawRead, slugs: string[], sourceIds: string[] | null, policy: PagePolicyPart): Promise<string[]> {
  const sql = renderFragment(sqlFragment`${trustedSql(VISIBLE_SLUGS_HEAD)}${trustedSql(policy === 'access' ? callerAccessAllowedSql('p') : privatePagesFilterForCaller('p'))}`);
  const rows = await raw<{ slug: string }>(sql.text, [slugs, sourceIds]);
  return rows.map(r => r.slug);
}

export interface VersionPageRow { id: number | string; slug: string; source_id: string; frontmatter: Record<string, unknown> }

/** The live pages with these ids: slug, source and frontmatter, which the version history uses to hide quarantined bodies. */
export async function readPagesForVersionHistory(raw: EngineRawRead, pageIds: number[]): Promise<VersionPageRow[]> {
  return raw<VersionPageRow>('SELECT id, slug, source_id, frontmatter FROM pages WHERE id = ANY($1::bigint[])', [pageIds]);
}
