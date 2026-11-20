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

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_SEARCH_MEMBERS: readonly string[] = [
  'listOrphanedAliasCounts', 'readSoftDeletedAliasCounts', 'listPageTypePairs',
];

export interface OrphanedAliasCount { source_id: string; slug_redirects: number; page_aliases: number }
export interface SoftDeletedAliasCounts { slug_redirects: number; page_aliases: number }
export interface PageTypePair { source_id: string; type: string }

// moved from core/repair/aliases.ts ORPHANED_ALIAS_COUNTS_SQL unchanged (MISSING('sa', 'canonical_slug') and MISSING('pa', 'slug') written out)
const ORPHANED_ALIAS_COUNTS_SQL = `SELECT source_id,sum(slug_redirects)::int AS slug_redirects,sum(page_aliases)::int AS page_aliases FROM (
    SELECT sa.source_id,1 AS slug_redirects,0 AS page_aliases FROM slug_aliases sa WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=sa.source_id AND p.slug=sa.canonical_slug)
    UNION ALL SELECT pa.source_id,0,1 FROM page_aliases pa WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=pa.source_id AND p.slug=pa.slug)) o GROUP BY source_id ORDER BY source_id`;

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

/** The statement of each read, for the test that pins them to the text the checks built. */
export const DOCTOR_SEARCH_SQL = {
  orphanedAliasCounts: ORPHANED_ALIAS_COUNTS_SQL,
  softDeletedAliasCount: SOFT_DELETED_ALIAS_COUNT_SQL,
  pageTypePairs: PAGE_TYPE_PAIRS_SQL,
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
