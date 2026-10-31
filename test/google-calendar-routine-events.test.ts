/**
 * Routine provider event types must not become meetings. Existing calendar
 * coverage tests cancellations and windows, not event types. The real client,
 * renderer and planner expose the regression without a new production seam.
 */
import { expect, test } from 'bun:test';
import { CalendarClient } from '../src/core/google/google-clients.ts';
import { renderCalendarEventPage } from '../src/core/google/google-render.ts';
import { planCalendarPage } from '../src/core/google/calendar-window.ts';

const tokens = {
  getAccessToken: async () => 'synthetic-token',
  forceRefresh: async () => 'synthetic-token',
};
const base = {
  id: 'event-instance', summary: 'Routine block', status: 'confirmed',
  start: { dateTime: '2026-10-27T12:00:00Z' },
  end: { dateTime: '2026-10-27T13:00:00Z' },
};

for (const eventType of ['focusTime', 'outOfOffice', 'workingLocation']) {
  test(`retires ${eventType} pages on lists, deltas and held-item reads`, async () => {
    const raw = { ...base, eventType };
    const client = new CalendarClient(tokens, async () => Response.json({
      ...raw, items: [raw], nextSyncToken: 'next-cursor',
    }));
    const windowed = await client.listEvents('', {});
    const delta = await client.listEvents('', { syncToken: 'cursor' });
    const held = await client.getEvent('', 'primary', raw.id);
    expect(windowed.nextSyncToken).toBe('next-cursor');
    expect(delta.nextSyncToken).toBe('next-cursor');
    expect(held).not.toBeNull();
    for (const event of [...windowed.events, ...delta.events, held!]) {
      const page = renderCalendarEventPage(event);
      expect(page).toBeNull();
      expect(planCalendarPage('inside', page?.relPath ?? null, 'calendar/old.md', 'calendar/new.md'))
        .toEqual({ kind: 'remove', relPath: 'calendar/old.md' });
    }
  });
}

test('preserves ordinary, private, solo and recurring meetings and unknown types', async () => {
  const raw = [
    base,
    { ...base, eventType: 'default' },
    { ...base, eventType: 'default', visibility: 'private' },
    { ...base, eventType: 'default', recurringEventId: 'series' },
    { ...base, eventType: 'future-type' },
  ];
  const client = new CalendarClient(tokens, async () => Response.json({ items: raw }));
  const { events } = await client.listEvents('', {});
  expect(events).toHaveLength(raw.length);
  for (const event of events) expect(renderCalendarEventPage(event)).not.toBeNull();
  expect(renderCalendarEventPage(events[2]!)!.markdown).toContain('visibility: private');
});
