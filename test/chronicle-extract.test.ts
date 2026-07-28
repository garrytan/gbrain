/**
 * v0.42.x — Life Chronicle (#2390) auto-emit extractor (Phase A.3).
 * PGLite in-memory. Covers eligibility, the extractor's parse barrier +
 * idempotent writes (event pages + timeline projection), and the backstop's
 * auto_chronicle gating + enqueue. The LLM judge is stubbed so the deterministic
 * write path is tested without a gateway.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import { runChronicleExtract, parseJudgeJson, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { runChronicleBackstop } from '../src/core/chronicle/backstop.ts';
import {
  configureGateway,
  resetGateway,
  __setChatTransportForTests,
} from '../src/core/ai/gateway.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const LONG_BODY = 'A'.repeat(120);

async function countEvents(): Promise<number> {
  const r = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type = 'event'`);
  return Number(r[0].n);
}

function chatResult(text: string, stopReason: ChatResult['stopReason']): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'deepseek:deepseek-v4-flash',
    providerId: 'deepseek',
  } as ChatResult;
}

function eventJson(what: string): string {
  return JSON.stringify([{
    when: '2026-06-18',
    who: ['people/sarah-chen'],
    what,
    kind: 'meeting',
  }]);
}

function configureChronicleTestGateway(): void {
  resetGateway();
  __setChatTransportForTests(null);
  configureGateway({
    chat_model: 'deepseek:deepseek-v4-flash',
    env: { DEEPSEEK_API_KEY: 'sk-test' },
  });
}

function restoreGateway(): void {
  resetGateway();
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });

describe('isChronicleEligible', () => {
  const body = LONG_BODY;
  test('meeting is eligible', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body }).ok).toBe(true);
  });
  test('meetings/ slug rescues a note-typed page', () => {
    expect(isChronicleEligible({ type: 'note', slug: 'meetings/x', body }).ok).toBe(true);
  });
  test('diary is excluded (privacy)', () => {
    expect(isChronicleEligible({ type: 'diary', slug: 'life/diary/x', body })).toEqual({ ok: false, reason: 'diary_excluded' });
  });
  test('event is excluded (anti-loop)', () => {
    expect(isChronicleEligible({ type: 'event', slug: 'life/events/x', body })).toEqual({ ok: false, reason: 'event_self' });
  });
  test('dream-generated is excluded', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body, dreamGenerated: true })).toEqual({ ok: false, reason: 'dream_generated' });
  });
  test('too-short body is excluded', () => {
    expect(isChronicleEligible({ type: 'meeting', slug: 'meetings/x', body: 'hi' })).toEqual({ ok: false, reason: 'too_short' });
  });
  test('unrelated type is excluded', () => {
    expect(isChronicleEligible({ type: 'concept', slug: 'wiki/concepts/x', body })).toEqual({ ok: false, reason: 'kind:concept' });
  });
});

describe('runChronicleExtract', () => {
  const oneEvent: ChronicleJudge = async () => ({
    events: [{ when: '2026-06-18T15:30:00Z', who: ['people/sarah-chen'], what: 'Sarah committed to Q3', kind: 'commitment' }],
  });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM timeline_entries');
    await engine.executeRaw(`DELETE FROM pages WHERE type = 'event' OR slug = 'meetings/2026-06-18-sync'`);
    await engine.putPage('meetings/2026-06-18-sync', {
      type: 'meeting', title: 'Weekly sync',
      compiled_truth: LONG_BODY,
      frontmatter: { attendees: ['people/sarah-chen'] },
      effective_date: new Date('2026-06-18T15:00:00Z'),
    });
  });

  test('writes an event page + timeline projection', async () => {
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    expect(r.status).toBe('extracted');
    expect(r.events_written).toBe(1);
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(day.length).toBe(1);
    expect(day[0].summary).toBe('Sarah committed to Q3');
    expect(day[0].page_slug).toBe('meetings/2026-06-18-sync'); // projection keyed to depth
    expect(day[0].event_slug?.startsWith('life/events/2026-06-18-')).toBe(true);
    expect(day[0].kind).toBe('commitment');
  });

  test('is idempotent: running twice yields one event + one projection', async () => {
    await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: oneEvent });
    expect(await countEvents()).toBe(1);
    const day = await engine.getTimelineForDate('2026-06-18', { sourceId: 'default' });
    expect(day.length).toBe(1);
  });

  test('parse barrier: a malformed proposal writes NOTHING', async () => {
    const before = await countEvents();
    const bad: ChronicleJudge = async () => ({ events: [{ when: '2026-06-18', who: [], kind: 'x' } as never] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: bad });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('malformed_proposal');
    expect(await countEvents()).toBe(before); // no partial write
  });

  test('parse barrier: a non-date `when` writes NOTHING (codex fix #2)', async () => {
    const before = await countEvents();
    const badDate: ChronicleJudge = async () => ({ events: [{ when: 'not-a-date', who: [], what: 'x', kind: 'meeting' }] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: badDate });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('malformed_proposal');
    expect(await countEvents()).toBe(before);
  });

  test('no events → no_events status', async () => {
    const none: ChronicleJudge = async () => ({ events: [] });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: none });
    expect(r.status).toBe('no_events');
  });

  // #2606: a truncated or unparseable judge response must NOT be recorded as
  // a legitimate no_events — it gets a distinct skipped reason.
  test('truncated judge output → skipped/judge_truncated, not no_events (#2606)', async () => {
    const truncated: ChronicleJudge = async () => ({ events: [], failure: 'truncated' });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: truncated });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('judge_truncated');
    expect(await countEvents()).toBe(0);
  });

  test('unparseable judge output → skipped/judge_parse_failed (#2606)', async () => {
    const parseFailed: ChronicleJudge = async () => ({ events: [], failure: 'parse_failed' });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: parseFailed });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('judge_parse_failed');
  });

  test('default judge splits a truncated 12k window and recovers both halves', async () => {
    const body = `LEFT_MARKER\n${'L'.repeat(5_900)}\nRIGHT_MARKER\n${'R'.repeat(5_900)}`;
    await engine.putPage('meetings/2026-06-18-sync', {
      type: 'meeting', title: 'Dense sync',
      compiled_truth: body,
      frontmatter: { attendees: ['people/sarah-chen'] },
      effective_date: new Date('2026-06-18T15:00:00Z'),
    });
    await engine.setConfig('chronicle.judge_max_tokens', '8000');
    configureChronicleTestGateway();
    const seen: ChatOpts[] = [];
    __setChatTransportForTests(async (opts) => {
      seen.push(opts);
      if (seen.length === 1) return chatResult('[{"when":"2026-06-18"', 'length');
      const prompt = String(opts.messages[0]?.content ?? '');
      if (prompt.includes('LEFT_MARKER')) return chatResult(eventJson('left event'), 'end');
      if (prompt.includes('RIGHT_MARKER')) return chatResult(eventJson('right event'), 'end');
      throw new Error('split prompt did not preserve a segment marker');
    });

    try {
      const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync' });
      expect(seen).toHaveLength(3);
      expect(seen.every((opts) => opts.maxTokens === 8000)).toBe(true);
      const leftPrompt = String(seen[1]!.messages[0]?.content ?? '');
      const rightPrompt = String(seen[2]!.messages[0]?.content ?? '');
      expect(leftPrompt.includes('LEFT_MARKER')).toBe(true);
      expect(leftPrompt.includes('RIGHT_MARKER')).toBe(false);
      expect(rightPrompt.includes('LEFT_MARKER')).toBe(false);
      expect(rightPrompt.includes('RIGHT_MARKER')).toBe(true);
      expect(r.status).toBe('extracted');
      expect(r.events_written).toBe(2);
    } finally {
      await engine.unsetConfig('chronicle.judge_max_tokens');
      restoreGateway();
    }
  });

  test('split retry remains all-or-nothing when one half is still truncated', async () => {
    const body = `LEFT_MARKER\n${'L'.repeat(5_900)}\nRIGHT_MARKER\n${'R'.repeat(5_900)}`;
    await engine.putPage('meetings/2026-06-18-sync', {
      type: 'meeting', title: 'Dense sync',
      compiled_truth: body,
      frontmatter: { attendees: ['people/sarah-chen'] },
      effective_date: new Date('2026-06-18T15:00:00Z'),
    });
    await engine.setConfig('chronicle.judge_max_tokens', '8000');
    configureChronicleTestGateway();
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      if (calls === 1) return chatResult('[{"when":"2026-06-18"', 'length');
      if (calls === 2) return chatResult(eventJson('left event'), 'end');
      return chatResult('[{"when":"2026-06-18"', 'length');
    });

    try {
      const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync' });
      expect(calls).toBe(3);
      expect(r.status).toBe('skipped');
      expect(r.reason).toBe('judge_truncated');
      expect(await countEvents()).toBe(0);
    } finally {
      await engine.unsetConfig('chronicle.judge_max_tokens');
      restoreGateway();
    }
  });

  test('split retry writes nothing when one half is filtered', async () => {
    const body = `LEFT_MARKER\n${'L'.repeat(5_900)}\nRIGHT_MARKER\n${'R'.repeat(5_900)}`;
    await engine.putPage('meetings/2026-06-18-sync', {
      type: 'meeting', title: 'Dense sync',
      compiled_truth: body,
      frontmatter: { attendees: ['people/sarah-chen'] },
      effective_date: new Date('2026-06-18T15:00:00Z'),
    });
    configureChronicleTestGateway();
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      if (calls === 1) return chatResult('[{"when":"2026-06-18"', 'length');
      if (calls === 2) return chatResult(eventJson('left event'), 'end');
      return chatResult('', 'content_filter');
    });

    try {
      const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync' });
      expect(calls).toBe(3);
      expect(r.status).toBe('skipped');
      expect(r.reason).toBe('judge_parse_failed');
      expect(await countEvents()).toBe(0);
    } finally {
      restoreGateway();
    }
  });
});

describe('parseJudgeJson failure signalling (#2606)', () => {
  test('a legitimate empty array parses to []', () => {
    expect(parseJudgeJson('[]')).toEqual([]);
    expect(parseJudgeJson('```json\n[]\n```')).toEqual([]);
  });

  test('a valid array round-trips', () => {
    const arr = parseJudgeJson('[{"when":"2026-06-18","who":[],"what":"x","kind":"meeting"}]');
    expect(Array.isArray(arr)).toBe(true);
    expect(arr!.length).toBe(1);
  });

  test('empty / no-array / truncated / non-array responses return null', () => {
    expect(parseJudgeJson('')).toBeNull();
    expect(parseJudgeJson('I found no events worth extracting.')).toBeNull();
    // Truncated mid-array (the maxTokens-cap shape from the issue).
    expect(parseJudgeJson('[{"when":"2026-06-18","who":["a"],"what":"long ev')).toBeNull();
    expect(parseJudgeJson('{"events": 1}')).toBeNull();
  });
});

describe('runChronicleBackstop gating', () => {
  beforeEach(async () => {
    await engine.unsetConfig('auto_chronicle');
    await engine.putPage('meetings/bs', { type: 'meeting', title: 'bs', compiled_truth: LONG_BODY });
  });

  test('skips when auto_chronicle is off (default)', async () => {
    const r = await runChronicleBackstop({ slug: 'meetings/bs', type: 'meeting', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r).toEqual({ enqueued: false, skipped: 'auto_chronicle_off' });
  });

  test('skips a diary page before consulting the flag', async () => {
    const r = await runChronicleBackstop({ slug: 'life/diary/x', type: 'diary', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r).toEqual({ enqueued: false, skipped: 'diary_excluded' });
  });

  test('enqueues a chronicle_extract job when enabled + eligible', async () => {
    await engine.setConfig('auto_chronicle', 'true');
    const r = await runChronicleBackstop({ slug: 'meetings/bs', type: 'meeting', compiled_truth: LONG_BODY }, { engine, sourceId: 'default' });
    expect(r.enqueued).toBe(true);
    const jobs = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'chronicle_extract'`);
    expect(Number(jobs[0].n)).toBeGreaterThanOrEqual(1);
  });
});
