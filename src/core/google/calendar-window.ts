/**
 * Which calendar events a google source keeps pages for (#5442).
 *
 * The source mirrors one rolling range: from `historyDays` back to
 * `CALENDAR_HORIZON_DAYS` ahead. Google can only apply that range to a
 * windowed list; a syncToken delta carries no timeMin/timeMax, and with
 * singleEvents=true a single edit to a recurring series brings back every
 * expanded instance of it, years in both directions. So the sweep checks each
 * listed event against the range itself, on every kind of list.
 *
 * `CalendarSyncWindow` is computed once per sweep and answers three questions:
 * - which side of the range an event falls on (`side`), matching Google's own
 *   rule: timeMin is compared with an event's end, timeMax with its start;
 * - what a delta cannot tell us: the range's leading edge moves forward every
 *   day, and an unchanged instance that crosses it never appears in a delta.
 *   `GoogleSourceState.calendar_horizon_ms` records how far ahead the calendar
 *   was last listed, and `coverageStartMs` says where the next catch-up list
 *   must begin;
 * - which existing pages a complete `--full` list has dropped
 *   (`unlistedCalendarPages`). Only events starting inside the listed range
 *   qualify, so pages older than the floor (for example after historyDays
 *   shrinks) are never removed by a reconcile.
 *
 * `planCalendarPage` turns one listed event into a page change; google-source
 * performs it with its own write and delete primitives.
 */
import type { CalendarEventData } from './types.ts';

/** How far ahead of now calendar pages are kept, in days. */
export const CALENDAR_HORIZON_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export type CalendarWindowSide = 'before' | 'inside' | 'after';

export class CalendarSyncWindow {
  readonly floorMs: number;
  readonly ceilMs: number;

  constructor(readonly nowMs: number, historyDays: number) {
    this.floorMs = nowMs - historyDays * DAY_MS;
    this.ceilMs = nowMs + CALENDAR_HORIZON_DAYS * DAY_MS;
  }

  /** timeMin/timeMax for a windowed list that starts at `fromMs` (the floor unless given). */
  listBounds(fromMs: number = this.floorMs): { timeMinIso: string; timeMaxIso: string } {
    return { timeMinIso: new Date(fromMs).toISOString(), timeMaxIso: new Date(this.ceilMs).toISOString() };
  }

  /**
   * An event is `after` the range when it starts at or past the ceiling and
   * `before` it when it ends at or before the floor (its start stands in for an
   * end that does not parse). A date that does not parse never moves an event
   * out of the range, so a cancelled skeleton with no dates stays `inside`.
   */
  side(startIso: string, endIso: string): CalendarWindowSide {
    const start = Date.parse(startIso);
    if (start >= this.ceilMs) return 'after';
    const end = Date.parse(endIso);
    const finish = Number.isNaN(end) ? start : end;
    return finish <= this.floorMs ? 'before' : 'inside';
  }

  /**
   * Where the catch-up list for unchanged instances should start, or null when
   * none is due. A sweep that listed the whole window already saw them. State
   * with no recorded horizon (saved before it existed) is listed from now, as
   * its last full list is of unknown age; a recorded horizon is listed from
   * once the ceiling has moved at least a day past it.
   */
  coverageStartMs(horizonMs: number | null | undefined, listedWholeWindow: boolean): number | null {
    if (listedWholeWindow) return null;
    if (typeof horizonMs !== 'number') return this.nowMs;
    return this.ceilMs - horizonMs >= DAY_MS ? horizonMs : null;
  }

  /** Whether an event starting at `startIso` begins inside [floor, ceiling). */
  startsInside(startIso: string | null): boolean {
    const start = Date.parse(startIso ?? '');
    return start >= this.floorMs && start < this.ceilMs;
  }
}

/** The page change one listed event calls for. */
export type CalendarPageChange =
  | { kind: 'write'; removeFirst: string | null }
  | { kind: 'remove'; relPath: string }
  | { kind: 'ignore' };

/**
 * Decide the page change for one listed event.
 *
 * `targetPath` is where the event renders, or null for a cancellation.
 * `currentPath` is the page already holding this event id, if any. Ids are
 * stable while paths derive from the date and title. A cancellation removes
 * the event's page wherever the event sits in time. An event that ended
 * before the floor is ignored, so history imported while it was in range is
 * kept as it is. One that now starts past the ceiling loses its page; the
 * catch-up list brings it back once it is in range. Anything else is
 * written, after removing a copy at an older path.
 */
export function planCalendarPage(side: CalendarWindowSide, targetPath: string | null, currentPath: string | null,
  fallbackPath: string): CalendarPageChange {
  if (targetPath === null) return { kind: 'remove', relPath: currentPath ?? fallbackPath };
  if (side === 'before') return { kind: 'ignore' };
  if (side === 'after') return currentPath ? { kind: 'remove', relPath: currentPath } : { kind: 'ignore' };
  return { kind: 'write', removeFirst: currentPath !== null && currentPath !== targetPath ? currentPath : null };
}

/**
 * Pages written by the sweep (they carry an event id) whose event starts
 * inside `window` but which a complete `--full` list of that window did not
 * name: deleted or cancelled upstream since the last list.
 */
export function unlistedCalendarPages<T extends { event_id: string | null; start_iso: string | null }>(pages: T[],
  listedIds: ReadonlySet<string>, window: CalendarSyncWindow): T[] {
  return pages.filter(page => page.event_id !== null && !listedIds.has(page.event_id) && window.startsInside(page.start_iso));
}
