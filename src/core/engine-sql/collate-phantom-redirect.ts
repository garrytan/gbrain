/**
 * The root-page walk of the phantom-redirect pass (src/core/cycle/phantom-redirect.ts) that ran through
 * `engine.executeRaw`, now a typed member so a Rust brain answers it from its store
 * (rust/docs/store/collate-phantom-redirect.md). The statement is the one the pass ran.
 */

/** The engine's `executeRaw` (bound). */
export type PhantomRedirectRaw = <R = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<R[]>;

/** The pass's window: live root pages (no `/` in the slug) after the cursor, minus the held ones, by slug bytes. */
export const LIST_ROOT_PAGE_SLUGS_AFTER_SQL = `SELECT slug FROM pages
       WHERE source_id = $1
         AND deleted_at IS NULL
         AND slug NOT LIKE '%/%'
         AND slug <> ALL($3::text[])
         AND slug COLLATE "C" > $4
       ORDER BY slug COLLATE "C" ASC
       LIMIT $2`;

/** Up to `limit` live root-page slugs of the source after `after` (bytewise), skipping `exclude`, in byte order. */
export async function listRootPageSlugsAfter(raw: PhantomRedirectRaw, sourceId: string, after: string, exclude: readonly string[], limit: number): Promise<string[]> {
  const rows = await raw<{ slug: string }>(LIST_ROOT_PAGE_SLUGS_AFTER_SQL, [sourceId, limit, [...exclude], after]);
  return rows.map(r => r.slug);
}
