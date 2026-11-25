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
import { ANY_OWNER_ONLY_SQL, OWNER_ONLY_LINEAGE_PRESENT_SQL, READ_SOURCE_OWNER_ONLY_SQL } from '../access/owner-only.ts';
import { callerAccessAllowedSql, privacyPartSql, privatePagesFilterForCaller, readPolicyFragment } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import type { TimedRawRead } from './entity-reads.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

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

/** The sources a private-only slug read covers: a federated array wins over a scalar; neither reads every source. */
export interface PrivateOnlySlugScope { sourceId?: string; sourceIds?: string[] }

/**
 * The slugs among `slugs` whose every in-scope page row fails the current caller's page policy
 * (`privatePagesFilterForCaller`), live rows only unless `includeDeleted`; a slug with no such row is not named. In no
 * set order (search/private-visibility.ts findPrivateOnlySlugs, get_page's fuzzy candidates). The text is the statement
 * that caller sent through `executeRaw`: the scope clause binds as its second parameter, as it did there.
 */
export async function readPrivateOnlySlugs(exec: TimedRawRead, slugs: readonly string[], scope: PrivateOnlySlugScope = {},
  opts: { includeDeleted?: boolean } = {}): Promise<string[]> {
  if (slugs.length === 0) return [];
  const scoped = scope.sourceIds && scope.sourceIds.length > 0 ? sqlFragment`AND p.source_id = ANY(${scope.sourceIds}::text[])`
    : scope.sourceId ? sqlFragment`AND p.source_id = ${scope.sourceId}` : sqlFragment``;
  const { text, params } = renderFragment(sqlFragment`SELECT p.slug FROM pages p
      WHERE p.slug = ANY(${slugs}::text[])
        ${trustedSql(opts.includeDeleted ? '' : 'AND p.deleted_at IS NULL')}
        ${scoped}
      GROUP BY p.slug
      HAVING bool_and(NOT (${trustedSql(privatePagesFilterForCaller('p'))}))`);
  const rows = await exec.executeRaw<{ slug: string }>(text, params);
  return rows.map(r => r.slug);
}

/**
 * The opening read of a remote page write's visibility check (authorizePageVisibility), one statement: whether any
 * access member is labelled-only, whether a reader identity could open the page `slug` of `sourceId` that the
 * empty-identity policy with privacy hides (null when no row of it, live or soft-deleted, is hidden; else whether the
 * row names readers or sits under a folder rule), and whether that source, or any source, is owner-only.
 */
export interface WriteVisibilityProbe { any_labelled: boolean; identity_may_open: boolean | null; owner_only_source: boolean; owner_only_any: boolean }

/**
 * readWriteVisibilityProbe: see WriteVisibilityProbe. Undefined only when the statement returns no row. The text is
 * the statement authorizePageVisibility sent through `executeRaw`, with the source id bound a second time for the
 * owner-only source test (`ownerOnlySourceSql`) instead of reusing `$1`. `ownerOnlyLineage` (from `ownerOnlyLineageReadable(engine)`)
 * makes the guard also read the marks a hard delete left (GST-2687, v322); the default is the source test alone.
 */
export async function readWriteVisibilityProbe(exec: LegacyUnscopedRead, sourceId: string, slug: string, ownerOnlyLineage: boolean = false): Promise<WriteVisibilityProbe | undefined> {
  const { rows: [row] } = await exec.run<WriteVisibilityProbe>(
    sqlFragment`SELECT EXISTS (SELECT 1 FROM access_members WHERE labelled_only) AS any_labelled, (SELECT (page_readers IS NOT NULL OR folder_rule_ids IS NOT NULL) FROM pages
      WHERE source_id=${sourceId} AND slug=${slug} AND NOT (${trustedSql(readPolicyFragment('pages', [], true))}) LIMIT 1) AS identity_may_open,
          EXISTS (SELECT 1 FROM sources read_source WHERE read_source.id = ${sourceId} AND ${trustedSql(READ_SOURCE_OWNER_ONLY_SQL)}) AS owner_only_source, ${trustedSql(ownerOnlyLineage ? OWNER_ONLY_LINEAGE_PRESENT_SQL : ANY_OWNER_ONLY_SQL)} AS owner_only_any`);
  return row;
}

/**
 * Whether the live page `slug` of `sourceId` fails the privacy part of the remote read policy (privacyPartSql: visibility,
 * privacy aliases, pinned questions, derived types and lineage); null when it has no live page. The caller reads
 * visibility.honor_aliases first (readHonorAliases), as remote reads do. The text is what ownerRewriteOf sent through `executeRaw`.
 */
export async function readPagePrivacyHidden(exec: LegacyUnscopedRead, sourceId: string, slug: string): Promise<boolean | null> {
  const { rows: [row] } = await exec.run<{ hidden: boolean }>(sqlFragment`SELECT NOT (${trustedSql(privacyPartSql('p'))}) AS hidden FROM pages p
    WHERE p.source_id = ${sourceId} AND p.slug = ${slug} AND p.deleted_at IS NULL`);
  return row ? row.hidden === true : null;
}

const OAUTH_CLIENT_FENCE_SQL = 'SELECT bound_slug_prefixes AS prefixes FROM oauth_clients WHERE client_id=$1';
const OAUTH_CLIENT_DELEGATED_FENCE_SQL = 'SELECT delegated_slug_prefixes AS prefixes FROM oauth_clients WHERE client_id=$1';
const LOCAL_WRITER_FENCE_SQL = "SELECT grant_ceiling->'slugPrefixes' AS prefixes FROM persistence_local_writers WHERE id=$1::uuid";

/**
 * The slug fence a stored writer carries now: an OAuth client's `bound_slug_prefixes` (its `delegated_slug_prefixes`
 * for a delegated write, `opts.delegated`), or a local writer's grant ceiling `slugPrefixes`. Null when the principal
 * has none, its row is gone, or its kind carries no fence (no read).
 */
export async function readWriterSlugFence(exec: LegacyUnscopedRead, principal: { kind: string; id: string }, opts?: { delegated?: boolean }): Promise<unknown> {
  const sql = principal.kind === 'oauth_client' ? (opts?.delegated ? OAUTH_CLIENT_DELEGATED_FENCE_SQL : OAUTH_CLIENT_FENCE_SQL)
    : principal.kind === 'local_cli' || principal.kind === 'local_stdio' ? LOCAL_WRITER_FENCE_SQL : null;
  if (sql === null) return null;
  const [row] = await exec.executeRaw<{ prefixes: unknown }>(sql, [principal.id]);
  return row?.prefixes ?? null;
}
