/**
 * The context_volunteer_events members (engine-sql/volunteer-events.ts, rust/docs/store/volunteer-events.md): the push-context
 * log's insert, usage read and retention delete. The page purge's scrub and receipt check are `deletePurgedNameStoreRows` and
 * the `context_volunteer_events` store probe (engine-sql/purge-stores.ts, purge-verify.ts). The channel listing is `listVolunteerChannels`
 * (engine-members/doctor.ts). `BrainEngine` extends this interface.
 */
import type * as VolunteerEventsSql from '../engine-sql/volunteer-events.ts';

export interface VolunteerEventMembers {
  /** Log volunteered pages, one insert; only rows whose page still exists are written (#9068). */
  insertVolunteerEventRows(rows: readonly VolunteerEventsSql.VolunteerEventInsertRow[]): Promise<void>;
  /** Volunteered and used counts per (arm, channel) over the last `days` days for the sources, in byte order. */
  listVolunteerUsage(sourceIds: readonly string[], days: number): Promise<VolunteerEventsSql.VolunteerUsageRow[]>;
  /** The retention delete: removes the events older than `ttlDays` days; how many went. */
  deleteVolunteerEventsOlderThan(ttlDays: number): Promise<number>;
}
