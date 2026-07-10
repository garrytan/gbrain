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
import { runChronicleExtract, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { runChronicleBackstop } from '../src/core/chronicle/backstop.ts';

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
