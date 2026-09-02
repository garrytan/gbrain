/**
 * The eligibility gate in front of loops_extract
 * (src/core/google/loops-extract.ts:loopExtractionEligibility).
 *
 * Table-driven, pure, no engine. Every row is a STRUCTURAL shape — Gmail
 * labels, List-Unsubscribe, calendar parts, who wrote the message. There are
 * deliberately no sender, domain, subject or body assertions anywhere in this
 * file: the gate must never grow a vendor list.
 *
 * Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';

import {
  loopExtractionEligibility,
  type ExtractEligibility,
} from '../src/core/google/loops-extract.ts';
import type { GmailMessageMeta, GmailThreadData } from '../src/core/google/types.ts';

const MY = new Set(['me@example.com']);

let seq = 0;

interface MsgSpec {
  from: string;
  to?: string[];
  labels?: string[];
  listUnsub?: boolean;
  calendarMethod?: string | null;
  body?: string;
  subject?: string;
}

function msg(spec: MsgSpec): GmailMessageMeta {
  seq += 1;
  return {
    id: `18c2f4a9b3d2${(0x2000 + seq).toString(16)}`,
    threadId: 'thread-1',
    from: spec.from,
    fromAddress: spec.from.toLowerCase(),
    to: (spec.to ?? ['me@example.com']).map((a) => a.toLowerCase()),
    cc: [],
    subject: spec.subject ?? 'A subject',
    dateIso: '2026-08-20T10:00:00.000Z',
    internalDateMs: Date.parse('2026-08-20T10:00:00.000Z'),
    labelIds: spec.labels ?? ['INBOX'],
    listUnsubscribe: spec.listUnsub ?? false,
    calendarMethod: spec.calendarMethod ?? null,
    bodyText: spec.body ?? 'Some body text.',
  };
}

const thread = (messages: GmailMessageMeta[]): GmailThreadData => ({
  threadId: 'thread-1',
  account: 'me@example.com',
  messages,
});

interface Row {
  name: string;
  messages: GmailMessageMeta[];
  eligible: boolean;
  reason: ExtractEligibility['reason'];
}

const ROWS: Row[] = [
  {
    name: 'ordinary human correspondence is eligible',
    messages: [msg({ from: 'bob@example.com' })],
    eligible: true,
    reason: 'human_correspondence',
  },
  {
    name: 'SPAM is never eligible',
    messages: [msg({ from: 'bob@example.com', labels: ['SPAM'] })],
    eligible: false,
    reason: 'spam_or_trash',
  },
  {
    name: 'TRASH is never eligible',
    messages: [msg({ from: 'bob@example.com', labels: ['TRASH'] })],
    eligible: false,
    reason: 'spam_or_trash',
  },
  {
    name: 'SPAM beats an owner message — deleted mail is not an obligation',
    messages: [
      msg({ from: 'bob@example.com', labels: ['SPAM'] }),
      msg({ from: 'me@example.com', labels: ['SENT', 'SPAM'] }),
    ],
    eligible: false,
    reason: 'spam_or_trash',
  },
  {
    name: 'a pure no-reply/notification thread is not eligible',
    messages: [msg({ from: 'noreply@vendor.example' })],
    eligible: false,
    reason: 'no_substantive_messages',
  },
  {
    name: 'a pure calendar-notice thread is not eligible',
    messages: [msg({ from: 'kate@example.com', calendarMethod: 'REQUEST' })],
    eligible: false,
    reason: 'no_substantive_messages',
  },
  {
    name: 'a human "Notification: ..." thread with no calendar part is eligible',
    messages: [msg({ from: 'bob@example.com', subject: 'Notification: your invoice is ready' })],
    eligible: true,
    reason: 'human_correspondence',
  },
  {
    name: 'an unrecognised MIME method does not make a thread a calendar notice',
    messages: [msg({ from: 'bob@example.com', calendarMethod: 'BOGUS' })],
    eligible: true,
    reason: 'human_correspondence',
  },
  {
    name: 'CATEGORY_PROMOTIONS without an owner message is not eligible',
    messages: [msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] })],
    eligible: false,
    reason: 'bulk_category',
  },
  {
    name: 'CATEGORY_SOCIAL without an owner message is not eligible',
    messages: [msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_SOCIAL'] })],
    eligible: false,
    reason: 'bulk_category',
  },
  {
    name: 'CATEGORY_FORUMS without an owner message is not eligible',
    messages: [msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_FORUMS'] })],
    eligible: false,
    reason: 'bulk_category',
  },
  {
    name: 'CATEGORY_UPDATES is NOT excluded — invoices and documents live there',
    messages: [msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_UPDATES'] })],
    eligible: true,
    reason: 'human_correspondence',
  },
  {
    name: 'List-Unsubscribe bulk mail the owner never answered is not eligible',
    messages: [msg({ from: 'bob@example.com', listUnsub: true })],
    eligible: false,
    reason: 'list_mail',
  },
  {
    name: 'a SENT message keeps a promotions thread eligible',
    messages: [
      msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
      msg({ from: 'me@example.com', labels: ['SENT'], to: ['bob@example.com'] }),
    ],
    eligible: true,
    reason: 'owner_participated',
  },
  {
    name: 'a SENT message keeps a List-Unsubscribe thread eligible',
    messages: [
      msg({ from: 'bob@example.com', listUnsub: true }),
      msg({ from: 'me@example.com', labels: ['SENT'], to: ['bob@example.com'] }),
    ],
    eligible: true,
    reason: 'owner_participated',
  },
  {
    name: 'owner recognised by address even without the SENT label',
    messages: [
      msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_SOCIAL'] }),
      msg({ from: 'me@example.com', to: ['bob@example.com'] }),
    ],
    eligible: true,
    reason: 'owner_participated',
  },
  {
    name: 'mixed thread: one bulk message, one real human message → eligible',
    messages: [
      msg({ from: 'bob@example.com', listUnsub: true }),
      msg({ from: 'bob@example.com' }),
    ],
    eligible: true,
    reason: 'human_correspondence',
  },
  {
    name: 'an empty thread is not eligible',
    messages: [],
    eligible: false,
    reason: 'no_substantive_messages',
  },
  // Ship-review fix: owner_participated used to be evaluated BEFORE the
  // calendar/noise filter, so an invitation the owner merely RSVP'd to (the
  // "Accepted:" notice Calendar sends on the owner's behalf — SENT label,
  // METHOD:REPLY) was eligible and paid for a model call. The owner must have
  // written a SUBSTANTIVE message; a pure-calendar exchange is never one.
  {
    name: "an invitation the owner RSVP'd to (Accepted: reply, SENT, METHOD:REPLY) is still pure calendar mail",
    messages: [
      msg({ from: 'kate@example.com', calendarMethod: 'REQUEST', subject: 'Invitation: Sync @ Tue' }),
      msg({
        from: 'me@example.com',
        to: ['kate@example.com'],
        labels: ['SENT'],
        calendarMethod: 'REPLY',
        subject: 'Accepted: Sync @ Tue',
      }),
    ],
    eligible: false,
    reason: 'no_substantive_messages',
  },
  {
    name: "an owner RSVP recognised by ADDRESS (no SENT label) is still pure calendar mail",
    messages: [
      msg({ from: 'kate@example.com', calendarMethod: 'REQUEST', subject: 'Invitation: Sync @ Tue' }),
      msg({ from: 'me@example.com', to: ['kate@example.com'], calendarMethod: 'REPLY', subject: 'Accepted: Sync @ Tue' }),
    ],
    eligible: false,
    reason: 'no_substantive_messages',
  },
  {
    name: "the owner's REAL reply to an invitation (no calendar part) keeps the thread eligible",
    messages: [
      msg({ from: 'kate@example.com', calendarMethod: 'REQUEST', subject: 'Invitation: Sync @ Tue' }),
      msg({
        from: 'me@example.com',
        to: ['kate@example.com'],
        labels: ['SENT'],
        subject: 'Re: Invitation: Sync @ Tue',
        body: 'Can we push to Wednesday? I will send the agenda tonight.',
      }),
    ],
    eligible: true,
    reason: 'owner_participated',
  },
  {
    name: 'an owner RSVP does not rescue a bulk thread either — the owner wrote nothing substantive',
    messages: [
      msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
      msg({ from: 'me@example.com', labels: ['SENT'], calendarMethod: 'REPLY', subject: 'Accepted: Webinar' }),
    ],
    eligible: false,
    reason: 'bulk_category',
  },
];

describe('loopExtractionEligibility', () => {
  for (const row of ROWS) {
    test(row.name, () => {
      const v = loopExtractionEligibility(thread(row.messages), MY);
      expect(v.eligible).toBe(row.eligible);
      expect(v.reason).toBe(row.reason);
    });
  }

  test('a SENT message alone is enough with no myAddresses supplied', () => {
    // The gate must work from Gmail labels alone — callers that cannot
    // resolve the owner's alias set still get the owner override.
    const v = loopExtractionEligibility(
      thread([
        msg({ from: 'bob@example.com', labels: ['INBOX', 'CATEGORY_PROMOTIONS'] }),
        msg({ from: 'someone@example.com', labels: ['SENT'] }),
      ]),
    );
    expect(v.eligible).toBe(true);
    expect(v.reason).toBe('owner_participated');
  });
});
