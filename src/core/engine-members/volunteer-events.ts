/**
 * The context_volunteer_events members (engine-sql/volunteer-events.ts, rust/docs/store/volunteer-events.md): the push-context
 * log's insert, usage read, retention delete and the two page purge statements. The channel listing is `listVolunteerChannels`
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
  /** A page purge's scrub: removes the events naming these slugs of the source; how many went. */
  deleteVolunteerEventsForSlugs(sourceId: string, slugs: readonly string[]): Promise<number>;
  /** How many events still name the slug of the source (the page purge receipt). */
  countVolunteerEventsForSlug(sourceId: string, slug: string): Promise<number>;
}
