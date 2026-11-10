/**
 * Stores that name a page by slug with no foreign key to it, cleared when the page is purged:
 * - `context_volunteer_events`: the push-context log keeps the slug and a rationale that can quote
 *   the name the page was matched by, for `VOLUNTEER_EVENTS_TTL_DAYS`;
 * - `mention_gazetteer_entries`: the mention pass's saved entry set keeps the page's normalized
 *   title and aliases keyed to the slug until the next pass diffs it.
 *
 * Source-scoped, and run inside the purge transaction so the rows go with the page. The next
 * mention pass builds its gazetteer from live pages, so a purged entry is in neither side of its
 * diff; links to the purged page already went with the page row.
 */
import type { BrainEngine } from '../engine.ts';

export async function scrubPurgedPageNames(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slugs: readonly string[],
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const count = async (sql: string) => (await engine.executeRaw(sql, [sourceId, [...slugs]])).length;
  return {
    context_volunteer_events: await count('DELETE FROM context_volunteer_events WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1'),
    mention_gazetteer_entries: await count('DELETE FROM mention_gazetteer_entries WHERE source_id = $1 AND target_slug = ANY($2::text[]) RETURNING 1'),
  };
}
