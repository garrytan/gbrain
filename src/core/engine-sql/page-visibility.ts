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
import { readPolicyFragment } from '../search/private-visibility.ts';
import type { LegacyUnscopedRead } from './brands.ts';
import { sqlFragment, trustedSql } from './fragment.ts';

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
