/**
 * The reads of `gbrain repair slug-spelling` (repair/slug-spelling.ts, repair/slug-spelling-guards.ts) and of its doctor
 * check `legacy_slug_spellings` (commands/doctor/checks/legacy-slug-spellings.ts). Each statement is the text its caller
 * ran through `executeRaw`, pinned byte for byte in test/engine-sql-caller-raw-sql-pins.test.ts. Unscoped on master (they
 * ran on the pool, or inside the caller's own transaction).
 */
import type { LegacyUnscopedRead } from './brands.ts';
import { renderFragment, sqlFragment, trustedSql } from './fragment.ts';
import { SCAN_KEY_SQL, SPELLING_KEY_SQL } from '../slug-spelling-key.ts';

/** One page whose slug may not be normal, for the doctor check's count (`normalizeSlug` decides). */
export interface SlugSpellingCandidateRow { id: number | string; source_id: string; slug: string }

/** The candidate rows one call answers (the caller's `BATCH`). */
export const SLUG_SPELLING_CANDIDATE_BATCH = 5000;

/**
 * The tables of `tables` that row-level security applies to for the running role, in name order. A policy's existence does
 * not prove it shows every row (a `USING (false)` policy hides them all), so a read of such a table can come back short.
 */
export async function readRowSecurityTables(exec: LegacyUnscopedRead, tables: readonly string[]): Promise<string[]> {
  return (await exec.executeRaw<{ t: string }>('SELECT t FROM unnest($1::text[]) AS t WHERE pg_catalog.row_security_active(t) ORDER BY t', [[...tables]])).map(row => row.t);
}

/**
 * The pages of every source (deleted ones included) whose slug has a capital or a character outside printable ASCII, with
 * an id above `afterId`, in id order, at most SLUG_SPELLING_CANDIDATE_BATCH. Every slug that is not normal is among them.
 */
export async function listSlugSpellingCandidates(exec: LegacyUnscopedRead, afterId: number): Promise<SlugSpellingCandidateRow[]> {
  return exec.executeRaw<SlugSpellingCandidateRow>(`SELECT id, source_id, slug FROM pages
      WHERE id > $1 AND (slug <> lower(slug) OR slug ~ '[^ -~]') ORDER BY id LIMIT 5000`, [afterId]);
}

/** The database's server encoding (`SHOW server_encoding`), or `unknown` when it answers no row. */
export async function readServerEncoding(exec: LegacyUnscopedRead): Promise<string> {
  const [row] = await exec.executeRaw<{ server_encoding: string }>('SHOW server_encoding');
  return row?.server_encoding ?? 'unknown';
}

/**
 * The tables of every schema on the search path that row-level security applies to for the running role, in name order
 * (the repair's guard: it refuses to move a page when any brain table can hide rows from it).
 */
export async function readRowSecurityBrainTables(exec: LegacyUnscopedRead): Promise<string[]> {
  return (await exec.executeRaw<{ t: string }>(`SELECT c.relname::text AS t FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY(pg_catalog.current_schemas(false)) AND c.relkind IN ('r', 'p') AND pg_catalog.row_security_active(c.oid) ORDER BY 1`)).map(row => row.t);
}

/** The source row the repair's preview and move read: its checkout, its incarnation and its slug-root mode (null: git-root). */
export interface SlugRepairSourceRow { local_path: string | null; incarnation: string; slug_root_mode: 'git-root' | 'source-root' | null }

export async function readSlugRepairSource(exec: LegacyUnscopedRead, sourceId: string): Promise<SlugRepairSourceRow | null> {
  const [row] = await exec.executeRaw<SlugRepairSourceRow>("SELECT local_path, incarnation::text AS incarnation, CASE WHEN config->>'slug_root_mode' IN ('git-root', 'source-root') THEN config->>'slug_root_mode' END AS slug_root_mode FROM sources WHERE id=$1", [sourceId]);
  return row ?? null;
}

/** One page of a source whose slug may not be normal, for the preview (`normalizeSlug` decides). */
export interface SourceSlugSpellingCandidateRow { id: number | string; slug: string; revision: string; source_path: string | null; deleted: boolean }

/** The source's pages (deleted ones included) that pass the same prefilter as `listSlugSpellingCandidates`, id above `afterId`, id order, 5000 a call. */
export async function listSourceSlugSpellingCandidates(exec: LegacyUnscopedRead, sourceId: string, afterId: number): Promise<SourceSlugSpellingCandidateRow[]> {
  return exec.executeRaw<SourceSlugSpellingCandidateRow>(`SELECT id, slug, knowledge_revision::text AS revision, source_path, deleted_at IS NOT NULL AS deleted FROM pages
      WHERE source_id=$1 AND id > $2 AND (slug <> lower(slug) OR slug ~ '[^ -~]') ORDER BY id LIMIT 5000`, [sourceId, afterId]);
}

/** A page that shares a spelling key with a slug. */
export interface SpellingKeyPageRow { id: number | string; slug: string }

/**
 * The source's pages (deleted ones included) other than `excludeId` whose spelling index key is one of `keys`
 * (`SPELLING_KEY_SQL`, through `idx_pages_spelling_key`), or, with `keys` null, whose ASCII scan key is `scanKey`
 * (`SCAN_KEY_SQL`, unindexed); in id order. The caller compares each slug with `normalizeSlug`.
 */
export async function readSpellingKeyPages(exec: LegacyUnscopedRead, sourceId: string, keys: readonly string[] | null, scanKey: string, excludeId: number): Promise<SpellingKeyPageRow[]> {
  const match = keys ? sqlFragment`${trustedSql(SPELLING_KEY_SQL)} = ANY(${[...keys]}::text[])` : sqlFragment`${trustedSql(SCAN_KEY_SQL)} = ${scanKey}`;
  const { text, params } = renderFragment(sqlFragment`SELECT id, slug FROM pages WHERE ${match} AND source_id = ${sourceId} AND id <> ${excludeId} ORDER BY id`);
  return exec.executeRaw<SpellingKeyPageRow>(text, params);
}

/** The slug of page `pageId` when it belongs to `sourceId` (deleted or not), or null. */
export async function readPageSlugInSource(exec: LegacyUnscopedRead, pageId: number, sourceId: string): Promise<string | null> {
  const [row] = await exec.executeRaw<{ slug: string }>('SELECT slug FROM pages WHERE id=$1 AND source_id=$2', [pageId, sourceId]);
  return row?.slug ?? null;
}

/** The page row the slug-spelling move re-reads under its locks (the preview's candidate columns), or null. */
export async function readSlugRepairPage(exec: LegacyUnscopedRead, pageId: number, sourceId: string): Promise<SourceSlugSpellingCandidateRow | null> {
  const [row] = await exec.executeRaw<SourceSlugSpellingCandidateRow>('SELECT id, slug, knowledge_revision::text AS revision, source_path, deleted_at IS NOT NULL AS deleted FROM pages WHERE id=$1 AND source_id=$2', [pageId, sourceId]);
  return row ?? null;
}
