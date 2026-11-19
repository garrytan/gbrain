/**
 * Page write guards on visibility: the reads a remote page write runs before it is queued or prepared to learn whether
 * the caller may see the page it names, which of a list of pages the caller reads, and whether a stored writer carries
 * a slug fence. One SQL implementation for both engines. The statement text is what persistence/page-visibility.ts
 * sent through `executeRaw`; the decisions (which policy part applies, what a fence means) stay in that caller.
 *
 * The page policy is rendered here, in the caller's access record (search/private-visibility.ts): `read` is
 * `privatePagesFilterForCaller` (member access, then privacy), `access` is `callerAccessAllowedSql` (member access
 * alone). The caller picks the part: remoteReadPolicySql's choice, or `access` for a caller that refuses privacy itself.
 */
import { callerAccessAllowedSql, privatePagesFilterForCaller } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

/** Which part of the page policy a visibility read applies. */
export type PagePolicyPart = 'read' | 'access';

/** One (source, slug) a caller asked about that names a page row, and whether a live row of it is readable. */
export interface CallerPageAccessRow { source_id: string; slug: string; readable: boolean }

/** Whether a row of page `slug` of `sourceId` (live or soft-deleted) fails the current caller's policy `opts.policy`. */
export async function readPageHiddenFromCaller(exec: LegacyUnscopedRead, sourceId: string, slug: string, opts: { policy: PagePolicyPart }): Promise<boolean> {
  const { rows } = await exec.run(
    sqlFragment`SELECT 1 FROM pages WHERE source_id=${sourceId} AND slug=${slug} AND NOT ${trustedSql(opts.policy === 'access' ? callerAccessAllowedSql('pages') : privatePagesFilterForCaller('pages'))} LIMIT 1`);
  return rows.length > 0;
}

/**
 * For each (source_id, slug) among `pages` that names a page row (soft-deleted rows included), whether a live row of
 * it passes the current caller's policy. One row per pair, in no set order.
 */
export async function readCallerPageAccess(exec: LegacyUnscopedRead, pages: readonly { source_id: string; slug: string }[], opts: { policy: PagePolicyPart }): Promise<CallerPageAccessRow[]> {
  const { rows } = await exec.run<CallerPageAccessRow>(sqlFragment`SELECT p.source_id, p.slug,
      bool_or(p.deleted_at IS NULL AND ${trustedSql(opts.policy === 'access' ? callerAccessAllowedSql('p') : privatePagesFilterForCaller('p'))}) AS readable FROM pages p
    JOIN unnest(${pages.map(p => p.source_id)}::text[], ${pages.map(p => p.slug)}::text[]) AS t(source_id, slug) ON p.source_id = t.source_id AND p.slug = t.slug
    GROUP BY p.source_id, p.slug`);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug, readable: r.readable === true }));
}

const OAUTH_CLIENT_FENCE_SQL = 'SELECT bound_slug_prefixes AS prefixes FROM oauth_clients WHERE client_id=$1';
const LOCAL_WRITER_FENCE_SQL = "SELECT grant_ceiling->'slugPrefixes' AS prefixes FROM persistence_local_writers WHERE id=$1::uuid";

/**
 * The slug fence a stored writer carries now: an OAuth client's `bound_slug_prefixes`, or a local writer's grant
 * ceiling `slugPrefixes`. Null when the principal has none, its row is gone, or its kind carries no fence (no read).
 */
export async function readWriterSlugFence(exec: LegacyUnscopedRead, principal: { kind: string; id: string }): Promise<unknown> {
  const sql = principal.kind === 'oauth_client' ? OAUTH_CLIENT_FENCE_SQL
    : principal.kind === 'local_cli' || principal.kind === 'local_stdio' ? LOCAL_WRITER_FENCE_SQL : null;
  if (sql === null) return null;
  const [row] = await exec.executeRaw<{ prefixes: unknown }>(sql, [principal.id]);
  return row?.prefixes ?? null;
}
