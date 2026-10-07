/**
 * Pure rules of the calendar sync window (src/core/google/calendar-window.ts).
 *
 * Protects the boundary semantics the sweep relies on (#5442): Google's
 * timeMin is compared with an event's END and timeMax with its START, so an
 * event touching either edge lands on a fixed side, and dates that do not
 * parse never push an event out of the window. Also pins when a catch-up list
 * is due, the --full reconcile scope, and the page change each listed event
 * calls for. The sweep-level behavior is in test/google-source-reconcile.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { CALENDAR_HORIZON_DAYS, CalendarSyncWindow, planCalendarPage, unlistedCalendarPages } from '../src/core/google/calendar-window.ts';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 6, 12, 0, 0);
const win = new CalendarSyncWindow(NOW, 30);
const iso = (ms: number) => new Date(ms).toISOString();

describe('CalendarSyncWindow', () => {
  test('spans historyDays back to the 60-day horizon', () => {
    expect(CALENDAR_HORIZON_DAYS).toBe(60);
    expect(win.floorMs).toBe(NOW - 30 * DAY);
    expect(win.ceilMs).toBe(NOW + 60 * DAY);
    expect(win.listBounds()).toEqual({ timeMinIso: iso(NOW - 30 * DAY), timeMaxIso: iso(NOW + 60 * DAY) });
    expect(win.listBounds(NOW + 10 * DAY).timeMinIso).toBe(iso(NOW + 10 * DAY));
  });

  test('side compares the end with the floor and the start with the ceiling, edges included', () => {
    expect(win.side(iso(win.floorMs - DAY), iso(win.floorMs))).toBe('before');
    expect(win.side(iso(win.floorMs - DAY), iso(win.floorMs + 1))).toBe('inside');
    expect(win.side(iso(win.ceilMs - 1), iso(win.ceilMs + DAY))).toBe('inside');
    expect(win.side(iso(win.ceilMs), iso(win.ceilMs + DAY))).toBe('after');
  });

  test('unparseable dates never move an event out of the window', () => {
    expect(win.side('', '')).toBe('inside');
    expect(win.side('not-a-date', iso(win.floorMs - DAY))).toBe('before');
    expect(win.side(iso(win.floorMs - 2 * DAY), 'not-a-date')).toBe('before');
    expect(win.side(iso(NOW), 'not-a-date')).toBe('inside');
  });

  test('a catch-up list is due for missing horizons and day-old ones, never after a whole-window list', () => {
    expect(win.coverageStartMs(null, false)).toBe(NOW);
    expect(win.coverageStartMs(undefined, false)).toBe(NOW);
    expect(win.coverageStartMs(win.ceilMs - DAY, false)).toBe(win.ceilMs - DAY);
    expect(win.coverageStartMs(win.ceilMs - DAY + 1, false)).toBeNull();
    expect(win.coverageStartMs(null, true)).toBeNull();
    expect(win.coverageStartMs(win.ceilMs - 30 * DAY, true)).toBeNull();
  });

  test('startsInside is [floor, ceiling) on the start alone', () => {
    expect(win.startsInside(iso(win.floorMs))).toBe(true);
    expect(win.startsInside(iso(win.floorMs - 1))).toBe(false);
    expect(win.startsInside(iso(win.ceilMs - 1))).toBe(true);
    expect(win.startsInside(iso(win.ceilMs))).toBe(false);
    expect(win.startsInside(null)).toBe(false);
  });
});

describe('planCalendarPage', () => {
  test('cancellations remove the page wherever the event sits, falling back to the rendered path', () => {
    expect(planCalendarPage('after', null, 'calendar/a.md', 'calendar/b.md')).toEqual({ kind: 'remove', relPath: 'calendar/a.md' });
    expect(planCalendarPage('inside', null, null, 'calendar/b.md')).toEqual({ kind: 'remove', relPath: 'calendar/b.md' });
  });

  test('outside the window: history is left alone, a page past the horizon is removed', () => {
    expect(planCalendarPage('before', 'calendar/new.md', 'calendar/old.md', 'x')).toEqual({ kind: 'ignore' });
    expect(planCalendarPage('after', 'calendar/new.md', 'calendar/old.md', 'x')).toEqual({ kind: 'remove', relPath: 'calendar/old.md' });
    expect(planCalendarPage('after', 'calendar/new.md', null, 'x')).toEqual({ kind: 'ignore' });
  });

  test('inside the window: write, removing a copy at another path first', () => {
    expect(planCalendarPage('inside', 'calendar/new.md', 'calendar/old.md', 'x')).toEqual({ kind: 'write', removeFirst: 'calendar/old.md' });
    expect(planCalendarPage('inside', 'calendar/new.md', 'calendar/new.md', 'x')).toEqual({ kind: 'write', removeFirst: null });
    expect(planCalendarPage('inside', 'calendar/new.md', null, 'x')).toEqual({ kind: 'write', removeFirst: null });
  });
});

describe('unlistedCalendarPages', () => {
  test('keeps only sweep pages that start inside the window and were not listed', () => {
    const page = (event_id: string | null, startMs: number) => ({ event_id, start_iso: iso(startMs) });
    const pages = [
      page('listed', NOW + DAY),
      page('dropped', NOW + 2 * DAY),
      page('aged', win.floorMs - DAY),
      page('far', win.ceilMs + DAY),
      page(null, NOW + 3 * DAY),
      { event_id: 'undated', start_iso: null },
    ];
    expect(unlistedCalendarPages(pages, new Set(['listed']), win).map((p) => p.event_id)).toEqual(['dropped']);
  });
});
