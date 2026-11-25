/**
 * The reads of the Git-gap census (commands/sources-git-gap.ts censusGitGap, countRowsWithoutFile, countSourceRows),
 * as typed members: PGLite and Postgres send the same statements as before, byte for byte (pinned in
 * test/engine-sql-caller-raw-sql-pins.test.ts), and a Rust brain answers from its store records
 * (rust/docs/store/git-gap-census.md).
 */
import type { BrainEngine } from '../engine.ts';
import { privacyPartSql } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** The source row the census starts from: its checkout root and incarnation. */
export interface GitGapSourceRow { local_path: string | null; incarnation: string }

/** One page row the census classifies (sources-git-gap.ts `Key`). */
export interface GitGapPageRow {
  id: string; slug: string; source_id: string; source_path: string | null; source_path_bytes: number | string | null; source_uri: string | null;
  withheld_source_path: string | null; type: string; frontmatter: unknown; database_only_reason: string | null; segmented: boolean;
  revision: string; lineage_private: boolean;
}

/** Which pages one batch reads: the next page ids after `after`, or exactly `ids` (the --newest scan). */
export type GitGapBatch = { after: string } | { ids: readonly string[] };

/** The census's batch size (sources-git-gap.ts BATCH). */
export const GIT_GAP_BATCH = 256;

/** The statements of sources-git-gap.ts that have no parameter-dependent text. */
export const GIT_GAP_CENSUS_SQL = {
  source: 'SELECT local_path, incarnation::text AS incarnation FROM sources WHERE id=$1',
  live: 'SELECT count(*)::int AS n FROM pages WHERE source_id=$1 AND deleted_at IS NULL',
  readOnly: 'SET TRANSACTION READ ONLY',
  newest: `SELECT id::text, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
        FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT $2`,
  unread: `SELECT count(*)::int AS n FROM facts f
        JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
        WHERE f.source_id=$1 AND f.row_num IS NOT NULL AND NOT (p.id = ANY($2::bigint[]))`,
  factsOnPages: `SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NOT NULL AND source_markdown_slug = ANY($2::text[])`,
  timelineOnPages: 'SELECT count(*)::int AS n FROM timeline_entries WHERE page_id = ANY($1::int[])',
  unfenced: 'SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NULL AND expired_at IS NULL',
  fencePageMissing: `SELECT count(*)::int AS n FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL)`,
  links: `SELECT COALESCE(l.link_source, '(none)') COLLATE "C" AS link_source, count(*)::int AS n
    FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.deleted_at IS NULL AND (l.link_source IS NULL OR NOT (l.link_source = ANY($2::text[])))
    GROUP BY 1 ORDER BY 1`,
  holds: `SELECT h.completed_keys->0->>'code' COLLATE "C" AS code, count(*)::int AS n FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND s.id=$2 GROUP BY 1 ORDER BY 1`,
  parked: `SELECT e.kind COLLATE "C" AS kind, p->>'error_code' COLLATE "C" AS code, count(*)::int AS targets
    FROM persistence_effects e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data->'parked')='array' THEN e.data->'parked' ELSE '[]'::jsonb END) p
    WHERE e.source_id=$1 GROUP BY 1, 2 ORDER BY 1, 2`,
} as const;

const count = async (tx: Raw, sql: string, params: unknown[]) => Number((await tx.executeRaw<{ n: number }>(sql, params))[0]?.n ?? 0);

/** The source's checkout root and incarnation, or null for an unknown source. */
export async function readGitGapSourceRow(tx: Raw, sourceId: string): Promise<GitGapSourceRow | null> {
  return (await tx.executeRaw<GitGapSourceRow>(GIT_GAP_CENSUS_SQL.source, [sourceId]))[0] ?? null;
}

/** The source's live (not soft-deleted) pages. */
export function countGitGapLivePages(tx: Raw, sourceId: string): Promise<number> {
  return count(tx, GIT_GAP_CENSUS_SQL.live, [sourceId]);
}

/** Makes the caller's open transaction read-only, as the census reads run (`SET TRANSACTION READ ONLY`). */
export async function markTransactionReadOnly(tx: Raw): Promise<void> {
  await tx.executeRaw(GIT_GAP_CENSUS_SQL.readOnly);
}

/** The `limit` most recently updated live pages of the source (ids, and update times to the second in UTC), newest first. */
export function listGitGapNewestPages(tx: Raw, sourceId: string, limit: number): Promise<Array<{ id: string; updated_at: string }>> {
  return tx.executeRaw<{ id: string; updated_at: string }>(GIT_GAP_CENSUS_SQL.newest, [sourceId, limit]);
}

/** The source's fenced facts on a live page that is not one of `pageIds`. */
export function countGitGapUnreadFacts(tx: Raw, sourceId: string, pageIds: readonly string[]): Promise<number> {
  return count(tx, GIT_GAP_CENSUS_SQL.unread, [sourceId, [...pageIds]]);
}

/**
 * One batch of the source's live pages by page id, at most GIT_GAP_BATCH, with the census key fields and whether the
 * privacy part (privacyPartSql, with the brain's honor-aliases setting) hides the page.
 */
export function readGitGapPageBatch(tx: Raw, sourceId: string, batch: GitGapBatch): Promise<GitGapPageRow[]> {
  const page = 'ids' in batch ? sqlFragment`pages.id = ANY(${[...batch.ids]}::bigint[])` : sqlFragment`pages.id > ${batch.after}::bigint`;
  const { text, params } = renderFragment(sqlFragment`SELECT id::text, slug, source_id, source_path, octet_length(source_path) AS source_path_bytes, source_uri, withheld_source_path, type, frontmatter,
          database_only_reason, body_storage='segmented' AS segmented, knowledge_revision::text AS revision, NOT ${trustedSql(privacyPartSql('pages'))} AS lineage_private
        FROM pages WHERE source_id=${sourceId} AND deleted_at IS NULL AND ${page} ORDER BY pages.id LIMIT 256`);
  return tx.executeRaw<GitGapPageRow>(text, params);
}

/** The source's fenced facts on the pages at `slugs`. */
export function countGitGapFactsOnPages(tx: Raw, sourceId: string, slugs: readonly string[]): Promise<number> {
  return count(tx, GIT_GAP_CENSUS_SQL.factsOnPages, [sourceId, [...slugs]]);
}

/** The timeline rows of the pages `pageIds`. */
export function countGitGapTimelineOnPages(tx: Raw, pageIds: readonly number[]): Promise<number> {
  return count(tx, GIT_GAP_CENSUS_SQL.timelineOnPages, [[...pageIds]]);
}

/** The source-wide rows with no Git home, the open hold codes and the parked effect targets (countSourceRows). */
export interface GitGapSourceRows {
  unfenced: number;
  fencePageMissing: number;
  links: Array<{ link_source: string; n: number }>;
  holds: Array<{ code: string | null; n: number }>;
  parked: Array<{ kind: string; code: string | null; targets: number }>;
}

/**
 * The census's source-wide counts, in its order: unfenced live facts, fenced facts on a missing page, the links of live
 * pages whose provenance is not one of `derivedLinkSources` by provenance, the current-incarnation hold records by code,
 * and each effect's parked targets by kind and error code; every list by byte order of its keys.
 */
export async function readGitGapSourceRows(tx: Raw, sourceId: string, derivedLinkSources: readonly string[], holdOp: string): Promise<GitGapSourceRows> {
  const unfenced = await count(tx, GIT_GAP_CENSUS_SQL.unfenced, [sourceId]);
  const fencePageMissing = await count(tx, GIT_GAP_CENSUS_SQL.fencePageMissing, [sourceId]);
  const links = await tx.executeRaw<{ link_source: string; n: number }>(GIT_GAP_CENSUS_SQL.links, [sourceId, [...derivedLinkSources]]);
  const holds = await tx.executeRaw<{ code: string | null; n: number }>(GIT_GAP_CENSUS_SQL.holds, [holdOp, sourceId]);
  const parked = await tx.executeRaw<{ kind: string; code: string | null; targets: number }>(GIT_GAP_CENSUS_SQL.parked, [sourceId]);
  return { unfenced, fencePageMissing, links, holds, parked };
}
