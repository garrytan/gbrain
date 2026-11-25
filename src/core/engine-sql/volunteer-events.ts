/**
 * The context_volunteer_events statements (migration v117), each with the text and parameters its caller ran through
 * `executeRaw`; only their home moved: the insert of `logVolunteerEventsFireAndForget`
 * (src/core/context/volunteer-events.ts), the usage read of `volunteerUsageStats` (context/volunteer.ts) and the 90-day
 * retention delete. The page purge's name-store scrub and its receipt's per-page check are in purge-stores.ts and
 * purge-verify.ts. The channel listing is `listVolunteerChannels` in doctor-acc.ts, and the source
 * delete's scrub is `scrub_context_volunteer_events` in sources.ts. The Rust engine keeps the rows in its store
 * (rust/docs/store/volunteer-events.md) and removes them with their page or source, as these statements do.
 */

import { joinFragments, renderFragment, sqlFragment } from './fragment.ts';

/** The slice of an engine these statements run through. */
export interface VolunteerRaw {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** One row to log: the columns of the insert; `volunteered_at` defaults to now. */
export interface VolunteerEventInsertRow {
  source_id: string;
  slug: string;
  confidence: number;
  match_arm: string;
  rationale: string;
  channel: string;
  session_id?: string | null;
  turn?: number | null;
}

/** One `(match_arm, channel)` group of `volunteerUsageStats`; the counts are `count(*)::text`. */
export interface VolunteerUsageRow { match_arm: string; channel: string; volunteered: string | number; used: string | number }

/**
 * ONE multi-row parameterized INSERT for a batch of volunteered pages (max 5 per call by the volunteer cap).
 * #9068: it writes only rows whose page still exists, probed under the feedback writers' key-share lock on the page row,
 * so a write built before a page purge and landing after it (or while the purge is open) drops that page's slug and
 * rationale instead of restoring them.
 */
export async function insertVolunteerEventRows(raw: VolunteerRaw, rows: readonly VolunteerEventInsertRow[]): Promise<void> {
  if (!rows.length) return;
  const tuples = rows.map((r) => sqlFragment`(${r.source_id}::text, ${r.slug}::text, ${r.confidence}::float8, ${r.match_arm}::text, ${r.rationale}::text, ${r.channel}::text, ${r.session_id ?? null}::text, ${r.turn ?? null}::int)`);
  const { text, params } = renderFragment(sqlFragment`INSERT INTO context_volunteer_events
       (source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     SELECT v.* FROM (VALUES ${joinFragments(tuples, ', ')}) AS v(source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = v.source_id AND pg.slug = v.slug FOR KEY SHARE)`);
  await raw.executeRaw(text, params);
}

/**
 * Per-arm/channel precision inputs over the last `days` days for the given sources: events volunteered and those whose
 * page was retrieved after them. Byte order of arm, then channel.
 */
export function listVolunteerUsage(raw: VolunteerRaw, sourceIds: readonly string[], days: number): Promise<VolunteerUsageRow[]> {
  return raw.executeRaw<VolunteerUsageRow>(
    `SELECT e.match_arm, e.channel,
              count(*)::text AS volunteered,
              count(*) FILTER (WHERE GREATEST(p.last_retrieved_at, r.last_retrieved_at) > e.volunteered_at)::text AS used
         FROM context_volunteer_events e
         LEFT JOIN pages p
           ON p.source_id = e.source_id AND p.slug = e.slug AND p.deleted_at IS NULL
         LEFT JOIN page_retrievals r ON r.page_id = p.id
        WHERE e.source_id = ANY($1::text[])
          AND e.volunteered_at > now() - ($2 || ' days')::interval
        GROUP BY e.match_arm, e.channel
        ORDER BY e.match_arm COLLATE "C", e.channel COLLATE "C"`,
    [sourceIds, String(days)],
  );
}

/** The retention delete: removes the rows older than `ttlDays` days; how many went. */
export async function deleteVolunteerEventsOlderThan(raw: VolunteerRaw, ttlDays: number): Promise<number> {
  const rows = await raw.executeRaw<{ count: string | number }>(
    `WITH deleted AS (
         DELETE FROM context_volunteer_events
         WHERE volunteered_at < now() - ($1 || ' days')::interval
         RETURNING 1
       )
       SELECT count(*)::text AS count FROM deleted`,
    [String(ttlDays)],
  );
  return Number(rows[0]?.count ?? 0);
}
