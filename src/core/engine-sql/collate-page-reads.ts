/**
 * Reads of pages, files and facts that sort by byte on every engine (the collate-equal lane), each a typed BrainEngine
 * member. Each function runs the statement its caller ran through `executeRaw`, with the same text and parameters, on the
 * engine's own `executeRaw`; only its home moved (pinned by test/engine-sql-caller-raw-sql-pins.test.ts, compared across
 * engines and the Rust store by test/engine-parity/collate-core-page-lists.test.ts).
 *
 * Placeholders that a caller numbered by hand (`$1` the limit, `$2` the slug) stay hand-numbered inside `trustedSql`
 * string literals of a fragment with no bound values, so the text is the caller's byte for byte.
 */
import { privatePagesFilterForCaller } from '../search/private-visibility.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import type { EngineRawRead } from './cli-reads-ops.ts';
import { poolWhere, type FactPoolFilters, type FactPoolScope } from './facts-trust.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The most files `file_list` returns. Both branches need a LIMIT: without one, the slug-filtered branch materializes every
 * file for that slug, and an MCP caller could force unbounded memory consumption by targeting a page with many attachments.
 */
export const FILE_LIST_LIMIT = 100;

/** The predicate over the files alias `f`: always true, or no page the file names is one the caller cannot read. No values. */
function fileReadableFragment(excludePrivate: boolean) {
  return excludePrivate
    ? sqlFragment`NOT EXISTS (SELECT 1 FROM pages fp WHERE (fp.id = f.page_id OR fp.slug = f.page_slug) AND NOT ${trustedSql(privatePagesFilterForCaller('fp'))})`
    : sqlFragment`TRUE`;
}

/**
 * file_list: the files of one page (by name) or of every page (by page, then name) that the caller can read, at most 100.
 * Text sorts by byte and equal names fall to the file id, so the limit cuts the same rows on every engine.
 */
export async function listReadableFileRows(raw: EngineRawRead, slug: string | undefined, excludePrivate: boolean): Promise<Array<Record<string, unknown>>> {
  const { text, params } = renderFragment(slug === undefined
    ? sqlFragment`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${trustedSql('TRUE')}) AND ${fileReadableFragment(excludePrivate)}
      ORDER BY ${trustedSql('page_slug COLLATE "C", filename COLLATE "C", id')} ${trustedSql('LIMIT $1')}`
    : sqlFragment`SELECT id, page_slug, filename, storage_path, mime_type, size_bytes, content_hash, created_at
      FROM files f WHERE (${trustedSql('f.page_slug = $2')}) AND ${fileReadableFragment(excludePrivate)}
      ORDER BY ${trustedSql('filename COLLATE "C", id')} ${trustedSql('LIMIT $1')}`);
  if (params.length !== 0) throw new Error('listReadableFileRows: the statement binds no value of its own');
  return raw<Record<string, unknown>>(text, slug === undefined ? [FILE_LIST_LIMIT] : [FILE_LIST_LIMIT, slug]);
}

/** `(source_id, type)` of every live typed page, found by a skip scan over idx_pages_source_type (v316): one index probe per pair. */
const PAGE_TYPE_PAIRS_SQL = `WITH RECURSIVE pairs AS (
  (SELECT source_id, type FROM pages WHERE deleted_at IS NULL AND type IS NOT NULL ORDER BY source_id, type LIMIT 1)
  UNION ALL
  SELECT n.source_id, n.type FROM pairs, LATERAL (
    SELECT p.source_id, p.type FROM pages p
     WHERE p.deleted_at IS NULL AND p.type IS NOT NULL AND (p.source_id, p.type) > (pairs.source_id, pairs.type)
     ORDER BY p.source_id, p.type LIMIT 1) n
)
SELECT source_id, type FROM pairs`;

/** The `(source_id, type)` pairs of the live typed pages, in the walk's own order (the caller sorts them by byte). */
export async function listPageTypePairs(raw: EngineRawRead): Promise<Array<{ source_id: string; type: string }>> {
  return raw<{ source_id: string; type: string }>(PAGE_TYPE_PAIRS_SQL);
}

/** Live pages with at least one outgoing `mentions` link. */
export async function countPagesWithMentionLinks(raw: EngineRawRead): Promise<number> {
  const [row] = await raw<{ count: number }>(
    `SELECT COUNT(DISTINCT l.from_page_id)::int AS count
       FROM links l
       JOIN pages p ON p.id = l.from_page_id
      WHERE l.link_source = 'mentions'
        AND p.deleted_at IS NULL`,
    [],
  );
  return row?.count ?? 0;
}

/** The sources that hold a live page (the gazetteer reads each one's pack). */
export async function listGazetteerSourceIds(raw: EngineRawRead): Promise<Array<{ id: string }>> {
  return raw<{ id: string }>('SELECT DISTINCT source_id AS id FROM pages WHERE deleted_at IS NULL', []);
}

export interface GazetteerPageRow {
  slug: string; source_id: string | null; title: string | null; type: string | null; connector_stub: boolean;
  h1: string | null; h2: string | null; h3: string | null; h4: string | null;
}

/** The live pages of the given types, with the frontmatter text of four handle keys (`handleKeys`, four of them) as h1..h4. */
export async function listGazetteerPages(raw: EngineRawRead, types: string[], handleKeys: readonly string[]): Promise<GazetteerPageRow[]> {
  return raw<GazetteerPageRow>(
    `SELECT slug, source_id, title, type, (frontmatter ->> 'google_contact_id') IS NOT NULL AS connector_stub,
            frontmatter ->> $2 AS h1, frontmatter ->> $3 AS h2, frontmatter ->> $4 AS h3, frontmatter ->> $5 AS h4
     FROM pages
     WHERE type = ANY($1::text[])
       AND deleted_at IS NULL`,
    [types, ...handleKeys],
  );
}

export interface GazetteerAliasRow {
  alias_norm: string; slug: string; source_id: string | null; title: string | null; type: string | null;
  origin: string | null; case_sensitive: boolean | null; alias_text: string | null; identity: unknown;
}

/** The `page_aliases` rows joined to live pages of the given types. A brain older than v110 has no table: the read throws. */
export async function listGazetteerAliasRows(raw: EngineRawRead, types: string[]): Promise<GazetteerAliasRow[]> {
  return raw<GazetteerAliasRow>(
    `SELECT pa.alias_norm, pa.slug, pa.source_id, p.title, p.type, pa.origin, pa.case_sensitive, pa.alias_text, p.frontmatter->>'identity' AS identity
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
       WHERE p.type = ANY($1::text[])
         AND p.deleted_at IS NULL`,
    [types],
  );
}

export interface StaleMentionPageRow {
  id: number; slug: string; source_id: string | null; body: string; title: string | null; body_storage: string | null;
}

/** The first `limit` live pages (by slug, by byte, then id) with a `mentions` link, with their `title, body, timeline` text. */
export async function listStaleMentionPages(raw: EngineRawRead, limit: number): Promise<StaleMentionPageRow[]> {
  return raw<StaleMentionPageRow>(
    `WITH scanned AS (
       SELECT p.id
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM links l
             WHERE l.from_page_id = p.id AND l.link_source = 'mentions'
          )
        ORDER BY p.slug COLLATE "C", p.id
        LIMIT $1
     )
     SELECT p.id, p.slug, p.source_id, p.title, p.body_storage,
            COALESCE(p.title, '') || E'\n\n' || COALESCE(p.compiled_truth, '') || E'\n\n' || COALESCE(p.timeline, '') AS body
       FROM pages p
       JOIN scanned s ON s.id = p.id
      ORDER BY p.slug COLLATE "C", p.id`,
    [limit],
  );
}

export interface StaleMentionLinkRow {
  from_id: number; from_slug: string; to_slug: string; to_source_id: string | null; link_kind: string | null; link_type: string;
}

/** The `mentions` links of those same pages, by from slug then to slug (by byte). */
export async function listStaleMentionLinks(raw: EngineRawRead, limit: number): Promise<StaleMentionLinkRow[]> {
  return raw<StaleMentionLinkRow>(
    `WITH scanned AS (
       SELECT p.id
         FROM pages p
        WHERE p.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM links l
             WHERE l.from_page_id = p.id AND l.link_source = 'mentions'
          )
        ORDER BY p.slug COLLATE "C", p.id
        LIMIT $1
     )
     SELECT l.from_page_id AS from_id, f.slug AS from_slug,
            t.slug AS to_slug, t.source_id AS to_source_id, l.link_kind, l.link_type
       FROM links l
       JOIN scanned s ON s.id = l.from_page_id
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions'
      ORDER BY f.slug COLLATE "C", t.slug COLLATE "C"`,
    [limit],
  );
}

/** The distinct (source_id, entity_slug) pairs with a fact in the authorized, filtered pool, by byte (the namesake check runs on these before any ranking). */
export async function listPoolEntityPairs(raw: EngineRawRead, scope: FactPoolScope, filters: FactPoolFilters): Promise<Array<{ source_id: string; entity_slug: string }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT f.source_id COLLATE "C" AS source_id, f.entity_slug COLLATE "C" AS entity_slug FROM facts f WHERE ${poolWhere(scope, filters)} AND f.entity_slug IS NOT NULL ORDER BY f.source_id COLLATE "C", f.entity_slug COLLATE "C"`);
  return raw<{ source_id: string; entity_slug: string }>(text, params);
}

/**
 * The distinct (source_id, entity_slug) pairs among `keys` that hold an active fact in the pool under its read policy and
 * have no live page at that slug (an unbacked name key), at most `limit`, by source then slug (by byte).
 */
export async function listPoolUnbackedKeys(raw: EngineRawRead, scope: FactPoolScope, keys: readonly string[], limit: number): Promise<Array<{ source_id: string; entity_slug: string }>> {
  const { text, params } = renderFragment(sqlFragment`SELECT DISTINCT f.source_id COLLATE "C" AS source_id, f.entity_slug COLLATE "C" AS entity_slug FROM facts f WHERE ${poolWhere(scope, undefined)} AND f.entity_slug = ANY(${[...keys]}::text[])
       AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
     ORDER BY f.source_id COLLATE "C", f.entity_slug COLLATE "C" LIMIT ${limit}`);
  return raw<{ source_id: string; entity_slug: string }>(text, params);
}
