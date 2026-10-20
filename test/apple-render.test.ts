/**
 * apple-render — pure, deterministic page rendering from fixture data.
 * Placeholders only (alice-example, acme-example). Mail bodies are untrusted:
 * these tests prove a hostile body cannot change page structure.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseMarkdown } from '../src/core/markdown.ts';
import {
  bareAddress,
  calendarRelPath,
  contactIdSlug,
  renderedHash,
  fenceQuote,
  groupMailThreads,
  inline,
  mailPriorFromPage,
  normalizePhone,
  parseMailBlocks,
  personSlugFromContact,
  renderCalendarEventPage,
  renderMailThreadPage,
  renderPersonPage,
} from '../src/core/apple/render.ts';
import type { AppleCalendarEvent, AppleContact, AppleMailMessage } from '../src/core/apple/types.ts';

const fx = <T,>(name: string): T[] =>
  (JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'apple', `${name}.json`), 'utf-8')) as { items: T[] }).items;
const events = fx<AppleCalendarEvent>('calendar');
const contacts = fx<AppleContact>('contacts');
const mail = fx<AppleMailMessage>('mail');

describe('calendar render', () => {
  test('path: calendar/YYYY/MM/YYYY-MM-DD-<slug>-<sha8>.md, local day as written', () => {
    const p = renderCalendarEventPage(events[0], 'local')!;
    expect(p.relPath).toMatch(/^calendar\/2026\/10\/2026-10-20-roadmap-sync-with-acme-example-[0-9a-f]{8}\.md$/);
    expect(calendarRelPath(events[0])).toBe(p.relPath);
    // all-day events keep their date-only start
    expect(renderCalendarEventPage(events[2], 'local')!.relPath).toMatch(/^calendar\/2026\/10\/2026-10-25-offsite-day-[0-9a-f]{8}\.md$/);
  });

  test('same event id in two calendars gets distinct paths', () => {
    const a = { ...events[0], calendarId: 'cal-a' };
    const b = { ...events[0], calendarId: 'cal-b' };
    expect(calendarRelPath(a)).not.toBe(calendarRelPath(b));
  });

  test('frontmatter carries the contract fields and parses back', () => {
    const p = renderCalendarEventPage(events[0], 'alice-example')!;
    const parsed = parseMarkdown(p.markdown, p.relPath);
    expect(parsed.type).toBe('meeting');
    const fm = parsed.frontmatter as Record<string, unknown>;
    expect(fm.apple_event_id).toBe('evt-001');
    expect(fm.apple_calendar_id).toBe('cal-work');
    expect(fm.calendar).toBe('Work');
    expect(fm.start).toBe('2026-10-20T09:00:00-07:00');
    expect(fm.end).toBe('2026-10-20T10:00:00-07:00');
    expect(fm.all_day).toBe(false);
    expect(fm.location).toBe('Room 1');
    expect(fm.attendees).toEqual(['alice-example@example.com', 'bob-example@example.com']);
    expect(fm.recurring).toBe(false);
    expect(fm.source_kind).toBe('apple');
    expect(fm.account).toBe('alice-example');
  });

  test('recurring flag and occurrence ids render', () => {
    const fm = parseMarkdown(renderCalendarEventPage(events[1], 'local')!.markdown, 'x.md').frontmatter as Record<string, unknown>;
    expect(fm.recurring).toBe(true);
    expect(fm.apple_event_id).toBe('evt-002#1792000000');
  });

  test('cancelled events render nothing', () => {
    expect(renderCalendarEventPage(events[3], 'local')).toBeNull();
    expect(renderCalendarEventPage({ ...events[0], status: 'Canceled' }, 'local')).toBeNull();
  });

  test('deterministic: identical input → identical bytes and hash', () => {
    const a = renderCalendarEventPage(events[0], 'local')!;
    const b = renderCalendarEventPage(structuredClone(events[0]), 'local')!;
    expect(a.markdown).toBe(b.markdown);
    expect(renderedHash(a.relPath, a.markdown)).toBe(renderedHash(b.relPath, b.markdown));
    expect(renderedHash(a.relPath, a.markdown)).not.toBe(renderedHash(a.relPath, a.markdown + ' '));
  });

  test('attendee order from EventKit does not change the rendered bytes (live-Mac churn)', () => {
    // Observed on a real Mac: EventKit listed the same event's attendees in a different order on
    // consecutive syncs, so the hash-diff rewrote unchanged pages every run. Render must sort.
    const ev = events[0];
    expect(ev.attendees.length).toBeGreaterThan(1);
    const reversed = { ...ev, attendees: [...ev.attendees].reverse() };
    const a = renderCalendarEventPage(ev, 'local')!;
    const b = renderCalendarEventPage(reversed, 'local')!;
    expect(b.markdown).toBe(a.markdown);
    expect(renderedHash(b.relPath, b.markdown)).toBe(renderedHash(a.relPath, a.markdown));
    const fm = parseMarkdown(a.markdown, a.relPath).frontmatter as Record<string, unknown>;
    expect(fm.attendees).toEqual([...(fm.attendees as string[])].sort());
  });

  test('hostile notes (fence/frontmatter/heading) stay inside an inert fence', () => {
    const p = renderCalendarEventPage(events[0], 'local')!;
    const parsed = parseMarkdown(p.markdown, p.relPath);
    expect(parsed.type).toBe('meeting');
    expect(parsed.title).toBe('Roadmap sync with Acme Example');
    // The notes block opens with a fence longer than the ``` inside the notes.
    expect(p.markdown).toContain('````\nAgenda:');
  });
});

describe('contact render', () => {
  test('named contact: <dir>/<slug>.md, type person, contract fields', () => {
    const p = renderPersonPage(contacts[0])!;
    expect(p.relPath).toBe('people/alice-example.md');
    const parsed = parseMarkdown(p.markdown, p.relPath);
    expect(parsed.type).toBe('person');
    const fm = parsed.frontmatter as Record<string, unknown>;
    expect(fm.apple_contact_id).toBe('con-001');
    expect(fm.emails).toEqual(['alice-example@example.com']);
    expect(fm.groups).toEqual(['Friends']);
    expect(fm.company).toBe('Acme Example');
    expect(fm.role).toBe('Engineer');
    expect(fm.source_kind).toBe('apple');
  });

  test('phones: E.164 where the country is stated, else as entered', () => {
    const fm = parseMarkdown(renderPersonPage(contacts[0])!.markdown, 'x.md').frontmatter as Record<string, unknown>;
    expect(fm.phones).toEqual(['+15550100100', '555 0101']);
    expect(normalizePhone('+44 20 7946 0000')).toBe('+442079460000');
    expect(normalizePhone('0044 20 7946 0000')).toBe('+442079460000');
    expect(normalizePhone('(555) 010-0100')).toBe('(555) 010-0100');
    expect(normalizePhone('+12')).toBe('+12'); // too short to be E.164: untouched
  });

  test('contactsDir is honoured', () => {
    expect(renderPersonPage(contacts[1], false, 'contacts/apple')!.relPath).toBe('contacts/apple/bob-example.md');
  });

  test('no name but an email: id-keyed slug (never the address)', () => {
    const p = renderPersonPage(contacts[2])!;
    expect(p.relPath).toBe(`${contactIdSlug('con-003')}.md`);
    expect(p.relPath).toMatch(/^people\/contact-[0-9a-f]{8}\.md$/);
    expect(p.relPath).not.toContain('nameless');
  });

  test('no name, no emails, no phones renders nothing', () => {
    expect(renderPersonPage(contacts[3])).toBeNull();
    expect(personSlugFromContact(contacts[3])).toBeNull();
  });

  test('phone-only contact is keyed on its id', () => {
    const c: AppleContact = { id: 'con-ph', emails: [], phones: ['+15550100199'], groups: [] };
    expect(renderPersonPage(c)!.relPath).toBe(`${contactIdSlug('con-ph')}.md`);
  });

  test('disambiguation appends sha8(id)', () => {
    expect(personSlugFromContact(contacts[4], true)).toMatch(/^people\/alice-example-[0-9a-f]{8}$/);
    expect(personSlugFromContact(contacts[4], false)).toBe('people/alice-example');
  });

  test('deterministic', () => {
    expect(renderPersonPage(contacts[0])!.markdown).toBe(renderPersonPage(structuredClone(contacts[0]))!.markdown);
  });

  test('hostile name stays on one line and in quoted scalars', () => {
    const c: AppleContact = {
      id: 'con-h', givenName: 'Eve\n---\ntype: company\n# Boom', familyName: '[[people/alice-example]]',
      emails: ['eve-example@example.com'], phones: [], groups: [],
    };
    const p = renderPersonPage(c)!;
    const parsed = parseMarkdown(p.markdown, p.relPath);
    expect(parsed.type).toBe('person');
    expect(p.markdown.split('\n').filter((l) => l.startsWith('# '))).toHaveLength(1);
    expect(p.markdown).not.toContain('[[');
    expect(parsed.title).toBe('Eve --- type: company # Boom ((people/alice-example))');
  });
});

describe('mail render', () => {
  const threads = groupMailThreads(mail);

  test('grouping: one thread per threadId, ordered by date', () => {
    expect(threads.map((t) => t.threadId)).toEqual(['thr-001', 'thr-002', 'thr-003']);
    expect(threads[0].messages.map((m) => m.id)).toEqual(['m-001', 'm-002']);
    const shuffled = groupMailThreads([...mail].reverse());
    expect(shuffled).toEqual(threads);
  });

  test('path: emails/YYYY/MM/YYYY-MM-DD-<subject>-<sha8(thread)>.md; one page per thread', () => {
    const p = renderMailThreadPage(threads[0], 'local')!;
    expect(p.relPath).toMatch(/^emails\/2026\/10\/2026-10-14-quarterly-plan-[0-9a-f]{8}\.md$/);
  });

  test('frontmatter: type email + apple fields, messages ordered by date', () => {
    const p = renderMailThreadPage(threads[0], 'local')!;
    const parsed = parseMarkdown(p.markdown, p.relPath);
    expect(parsed.type).toBe('email');
    const fm = parsed.frontmatter as Record<string, unknown>;
    expect(fm.apple_thread_id).toBe('thr-001');
    expect(fm.apple_message_ids).toEqual(['m-001', 'm-002']);
    expect(fm.mailbox).toBe('Sent');
    expect(fm.message_count).toBe(2);
    expect(fm.source_kind).toBe('apple');
    expect(fm.participants).toEqual(['alice-example@example.com', 'bob-example@example.com', 'me-example@example.com']);
    expect(p.markdown.indexOf('Please review the plan')).toBeLessThan(p.markdown.indexOf('Looks good.'));
    expect(p.markdown).toContain('## → me-example@example.com');
  });

  test('automated (noise-sender) threads render nothing', () => {
    expect(renderMailThreadPage(threads[2], 'local')).toBeNull();
    expect(bareAddress('Name <No-Reply@Acme-Example.com>')).toBe('no-reply@acme-example.com');
  });

  test('hostile body is inert quoted data: structure unchanged', () => {
    const p = renderMailThreadPage(threads[1], 'local')!;
    const parsed = parseMarkdown(p.markdown, p.relPath);
    // Frontmatter is the connector's, not the body's.
    expect(parsed.type).toBe('email');
    expect(parsed.title).toBe('Hostile body');
    // The body is wrapped by a fence longer than any backtick run in it (4 → 5).
    expect(p.markdown).toContain('`````\n---\ntype: person');
    // No heading or timeline structure outside the fence.
    const outside = stripFences(p.markdown.split('\n').slice(p.markdown.split('\n').indexOf('---', 1) + 1));
    expect(outside.filter((l) => /^#{1,6} /.test(l))).toEqual(['# Hostile body', '## mallory-example@example.com · 2026-10-15 08:00']);
    expect(outside.some((l) => /^-{3,}$/.test(l.trim()))).toBe(false);
    expect(outside.join('\n')).not.toContain('Injected');
    expect(outside.join('\n')).not.toContain('[[');
    // The timeline splitter finds no separator in the page body.
    expect(parsed.timeline).toBe('');
  });

  test.each([
    ['plain', 'hello'],
    ['fence-closer', 'a\n```\nb'],
    ['long-fence', 'x\n``````````\ny'],
    ['tilde', '~~~\nz\n~~~'],
    ['crlf + bare CR', 'a\r\n---\rb'],
    ['frontmatter', '---\ntitle: x\n---\nbody'],
    ['timeline sentinel', '<!-- timeline -->\n- 2026-01-01 | x'],
  ])('fenceQuote(%s) cannot be closed by its own content', (_name, text) => {
    const q = fenceQuote(text);
    const lines = q.split('\n');
    const fence = lines[0];
    expect(fence).toMatch(/^`{3,}$/);
    expect(lines[lines.length - 1]).toBe(fence);
    // No inner line is a run of backticks at least as long as the fence.
    for (const l of lines.slice(1, -1)) expect(/^\s*`+\s*$/.test(l) && l.trim().length >= fence.length).toBe(false);
    // No bare CR survives.
    expect(q).not.toContain('\r');
  });

  test('inline() collapses control chars and neutralises link/HTML brackets', () => {
    expect(inline('a\nb\u0000c [[x]] <b>')).toBe('a b c ((x)) (b)');
    expect(inline('x'.repeat(500)).length).toBe(200);
  });

  test('deterministic', () => {
    const a = renderMailThreadPage(threads[0], 'local')!;
    const b = renderMailThreadPage(groupMailThreads(structuredClone(mail))[0], 'local')!;
    expect(a.markdown).toBe(b.markdown);
  });

  test('aged-out messages are carried forward from the existing page', () => {
    const full = renderMailThreadPage(threads[0], 'local')!;
    const parsed = parseMarkdown(full.markdown, full.relPath);
    const body = full.markdown.slice(full.markdown.indexOf('\n---\n', 4) + 5);
    const prior = mailPriorFromPage(full.relPath, parsed.frontmatter as Record<string, unknown>, body, parsed.title)!;
    expect(prior).not.toBeNull();
    expect(prior.ids).toEqual(['m-001', 'm-002']);
    // The reader now lists only the newest message; the page keeps both.
    const windowed = groupMailThreads([mail[1]])[0];
    const rerendered = renderMailThreadPage(windowed, 'local', prior)!;
    expect(rerendered.relPath).toBe(full.relPath);
    expect(rerendered.markdown).toBe(full.markdown);
    // A new reply appends after the carried messages.
    const reply: AppleMailMessage = { ...mail[1], id: 'm-005', date: '2026-10-16T08:00:00-07:00', body: 'Thanks!' };
    const grown = renderMailThreadPage(groupMailThreads([mail[1], reply])[0], 'local', prior)!;
    const fm = parseMarkdown(grown.markdown, grown.relPath).frontmatter as Record<string, unknown>;
    expect(fm.apple_message_ids).toEqual(['m-001', 'm-002', 'm-005']);
    expect(grown.relPath).toBe(full.relPath);
  });

  test('carry-forward preserves chronological order and newest-message metadata when an older slice is reread', () => {
    const full = renderMailThreadPage(threads[0], 'local')!;
    const parsed = parseMarkdown(full.markdown, full.relPath);
    const body = full.markdown.slice(full.markdown.indexOf('\n---\n', 4) + 5);
    const prior = mailPriorFromPage(full.relPath, parsed.frontmatter as Record<string, unknown>, body, parsed.title)!;
    const olderOnly = renderMailThreadPage(groupMailThreads([mail[0]])[0], 'local', prior)!;
    const frontmatter = parseMarkdown(olderOnly.markdown, olderOnly.relPath).frontmatter as Record<string, unknown>;
    expect(frontmatter.apple_message_ids).toEqual(['m-001', 'm-002']);
    expect(frontmatter.date).toBe(prior.latest.date);
    expect(olderOnly.markdown.indexOf('Hello,')).toBeLessThan(olderOnly.markdown.indexOf('Looks good.'));
  });

  test('parseMailBlocks does not split on a heading inside a fenced body', () => {
    const p = renderMailThreadPage(groupMailThreads([{ ...mail[0], body: '## not a message\n```\nx\n```' }])[0], 'local')!;
    const body = p.markdown.slice(p.markdown.indexOf('\n---\n', 4) + 5);
    expect(parseMailBlocks(body)).toHaveLength(1);
  });
});

/** Drop every line inside a fenced code block (fence lines included). */
function stripFences(lines: string[]): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const l of lines) {
    if (fence !== null) { if (l === fence) fence = null; continue; }
    const m = /^(`{3,})$/.exec(l);
    if (m) { fence = m[1]; continue; }
    out.push(l);
  }
  return out;
}

describe('render details (review fixes)', () => {
  test('yamlStr escapes DEL, C1 controls (incl. NEL) and line/paragraph separators so frontmatter stays one line per value', () => {
    const hostile = 'a\u007fb\u0085c\u009fd\u2028e\u2029f';
    const p = renderCalendarEventPage({ ...events[0]!, title: 'Plain title', location: hostile }, 'local')!;
    const fm = p.markdown.split('---')[1]!;
    for (const ch of ['\u007f', '\u0085', '\u009f', '\u2028', '\u2029']) expect(fm).not.toContain(ch);
    expect(fm).toContain('\\u007f');
    expect(fm).toContain('\\u0085');
    const parsed = parseMarkdown(p.markdown, 'x.md');
    expect(parsed.frontmatter.location).toBe(hostile);
  });

  test('a multi-day timed event renders the end DATE as well as the time; a same-day one keeps the short form', () => {
    const base = { ...events[0]!, allDay: false };
    const multi = renderCalendarEventPage({ ...base, start: '2026-10-20T22:00:00-07:00', end: '2026-10-21T06:00:00-07:00' }, 'local')!;
    expect(multi.markdown).toContain('2026-10-20 22:00 → 2026-10-21 06:00');
    const same = renderCalendarEventPage({ ...base, start: '2026-10-20T09:00:00-07:00', end: '2026-10-20T10:00:00-07:00' }, 'local')!;
    expect(same.markdown).toContain('2026-10-20 09:00 → 10:00');
  });

  test('mailPriorFromPage returns null for a page whose body no longer splits into one block per id (the sweep then refuses to overwrite)', () => {
    const fm = { apple_message_ids: ['m-1', 'm-2'], first_message_date: '2026-10-14T09:00:00-07:00' };
    expect(mailPriorFromPage('emails/x.md', fm, 'Hand-edited body', 'Quarterly plan')).toBeNull();
  });
});


// F10: chronology was covered for different dates, not timestamp ties. Rereading only the lower id
// must preserve the higher-id sender/mailbox. Reverting the tie comparison changes this observable FM.
test('F10 equal-date carry-forward uses the same date-plus-id ordering for latest metadata and evidence', () => {
  const base: AppleMailMessage={id:'a',threadId:'tie',mailbox:'INBOX',subject:'Example tie',from:'external@example.com',to:['owner@example.com'],cc:[],date:'2026-01-02T03:04:00Z',body:'Can you review?',read:true,automated:false,bulk:false};
  const z={...base,id:'z',from:'owner@example.com',to:['external@example.com'],mailbox:'Sent',body:'Here is the review.'};
  const full=renderMailThreadPage(groupMailThreads([base,z])[0]!, 'local')!;
  const parsed=parseMarkdown(full.markdown,full.relPath);
  const body=full.markdown.slice(full.markdown.indexOf('\n---\n',4)+5);
  const prior=mailPriorFromPage(full.relPath,parsed.frontmatter,body,parsed.title)!;
  const slice=renderMailThreadPage(groupMailThreads([base])[0]!, 'local',prior)!;
  const fm=parseMarkdown(slice.markdown,slice.relPath).frontmatter;
  expect(fm.apple_message_ids).toEqual(['a','z']);expect(fm.message_id).toBe('z');
  expect(fm.from).toBe('owner@example.com');expect(fm.mailbox).toBe('Sent');
  expect(fm.apple_loop_messages).toHaveLength(2);
});


test('F10 mixed-case equal-time ids use canonical lexical order everywhere, not locale-dependent metadata', () => {
  const a: AppleMailMessage={id:'Z',threadId:'mixed-tie',mailbox:'INBOX',subject:'Example tie',from:'external@example.com',to:['owner@example.com'],cc:[],date:'2026-01-02T03:04:00Z',body:'Can you review?',read:true,automated:false,bulk:false};
  const z={...a,id:'a',from:'owner@example.com',mailbox:'Sent'};
  const full=renderMailThreadPage(groupMailThreads([a,z])[0]!, 'local')!;
  const parsed=parseMarkdown(full.markdown,full.relPath);
  expect(parsed.frontmatter.apple_message_ids).toEqual(['Z','a']);
  expect(parsed.frontmatter.from).toBe('owner@example.com');
  const prior=mailPriorFromPage(full.relPath,parsed.frontmatter,full.markdown.slice(full.markdown.indexOf('\n---\n',4)+5),parsed.title)!;
  const carried=renderMailThreadPage(groupMailThreads([a])[0]!, 'local',prior)!;
  expect(parseMarkdown(carried.markdown,carried.relPath).frontmatter.from).toBe('owner@example.com');
});
