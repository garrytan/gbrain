import { describe, test, expect } from 'bun:test';
import {
  computeContentSanityAuditCheck,
  CONTENT_SANITY_NEW_PAGES_WARN_THRESHOLD,
} from '../src/commands/doctor.ts';
import {
  summarizeContentSanityEvents,
  type ContentSanityAuditEvent,
} from '../src/core/audit/content-sanity-audit.ts';

function event(over: Partial<ContentSanityAuditEvent>): ContentSanityAuditEvent {
  return {
    ts: '2026-07-17T10:00:00.000Z',
    event_type: 'warn',
    slug: 'test',
    source_id: 'default',
    bytes: 100_000,
    junk_pattern_matches: [],
    literal_substring_matches: [],
    reason_messages: ['PAGE_OVERSIZE_WARN: body 100000 bytes exceeds 50000 byte warn threshold'],
    ...over,
  };
}
const onDay = (day: string, over: Partial<ContentSanityAuditEvent> = {}) =>
  event({ ts: `${day}T10:00:00.000Z`, ...over });
/** Same slug re-warned across `days` distinct days — a chronic signature. */
const chronicWarn = (slug: string, days = 3) =>
  Array.from({ length: days }, (_, i) => onDay(`2026-07-${String(11 + i).padStart(2, '0')}`, { slug }));

describe('computeContentSanityAuditCheck (#1893 chronic vs new scoring)', () => {
  test('chronic-only warn stream scores ok and names the standing-state checks', () => {
    const check = computeContentSanityAuditCheck(summarizeContentSanityEvents([
      ...chronicWarn('transcript-a', 7),
      ...chronicWarn('transcript-b', 7),
    ]));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('chronic=2 new=0');
    expect(check.message).toContain('Top chronic: default/transcript-a (7 events/7d)');
    expect(check.message).toContain('oversized_pages/flagged_pages/quarantined_pages');
  });

  test('one new soft_block page warns even when everything else is chronic', () => {
    const check = computeContentSanityAuditCheck(summarizeContentSanityEvents([
      ...chronicWarn('transcript-a', 7),
      onDay('2026-07-17', { slug: 'fresh-oversize', event_type: 'soft_block' }),
    ]));
    expect(check.status).toBe('warn');
  });

  test('new warn pages below threshold stay ok; at threshold warn', () => {
    const below = Array.from({ length: CONTENT_SANITY_NEW_PAGES_WARN_THRESHOLD - 1 }, (_, i) =>
      onDay('2026-07-17', { slug: `new-${i}` }));
    expect(computeContentSanityAuditCheck(summarizeContentSanityEvents(below)).status).toBe('ok');
    const at = [...below, onDay('2026-07-17', { slug: 'new-last' })];
    expect(computeContentSanityAuditCheck(summarizeContentSanityEvents(at)).status).toBe('warn');
  });

  test('one page re-imported 10 times in a day no longer trips the volume threshold', () => {
    const check = computeContentSanityAuditCheck(summarizeContentSanityEvents(
      Array.from({ length: 10 }, (_, i) =>
        event({ slug: 'noisy', ts: `2026-07-17T0${i}:00:00.000Z` })),
    ));
    expect(check.status).toBe('ok');
  });

  test('hard dispositions fail even when chronic', () => {
    const check = computeContentSanityAuditCheck(summarizeContentSanityEvents([
      onDay('2026-07-14', { slug: 'junk', event_type: 'quarantine', junk_pattern_matches: ['cloudflare_attention_required'] }),
      onDay('2026-07-15', { slug: 'junk', event_type: 'quarantine', junk_pattern_matches: ['cloudflare_attention_required'] }),
      onDay('2026-07-16', { slug: 'junk', event_type: 'quarantine', junk_pattern_matches: ['cloudflare_attention_required'] }),
    ]));
    expect(check.status).toBe('fail');
  });

  test('bypass events warn and surface in the message — chronicity never buries a switched-off gate', () => {
    const single = computeContentSanityAuditCheck(summarizeContentSanityEvents([
      onDay('2026-07-17', { slug: 'x', bypass_active: true }),
    ]));
    expect(single.status).toBe('warn');
    expect(single.message).toContain('bypass=1');
    const chronicBypass = computeContentSanityAuditCheck(summarizeContentSanityEvents([
      onDay('2026-07-14', { slug: 'x', bypass_active: true }),
      onDay('2026-07-15', { slug: 'x', bypass_active: true }),
      onDay('2026-07-16', { slug: 'x', bypass_active: true }),
    ]));
    expect(chronicBypass.status).toBe('warn');
  });

  test('no chronic signatures omits the Top chronic callout', () => {
    const check = computeContentSanityAuditCheck(summarizeContentSanityEvents([
      onDay('2026-07-17', { slug: 'x' }),
    ]));
    expect(check.message).not.toContain('Top chronic');
  });
});
