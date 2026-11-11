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
 *
 * `ifPresent` is for the restore replay: a restored archive can predate either table, so each is
 * checked before it is deleted from. Live purges run on a migrated schema and skip the check.
 */
import type { BrainEngine } from '../engine.ts';

export async function scrubPurgedPageNames(
  engine: Pick<BrainEngine, 'executeRaw'>,
  sourceId: string,
  slugs: readonly string[],
  opts: { ifPresent?: boolean } = {},
): Promise<Record<string, number>> {
  if (!slugs.length) return {};
  const count = async (table: string, sql: string) => {
    if (opts.ifPresent) {
      const [found] = await engine.executeRaw<{ present: boolean }>('SELECT to_regclass($1::text) IS NOT NULL AS present', [table]);
      if (!found?.present) return 0;
    }
    return (await engine.executeRaw(sql, [sourceId, [...slugs]])).length;
  };
  return {
    context_volunteer_events: await count('context_volunteer_events', 'DELETE FROM context_volunteer_events WHERE source_id = $1 AND slug = ANY($2::text[]) RETURNING 1'),
    mention_gazetteer_entries: await count('mention_gazetteer_entries', 'DELETE FROM mention_gazetteer_entries WHERE source_id = $1 AND target_slug = ANY($2::text[]) RETURNING 1'),
  };
}
