/**
 * THE PRECISION GATE for the zero-LLM thread-state machine
 * (src/core/google/loop-detect.ts:detectThreadLoop).
 *
 * Labeled fixture corpus: every row asserts the EXACT verdict — either no
 * loop at all or exactly one loop of the expected type with the expected
 * counterparty. Zero false positives on this corpus is the assertion; every
 * new false-positive class gets a fixture row before its fix (per the
 * contract in loop-detect.ts's header).
 *
 * Pure function — no engine, no I/O. Synthetic data only.
 */
import { describe, expect, test } from 'bun:test';

import {
  detectThreadLoop,
  INBOUND_GRACE_HOURS,
  OUTBOUND_GRACE_HOURS,
  type ThreadLoopVerdict,
} from '../src/core/google/loop-detect.ts';
import type { SuppressionSet } from '../src/core/loops/loops-store.ts';
import type { GmailMessageMeta, GmailThreadData } from '../src/core/google/types.ts';

// Frozen clock — every age below is relative to this instant, so the corpus
// is fully deterministic (no wall-clock flake at grace boundaries).
const NOW = new Date('2026-08-25T12:00:00Z');

const MY = new Set(['me@example.com', 'alias@example.com']);

const THREAD_ID = '18c2f4a9b3d21e07';

let msgSeq = 0;

interface MsgSpec {
  from: string;
  to?: string[];
  cc?: string[];
  ageHours: number;
  sent?: boolean;
  body?: string;
  subject?: string;
  listUnsub?: boolean;
  /** Explicit internalDateMs override (0 = the all-zero-date case). */
  dateMs?: number;
}

function msg(spec: MsgSpec): GmailMessageMeta {
  const internalDateMs =
    spec.dateMs !== undefined ? spec.dateMs : NOW.getTime() - spec.ageHours * 3_600_000;
  msgSeq += 1;
  return {
    id: `18c2f4a9b3d2${(0x1000 + msgSeq).toString(16)}`,
    threadId: THREAD_ID,
    from: spec.from,
    fromAddress: spec.from.toLowerCase(),
    to: (spec.to ?? []).map((a) => a.toLowerCase()),
    cc: (spec.cc ?? []).map((a) => a.toLowerCase()),
    subject: spec.subject ?? 'Quarterly plan',
    dateIso: new Date(Math.max(internalDateMs, 0)).toISOString(),
    internalDateMs,
    labelIds: spec.sent ? ['SENT'] : ['INBOX'],
    listUnsubscribe: spec.listUnsub ?? false,
    bodyText: spec.body ?? 'Can you review the plan?',
  };
}

function thread(messages: GmailMessageMeta[], threadId = THREAD_ID): GmailThreadData {
  return { threadId, account: 'me@example.com', messages };
}

function sup(over: Partial<SuppressionSet> = {}): SuppressionSet {
  return { senders: new Set<string>(), threads: new Set<string>(), ...over };
}

interface CorpusCase {
  name: string;
  messages: GmailMessageMeta[];
  suppressions?: SuppressionSet;
  expect:
    | null
    | { type: 'unanswered_inbound' | 'unanswered_outbound'; counterparty: string };
}

const CASES: CorpusCase[] = [
  // ── Inbound: I owe the reply ───────────────────────────────────────────────
  {
    name: 'inbound to me in To:, 48h old → unanswered_inbound',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'inbound 2h old → none (grace window)',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 2 })],
    expect: null,
  },
  {
    name: 'inbound exactly at the 24h grace boundary → opens',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 24 })],
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'inbound 23h old (just inside grace) → none',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 23 })],
    expect: null,
  },
  {
    name: 'inbound where I am only in Cc → none',
    messages: [
      msg({ from: 'bob@example.com', to: ['carol@example.com'], cc: ['me@example.com'], ageHours: 48 }),
    ],
    expect: null,
  },
  {
    name: 'inbound not addressed to me at all (bcc/list delivery) → none',
    messages: [msg({ from: 'bob@example.com', to: ['carol@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound with empty To: (pure bcc) → none',
    messages: [msg({ from: 'bob@example.com', to: [], cc: ['carol@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound with List-Unsubscribe → none (list mail)',
    messages: [
      msg({ from: 'digest@example.com', to: ['me@example.com'], ageHours: 48, listUnsub: true }),
    ],
    expect: null,
  },
  {
    name: 'inbound from noreply@ → none (noise)',
    messages: [msg({ from: 'noreply@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from no-reply@ → none (noise)',
    messages: [msg({ from: 'no-reply@mailer.example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from notifications@ → none (noise)',
    messages: [msg({ from: 'notifications@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from notification@ → none (noise)',
    messages: [msg({ from: 'notification@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from mailer-daemon@ → none (bounce noise)',
    messages: [msg({ from: 'mailer-daemon@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from postmaster@ → none (noise)',
    messages: [msg({ from: 'postmaster@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from donotreply@ → none (noise)',
    messages: [msg({ from: 'donotreply@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from do-not-reply@ → none (noise)',
    messages: [msg({ from: 'do-not-reply@example.com', to: ['me@example.com'], ageHours: 48 })],
    expect: null,
  },
  {
    name: 'inbound from calendar-notification@ → none (noise)',
    messages: [
      msg({ from: 'calendar-notification@example.com', to: ['me@example.com'], ageHours: 48 }),
    ],
    expect: null,
  },
  {
    name: 'inbound addressed to my alias in To: → unanswered_inbound',
    messages: [msg({ from: 'bob@example.com', to: ['alias@example.com'], ageHours: 48 })],
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'inbound to me AND others in To: → unanswered_inbound on the sender',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com', 'carol@example.com'], ageHours: 48 }),
    ],
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'mixed: inbound 48h, my reply 36h, their reply 30h → unanswered_inbound on the latest inbound sender',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 }),
      msg({ from: 'me@example.com', to: ['bob@example.com', 'carol@example.com'], ageHours: 36, sent: true, body: 'Here you go.' }),
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 30 }),
    ],
    expect: { type: 'unanswered_inbound', counterparty: 'carol@example.com' },
  },
  {
    name: 'inbound 48h followed by a fresh noise notification → still unanswered_inbound on the human',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 }),
      msg({ from: 'notifications@example.com', to: ['me@example.com'], ageHours: 1 }),
    ],
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'earlier list mail, latest personal message without List-Unsubscribe → opens',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 72, listUnsub: true }),
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 }),
    ],
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'thread where the LAST message is MY reply (SENT) with no "?" → none (answered)',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 }),
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 20, sent: true, body: 'Done, see attached.' }),
    ],
    expect: null,
  },
  {
    name: 'suppressed sender → none (mute wins)',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 })],
    suppressions: sup({ senders: new Set(['bob@example.com']) }),
    expect: null,
  },
  {
    name: 'suppressed thread → none (mute wins)',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 })],
    suppressions: sup({ threads: new Set([THREAD_ID]) }),
    expect: null,
  },
  {
    name: 'a DIFFERENT suppressed sender does not mute this one → opens',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 })],
    suppressions: sup({ senders: new Set(['eve@example.com']) }),
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'a DIFFERENT suppressed thread does not mute this one → opens',
    messages: [msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 })],
    suppressions: sup({ threads: new Set(['18c2f4a9b3d2ffff']) }),
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },

  // ── Outbound: I'm waiting on them ─────────────────────────────────────────
  {
    name: 'my outbound with "?" 96h old → unanswered_outbound',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 96, sent: true, body: 'Any update on the contract?' }),
    ],
    expect: { type: 'unanswered_outbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'my outbound with "?" 24h old → none (72h grace)',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 24, sent: true, body: 'Any update?' }),
    ],
    expect: null,
  },
  {
    name: 'my outbound with "?" exactly at the 72h boundary → opens',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 72, sent: true, body: 'Any update?' }),
    ],
    expect: { type: 'unanswered_outbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'my outbound with "?" 71h old (just inside grace) → none',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 71, sent: true, body: 'Any update?' }),
    ],
    expect: null,
  },
  {
    name: 'my outbound WITHOUT "?" 96h old → none (FYI rule)',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 96, sent: true, body: 'FYI, deck attached.' }),
    ],
    expect: null,
  },
  {
    name: 'my outbound only to my own alias → none (self-thread)',
    messages: [
      msg({ from: 'me@example.com', to: ['alias@example.com'], ageHours: 96, sent: true, body: 'Note to self: renew domain?' }),
    ],
    expect: null,
  },
  {
    name: 'all-mine thread (notes to self, several messages) → none',
    messages: [
      msg({ from: 'me@example.com', to: ['me@example.com'], ageHours: 120, sent: true, body: 'Draft one?' }),
      msg({ from: 'alias@example.com', to: ['me@example.com'], ageHours: 96, sent: true, body: 'Draft two?' }),
    ],
    expect: null,
  },
  {
    name: 'sent-label detection: from address NOT in MY but labeled SENT → treated as mine (outbound)',
    messages: [
      msg({ from: 'other@example.com', to: ['bob@example.com'], ageHours: 96, sent: true, body: 'Did you get my note?' }),
    ],
    expect: { type: 'unanswered_outbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'sent-label detection: SENT message without "?" → none (FYI rule still applies)',
    messages: [
      msg({ from: 'other@example.com', to: ['bob@example.com'], ageHours: 96, sent: true, body: 'FYI only.' }),
    ],
    expect: null,
  },
  {
    name: 'outbound "?" with me AND bob in To: → counterparty is the first non-mine recipient',
    messages: [
      msg({ from: 'me@example.com', to: ['me@example.com', 'bob@example.com'], ageHours: 96, sent: true, body: 'Thoughts?' }),
    ],
    expect: { type: 'unanswered_outbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'outbound "?" addressed only to me with an external Cc → none (Cc is not a counterparty)',
    messages: [
      msg({ from: 'me@example.com', to: ['me@example.com'], cc: ['bob@example.com'], ageHours: 96, sent: true, body: 'Thoughts?' }),
    ],
    expect: null,
  },
  {
    name: 'outbound "?" to two external recipients → counterparty is the first',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com', 'carol@example.com'], ageHours: 96, sent: true, body: 'Can one of you take this?' }),
    ],
    expect: { type: 'unanswered_outbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'outbound with suppressed counterparty → none',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 96, sent: true, body: 'Any update?' }),
    ],
    suppressions: sup({ senders: new Set(['bob@example.com']) }),
    expect: null,
  },
  {
    name: 'outbound on a suppressed thread → none',
    messages: [
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 96, sent: true, body: 'Any update?' }),
    ],
    suppressions: sup({ threads: new Set([THREAD_ID]) }),
    expect: null,
  },
  {
    name: 'inbound then my old follow-up question → unanswered_outbound (last word is my ask)',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 100 }),
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 96, sent: true, body: 'Does Tuesday work?' }),
    ],
    expect: { type: 'unanswered_outbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'inbound then my FRESH reply with "?" (20h) → none (outbound grace)',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 }),
      msg({ from: 'me@example.com', to: ['bob@example.com'], ageHours: 20, sent: true, body: 'Does Tuesday work?' }),
    ],
    expect: null,
  },

  // ── Degenerate threads ────────────────────────────────────────────────────
  {
    name: 'empty thread → none',
    messages: [],
    expect: null,
  },
  {
    name: 'all-zero internalDate → none',
    messages: [
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48, dateMs: 0 }),
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 30, dateMs: 0 }),
    ],
    expect: null,
  },
  {
    name: 'zero-date message alongside a valid inbound → the valid one still opens',
    messages: [
      msg({ from: 'carol@example.com', to: ['me@example.com'], ageHours: 200, dateMs: 0 }),
      msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48 }),
    ],
    expect: { type: 'unanswered_inbound', counterparty: 'bob@example.com' },
  },
  {
    name: 'thread of nothing but noise senders → none',
    messages: [
      msg({ from: 'noreply@example.com', to: ['me@example.com'], ageHours: 96 }),
      msg({ from: 'notifications@example.com', to: ['me@example.com'], ageHours: 48 }),
    ],
    expect: null,
  },
];

describe('detectThreadLoop precision corpus', () => {
  test('grace constants are the documented values', () => {
    expect(INBOUND_GRACE_HOURS).toBe(24);
    expect(OUTBOUND_GRACE_HOURS).toBe(72);
  });

  test(`corpus has at least 40 labeled cases (${CASES.length})`, () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40);
  });

  for (const c of CASES) {
    test(c.name, () => {
      const verdict: ThreadLoopVerdict = detectThreadLoop(
        thread(c.messages),
        MY,
        NOW,
        c.suppressions,
      );
      if (c.expect === null) {
        // ZERO false positives: the corpus assertion is exact emptiness.
        expect(verdict.open).toEqual([]);
      } else {
        expect(verdict.open).toHaveLength(1);
        expect(verdict.open[0].loopType).toBe(c.expect.type);
        expect(verdict.open[0].counterpartyEmail).toBe(c.expect.counterparty);
      }
    });
  }

  test('open verdict carries subject in the summary and a body quote + message id in evidence', () => {
    const m = msg({
      from: 'bob@example.com',
      to: ['me@example.com'],
      ageHours: 48,
      subject: 'Budget review',
      body: '  Can you   send\nover the numbers?  ',
    });
    const verdict = detectThreadLoop(thread([m]), MY, NOW);
    expect(verdict.open).toHaveLength(1);
    const spec = verdict.open[0];
    expect(spec.summary).toContain('Budget review');
    expect(spec.summary).toContain('bob@example.com');
    expect(spec.evidence).toHaveLength(1);
    expect(spec.evidence[0].message_id).toBe(m.id);
    // Whitespace-collapsed quote from the body.
    expect(spec.evidence[0].quote).toBe('Can you send over the numbers?');
    expect(spec.lastActivityMs).toBe(m.internalDateMs);
  });

  test('Re:/Fwd: prefixes are stripped from the summary subject', () => {
    const verdict = detectThreadLoop(
      thread([
        msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48, subject: 'Re: Re: Budget' }),
      ]),
      MY,
      NOW,
    );
    expect(verdict.open[0].summary).toContain('"Budget"');
    expect(verdict.open[0].summary).not.toContain('Re:');

    const fwd = detectThreadLoop(
      thread([
        msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48, subject: 'Fwd: Offsite' }),
      ]),
      MY,
      NOW,
    );
    expect(fwd.open[0].summary).toContain('"Offsite"');
    expect(fwd.open[0].summary).not.toContain('Fwd:');
  });

  test('empty subject falls back to (no subject)', () => {
    const verdict = detectThreadLoop(
      thread([msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48, subject: '' })]),
      MY,
      NOW,
    );
    expect(verdict.open[0].summary).toContain('(no subject)');
  });

  test('quote is capped at 200 chars', () => {
    const verdict = detectThreadLoop(
      thread([
        msg({ from: 'bob@example.com', to: ['me@example.com'], ageHours: 48, body: `${'x'.repeat(500)}?` }),
      ]),
      MY,
      NOW,
    );
    expect(verdict.open[0].evidence[0].quote?.length).toBe(200);
  });
});
