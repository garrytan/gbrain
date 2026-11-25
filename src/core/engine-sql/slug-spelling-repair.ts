/**
 * The reads of `gbrain repair slug-spelling` (repair/slug-spelling.ts, repair/slug-spelling-guards.ts) and of its doctor
 * check `legacy_slug_spellings` (commands/doctor/checks/legacy-slug-spellings.ts). Each statement is the text its caller
 * ran through `executeRaw`, pinned byte for byte in test/engine-sql-caller-raw-sql-pins.test.ts. Unscoped on master (they
 * ran on the pool, or inside the caller's own transaction).
 */
import type { LegacyUnscopedRead } from './brands.ts';

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
