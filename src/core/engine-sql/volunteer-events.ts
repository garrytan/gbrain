/**
 * The volunteered-page log statements context/volunteer-events.ts and context/volunteer.ts ran through executeRaw, as
 * typed members: PGLite and Postgres send the same text as before (the insert's VALUES list is built per row, its
 * placeholders numbered by renderFragment exactly as the caller numbered them), and a Rust brain answers from its store
 * (rust/docs/store/volunteer-events.md).
 */
import type { BrainEngine } from '../engine.ts';
import { joinFragments, renderFragment, sqlFragment } from './fragment.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/** One volunteered page to log. */
export interface VolunteerEventInsert {
  source_id: string;
  slug: string;
  confidence: number;
  match_arm: string;
  rationale: string;
  channel: string;
  session_id?: string | null;
  turn?: number | null;
}

/** One match arm and channel of the usage read: volunteered and later-retrieved counts (as text, as the SQL casts them). */
export interface VolunteerUsageRow { match_arm: string; channel: string; volunteered: string | number; used: string | number }

/** The usage statement context/volunteer.ts volunteerUsageStats ran. */
export const VOLUNTEER_USAGE_SQL = `SELECT e.match_arm, e.channel,
              count(*)::text AS volunteered,
              count(*) FILTER (WHERE GREATEST(p.last_retrieved_at, r.last_retrieved_at) > e.volunteered_at)::text AS used
         FROM context_volunteer_events e
         LEFT JOIN pages p
           ON p.source_id = e.source_id AND p.slug = e.slug AND p.deleted_at IS NULL
         LEFT JOIN page_retrievals r ON r.page_id = p.id
        WHERE e.source_id = ANY($1::text[])
          AND e.volunteered_at > now() - ($2 || ' days')::interval
        GROUP BY e.match_arm, e.channel
        ORDER BY e.match_arm COLLATE "C", e.channel COLLATE "C"`;

/**
 * Logs the volunteered pages whose page row still exists, probed under the feedback writers' key-share lock (#9068);
 * the rest are dropped. One statement for the batch. No row, no statement. A failure is thrown unchanged.
 */
export async function insertVolunteerEvents(tx: Raw, rows: readonly VolunteerEventInsert[]): Promise<void> {
  if (!rows.length) return;
  const tuples = joinFragments(rows.map(r => sqlFragment`(${r.source_id}::text, ${r.slug}::text, ${r.confidence}::float8, ${r.match_arm}::text, ${r.rationale}::text, ${r.channel}::text, ${r.session_id ?? null}::text, ${r.turn ?? null}::int)`), ', ');
  const { text, params } = renderFragment(sqlFragment`INSERT INTO context_volunteer_events
       (source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     SELECT v.* FROM (VALUES ${tuples}) AS v(source_id, slug, confidence, match_arm, rationale, channel, session_id, turn)
     WHERE EXISTS (SELECT 1 FROM pages pg WHERE pg.source_id = v.source_id AND pg.slug = v.slug FOR KEY SHARE)`);
  await tx.executeRaw(text, params);
}

/** The volunteered and used counts per match arm and channel over the last `days` days of the sources, by byte of arm then channel. */
export function readVolunteerUsage(tx: Raw, sourceIds: readonly string[], days: number): Promise<VolunteerUsageRow[]> {
  return tx.executeRaw<VolunteerUsageRow>(VOLUNTEER_USAGE_SQL, [[...sourceIds], String(days)]);
}

/** The retention delete the dream cycle's purge phase runs: removes the rows older than `ttlDays` days; how many went. */
export async function deleteVolunteerEventsOlderThan(tx: Raw, ttlDays: number): Promise<number> {
  const rows = await tx.executeRaw<{ count: string | number }>(
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
