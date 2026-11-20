/**
 * Statements three commands ran through `engine.executeRaw`, now typed members so a Rust brain answers them from its
 * store (rust/docs/store/collate-command-reads.md): the member-disable pages check (commands/access-read-by-nobody.ts),
 * the who-can-read page rows (commands/access.ts) and the reconcile-links page walk (commands/reconcile-links.ts).
 * Each orders its text keys by byte (`COLLATE "C"`), so every engine lists them in one order whatever its locale.
 * The statements and their parameters are unchanged; only their home moved.
 */

/** The engine's `executeRaw` (bound). */
export type CommandReadRaw = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** A page by source and slug. */
export interface LivePageNamingReaderRow { source_id: string; slug: string }

/** The most pages listLivePagesNamingReader returns: member disable checks 200 and reads one more to see a cut. */
export const LIVE_PAGES_NAMING_READER_LIMIT = 201;

/** The statement commands/access-read-by-nobody.ts ran, spelled out as one literal (LIMIT is LIVE_PAGES_NAMING_READER_LIMIT). */
export const LIVE_PAGES_NAMING_READER_SQL = `SELECT source_id, slug FROM pages WHERE deleted_at IS NULL AND frontmatter ? 'readable_by' AND gbrain_access_readers(frontmatter) @> ARRAY[$1]::text[]
     ORDER BY source_id COLLATE "C", slug COLLATE "C" LIMIT 201`;

/** The live pages whose normalized readers name exactly `principal`, by source id then slug, at most LIVE_PAGES_NAMING_READER_LIMIT. */
export async function listLivePagesNamingReader(raw: CommandReadRaw, principal: string): Promise<LivePageNamingReaderRow[]> {
  const rows = await raw<LivePageNamingReaderRow>(LIVE_PAGES_NAMING_READER_SQL, [principal]);
  return rows.map(r => ({ source_id: r.source_id, slug: r.slug }));
}

/** What who-can-read reads of a page: its type, frontmatter and the folder rules stamped on it (`source:rule_id`; null when none). */
export interface PageAccessRow {
  slug: string;
  source_id: string;
  type: string | null;
  frontmatter: unknown;
  folder_rule_ids: string[] | null;
}

/** The statements commands/access.ts whoCanRead ran: every source's page of the slug, or the one in a source. */
export const PAGE_ACCESS_ROWS_SQL = {
  any_source: `SELECT slug, source_id, type, frontmatter, folder_rule_ids FROM pages WHERE slug = $1 ORDER BY source_id COLLATE "C"`,
  one_source: `SELECT slug, source_id, type, frontmatter, folder_rule_ids FROM pages WHERE slug = $1 AND source_id = $2 ORDER BY source_id COLLATE "C"`,
} as const;

/** The page rows named `slug` (soft-deleted ones too), in one source when `sourceId` is given, else in every source by source id. */
export async function readPageAccessRows(raw: CommandReadRaw, slug: string, sourceId?: string): Promise<PageAccessRow[]> {
  const rows = sourceId
    ? await raw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.one_source, [slug, sourceId])
    : await raw<PageAccessRow>(PAGE_ACCESS_ROWS_SQL.any_source, [slug]);
  return rows.map(r => ({ slug: r.slug, source_id: r.source_id, type: r.type ?? null, frontmatter: r.frontmatter, folder_rule_ids: r.folder_rule_ids ?? null }));
}

/** The statement commands/reconcile-links.ts ran: a source's markdown pages by slug (no deleted filter, as before). */
export const MARKDOWN_PAGE_SLUGS_SQL = `SELECT slug FROM pages WHERE page_kind = 'markdown' AND source_id = $1 ORDER BY slug COLLATE "C"`;

/** The slugs of a source's markdown pages (soft-deleted ones too), by byte. */
export async function listMarkdownPageSlugs(raw: CommandReadRaw, sourceId: string): Promise<string[]> {
  const rows = await raw<{ slug: string }>(MARKDOWN_PAGE_SLUGS_SQL, [sourceId]);
  return rows.map(r => r.slug);
}
