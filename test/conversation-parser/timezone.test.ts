/**
 * #5430 (W14 P1.9, E.1): the conversation parser honours the page's declared
 * IANA timezone when it builds message timestamps. Before, every builder
 * emitted `:00Z`, so a Tokyo 09:00 message carried `T09:00:00Z` (18:00 Tokyo)
 * and every derived fact's `valid_from` was off by the zone offset.
 *
 * Policy for the two DST edge cases (documented in parse.ts `localToUtcIso`):
 *   - a FOLD (the local time happens twice, autumn) resolves to the first
 *     occurrence (the earlier instant, still on daylight time);
 *   - a GAP (the local time never happens, spring) resolves with the offset in
 *     force before the transition, so the instant lands just after the gap.
 * An invalid zone keeps UTC and the warning says so.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { deriveDateContext, localToUtcIso, parseConversation } from '../../src/core/conversation-parser/parse.ts';
import type { Page } from '../../src/core/types.ts';

function makePage(frontmatter: Record<string, unknown>): Page {
  return {
    id: 1, slug: 'conv/test', type: 'conversation', title: 'Test', frontmatter,
    compiled_truth: '', timeline: '', created_at: new Date(), updated_at: new Date(), source_id: 'default',
  } as unknown as Page;
}

const TELEGRAM = ['**[09:00] \u{1f464} Alice:** good morning', '**[09:05] \u{1f464} Bob:** morning'].join('\n');

describe('localToUtcIso', () => {
  test('Asia/Tokyo 09:00 is 00:00Z (positive offset)', () => {
    expect(localToUtcIso('2024-03-15', 9, 0, 'Asia/Tokyo')).toBe('2024-03-15T00:00:00Z');
  });
  test('America/Los_Angeles 09:00 is 16:00Z in March (negative offset, daylight time) and 17:00Z in January', () => {
    expect(localToUtcIso('2024-03-15', 9, 0, 'America/Los_Angeles')).toBe('2024-03-15T16:00:00Z');
    expect(localToUtcIso('2024-01-15', 9, 0, 'America/Los_Angeles')).toBe('2024-01-15T17:00:00Z');
  });
  test('Asia/Kolkata 09:00 is 03:30Z (half-hour offset) and Asia/Kathmandu 09:00 is 03:15Z', () => {
    expect(localToUtcIso('2024-03-15', 9, 0, 'Asia/Kolkata')).toBe('2024-03-15T03:30:00Z');
    expect(localToUtcIso('2024-03-15', 9, 0, 'Asia/Kathmandu')).toBe('2024-03-15T03:15:00Z');
  });
  test('a local time that crosses the date line moves the UTC date', () => {
    expect(localToUtcIso('2024-03-15', 1, 30, 'Asia/Tokyo')).toBe('2024-03-14T16:30:00Z');
    expect(localToUtcIso('2024-03-15', 22, 0, 'America/Los_Angeles')).toBe('2024-03-16T05:00:00Z');
  });
  test('a DST fold resolves to the first occurrence (New York 2024-11-03 01:30 is still EDT)', () => {
    expect(localToUtcIso('2024-11-03', 1, 30, 'America/New_York')).toBe('2024-11-03T05:30:00Z');
    expect(localToUtcIso('2024-11-03', 0, 30, 'America/New_York')).toBe('2024-11-03T04:30:00Z');
    expect(localToUtcIso('2024-11-03', 2, 30, 'America/New_York')).toBe('2024-11-03T07:30:00Z');
  });
  test('a DST gap resolves with the pre-transition offset (New York 2024-03-10 02:30 does not exist; EST gives 07:30Z, 03:30 EDT)', () => {
    expect(localToUtcIso('2024-03-10', 2, 30, 'America/New_York')).toBe('2024-03-10T07:30:00Z');
    expect(localToUtcIso('2024-03-10', 1, 59, 'America/New_York')).toBe('2024-03-10T06:59:00Z');
    expect(localToUtcIso('2024-03-10', 3, 0, 'America/New_York')).toBe('2024-03-10T07:00:00Z');
  });
  test('UTC and Etc/GMT zones are identity', () => {
    expect(localToUtcIso('2024-03-15', 9, 0, 'UTC')).toBe('2024-03-15T09:00:00Z');
    expect(localToUtcIso('2024-03-15', 9, 0, 'Etc/GMT+5')).toBe('2024-03-15T14:00:00Z');
  });
  test('independent of the host timezone', () => {
    const script = `import { localToUtcIso } from ${JSON.stringify(new URL('../../src/core/conversation-parser/parse.ts', import.meta.url).pathname)};
      console.log(JSON.stringify([localToUtcIso('2024-03-15', 9, 0, 'Asia/Tokyo'), localToUtcIso('2024-11-03', 1, 30, 'America/New_York'), localToUtcIso('2024-03-10', 2, 30, 'America/New_York')]));`;
    for (const TZ of ['Pacific/Kiritimati', 'America/Anchorage', 'UTC']) {
      const out = execFileSync(process.execPath, ['-e', script], { env: { ...process.env, TZ }, encoding: 'utf8' }).trim();
      expect(JSON.parse(out)).toEqual(['2024-03-15T00:00:00Z', '2024-11-03T05:30:00Z', '2024-03-10T07:30:00Z']);
    }
  }, 60_000);
});

describe('parseConversation honours frontmatter.timezone', () => {
  test('time-only pattern: Tokyo 09:00 becomes 00:00Z and no UTC warning is raised', () => {
    const r = parseConversation(TELEGRAM, { page: makePage({ date: '2024-03-15', timezone: 'Asia/Tokyo' }) });
    expect(r.messages.map(m => m.timestamp)).toEqual(['2024-03-15T00:00:00Z', '2024-03-15T00:05:00Z']);
    expect(r.timezone_warning).toBeUndefined();
  });
  test('inline-date pattern (whatsapp-iso) applies the zone too', () => {
    const body = ['[15/03/24, 09:00:00] Alice: hi', '[15/03/24, 09:05:00] Bob: hello'].join('\n');
    const r = parseConversation(body, { page: makePage({ timezone: 'America/Los_Angeles' }) });
    expect(r.matched_pattern_id).toBe('whatsapp-iso');
    expect(r.messages.map(m => m.timestamp)).toEqual(['2024-03-15T16:00:00Z', '2024-03-15T16:05:00Z']);
  });
  test('no-time pattern (irc-classic) anchors at local midnight', () => {
    const body = ['<alice> hi there', '<bob> hello'].join('\n');
    const r = parseConversation(body, { page: makePage({ date: '2024-03-15', timezone: 'Asia/Tokyo' }) });
    expect(r.matched_pattern_id).toBe('irc-classic');
    expect(r.messages[0].timestamp).toBe('2024-03-14T15:00:00Z');
  });
  test('an invalid zone keeps UTC and the warning names it', () => {
    const ctx = deriveDateContext({ page: makePage({ date: '2024-03-15', timezone: 'Mars/Olympus_Mons' }) });
    expect(ctx.timezone).toBeUndefined();
    expect(ctx.invalid_timezone).toBe('Mars/Olympus_Mons');
    const r = parseConversation(TELEGRAM, { page: makePage({ date: '2024-03-15', timezone: 'Mars/Olympus_Mons' }) });
    expect(r.messages[0].timestamp).toBe('2024-03-15T09:00:00Z');
    expect(r.timezone_warning).toContain("'Mars/Olympus_Mons'");
    expect(r.timezone_warning).toContain('not a valid IANA');
  });
  test('no zone keeps UTC with the existing warning', () => {
    const r = parseConversation(TELEGRAM, { fallbackDate: '2024-03-15' });
    expect(r.messages[0].timestamp).toBe('2024-03-15T09:00:00Z');
    expect(r.timezone_warning).toContain('assumed UTC');
  });
});
