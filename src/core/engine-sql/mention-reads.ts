/**
 * The reads of the entity gazetteer (src/core/by-mention.ts buildGazetteer), the full extract walk's watermark
 * snapshot and the by-mention rebuild (src/commands/extract.ts) and `gbrain extract mentions --explain`
 * (src/commands/extract-mentions-explain.ts), each with the text and parameters its caller ran through `executeRaw`;
 * only their home moved. The Rust engine answers them from its store (rust/crates/gbrain-store/src/cli_reads/mention_reads.rs,
 * rust/docs/store/mention-state.md).
 */
import type { MentionRaw } from './mention-pass.ts';

export interface GazetteerPageRow {
  slug: string; source_id: string | null; title: string | null; type: string | null; connector_stub: boolean;
  h1: string | null; h2: string | null; h3: string | null; h4: string | null;
}
export interface GazetteerAliasRow {
  alias_norm: string; slug: string; source_id: string | null; title: string | null; type: string | null;
  origin: string | null; case_sensitive: boolean | null; alias_text: string | null; identity: unknown;
}
export interface PageStampTimeRow { slug: string; source_id: string; updated_at_iso: string }
export interface ExplainScanPageRow { id: number; slug: string; title: string | null; compiled_truth: string; timeline: string; mention_ignore: unknown; due: boolean }
export interface PageNameTextRow { title: string | null; compiled_truth: string | null; timeline: string | null; frontmatter: Record<string, unknown> | null }

/** The sources that hold a live page (buildGazetteer). */
export function listLivePageSourceIds(raw: MentionRaw): Promise<Array<{ id: string }>> {
  return raw.executeRaw<{ id: string }>('SELECT DISTINCT source_id AS id FROM pages WHERE deleted_at IS NULL', []);
}

/** Live pages of `types`, with the four handle frontmatter keys `handleKeys` names and whether a connector made it. */
export function listGazetteerPages(raw: MentionRaw, types: readonly string[], handleKeys: readonly [string, string, string, string]): Promise<GazetteerPageRow[]> {
  // The retirement test is `retiredPageSql('pages')` spelled out (the engine-sql-dynamic guard wants whole literals; the pin
  // test, test/engine-sql-caller-raw-sql-pins.test.ts, holds it to that builder).
  return raw.executeRaw<GazetteerPageRow>(
    `SELECT slug, source_id, title, type, (frontmatter ->> 'google_contact_id') IS NOT NULL AS connector_stub,
            frontmatter ->> $2 AS h1, frontmatter ->> $3 AS h2, frontmatter ->> $4 AS h3, frontmatter ->> $5 AS h4
     FROM pages
     WHERE type = ANY($1::text[])
       AND deleted_at IS NULL
       AND NOT (lower(COALESCE(pages.frontmatter->>'canonical', '')) IN ('false', 'no')
    OR btrim(COALESCE(pages.frontmatter->>'superseded_by', '')) <> ''
    OR btrim(COALESCE(pages.frontmatter->>'merged_into', '')) <> ''
    OR lower(COALESCE(pages.frontmatter->>'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)')`,
    [types, ...handleKeys],
  );
}

/** The alias rows of live pages of `types`, with each page's title, type and frontmatter identity. */
export function listGazetteerAliases(raw: MentionRaw, types: readonly string[]): Promise<GazetteerAliasRow[]> {
  return raw.executeRaw<GazetteerAliasRow>(
      `SELECT pa.alias_norm, pa.slug, pa.source_id, p.title, p.type, pa.origin, pa.case_sensitive, pa.alias_text, p.frontmatter->>'identity' AS identity
       FROM page_aliases pa
       JOIN pages p ON p.slug = pa.slug AND p.source_id = pa.source_id
       WHERE p.type = ANY($1::text[])
         AND p.deleted_at IS NULL
         AND NOT (lower(COALESCE(p.frontmatter->>'canonical', '')) IN ('false', 'no')
    OR btrim(COALESCE(p.frontmatter->>'superseded_by', '')) <> ''
    OR btrim(COALESCE(p.frontmatter->>'merged_into', '')) <> ''
    OR lower(COALESCE(p.frontmatter->>'status', '')) ~ '(^|[^a-z])(alias|redirect|redirected)([^a-z]|$)')`,
      [types],
    );
}

/** Each live page among (`slugs[i]`, `sourceIds[i]`) with its updated_at as ISO microseconds (the full walk's snapshot). */
export function readPageStampTimes(raw: MentionRaw, slugs: readonly string[], sourceIds: readonly string[]): Promise<PageStampTimeRow[]> {
  return raw.executeRaw<PageStampTimeRow>(
      `SELECT p.slug, p.source_id,
              to_char(p.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_iso
         FROM pages p
         JOIN unnest($1::text[], $2::text[]) AS v(slug, source_id)
           ON p.slug = v.slug AND p.source_id = v.source_id
        WHERE p.deleted_at IS NULL`,
      [slugs, sourceIds],
    );
}

/** The live page's content revision, row-locked FOR SHARE (the by-mention rebuild's conditional publish). */
export function readPageRevisionForShare(raw: MentionRaw, sourceId: string, slug: string): Promise<Array<{ revision: string }>> {
  return raw.executeRaw<{ revision: string }>(
            'SELECT knowledge_revision::text AS revision FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL FOR SHARE', [sourceId, slug]);
}

/** The live page at the slug, if any (explain). */
export function readExplainPage(raw: MentionRaw, sourceId: string, slug: string): Promise<Array<{ slug: string; type: string | null; title: string | null }>> {
  return raw.executeRaw<{ slug: string; type: string | null; title: string | null }>(
    'SELECT slug, type, title FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
}

/** The live page's text, its `mention_ignore` and whether it is due for the mention pass at extractor `version`. */
export function readExplainScanPage(raw: MentionRaw, sourceId: string, slug: string, version: number): Promise<ExplainScanPageRow[]> {
  return raw.executeRaw<ExplainScanPageRow>(
    `SELECT p.id, p.slug, p.title, p.compiled_truth, p.timeline, p.frontmatter->'mention_ignore' AS mention_ignore,
            (s.page_id IS NULL OR s.mention_revision IS DISTINCT FROM p.knowledge_revision OR s.mention_version IS DISTINCT FROM $3) AS due
       FROM pages p LEFT JOIN page_mention_state s ON s.page_id = p.id
      WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [sourceId, slug, version]);
}

/** How many mention links the page has to `targets` in the source. */
export function countMentionLinksTo(raw: MentionRaw, pageId: number, sourceId: string, targets: readonly string[]): Promise<Array<{ n: number }>> {
  return raw.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM links l JOIN pages t ON t.id = l.to_page_id
      WHERE l.from_page_id = $1 AND l.link_source = 'mentions' AND t.source_id = $2 AND t.slug = ANY($3::text[])`, [pageId, sourceId, targets]);
}

/** The live page's title, body and frontmatter. */
export function readPageNameText(raw: MentionRaw, sourceId: string, slug: string): Promise<PageNameTextRow[]> {
  return raw.executeRaw<PageNameTextRow>(
    'SELECT title, compiled_truth, timeline, frontmatter FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [sourceId, slug]);
}

/** The page's frontmatter alias rows, by alias. */
export function listFrontmatterAliasNorms(raw: MentionRaw, sourceId: string, slug: string): Promise<Array<{ alias_norm: string }>> {
  return raw.executeRaw<{ alias_norm: string }>(
    `SELECT alias_norm FROM page_aliases WHERE source_id = $1 AND slug = $2 AND origin = 'frontmatter' ORDER BY alias_norm`, [sourceId, slug]);
}

/** Up to 50 live pages of `types` whose title or body ILIKE `pattern` (explain's rejected-declaration search). */
export function listRejectedDeclarationPages(raw: MentionRaw, sourceId: string, types: readonly string[], pattern: string): Promise<PageNameTextRow[]> {
  return raw.executeRaw<PageNameTextRow>(
    `SELECT title, compiled_truth, timeline, frontmatter FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND type = ANY($2::text[])
        AND (compiled_truth ILIKE $3 OR title ILIKE $3) LIMIT 50`, [sourceId, types, pattern]);
}
