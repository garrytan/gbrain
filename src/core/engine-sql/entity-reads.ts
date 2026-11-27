
import { callerAccessAllowedSql, privatePagesFilterForCaller, remoteReadFloorSql } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { ignoredPrivacyLabelSql, NOTICE_READ_TIMEOUT_MS, privacyLabelKeySql, SCAN_CAP } from '../search/ignored-privacy-labels.ts';

/**
 * The page policy a retirement hop applies to the page it reads (alias `p`), rendered in the caller's access record:
 * none, the caller's page policy (`privatePagesFilterForCaller`), the remote read floor (`remoteReadFloorSql`), or
 * member access alone (`callerAccessAllowedSql`).
 */
export type RetirementPrivacy = 'none' | 'caller' | 'floor' | 'member_access';

/**
 * Live pages of one source, by slug (`slugs`) or updated since a database timestamp (`since`), that carry a privacy
 * label gbrain does not recognize and no visibility key (ignored-privacy-labels.ts `ignoredPrivacyLabelSql`), at most
 * `limit` (default SCAN_CAP) of them, in no particular order.
 */
export async function readIgnoredPrivacyLabelPages(exec: TimedRawRead, sourceId: string,
  scope: { slugs: readonly string[] } | { since: string }, opts: { limit?: number; timeoutMs?: number } = {}): Promise<IgnoredLabelPageRow[]> {
  const bySlug = 'slugs' in scope;
  const limit = Math.max(0, Math.floor(opts.limit ?? SCAN_CAP));
  const within = bySlug ? sqlFragment`p.slug = ANY(${[...new Set(scope.slugs)]}::text[])` : sqlFragment`p.updated_at >= ${scope.since}::timestamptz`;
  const { text, params } = renderFragment(sqlFragment`SELECT p.type, p.frontmatter FROM pages p
      WHERE p.source_id = ${sourceId} AND ${within} AND p.deleted_at IS NULL
        AND NOT (p.frontmatter ? 'readable_by') AND p.folder_rule_ids IS NULL
        AND ${trustedSql(privacyLabelKeySql('p'))} AND ${trustedSql(ignoredPrivacyLabelSql('p'))}
      LIMIT ${limit}`);
  return exec.executeRaw<IgnoredLabelPageRow>(text, params, { timeoutMs: opts.timeoutMs ?? NOTICE_READ_TIMEOUT_MS });
}

/**
 * The type and frontmatter of the live page at `slug` in the source, or null (put_page's ignored-label notice reads the
 * page it stored back, so the stored frontmatter decides). `timeoutMs` bounds the Postgres statement.
 */
export async function readLivePageFrontmatter(exec: TimedRawRead, sourceId: string, slug: string,
  opts: { timeoutMs?: number } = {}): Promise<IgnoredLabelPageRow | null> {
  const [page] = await exec.executeRaw<IgnoredLabelPageRow>(
    'SELECT type, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug],
    { timeoutMs: opts.timeoutMs ?? NOTICE_READ_TIMEOUT_MS });
  return page ?? null;
}

/** An executor reduced to the raw path with no options: a scoped transaction's executor and an engine's own `executeRaw` both fit. */
export interface PlainRawRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

export interface IgnoredLabelPageRow { type: string | null; frontmatter: Record<string, unknown> | null }

/**
 * An engine's own `executeRaw`, for the reads whose call sites bound them with `timeoutMs` (a transaction-local
 * `statement_timeout` on Postgres; PGLite ignores it). The engine passes itself so the bound holds as before.
 */
export interface TimedRawRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[], opts?: { timeoutMs?: number }): Promise<R[]>;
}

/**
 * The stored `chunker_version` of the page row with id `pageId`, live, soft-deleted or segmented, as
 * `{ chunker_version }`; null when no row has the id (search/safe-chunks.ts provenanceDistrusted: a negative version
 * is a body write that removed a protected fence).
 */
export async function readPageChunkerVersion(exec: TimedRawRead, pageId: number): Promise<{ chunker_version: number | null } | null> {
  const [row] = await exec.executeRaw<{ chunker_version: number | null }>('SELECT chunker_version FROM pages WHERE id = $1', [pageId]);
  return row ? { chunker_version: row.chunker_version === null ? null : Number(row.chunker_version) } : null;
}

/**
 * Whether the image page at `slug` of the source (any row, live or soft-deleted) carries chunks sealed past the
 * safe-chunk fence, as `{ has_visual }` (whether any chunk holds an image vector); null when no row passes the fence
 * (import-file.ts importImageFile: an unchanged image whose index is complete is skipped). The fence test is written
 * out (`safeChunksFilter('p')`, SAFE_FENCE_CHUNKER_VERSION 4); the caller raw-SQL pins rebuild it from the builder.
 */
export async function readImageSealProbe(exec: PlainRawRead, sourceId: string, slug: string): Promise<{ has_visual: boolean } | null> {
  const [row] = await exec.executeRaw<{ has_visual: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM content_chunks c WHERE c.page_id = p.id AND c.embedding_image IS NOT NULL) AS has_visual
         FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.chunker_version >= 4`,
    [sourceId, slug]);
  return row ? { has_visual: row.has_visual === true } : null;
}
