import { describe, expect, test } from 'bun:test';
import fixture from '../integrations/calendar-to-brain/fixtures/mock-response.json';
import {
  normalizeEvents,
  groupEventsByDay,
  renderDayMarkdown,
  buildRequestedWindow,
  parseArgs,
} from '../integrations/calendar-to-brain/collector.mjs';

describe('calendar-to-brain collector', () => {
  test('normalizes fixture, skips cancelled events, and groups by day', () => {
    const events = normalizeEvents(fixture);
    expect(events).toHaveLength(3);
    expect(events.map((event) => event.id)).toEqual(['evt_all_day', 'evt_timed_1', 'evt_timed_2']);

    const grouped = groupEventsByDay(events);
    expect([...grouped.keys()]).toEqual(['2026-05-10', '2026-05-11']);
    expect(grouped.get('2026-05-10').map((event) => event.id)).toEqual(['evt_all_day', 'evt_timed_1']);
  });

  test('renders markdown with explicit redacted source and no leaked emails', () => {
    const events = normalizeEvents(fixture);
    const grouped = groupEventsByDay(events);
    const serviceId = ['google.calendar', 'fixture-user'].join(':');
    const markdown = renderDayMarkdown('2026-05-10', grouped.get('2026-05-10'), {
      collectedAt: '2026-05-09T00:00:00.000Z',
      serviceId,
      range: buildRequestedWindow('2026-05-10', '2026-05-11'),
    });

    expect(markdown).toContain('service: google.calendar:[redacted]');
    expect(markdown).toContain('Source: ClawVisor Google Calendar (google.calendar:[redacted])');
    expect(markdown).not.toContain(serviceId);
    expect(markdown).not.toContain('fixture-user');
    expect(markdown).toContain('All day **Offsite équipe**');
    expect(markdown).toContain('09:00-09:30 **Point dossier X**');
    expect(markdown).toContain('Attendees: Alice Martin, Bob Durant');
    expect(markdown).not.toContain('@');
  });

  test('CLI defaults stay safe', () => {
    const args = parseArgs(['--mock']);
    expect(args.dryRun).toBe(true);
    expect(args.write).toBe(false);
    expect(args.maxResults).toBe(3);
    expect(args.from).toBeTruthy();
    expect(args.to).toBeTruthy();
  });
});
