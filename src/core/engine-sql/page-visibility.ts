
import type { LegacyUnscopedRead } from './brands.ts';

/**
 * The opening read of a remote page write's visibility check (authorizePageVisibility), one statement: whether any
 * access member is labelled-only, whether a reader identity could open the page `slug` of `sourceId` that the
 * empty-identity policy with privacy hides (null when no row of it, live or soft-deleted, is hidden; else whether the
 * row names readers or sits under a folder rule), and whether that source, or any source, is owner-only.
 */
export interface WriteVisibilityProbe { any_labelled: boolean; identity_may_open: boolean | null; owner_only_source: boolean; owner_only_any: boolean }

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
