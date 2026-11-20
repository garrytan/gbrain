/**
 * Git-gap census reads: the database side of `gbrain sources git-gap` and doctor `db_ahead_of_git` /
 * `strict_facts_outside_git` (src/commands/sources-git-gap.ts `censusGitGap`). Each statement is the one the census ran
 * through `executeRaw`; the grouped counts sort their text keys bytewise (COLLATE "C", the PGLite order), so every
 * engine returns the same groups in the same order. The page-key statement embeds the page-privacy predicate
 * (search/private-visibility.ts `privacyPartSql`), composed per call because it follows the brain's alias setting and
 * schema version. The Rust engine refuses these members by name: its store does not serve the census
 * (rust/docs/store/git-gap-census.md).
 */
import { privacyPartSql } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql, type SqlFragment } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Doctor calls them under its deadline-bound engine, so src/core/statement-deadline.ts keeps
 * the statement bound on them (BOUNDED_TYPED_READS).
 */
export const GIT_GAP_CENSUS_MEMBERS: readonly string[] = ['readGitGapSource', 'readGitGapNewestWindow', 'listGitGapPageKeys', 'countGitGapRowsWithoutFile', 'countGitGapSourceRows'];

/** The source a census compares: its checkout path, its incarnation, and its live (not soft-deleted) page count. */
export interface GitGapSourceRow { local_path: string | null; incarnation: string; live_pages: number }

/** The newest live pages of a source by `updated_at` (UTC, to the second), and the fenced facts on its other live pages. */
export interface GitGapNewestWindow { pages: Array<{ id: string; updated_at: string }>; facts_on_unread_pages: number }

/** One live page as the census classifies it. `lineage_private` is true when the page-privacy predicate rejects it. */
export interface GitGapPageKey {
  id: string; slug: string; source_id: string; source_path: string | null; source_path_bytes: number | null; source_uri: string | null; withheld_source_path: string | null; type: string;
  frontmatter: unknown; database_only_reason: string | null; segmented: boolean; lineage_private: boolean; revision: string | null;
}

/** A batch of live page keys: the pages after `afterId` (by id), or the pages of `ids`. */
export type GitGapKeyWindow = { afterId: string } | { ids: readonly string[] };

/** The source-wide rows the census counts with no Git home, the source's open Git holds by code, and its parked targets. */
export interface GitGapSourceRows {
  facts_unfenced: number;
  facts_fence_page_missing: number;
  links: Array<{ link_source: string; n: number }>;
  holds: Array<{ code: string | null; n: number }>;
  parked: Array<{ kind: string; code: string | null; targets: number }>;
}

const SOURCE_SQL = `SELECT s.local_path, s.incarnation::text AS incarnation,
    (SELECT count(*)::int FROM pages p WHERE p.source_id=s.id AND p.deleted_at IS NULL) AS live_pages
  FROM sources s WHERE s.id=$1`;

const NEWEST_PAGES_SQL = `SELECT id::text AS id, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
  FROM pages WHERE source_id=$1 AND deleted_at IS NULL ORDER BY updated_at DESC, id DESC LIMIT $2`;

const UNREAD_FACTS_SQL = `SELECT count(*)::int AS n FROM facts f
  JOIN pages p ON p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL
  WHERE f.source_id=$1 AND f.row_num IS NOT NULL AND NOT (p.id = ANY($2::bigint[]))`;

/** The page-key window: one batch of live pages after a cursor, or the named ids (the newest window). */
const keyFragment = (sourceId: string, window: GitGapKeyWindow, limit: number): SqlFragment => sqlFragment`SELECT id::text AS id, slug, source_id, source_path, octet_length(source_path) AS source_path_bytes, source_uri, withheld_source_path, type,
    frontmatter, database_only_reason, body_storage='segmented' AS segmented, knowledge_revision::text AS revision, NOT ${trustedSql(privacyPartSql('pages'))} AS lineage_private
  FROM pages WHERE source_id=${sourceId} AND deleted_at IS NULL AND ${'ids' in window ? sqlFragment`pages.id = ANY(${[...window.ids]}::bigint[])` : sqlFragment`pages.id > ${window.afterId}::bigint`} ORDER BY pages.id LIMIT ${limit}`;

const FENCED_FACTS_ON_SLUGS_SQL = 'SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NOT NULL AND source_markdown_slug = ANY($2::text[])';
const TIMELINE_ON_PAGES_SQL = 'SELECT count(*)::int AS n FROM timeline_entries WHERE page_id = ANY($1::int[])';

const UNFENCED_FACTS_SQL = 'SELECT count(*)::int AS n FROM facts WHERE source_id=$1 AND row_num IS NULL AND expired_at IS NULL';
const FENCE_PAGE_MISSING_SQL = `SELECT count(*)::int AS n FROM facts f WHERE f.source_id=$1 AND f.row_num IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id=f.source_id AND p.slug=f.source_markdown_slug AND p.deleted_at IS NULL)`;
const UNDERIVED_LINKS_SQL = `SELECT COALESCE(l.link_source, '(none)') AS link_source, count(*)::int AS n
  FROM links l JOIN pages p ON p.id=l.from_page_id WHERE p.source_id=$1 AND p.deleted_at IS NULL AND (l.link_source IS NULL OR NOT (l.link_source = ANY($2::text[])))
  GROUP BY 1 ORDER BY COALESCE(l.link_source, '(none)') COLLATE "C"`;
const HOLDS_BY_CODE_SQL = `SELECT h.completed_keys->0->>'code' AS code, count(*)::int AS n FROM op_checkpoints h
  JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
  WHERE h.op=$1 AND s.id=$2 GROUP BY 1 ORDER BY (h.completed_keys->0->>'code') COLLATE "C"`;
const PARKED_BY_CODE_SQL = `SELECT e.kind, p->>'error_code' AS code, count(*)::int AS targets
  FROM persistence_effects e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.data->'parked')='array' THEN e.data->'parked' ELSE '[]'::jsonb END) p
  WHERE e.source_id=$1 GROUP BY 1, 2 ORDER BY e.kind COLLATE "C", (p->>'error_code') COLLATE "C"`;

/** The source row a census opens with, or null when no source has that id. */
export async function readGitGapSource(raw: EngineRawRead, sourceId: string): Promise<GitGapSourceRow | null> {
  const [row] = await raw<{ local_path: string | null; incarnation: string; live_pages: number }>(SOURCE_SQL, [sourceId]);
  return row ? { local_path: row.local_path ?? null, incarnation: String(row.incarnation), live_pages: Number(row.live_pages ?? 0) } : null;
}

/** The `newest` most recently updated live pages (ties by id, newest first) and the fenced facts on every other live page. */
export async function readGitGapNewestWindow(raw: EngineRawRead, sourceId: string, newest: number): Promise<GitGapNewestWindow> {
  const pages = await raw<{ id: string; updated_at: string }>(NEWEST_PAGES_SQL, [sourceId, newest]);
  const [unread] = await raw<{ n: number }>(UNREAD_FACTS_SQL, [sourceId, pages.map(row => row.id)]);
  return { pages: pages.map(row => ({ id: String(row.id), updated_at: String(row.updated_at) })), facts_on_unread_pages: Number(unread?.n ?? 0) };
}

/** Up to `limit` live page keys of a source in id order: those after `window.afterId`, or those among `window.ids`. */
export async function listGitGapPageKeys(raw: EngineRawRead, sourceId: string, window: GitGapKeyWindow, limit: number): Promise<GitGapPageKey[]> {
  const { text, params } = renderFragment(keyFragment(sourceId, window, limit));
  return raw<GitGapPageKey>(text, params);
}

/** Fenced fact rows on `slugs` of a source, and timeline rows on `pageIds`: the rows of pages with no committed file. */
export async function countGitGapRowsWithoutFile(raw: EngineRawRead, sourceId: string, slugs: readonly string[], pageIds: readonly string[]): Promise<{ facts: number; timeline_entries: number }> {
  const [facts] = await raw<{ n: number }>(FENCED_FACTS_ON_SLUGS_SQL, [sourceId, [...slugs]]);
  const [timeline] = await raw<{ n: number }>(TIMELINE_ON_PAGES_SQL, [pageIds.map(Number)]);
  return { facts: Number(facts?.n ?? 0), timeline_entries: Number(timeline?.n ?? 0) };
}

/**
 * The source-wide rows with no Git home: unfenced live facts, fenced facts whose page is gone, links on live pages that
 * no file derives (provenance not in `derivedLinkSources`, by provenance), the source's open holds of op `holdOp` by
 * code, and its parked effect targets by kind and code. Groups sort bytewise.
 */
export async function countGitGapSourceRows(raw: EngineRawRead, sourceId: string, opts: { derivedLinkSources: readonly string[]; holdOp: string }): Promise<GitGapSourceRows> {
  const [unfenced] = await raw<{ n: number }>(UNFENCED_FACTS_SQL, [sourceId]);
  const [missing] = await raw<{ n: number }>(FENCE_PAGE_MISSING_SQL, [sourceId]);
  const links = await raw<{ link_source: string; n: number }>(UNDERIVED_LINKS_SQL, [sourceId, [...opts.derivedLinkSources]]);
  const holds = await raw<{ code: string | null; n: number }>(HOLDS_BY_CODE_SQL, [opts.holdOp, sourceId]);
  const parked = await raw<{ kind: string; code: string | null; targets: number }>(PARKED_BY_CODE_SQL, [sourceId]);
  return {
    facts_unfenced: Number(unfenced?.n ?? 0), facts_fence_page_missing: Number(missing?.n ?? 0),
    links: links.map(row => ({ link_source: String(row.link_source), n: Number(row.n) })),
    holds: holds.map(row => ({ code: row.code ?? null, n: Number(row.n) })),
    parked: parked.map(row => ({ kind: String(row.kind), code: row.code ?? null, targets: Number(row.targets) })),
  };
}
