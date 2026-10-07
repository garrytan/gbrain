/**
 * v0.42.x — Life Chronicle (#2390) auto-emit extractor (Phase A.3).
 * PGLite in-memory. Covers eligibility, the extractor's parse barrier +
 * idempotent writes (event pages + timeline projection). The write-path
 * decision and execution live in test/chronicle-auto-*.test.ts. The LLM judge is stubbed so the deterministic
 * write path is tested without a gateway.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { isChronicleEligible } from '../src/core/chronicle/eligibility.ts';
import { runChronicleExtract, parseJudgeJson, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
const LONG_BODY = 'A'.repeat(120);

async function countEvents(): Promise<number> {
  const r = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM pages WHERE type = 'event'`);
  return Number(r[0].n);
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

  // #2608: a keyless daemon (no servable chat provider) must NOT be recorded
  // as a legitimate no_events run — pre-fix the default judge returned a bare
  // `{events: []}` when isAvailable('chat') was false, indistinguishable from
  // "the judge read the page and found nothing", so keyless installs reported
  // clean chronicle runs forever.
  test('no chat provider → skipped/judge_llm_unavailable, not no_events (#2608)', async () => {
    const unavailable: ChronicleJudge = async () => ({ events: [], failure: 'llm_unavailable' });
    const r = await runChronicleExtract(engine, { slug: 'meetings/2026-06-18-sync', judge: unavailable });
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe('judge_llm_unavailable');
    expect(await countEvents()).toBe(0);
  });

  test('defaultJudge surfaces llm_unavailable (source contract, #2608)', async () => {
    // The default judge is not exported; pin the load-bearing line so the
    // bare-`{events: []}` regression can't silently return.
    const { readFileSync } = await import('fs');
    // test-reads-source-ok[structural]: defaultJudge is module-private and needs a live gateway; the text pin is the only unit-testable seam (#2608)
    const src = readFileSync('src/core/chronicle/extract-events.ts', 'utf8');
    expect(src).toMatch(/isAvailable\('chat'\)\)\s*return \{ events: \[\], failure: 'llm_unavailable' \}/);
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

// #5209: the judge reply's array ends at its own `]`. Slicing to the last `]`
// in the reply pulled a trailing footnote or wikilink into the JSON and lost
// a valid answer as parse_failed.
describe('parseJudgeJson ignores brackets in prose after the array (#5209)', () => {
  const meeting = (what: string) => JSON.stringify({ when: '2027-03-02', who: ['alice-example'], what, kind: 'meeting' });

  test('a footnote marker after the array', () => {
    expect(parseJudgeJson(`[${meeting('kickoff')}]\nBased on the transcript [1].`)).toEqual([JSON.parse(meeting('kickoff'))]);
  });

  test('two events, then a wikilink line', () => {
    const out = parseJudgeJson(`Events:\n[${meeting('kickoff')},${meeting('retro')}]\nAlso see [[projects/acme-example]]`);
    expect(out?.map(e => e.what)).toEqual(['kickoff', 'retro']);
  });

  test('a closing bracket and an escaped quote inside a field', () => {
    const out = parseJudgeJson(`[${meeting('she said "ship it]" twice')}] (refs: [a], [b])`);
    expect(out?.[0]?.what).toBe('she said "ship it]" twice');
  });

  test('control: a cut-off array followed by a citation is still a failure', () => {
    expect(parseJudgeJson(`[${meeting('kickoff')}, {"when":"2027-03-03"\n[Source: notes]`)).toBeNull();
  });

  test('control: prose with brackets but no JSON array is still a failure', () => {
    expect(parseJudgeJson('No events found [see policy].')).toBeNull();
  });
});

// #5876 (E2): the default judge used to map a thrown provider error and a
// refusal to `{events: []}`, so a failed call was recorded as no_events and
// its content never retried.
describe('default judge failure classes (#5876)', () => {
  beforeEach(async () => {
    await engine.executeRaw(`DELETE FROM pages WHERE type = 'event' OR slug = 'meetings/judge-classes'`);
    await engine.putPage('meetings/judge-classes', { type: 'meeting', title: 'Judge', compiled_truth: LONG_BODY });
    configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'sk-test' } });
  });
  afterAll(() => { __setChatTransportForTests(null); resetGateway(); });

  test('a provider error is judge_chat_error, not no_events', async () => {
    __setChatTransportForTests(async () => { throw new Error('provider 503'); });
    expect(await runChronicleExtract(engine, { slug: 'meetings/judge-classes' }))
      .toMatchObject({ status: 'skipped', reason: 'judge_chat_error', events_written: 0 });
  });

  test('a refusal is judge_refused, not no_events', async () => {
    __setChatTransportForTests(async () => ({ text: '', blocks: [], stopReason: 'refusal', model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      usage: { input_tokens: 1, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 } }) as never);
    expect(await runChronicleExtract(engine, { slug: 'meetings/judge-classes' })).toMatchObject({ status: 'skipped', reason: 'judge_refused' });
  });
});
