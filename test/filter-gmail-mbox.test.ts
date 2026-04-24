import { describe, test, expect } from 'bun:test';
import {
  splitMbox,
  parseMessage,
  extractEmailAddress,
  shouldDrop,
  decodeBody,
  stripQuotedReplies,
  sanitizeSlug,
  messageToMarkdown,
} from '../scripts/filter-gmail-mbox.ts';

function buildMessage(headers: Record<string, string>, body: string): string {
  const lines = ['From - Mon Jan 01 00:00:00 2020'];
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`);
  lines.push('');
  lines.push(body);
  return lines.join('\n');
}

describe('splitMbox', () => {
  test('splits two messages on From boundary', () => {
    const mbox =
      'From - Mon Jan 01\nSubject: a\n\nBody A\n\nFrom - Tue Jan 02\nSubject: b\n\nBody B\n';
    const parts = splitMbox(mbox);
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain('Subject: a');
    expect(parts[1]).toContain('Subject: b');
  });

  test('does not split body lines that start with >From', () => {
    const mbox =
      'From - Mon Jan 01\nSubject: a\n\nHey\n>From someone else I heard this\n';
    const parts = splitMbox(mbox);
    expect(parts.length).toBe(1);
  });

  test('returns empty array for empty input', () => {
    expect(splitMbox('')).toEqual([]);
  });
});

describe('parseMessage', () => {
  test('parses headers and body', () => {
    const raw = buildMessage(
      { From: 'a@b.com', Subject: 'hi', Date: '2020-01-01' },
      'Hello world',
    );
    const msg = parseMessage(raw);
    expect(msg.headers.get('from')).toBe('a@b.com');
    expect(msg.headers.get('subject')).toBe('hi');
    expect(msg.body.trim()).toBe('Hello world');
  });

  test('handles header continuation lines', () => {
    const raw =
      'From - x\nSubject: this is a\n  folded subject\nFrom: a@b.com\n\nbody';
    const msg = parseMessage(raw);
    expect(msg.headers.get('subject')).toBe('this is a folded subject');
  });

  test('lowercases header keys', () => {
    const raw = buildMessage({ 'List-Unsubscribe': '<mailto:x>' }, 'body');
    const msg = parseMessage(raw);
    expect(msg.headers.has('list-unsubscribe')).toBe(true);
  });
});

describe('extractEmailAddress', () => {
  test('strips display name in angle brackets', () => {
    expect(extractEmailAddress('Name <a@b.com>')).toBe('a@b.com');
  });
  test('handles bare email', () => {
    expect(extractEmailAddress('a@b.com')).toBe('a@b.com');
  });
  test('lowercases', () => {
    expect(extractEmailAddress('Name <A@B.COM>')).toBe('a@b.com');
  });
});

describe('shouldDrop', () => {
  test('drops noreply senders', () => {
    const msg = parseMessage(
      buildMessage({ From: 'noreply@service.com' }, 'body'),
    );
    expect(shouldDrop(msg, []).drop).toBe(true);
    expect(shouldDrop(msg, []).reason).toBe('noreply');
  });

  test('drops messages with List-Unsubscribe', () => {
    const msg = parseMessage(
      buildMessage(
        { From: 'marketing@brand.com', 'List-Unsubscribe': '<mailto:x>' },
        'body',
      ),
    );
    expect(shouldDrop(msg, []).drop).toBe(true);
    expect(shouldDrop(msg, []).reason).toBe('unsubscribe');
  });

  test('drops text/calendar', () => {
    const msg = parseMessage(
      buildMessage(
        { From: 'calendar@g.com', 'Content-Type': 'text/calendar; charset=utf-8' },
        'body',
      ),
    );
    expect(shouldDrop(msg, []).drop).toBe(true);
    expect(shouldDrop(msg, []).reason).toBe('calendar');
  });

  test('keeps normal human sender', () => {
    const msg = parseMessage(buildMessage({ From: 'friend@gmail.com' }, 'body'));
    expect(shouldDrop(msg, []).drop).toBe(false);
  });

  test('--keep override preserves flagged sender', () => {
    const msg = parseMessage(
      buildMessage(
        { From: 'noreply@mybank.com', 'List-Unsubscribe': '<mailto:x>' },
        'body',
      ),
    );
    expect(shouldDrop(msg, ['mybank.com']).drop).toBe(false);
  });

  test('--keep matches on substring of email', () => {
    const msg = parseMessage(
      buildMessage({ From: 'alerts@notifications.airline.com' }, 'body'),
    );
    expect(shouldDrop(msg, ['airline.com']).drop).toBe(false);
    expect(shouldDrop(msg, ['other.com']).drop).toBe(true);
  });
});

describe('stripQuotedReplies', () => {
  test('removes "> " quoted lines', () => {
    const input = 'My reply\n> Original line 1\n> Original line 2';
    expect(stripQuotedReplies(input)).toBe('My reply');
  });

  test('removes "On ... wrote:" block and everything after', () => {
    const input =
      'Sure, sounds good.\n\nOn Mon, Jan 1, 2020 at 3:45 PM, A <a@b.com> wrote:\n> Hi\n> Please check';
    expect(stripQuotedReplies(input)).toBe('Sure, sounds good.');
  });

  test('keeps unquoted content intact', () => {
    expect(stripQuotedReplies('Just a normal message')).toBe(
      'Just a normal message',
    );
  });
});

describe('decodeBody', () => {
  test('decodes quoted-printable', () => {
    const msg = parseMessage(
      buildMessage(
        { 'Content-Transfer-Encoding': 'quoted-printable' },
        'Hello =3D world',
      ),
    );
    expect(decodeBody(msg)).toContain('Hello = world');
  });

  test('decodes base64', () => {
    const encoded = Buffer.from('hello base64').toString('base64');
    const msg = parseMessage(
      buildMessage({ 'Content-Transfer-Encoding': 'base64' }, encoded),
    );
    expect(decodeBody(msg).trim()).toBe('hello base64');
  });

  test('extracts text/plain from multipart', () => {
    const boundary = 'BOUND123';
    const body = [
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Plain text version',
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>HTML version</p>',
      `--${boundary}--`,
    ].join('\n');
    const msg = parseMessage(
      buildMessage(
        { 'Content-Type': `multipart/alternative; boundary="${boundary}"` },
        body,
      ),
    );
    const decoded = decodeBody(msg);
    expect(decoded).toContain('Plain text version');
  });
});

describe('sanitizeSlug', () => {
  test('lowercases and hyphenates', () => {
    expect(sanitizeSlug('Hello World')).toBe('hello-world');
  });
  test('strips special chars', () => {
    expect(sanitizeSlug('Re: [Ext] Meeting!!!')).toBe('re-ext-meeting');
  });
  test('truncates to 80', () => {
    expect(sanitizeSlug('a'.repeat(200)).length).toBe(80);
  });
});

describe('messageToMarkdown', () => {
  test('emits frontmatter + body, returns YYYY/MM path', () => {
    const msg = parseMessage(
      buildMessage(
        {
          From: 'a@b.com',
          To: 'c@d.com',
          Subject: 'Test Thread',
          Date: 'Wed, 15 Mar 2023 10:30:00 +0000',
          'Message-ID': '<abc123@b.com>',
        },
        'Real content here',
      ),
    );
    const out = messageToMarkdown(msg);
    expect(out).not.toBeNull();
    expect(out!.path).toMatch(/^2023\/03\/test-thread-[a-f0-9]{8}\.md$/);
    expect(out!.content).toContain('type: email');
    expect(out!.content).toContain('Real content here');
    expect(out!.content).toContain('subject: "Test Thread"');
  });

  test('returns null when body is empty after stripping', () => {
    const msg = parseMessage(
      buildMessage(
        { From: 'a@b.com', Subject: 'Empty' },
        '> quoted only\n> more quoted',
      ),
    );
    expect(messageToMarkdown(msg)).toBeNull();
  });
});
