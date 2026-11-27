/**
 * The volunteered-page log members (BrainEngine insertVolunteerEvents, readVolunteerUsage, deleteVolunteerEventsOlderThan; SQL in
 * engine-sql/volunteer-events.ts), served from the store's event records (rust/crates/gbrain-store/src/volunteer_events.rs,
 * rust/docs/store/volunteer-events.md); the 90-day purge (deleteVolunteerEventsOlderThan) is served there too.
 */
import type { VolunteerEventInsert, VolunteerUsageRow } from '../../engine-sql/volunteer-events.ts';
import { storeCall, type StoreMember } from './common.ts';

export const insertVolunteerEvents: StoreMember<[rows: readonly VolunteerEventInsert[]], void> = async (brain, rows) => {
  if (!rows.length) return;
  await storeCall({ member: 'insertVolunteerEvents' }, () => brain.insertVolunteerEvents(rows.map(r => ({
    source_id: r.source_id, slug: r.slug, confidence: r.confidence, match_arm: r.match_arm, rationale: r.rationale, channel: r.channel,
    session_id: r.session_id ?? null, turn: r.turn ?? null,
  }))));
};

export const readVolunteerUsage: StoreMember<[sourceIds: readonly string[], days: number], VolunteerUsageRow[]> = async (brain, sourceIds, days) => {
  const rows = await storeCall({ member: 'readVolunteerUsage' }, () => brain.readVolunteerUsage([...sourceIds], days)) as Array<{ match_arm: string; channel: string; volunteered: number; used: number }>;
  // The SQL casts both counts to text.
  return rows.map(r => ({ match_arm: r.match_arm, channel: r.channel, volunteered: String(r.volunteered), used: String(r.used) }));
};

export const deleteVolunteerEventsOlderThan: StoreMember<[ttlDays: number], number> = async (brain, ttlDays) =>
  Number(await storeCall({ member: 'deleteVolunteerEventsOlderThan' }, () => brain.deleteVolunteerEventsOlderThan(ttlDays)));
