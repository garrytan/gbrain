/**
 * #5025 + N2: conversation facts on email and meeting pages.
 *
 * Protects: a Gmail thread page as gbrain renders it parses into one turn
 * per message (sender display name, heading time), including a one-message
 * thread, and its facts extract; meeting-note metadata labels
 * (`**Attendees:**`, `**Date:**`) are never speakers; a prose meeting page is
 * marked not extractable once and then leaves the backlog instead of being
 * rescanned every run; a time-only parse on a page with no date never yields
 * facts dated 1970-01-01.
 * Fails when: email pages parse to zero turns and stay "retryable" forever,
 * or a prose meeting page parses into turns by "Attendees" and "Date" at the
 * epoch (the pre-fix behavior).
 * Seams: real PGLite; the extractor is injected (no model calls).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { parseConversation } from '../src/core/conversation-parser/parse.ts';
import { looksLikeMeetingNotes } from '../src/core/conversation-parser/builtins.ts';
import { renderThreadPage } from '../src/core/google/google-render.ts';
import type { GmailMessageMeta } from '../src/core/google/types.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { runExtractConversationFactsCore, NON_EXTRACTABLE_AUDIT_SOURCE } from '../src/commands/extract-conversation-facts.ts';
import { computeConversationFactsBacklogCheck } from '../src/commands/doctor/checks/search-eval.ts';

function message(over: Partial<GmailMessageMeta>): GmailMessageMeta {
  const dateIso = over.dateIso ?? '2026-09-07T12:21:00.000Z';
  return {
    id: '18c2f4a9b3d21e01', threadId: '18c2f4a9b3d21e00', from: 'Alice Example <alice@example.com>',
    fromAddress: 'alice@example.com', to: ['bob@example.com'], cc: [], subject: 'Planning call',
    dateIso, internalDateMs: Date.parse(dateIso), labelIds: [], listUnsubscribe: false,
    bodyText: 'Can we move the planning call to Thursday?', ...over,
  };
}

const twoMessageThread = () => renderThreadPage({
  threadId: '18c2f4a9b3d21e00', account: 'bob@example.com', messages: [
    message({}),
    message({
      id: '18c2f4a9b3d21e02', from: '"Bob Example" <bob@example.com>', fromAddress: 'bob@example.com',
      to: ['alice@example.com'], subject: 'Re: Planning call', dateIso: '2026-09-07T14:05:00.000Z',
      labelIds: ['SENT'], bodyText: 'Thursday works. I will send an invite.',
    }),
  ],
})!.markdown;

const PROSE_MEETING = `---
type: meeting
title: Weekly sync
date: 2026-09-07
---
# Weekly sync

**Attendees:** Alice Example, Bob Example
**Date:** 2026-09-07

## Summary

The team agreed to ship the widget on Friday. Bob owns the launch checklist.
`;

describe('parser', () => {
  test('a Gmail thread page parses one turn per message with the sender name and heading time', () => {
    const body = twoMessageThread().split('\n---\n').slice(1).join('\n---\n');
    const r = parseConversation(body, {});
    expect(r.matched_pattern_id).toBe('email-thread-heading');
    expect(r.messages.map((m) => [m.speaker, m.timestamp])).toEqual([
      ['Alice Example', '2026-09-07T12:21:00Z'],
      ['Bob Example', '2026-09-07T14:05:00Z'],
    ]);
    expect(r.messages[1]!.text).toContain('Thursday works.');
    expect(r.unrecognized_headings).toBeUndefined();
  });


  test('meeting-note metadata labels are never speakers', () => {
    expect(parseConversation(PROSE_MEETING, { fallbackDate: '2026-09-07' }).phase).toBe('no_match');
    const withTurns = [
      '**Attendees:** Alice Example, Bob Example', '**Date:** 2026-09-07',
      '**Alice Example:** Shall we ship Friday?', '**Bob Example:** Yes, I own the checklist.', '**Alice Example:** Great.',
    ].join('\n');
    const r = parseConversation(withTurns, { fallbackDate: '2026-09-07' });
    expect(r.messages.map((m) => m.speaker)).toEqual(['Alice Example', 'Bob Example', 'Alice Example']);
  });

  test('speaker-role labels (Host, Guest, Facilitator) stay speakers', () => {
    const interview = [
      '**Host:** Welcome to the show.', '**Guest:** Thanks for having me.',
      '**Host:** What are you building?', '**Guest:** A planning tool for small teams.',
      '**Facilitator:** One last question.', '**Guest:** Happy to answer.',
    ].join('\n');
    const r = parseConversation(interview, { fallbackDate: '2026-09-01' });
    expect(r.messages.map((m) => m.speaker)).toEqual(['Host', 'Guest', 'Host', 'Guest', 'Facilitator', 'Guest']);
    expect(looksLikeMeetingNotes(interview)).toBe(false);
  });

  test('looksLikeMeetingNotes recognizes metadata labels and attendee sections only', () => {
    expect(looksLikeMeetingNotes(PROSE_MEETING)).toBe(true);
    expect(looksLikeMeetingNotes('# Event\n\n## Attendees\n\n- alice@example.com')).toBe(true);
    expect(looksLikeMeetingNotes('## Summary\n\nAn unsupported transcript without speaker anchors.')).toBe(false);
  });
});

describe('extractor', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });
  beforeEach(async () => {
    await resetPgliteState(engine);
  });

  const extractor = async (input: { turnText: string }) => [
    { fact: 'The planning call moved to Thursday', kind: 'event' as const, confidence: 1, entity_slug: null, source: 'test', context: input.turnText },
  ];

  test('an email thread page extracts facts from its messages', async () => {
    await importFromContent(engine, 'email/planning-call', twoMessageThread(), { noEmbed: true });
    const r = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: 'email/planning-call', extractor, sleepMs: 0 });
    expect(r).toMatchObject({ pages_processed: 1, pages_skipped_unparsed: 0, segments_processed: 1, facts_inserted: 1 });
  });

  test('a prose meeting page is marked not extractable once, then skipped', async () => {
    await importFromContent(engine, 'meetings/weekly-sync', PROSE_MEETING, { noEmbed: true });
    await engine.setConfig('cycle.conversation_facts_backfill.enabled', 'true');
    const backlog = async () => (await computeConversationFactsBacklogCheck(engine)).details?.backlog;
    expect(await backlog()).toBe(1);
    let calls = 0;
    const counting = async (input: { turnText: string }) => { calls++; return extractor(input); };
    const first = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: 'meetings/weekly-sync', extractor: counting, sleepMs: 0 });
    expect(first).toMatchObject({ pages_skipped: 1, pages_skipped_unparsed: 0, pages_skipped_insufficient_turns: 0, pages_marked_non_extractable: 1, facts_inserted: 0 });
    const [audit] = await engine.executeRaw<{ fact: string }>('SELECT context AS fact FROM facts WHERE source = $1', [NON_EXTRACTABLE_AUDIT_SOURCE]);
    expect(audit!.fact).toContain('no speaker turns in this meeting page');
    const second = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: 'meetings/weekly-sync', extractor: counting, sleepMs: 0 });
    expect(second).toMatchObject({ pages_skipped_non_extractable: 1, pages_marked_non_extractable: 0 });
    expect(calls).toBe(0);
    expect(await backlog()).toBe(0);
  });

  test('a one-message email thread is marked not extractable', async () => {
    const single = renderThreadPage({ threadId: '18c2f4a9b3d21e00', account: 'bob@example.com', messages: [message({})] })!.markdown;
    await importFromContent(engine, 'email/single', single, { noEmbed: true });
    const r = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: 'email/single', extractor, sleepMs: 0 });
    expect(r).toMatchObject({ pages_marked_non_extractable: 1, pages_skipped_unparsed: 0, facts_inserted: 0 });
    const [audit] = await engine.executeRaw<{ fact: string }>('SELECT context AS fact FROM facts WHERE source = $1', [NON_EXTRACTABLE_AUDIT_SOURCE]);
    expect(audit!.fact).toContain('a single email message in this email page');
  });

  test('a time-only parse on a page with no date yields no epoch-dated facts', async () => {
    await engine.putPage('conversations/undated', {
      type: 'conversation', title: 'Undated chat', timeline: '', frontmatter: {},
      compiled_truth: ['**Alice Example:** Shall we ship Friday?', '**Bob Example:** Yes.', '**Alice Example:** Great.', '**Bob Example:** Done.'].join('\n'),
    });
    const r = await runExtractConversationFactsCore(engine, { sourceId: 'default', slug: 'conversations/undated', extractor, sleepMs: 0 });
    expect(r).toMatchObject({ facts_inserted: 0, pages_marked_non_extractable: 1, pages_skipped_unparsed: 0 });
    const rows = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE valid_from < '1971-01-01'`);
    expect(Number(rows[0]!.n)).toBe(0);
  });
});
