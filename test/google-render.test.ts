/**
 * google-render — pure unit tests for the google source kind's renderers.
 *
 * No I/O, no engine: covers htmlToText, trimQuotedReply, the noise/signature
 * rules, subject slugs, path stability, and the three page renderers.
 * All fixture data is synthetic (example.com addresses, hex message ids).
 */
import { describe, expect, test } from 'bun:test';

import {
  calendarRelPath,
  htmlToText,
  isCalendarSystemMail,
  isNoiseSender,
  isSignatureRequest,
  personSlugFromContact,
  renderCalendarEventPage,
  renderPersonPage,
  renderThreadPage,
  subjectSlug,
  threadRelPath,
  trimQuotedReply,
} from '../src/core/google/google-render.ts';
import {
  bareAddress,
  splitAddressList,
  type CalendarEventData,
  type ContactData,
  type GmailMessageMeta,
  type GmailThreadData,
} from '../src/core/google/types.ts';

// ── Fixture builders ─────────────────────────────────────────────────────────

const T_ID = '17aa1111bbbb2222';

function msg(over: Partial<GmailMessageMeta> = {}): GmailMessageMeta {
  const ms = over.internalDateMs ?? Date.parse('2026-08-10T12:00:00Z');
  return {
    id: '18c2f4a9b3d21e01',
    threadId: T_ID,
    from: 'Charlie Example <charlie@example.com>',
    fromAddress: 'charlie@example.com',
    to: ['a@example.com'],
    cc: [],
    subject: 'Zephyr roadmap',
    dateIso: new Date(ms).toISOString(),
    internalDateMs: ms,
    labelIds: [],
    listUnsubscribe: false,
    bodyText: 'Sharing the roadmap draft.',
    ...over,
  };
}

function thread(messages: GmailMessageMeta[], threadId = T_ID): GmailThreadData {
  return { threadId, account: 'a@example.com', messages };
}

// ── types.ts helpers ─────────────────────────────────────────────────────────

describe('bareAddress + splitAddressList', () => {
  test('bareAddress extracts and lowercases', () => {
    expect(bareAddress('Alice Example <Alice@Example.com>')).toBe('alice@example.com');
    expect(bareAddress('a@example.com')).toBe('a@example.com');
    expect(bareAddress('  B@EXAMPLE.COM  ')).toBe('b@example.com');
  });

  test('splitAddressList handles quoted display-name commas', () => {
    expect(splitAddressList('"Example, Alice" <alice@example.com>, b@example.com')).toEqual([
      'alice@example.com',
      'b@example.com',
    ]);
  });

  test('splitAddressList drops non-addresses and empty input', () => {
    expect(splitAddressList('')).toEqual([]);
    expect(splitAddressList('   ')).toEqual([]);
    expect(splitAddressList('Undisclosed recipients')).toEqual([]);
  });
});

// ── htmlToText ───────────────────────────────────────────────────────────────

describe('htmlToText', () => {
  test('strips tags', () => {
    expect(htmlToText('<b>bold</b> text')).toBe('bold text');
  });

  test('br and closing block tags become newlines', () => {
    expect(htmlToText('a<br>b')).toBe('a\nb');
    expect(htmlToText('a<br/>b')).toBe('a\nb');
    expect(htmlToText('<p>a</p><p>b</p>')).toBe('a\nb');
    expect(htmlToText('<div>x</div><div>y</div>')).toBe('x\ny');
  });

  test('entities decoded (named and numeric)', () => {
    expect(htmlToText('&lt;tag&gt; &amp; &quot;q&quot; &#65;')).toBe('<tag> & "q" A');
    expect(htmlToText('caf&#233;')).toBe('café');
    expect(htmlToText('a&nbsp;b')).toBe('a b');
  });

  test('style, script, and comments dropped entirely', () => {
    expect(htmlToText('x<style>.a{color:red}</style>y')).toBe('xy');
    expect(htmlToText('x<script>run()</script>y')).toBe('xy');
    expect(htmlToText('x<!-- hidden -->y')).toBe('xy');
  });

  test('list items get dash bullets', () => {
    expect(htmlToText('<ul><li>one</li><li>two</li></ul>')).toBe('- one\n- two');
  });

  test('blank-line runs collapse to one', () => {
    expect(htmlToText('a<br><br><br><br>b')).toBe('a\n\nb');
  });
});

// ── trimQuotedReply ──────────────────────────────────────────────────────────

describe('trimQuotedReply', () => {
  test('cuts the "On ... wrote:" tail', () => {
    const text = 'Thanks!\n\nOn Mon, Aug 10, 2026 at 9:00 AM Charlie Example <charlie@example.com> wrote:\n> old text\n> more old text';
    expect(trimQuotedReply(text)).toBe('Thanks!');
  });

  test('cuts a trailing run of >-quoted lines (blanks included)', () => {
    expect(trimQuotedReply('Reply text\n\n> quoted a\n> quoted b')).toBe('Reply text');
  });

  test('preserves inline quotes mid-message', () => {
    const text = '> inline quoted question\nMy answer after the quote';
    expect(trimQuotedReply(text)).toBe(text);
  });

  test('cuts the Original Message separator tail', () => {
    expect(trimQuotedReply('New note\n-- Original Message --\nold body')).toBe('New note');
  });
});

// ── Noise + signature rules ──────────────────────────────────────────────────

describe('isNoiseSender', () => {
  test('flags the noise-sender list', () => {
    expect(isNoiseSender('noreply@example.com')).toBe(true);
    expect(isNoiseSender('no-reply@example.com')).toBe(true);
    expect(isNoiseSender('notifications@example.com')).toBe(true);
    expect(isNoiseSender('notification@example.com')).toBe(true);
    expect(isNoiseSender('calendar-notification@example.com')).toBe(true);
    expect(isNoiseSender('mailer-daemon@example.com')).toBe(true);
    expect(isNoiseSender('postmaster@example.com')).toBe(true);
    expect(isNoiseSender('donotreply@example.com')).toBe(true);
    expect(isNoiseSender('do-not-reply@example.com')).toBe(true);
    expect(isNoiseSender('NOREPLY@EXAMPLE.COM')).toBe(true);
  });

  test('does not flag ordinary senders', () => {
    expect(isNoiseSender('alice@example.com')).toBe(false);
    expect(isNoiseSender('replies-welcome@example.com')).toBe(false);
  });
});

describe('isCalendarSystemMail', () => {
  // Structural METHOD first (any non-empty method), then the anchored
  // subject-prefix fallback for messages whose calendar part carried no
  // parsable method ('' / null). A Re:/Fwd:-style prefix always loses.
  const cases: Array<[string, { calendarMethod?: string | null; subject?: string }, boolean]> = [
    ['non-empty METHOD wins regardless of subject', { calendarMethod: 'REQUEST', subject: 'Zephyr roadmap' }, true],
    ['REPLY method on a plain subject', { calendarMethod: 'REPLY', subject: 'Accepted: Team sync' }, true],
    ["'' method + Invitation subject → fallback true", { calendarMethod: '', subject: 'Invitation: Team sync @ Fri Aug 21' }, true],
    ["'' method + plain subject → false", { calendarMethod: '', subject: 'Team sync notes' }, false],
    ['null method + Updated invitation subject', { calendarMethod: null, subject: 'Updated invitation: Budget sync' }, true],
    ['es prefix', { calendarMethod: null, subject: 'Invitación: Sincronización semanal' }, true],
    ['es updated prefix', { calendarMethod: null, subject: 'Invitación actualizada: Sincronización' }, true],
    ['fr prefix', { calendarMethod: null, subject: 'Invitation mise à jour: Point hebdo' }, true],
    ['fr accepted prefix', { calendarMethod: null, subject: 'Acceptée: Point hebdo' }, true],
    ['de prefix', { calendarMethod: null, subject: 'Einladung: Wöchentlicher Sync' }, true],
    ['de accepted prefix', { calendarMethod: null, subject: 'Zugesagt: Wöchentlicher Sync' }, true],
    ['AW: (de reply) never system mail', { calendarMethod: null, subject: 'AW: Einladung: Wöchentlicher Sync' }, false],
    ['SV: (sv reply) never system mail', { calendarMethod: null, subject: 'SV: Invitation: Team sync' }, false],
    ['Re: Fwd: chain never system mail', { calendarMethod: null, subject: 'Re: Fwd: Invitation: Team sync' }, false],
    ['Fwd: alone never system mail', { calendarMethod: '', subject: 'Fwd: Invitation: Team sync' }, false],
    ['leading whitespace is trimmed before anchoring', { calendarMethod: null, subject: '   Invitation: Team sync' }, true],
    ['mid-subject "invitation:" does not match (anchored)', { calendarMethod: null, subject: 'About the Invitation: thoughts?' }, false],
    ['empty message shape', {}, false],
    ['no method, empty subject', { calendarMethod: null, subject: '' }, false],
    // Ship-review fixes: 'Notification:' is a generic human/vendor prefix (a
    // human "Notification: your invoice" must keep opening loops), and an
    // unrecognised MIME method is NOT trusted as a Calendar stamp.
    ['generic "Notification:" prefix is NOT calendar system mail', { calendarMethod: null, subject: 'Notification: your invoice is ready' }, false],
    ['unknown MIME method is not trusted', { calendarMethod: 'BOGUS', subject: 'Team sync notes' }, false],
    ['unknown method + Invitation subject still reaches the subject fallback', { calendarMethod: 'BOGUS', subject: 'Invitation: Team sync' }, true],
  ];
  for (const [label, msg, expected] of cases) {
    test(`${label} → ${expected}`, () => {
      expect(isCalendarSystemMail(msg)).toBe(expected);
    });
  }

  const ICAL_METHODS = ['REQUEST', 'REPLY', 'CANCEL', 'PUBLISH', 'COUNTER', 'DECLINECOUNTER', 'REFRESH', 'ADD'];
  for (const method of ICAL_METHODS) {
    test(`iCalendar METHOD ${method} is system mail (case-insensitive)`, () => {
      expect(isCalendarSystemMail({ calendarMethod: method, subject: 'Team sync notes' })).toBe(true);
      expect(isCalendarSystemMail({ calendarMethod: method.toLowerCase(), subject: 'Team sync notes' })).toBe(true);
    });
  }
});

describe('isSignatureRequest', () => {
  test('matches on subject', () => {
    expect(isSignatureRequest('Please sign: mutual NDA', 'alice@example.com')).toBe(true);
    expect(isSignatureRequest('Signature needed on the agreement', 'alice@example.com')).toBe(true);
    expect(isSignatureRequest('Everyone has signed the doc', 'alice@example.com')).toBe(true);
  });

  test('matches on from', () => {
    expect(isSignatureRequest('Agreement ready', 'Sign Service <sign@docusign-example.com>')).toBe(true);
    expect(isSignatureRequest('Agreement ready', 'HelloSign Example <sign@example.com>')).toBe(true);
  });

  test('does not match ordinary mail', () => {
    expect(isSignatureRequest('Quarterly update', 'alice@example.com')).toBe(false);
  });
});

// ── subjectSlug + threadRelPath ──────────────────────────────────────────────

describe('subjectSlug', () => {
  test('strips reply/forward prefixes (stacked)', () => {
    expect(subjectSlug('Re: Fwd: AW: Hello World')).toBe('hello-world');
    expect(subjectSlug('RE: re: Big News!')).toBe('big-news');
    expect(subjectSlug('Fw: Update')).toBe('update');
  });

  test('caps at 48 chars with no trailing hyphen', () => {
    const s = subjectSlug('This is an extremely long subject line that keeps going and going beyond the cap');
    expect(s.length).toBeLessThanOrEqual(48);
    expect(s.endsWith('-')).toBe(false);
    expect(s).toBe('this-is-an-extremely-long-subject-line-that-keep');
  });

  test('falls back to no-subject', () => {
    expect(subjectSlug('')).toBe('no-subject');
    expect(subjectSlug('Re: ')).toBe('no-subject');
    expect(subjectSlug('!!!')).toBe('no-subject');
  });
});

describe('threadRelPath', () => {
  test('keyed on the FIRST message: stable across re-renders with new replies', () => {
    const t1 = thread([msg()]);
    const p1 = threadRelPath(t1);
    expect(p1).toMatch(/^emails\/2026\/08\/2026-08-10-zephyr-roadmap-[0-9a-f]{8}\.md$/);

    const t2 = thread([
      msg(),
      msg({
        id: '18c2f4a9b3d21e02',
        subject: 'Re: Zephyr roadmap',
        internalDateMs: Date.parse('2026-09-01T00:00:00Z'),
      }),
    ]);
    expect(threadRelPath(t2)).toBe(p1);
  });

  test('different threads get different paths (sha8 of threadId)', () => {
    const a = threadRelPath(thread([msg()], '17aa1111bbbb2222'));
    const b = threadRelPath(thread([msg({ threadId: '17aa3333cccc4444' })], '17aa3333cccc4444'));
    expect(a).not.toBe(b);
  });
});

// ── renderThreadPage ─────────────────────────────────────────────────────────

describe('renderThreadPage', () => {
  function twoMessageThread(): GmailThreadData {
    return thread([
      msg(),
      msg({
        id: '18c2f4a9b3d21e02',
        from: 'A Example <a@example.com>',
        fromAddress: 'a@example.com',
        to: ['charlie@example.com'],
        cc: ['dana@example.com'],
        subject: 'Re: Zephyr roadmap',
        internalDateMs: Date.parse('2026-08-11T08:00:00Z'),
        dateIso: '2026-08-11T08:00:00.000Z',
        labelIds: ['SENT'],
        bodyText: 'Looks good, shipping it.',
      }),
    ]);
  }

  test('frontmatter carries type, thread_id, latest message_id, all message_ids, account', () => {
    const page = renderThreadPage(twoMessageThread());
    expect(page).not.toBeNull();
    const md = page!.markdown;
    expect(md).toContain('type: email');
    expect(md).toContain(`thread_id: "${T_ID}"`);
    expect(md).toContain('message_id: "18c2f4a9b3d21e02"'); // LATEST id
    expect(md).toContain('message_ids: \n  - "18c2f4a9b3d21e01"\n  - "18c2f4a9b3d21e02"');
    expect(md).toContain('account: "a@example.com"');
    expect(md).toContain('message_count: 2');
    expect(page!.relPath).toBe(threadRelPath(twoMessageThread()));
  });

  test('participants are sorted', () => {
    const md = renderThreadPage(twoMessageThread())!.markdown;
    expect(md).toContain(
      'participants: \n  - "a@example.com"\n  - "charlie@example.com"\n  - "dana@example.com"',
    );
  });

  test('senders lists only message AUTHORS (never To/Cc recipients), sorted', () => {
    // twoMessageThread: charlie wrote the first message, a@ the second; dana
    // is Cc-only. The loops lane mutes SENDERS, so recipients must not appear.
    const md = renderThreadPage(twoMessageThread())!.markdown;
    expect(md).toContain('senders: \n  - "a@example.com"\n  - "charlie@example.com"\nlabels:');
  });

  test('per-message sections carry code-built Gmail deep links', () => {
    const md = renderThreadPage(twoMessageThread())!.markdown;
    expect(md).toContain('[Source: email "Zephyr roadmap", 2026-08-10](https://mail.google.com/mail/u/?authuser=a%40example.com#inbox/18c2f4a9b3d21e01)');
    expect(md).toContain('#inbox/18c2f4a9b3d21e02');
  });

  test('SENT messages carry the → marker; inbound ones do not', () => {
    const md = renderThreadPage(twoMessageThread())!.markdown;
    expect(md).toContain('## → A Example <a@example.com>');
    expect(md).toContain('## Charlie Example <charlie@example.com>');
    expect(md).not.toContain('## → Charlie Example');
  });

  test('pure-noise thread renders null', () => {
    const noise = thread([
      msg({ from: 'Notifier <noreply@example.com>', fromAddress: 'noreply@example.com' }),
      msg({
        id: '18c2f4a9b3d21e09',
        from: 'Robot <notifications@example.com>',
        fromAddress: 'notifications@example.com',
      }),
    ]);
    expect(renderThreadPage(noise)).toBeNull();
    expect(renderThreadPage(thread([]))).toBeNull();
  });

  test('mixed thread with one noise message still renders', () => {
    const mixed = thread([
      msg(),
      msg({
        id: '18c2f4a9b3d21e09',
        from: 'Robot <noreply@example.com>',
        fromAddress: 'noreply@example.com',
      }),
    ]);
    expect(renderThreadPage(mixed)).not.toBeNull();
  });

  test('signature-request thread renders with noise: signature-request', () => {
    const sig = thread([
      msg({
        from: 'Sign Service <sign@docusign-example.com>',
        fromAddress: 'sign@docusign-example.com',
        subject: 'Ready for your signature: consulting agreement',
      }),
    ]);
    const page = renderThreadPage(sig);
    expect(page).not.toBeNull();
    expect(page!.markdown).toContain('noise: signature-request');
  });

  test('ordinary thread carries no noise marker', () => {
    expect(renderThreadPage(twoMessageThread())!.markdown).not.toContain('noise:');
  });
});

// ── renderCalendarEventPage ──────────────────────────────────────────────────

function calEvent(over: Partial<CalendarEventData> = {}): CalendarEventData {
  return {
    id: 'evt0000000000001',
    summary: 'Zephyr planning sync',
    description: '',
    startIso: '2026-08-12T17:00:00Z',
    endIso: '2026-08-12T18:00:00Z',
    allDay: false,
    organizer: 'a@example.com',
    attendees: [
      { email: 'a@example.com', displayName: null, self: true, responseStatus: 'accepted' },
      { email: 'charlie@example.com', displayName: 'Charlie Example', self: false, responseStatus: 'tentative' },
    ],
    location: null,
    hangoutLink: null,
    htmlLink: 'https://calendar.google.com/calendar/event?eid=evt0000000000001',
    status: 'confirmed',
    account: 'a@example.com',
    ...over,
  };
}

describe('renderCalendarEventPage', () => {
  test('renders type: meeting with attendees', () => {
    const page = renderCalendarEventPage(calEvent());
    expect(page).not.toBeNull();
    const md = page!.markdown;
    expect(md).toContain('type: meeting');
    expect(md).toContain('event_id: "evt0000000000001"');
    expect(md).toContain('attendees: \n  - "a@example.com"\n  - "charlie@example.com"');
    expect(md).toContain('## Attendees');
    expect(md).toContain('- Charlie Example <charlie@example.com> · tentative');
    expect(page!.relPath).toBe(calendarRelPath(calEvent()));
    expect(page!.relPath).toMatch(/^calendar\/2026\/08\/2026-08-12-zephyr-planning-sync-[0-9a-f]{8}\.md$/);
  });

  test('cancelled event renders null', () => {
    expect(renderCalendarEventPage(calEvent({ status: 'cancelled' }))).toBeNull();
  });

  test('attendees with empty emails are dropped', () => {
    const page = renderCalendarEventPage(
      calEvent({ attendees: [{ email: '', displayName: 'Room', self: false, responseStatus: null }] }),
    );
    expect(page!.markdown).toContain('attendees: []');
    expect(page!.markdown).not.toContain('## Attendees');
  });

  test('description is HTML-stripped', () => {
    const page = renderCalendarEventPage(calEvent({ description: '<b>Agenda</b>: review &amp; plan' }));
    expect(page!.markdown).toContain('Agenda: review & plan');
  });
});

// ── renderPersonPage + personSlugFromContact ─────────────────────────────────

function contact(over: Partial<ContactData> = {}): ContactData {
  return {
    resourceName: 'people/c000000001',
    displayName: 'Alice Example',
    emails: ['alice@example.com', 'alice.alt@example.com'],
    organization: 'Acme Example',
    title: 'Engineer',
    deleted: false,
    ...over,
  };
}

describe('personSlugFromContact', () => {
  test('slug from display name', () => {
    expect(personSlugFromContact(contact())).toBe('people/alice-example');
  });

  test('slug from email local part when no name', () => {
    expect(personSlugFromContact(contact({ displayName: null, emails: ['dana@example.com'] }))).toBe('people/dana');
  });

  test('null when neither name nor email', () => {
    expect(personSlugFromContact(contact({ displayName: null, emails: [] }))).toBeNull();
  });
});

describe('renderPersonPage', () => {
  test('aliases list carries emails + display name; google_contact_id marker present', () => {
    const page = renderPersonPage(contact());
    expect(page).not.toBeNull();
    const md = page!.markdown;
    expect(page!.relPath).toBe('people/alice-example.md');
    expect(md).toContain('type: person');
    expect(md).toContain('aliases: \n  - "alice@example.com"\n  - "alice.alt@example.com"\n  - "Alice Example"');
    expect(md).toContain('emails: \n  - "alice@example.com"\n  - "alice.alt@example.com"');
    expect(md).toContain('google_contact_id: "people/c000000001"');
    expect(md).toContain('company: "Acme Example"');
    expect(md).toContain('role: "Engineer"');
    expect(md).toContain('Engineer at Acme Example.');
    expect(md).toContain('[Source: Google Contacts]');
  });

  test('no emails renders null', () => {
    expect(renderPersonPage(contact({ emails: [] }))).toBeNull();
  });
});
