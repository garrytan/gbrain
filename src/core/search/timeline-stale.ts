/**
 * The search `stale` flag (SearchResult.stale, printed as "(stale)" by `gbrain search`): a page is stale when one of
 * its timeline entries is newer than the page row, `pages.updated_at < MAX(timeline_entries.created_at)`. PGLite and
 * the Rust engine apply this rule on keyword, chunk, title and vector search; Postgres applies it too when the role
 * may read `timeline_entries` (postgres-engine/timeline-stale-probe.ts).
 */

/** The flag for the page whose `updated_at` and id are the given expressions; `probe: false` projects `false`. */
export function timelineStaleSql(updatedAt: string, pageId: string, probe = true): string {
  if (!probe) return 'false';
  return `CASE WHEN ${updatedAt} < (
          SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = ${pageId}
        ) THEN true ELSE false END`;
}
