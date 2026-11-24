/**
 * Doctor search-and-knowledge reads: the statements `gbrain doctor` checks (dangling_aliases, type_proliferation,
 * person_title_duplicates, markdown_body_completeness, link_resolution_opportunity, hidden_by_search_policy,
 * image_embedding_coverage, text_projection_readiness, extract_atoms_backlog) ran through `executeRaw`, each with the
 * same text and parameters, on the engine's own `executeRaw`; only their home moved (src/core/onboard/checks.ts,
 * src/commands/doctor/checks/**, src/core/persistence/sync-holds.ts, src/core/page-state/projections.ts,
 * src/core/cycle/extract-atoms.ts). Each variant is one constant statement, so no clause is spliced into SQL.
 * The Rust engine answers the same members from its store records
 * (rust/crates/gbrain-store/src/cli_reads/doctor_search.rs, rust/docs/store/cli-reads-doctor-search.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { GIT_HOLD_SUMMARY_OP } from './sync-hold-op.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_SEARCH_MEMBERS: readonly string[] = [
  'listOrphanedAliasCounts', 'readSoftDeletedAliasCounts', 'listPageTypePairs',
  'listTruncatedMarkdownBodies', 'countSegmentedMarkdownBodies', 'listRecentPageBodies', 'countSegmentedRecentPages',
  'countPagesHiddenByPrefix', 'listGitImageHoldCounts', 'readProjectionBacklog',
  'countAtomExtractionBacklog', 'listAtomBacklogSourceIds',
];

/** Rows `listTruncatedMarkdownBodies` reads: the list limit of the markdown_body_completeness check plus one (a full list means a floor). */
export const TRUNCATED_BODY_ROWS = 101;
/** Pages `listRecentPageBodies` samples: the SAMPLE_LIMIT of the link_resolution_opportunity check. */
export const RECENT_PAGE_SAMPLE = 1000;

export interface OrphanedAliasCount { source_id: string; slug_redirects: number; page_aliases: number }
export interface SoftDeletedAliasCounts { slug_redirects: number; page_aliases: number }
export interface PageTypePair { source_id: string; type: string }
export interface TruncatedMarkdownBody { slug: string; body_len: number; raw_len: number }
export interface RecentPageBody { compiled_truth: string | null; timeline: string | null }
export interface GitImageHoldCount { source_id: string; images: number }

// moved from core/repair/aliases.ts ORPHANED_ALIAS_COUNTS_SQL unchanged (MISSING('sa', 'canonical_slug') and MISSING('pa', 'slug') written out),
// including its byte-order sort (b7d1b3b2a3 added `COLLATE "C"` there after the move; this copy had kept the old ORDER BY)
const ORPHANED_ALIAS_COUNTS_SQL = `SELECT source_id,sum(slug_redirects)::int AS slug_redirects,sum(page_aliases)::int AS page_aliases FROM (
    SELECT sa.source_id,1 AS slug_redirects,0 AS page_aliases FROM slug_aliases sa WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=sa.source_id AND p.slug=sa.canonical_slug)
    UNION ALL SELECT pa.source_id,0,1 FROM page_aliases pa WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=pa.source_id AND p.slug=pa.slug)) o GROUP BY source_id ORDER BY source_id COLLATE "C"`;

// moved from core/repair/aliases.ts SOFT_DELETED_ALIAS_COUNT_SQL unchanged (SOFT_DELETED('sa', 'canonical_slug') and SOFT_DELETED('pa', 'slug') written out)
const SOFT_DELETED_ALIAS_COUNT_SQL = `SELECT
    (SELECT count(*)::int FROM slug_aliases sa WHERE EXISTS (SELECT 1 FROM pages p WHERE p.source_id=sa.source_id AND p.slug=sa.canonical_slug AND p.deleted_at IS NOT NULL)) AS slug_redirects,
    (SELECT count(*)::int FROM page_aliases pa WHERE EXISTS (SELECT 1 FROM pages p WHERE p.source_id=pa.source_id AND p.slug=pa.slug AND p.deleted_at IS NOT NULL)) AS page_aliases`;

// moved from core/onboard/checks.ts PAGE_TYPE_PAIRS_SQL unchanged: a skip scan over idx_pages_source_type, one probe per distinct pair
const PAGE_TYPE_PAIRS_SQL = `WITH RECURSIVE pairs AS (
  (SELECT source_id, type FROM pages WHERE deleted_at IS NULL AND type IS NOT NULL ORDER BY source_id, type LIMIT 1)
  UNION ALL
  SELECT n.source_id, n.type FROM pairs, LATERAL (
    SELECT p.source_id, p.type FROM pages p
     WHERE p.deleted_at IS NULL AND p.type IS NOT NULL AND (p.source_id, p.type) > (pairs.source_id, pairs.type)
     ORDER BY p.source_id, p.type LIMIT 1) n
)
SELECT source_id, type FROM pairs`;

// moved from doctor/checks/data-integrity.ts runMarkdownBody unchanged (LISTED_PAGE_LIMIT + 1 written out)
const TRUNCATED_MARKDOWN_BODIES_SQL = `SELECT p.slug,
              length(p.compiled_truth) AS body_len,
              length(rd.data ->> 'content') AS raw_len
       FROM pages p
       JOIN raw_data rd ON rd.page_id = p.id
       WHERE rd.data ? 'content'
         AND length(rd.data ->> 'content') > 1000
         AND length(p.compiled_truth) < length(rd.data ->> 'content') * 0.3
         AND (rd.data ->> 'content') ~ '(^|\n)##+ '
       LIMIT 101`;

// moved from doctor/checks/data-integrity.ts runMarkdownBody unchanged: segmented pages the length comparison above passes by
const SEGMENTED_MARKDOWN_BODIES_SQL = `SELECT COUNT(DISTINCT p.id)::int AS n
       FROM pages p
       JOIN raw_data rd ON rd.page_id = p.id
       WHERE p.body_storage = 'segmented'
         AND rd.data ? 'content'
         AND length(rd.data ->> 'content') > 1000
         AND (rd.data ->> 'content') ~ '(^|\n)##+ '`;

// moved from doctor/checks/calibration.ts checkLinkResolutionOpportunity unchanged (`scope` and SAMPLE_LIMIT written out)
const RECENT_PAGE_BODIES_SQL = `SELECT compiled_truth, timeline FROM pages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1000`;
const RECENT_PAGE_BODIES_IN_SOURCES_SQL = `SELECT compiled_truth, timeline FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) ORDER BY id DESC LIMIT 1000`;
const SEGMENTED_RECENT_PAGES_SQL = `SELECT COUNT(*)::int AS n FROM (SELECT body_storage FROM pages WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1000) s WHERE s.body_storage = 'segmented'`;
const SEGMENTED_RECENT_PAGES_IN_SOURCES_SQL = `SELECT COUNT(*)::int AS n FROM (SELECT body_storage FROM pages WHERE deleted_at IS NULL AND source_id = ANY($1::text[]) ORDER BY id DESC LIMIT 1000) s WHERE s.body_storage = 'segmented'`;

// moved from core/persistence/sync-holds.ts readGitImageHoldCounts unchanged ($1 is GIT_HOLD_SUMMARY_OP, $2 the source ids)
const GIT_IMAGE_HOLD_COUNTS_SQL = `SELECT s.id AS source_id, COALESCE((h.completed_keys->0->>'images')::int,0) AS images
    FROM op_checkpoints h JOIN sources s ON h.fingerprint=s.id||':'||s.incarnation::text
    WHERE h.op=$1 AND s.id=ANY($2::text[]) AND COALESCE((h.completed_keys->0->>'images')::int,0)>0`;

// moved from doctor/checks/calibration.ts checkHiddenBySearchPolicy: its one statement counted every prefix with a FILTER; this counts one
// (the LIKE pattern is $1), with buildVisibilityClause('p', 's') written out.
// chunk-visibility-ok: counts pages that have a chunk (the EXISTS), for the exclude-policy audit
const PAGES_HIDDEN_BY_PREFIX_SQL = `SELECT COUNT(DISTINCT p.id)::int AS n
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       WHERE EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)
         AND p.deleted_at IS NULL AND ((p.text_projection_revision = p.knowledge_revision) IS TRUE OR (p.text_projection_revision = '00000000-0000-0000-0000-000000000153'::uuid) IS TRUE) AND NOT s.archived AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'quarantine') AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'pinned_question')
         AND p.slug LIKE $1 ESCAPE '\\'`;
// chunk-visibility-ok: the same statement scoped to the caller's sources
const PAGES_HIDDEN_BY_PREFIX_IN_SOURCES_SQL = `SELECT COUNT(DISTINCT p.id)::int AS n
       FROM pages p
       JOIN sources s ON s.id = p.source_id
       WHERE EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)
         AND p.deleted_at IS NULL AND ((p.text_projection_revision = p.knowledge_revision) IS TRUE OR (p.text_projection_revision = '00000000-0000-0000-0000-000000000153'::uuid) IS TRUE) AND NOT s.archived AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'quarantine') AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'pinned_question')
         AND p.slug LIKE $1 ESCAPE '\\'
         AND p.source_id = ANY($2::text[])`;

/** The statement of each read, for the test that pins them to the text the checks built. */
export const DOCTOR_SEARCH_SQL = {
  orphanedAliasCounts: ORPHANED_ALIAS_COUNTS_SQL,
  softDeletedAliasCount: SOFT_DELETED_ALIAS_COUNT_SQL,
  pageTypePairs: PAGE_TYPE_PAIRS_SQL,
  truncatedMarkdownBodies: TRUNCATED_MARKDOWN_BODIES_SQL,
  segmentedMarkdownBodies: SEGMENTED_MARKDOWN_BODIES_SQL,
  recentPageBodies: RECENT_PAGE_BODIES_SQL,
  recentPageBodiesInSources: RECENT_PAGE_BODIES_IN_SOURCES_SQL,
  segmentedRecentPages: SEGMENTED_RECENT_PAGES_SQL,
  segmentedRecentPagesInSources: SEGMENTED_RECENT_PAGES_IN_SOURCES_SQL,
  pagesHiddenByPrefix: PAGES_HIDDEN_BY_PREFIX_SQL,
  pagesHiddenByPrefixInSources: PAGES_HIDDEN_BY_PREFIX_IN_SOURCES_SQL,
  gitImageHoldCounts: GIT_IMAGE_HOLD_COUNTS_SQL,
} as const;

/** Alias rows (both tables) whose target page row is absent, per source, in source order. */
export async function listOrphanedAliasCounts(raw: EngineRawRead): Promise<OrphanedAliasCount[]> {
  const rows = await raw<{ source_id: string; slug_redirects: string | number; page_aliases: string | number }>(ORPHANED_ALIAS_COUNTS_SQL);
  return rows.map((row) => ({ source_id: row.source_id, slug_redirects: Number(row.slug_redirects), page_aliases: Number(row.page_aliases) }));
}

/** Alias rows (both tables) whose target page is soft-deleted. */
export async function readSoftDeletedAliasCounts(raw: EngineRawRead): Promise<SoftDeletedAliasCounts> {
  const [row] = await raw<{ slug_redirects: string | number; page_aliases: string | number }>(SOFT_DELETED_ALIAS_COUNT_SQL);
  return { slug_redirects: Number(row?.slug_redirects ?? 0), page_aliases: Number(row?.page_aliases ?? 0) };
}

/** Every distinct (source, type) among live typed pages, in source then type order. */
export async function listPageTypePairs(raw: EngineRawRead): Promise<PageTypePair[]> {
  return raw<PageTypePair>(PAGE_TYPE_PAIRS_SQL);
}

/** Pages whose body is under 30% of their raw `content` (which has H2/H3 headings and is over 1000 characters), at most TRUNCATED_BODY_ROWS. */
export async function listTruncatedMarkdownBodies(raw: EngineRawRead): Promise<TruncatedMarkdownBody[]> {
  const rows = await raw<{ slug: string; body_len: string | number; raw_len: string | number }>(TRUNCATED_MARKDOWN_BODIES_SQL);
  return rows.map((row) => ({ slug: row.slug, body_len: Number(row.body_len), raw_len: Number(row.raw_len) }));
}

/** Segmented pages whose raw `content` is over 1000 characters with H2/H3 headings (the length comparison skips them). */
export async function countSegmentedMarkdownBodies(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ n: string | number }>(SEGMENTED_MARKDOWN_BODIES_SQL);
  return Number(row?.n ?? 0);
}

/** The bodies of the RECENT_PAGE_SAMPLE newest live pages (a segmented page's columns are NULL), within `sourceIds` when given. */
export async function listRecentPageBodies(raw: EngineRawRead, sourceIds: string[] | null): Promise<RecentPageBody[]> {
  return sourceIds
    ? raw<RecentPageBody>(RECENT_PAGE_BODIES_IN_SOURCES_SQL, [sourceIds])
    : raw<RecentPageBody>(RECENT_PAGE_BODIES_SQL);
}

/** How many of those RECENT_PAGE_SAMPLE newest live pages are stored in segments. */
export async function countSegmentedRecentPages(raw: EngineRawRead, sourceIds: string[] | null): Promise<number> {
  const [row] = sourceIds
    ? await raw<{ n: string | number }>(SEGMENTED_RECENT_PAGES_IN_SOURCES_SQL, [sourceIds])
    : await raw<{ n: string | number }>(SEGMENTED_RECENT_PAGES_SQL);
  return Number(row?.n ?? 0);
}

/** Chunked pages search serves (live, projected, unarchived source, not quarantined or pinned) whose slug matches the LIKE `pattern` (`\` escapes). */
export async function countPagesHiddenByPrefix(raw: EngineRawRead, pattern: string, sourceIds: string[] | null): Promise<number> {
  const [row] = sourceIds
    ? await raw<{ n: string | number }>(PAGES_HIDDEN_BY_PREFIX_IN_SOURCES_SQL, [pattern, sourceIds])
    : await raw<{ n: string | number }>(PAGES_HIDDEN_BY_PREFIX_SQL, [pattern]);
  return Number(row?.n ?? 0);
}

/** Unsupported-image holds per source's current incarnation among `sourceIds` (sources with none are not listed). */
export async function listGitImageHoldCounts(raw: EngineRawRead, sourceIds: string[]): Promise<GitImageHoldCount[]> {
  const rows = await raw<{ source_id: string; images: string | number }>(GIT_IMAGE_HOLD_COUNTS_SQL, [GIT_HOLD_SUMMARY_OP, sourceIds]);
  return rows.map((row) => ({ source_id: row.source_id, images: Number(row.images) }));
}

// moved from commands/doctor/checks/extraction-sync.ts countExtractAtomsBacklogBySource unchanged
const LIST_ATOM_BACKLOG_SOURCE_IDS_SQL = `SELECT source_id FROM pages WHERE deleted_at IS NULL GROUP BY source_id ORDER BY source_id COLLATE "C"`;

/** The sources with a live page, by id in byte order: the roster extract_atoms_backlog counts per source on the unscoped path. */
export async function listAtomBacklogSourceIds(raw: EngineRawRead): Promise<Array<{ source_id: string }>> {
  return raw<{ source_id: string }>(LIST_ATOM_BACKLOG_SOURCE_IDS_SQL);
}
