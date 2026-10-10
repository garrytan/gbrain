/**
 * Life Chronicle date quality (CL-1 premature events, CL-2 invented days) on a managed brain.
 *
 * Protects: an event is published only when the page records it as happened by the end of the
 * page's own day. A plan dated after the page (a follow-up, a scheduled offsite) is dropped as
 * `future_dated`; a past event the judge can date only by year or month ("back in 2024" → "2024")
 * is dropped as `date_imprecise` instead of being pinned to YYYY-01-01. Same-day events, ended
 * invites, a conversation's later messages and generation reconciliation keep working.
 * Fails when: a proposal dated after the page's day, or without a day, reaches life/events/.
 * Seams: injected judge (`runPhaseChronicle({ judge })`, `runChronicleExtract({ judge })`).
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import {
  chronicleEventCutoff, chronicleJudgeContext, runChronicleExtract, screenChronicleProposals,
  type ChronicleEventProposal, type ChronicleJudge,
} from '../src/core/chronicle/extract-events.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

/** PGLite in the unit lane; the e2e wrapper reruns every case on an isolated Postgres database. */
const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl });

const day = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const PAGE_DAY = day(-3);
const BODY = 'Alice and Bob reviewed the launch plan, agreed to ship the beta and scheduled the team offsite. '.repeat(3);
const meeting = (body = BODY, extra = `date: ${PAGE_DAY}\n`) => `---\ntype: meeting\ntitle: Sync\n${extra}---\n\n${body}`;
const ev = (when: string, what: string, kind = 'meeting'): ChronicleEventProposal => ({ when, who: ['people/alice-example'], what, kind });

async function put(ctx: OperationContext, slug: string, content: string) {
  const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  return operationsByName.put_page.handler(ctx, { slug, content, ...(current ? { expected_revision: current.revision } : {}) });
}
async function settle(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
}
async function events(engine: BrainEngine) {
  return engine.executeRaw<{ day: string; what: string; deleted: boolean }>(
    `SELECT substring(slug from 13 for 10) AS day, frontmatter->'event'->>'what' AS what, deleted_at IS NOT NULL AS deleted
       FROM pages WHERE type='event' ORDER BY what`);
}
async function ledger(engine: BrainEngine) {
  return engine.executeRaw<{ slug: string; state: string; reason: string | null }>(
    'SELECT slug, state, reason FROM chronicle_page_state WHERE attempts > 0 ORDER BY slug, decided_at');
}
async function runOnce(engine: BrainEngine, judge: ChronicleJudge) {
  await settle(engine);
  return runPhaseChronicle(engine, { judge });
}

describe('CL-1: nothing after the page\'s own day', () => {
  test('a past meeting mentioning a future offsite publishes the meeting, never the offsite', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/sync', meeting());
    const r = await runOnce(engine, async () => ({ events: [
      ev(PAGE_DAY, 'Alice and Bob reviewed the launch plan'),
      ev(day(-1), 'Alice to send the beta notes', 'commitment'),
      ev(day(30), 'Team offsite in Austin', 'travel'),
    ] }));
    expect(r.details).toMatchObject({ judged: 1, extracted: 1, events_written: 1, events_dropped: { future_dated: 2 } });
    expect((await events(engine)).map((e) => [e.day, e.what])).toEqual([[PAGE_DAY, 'Alice and Bob reviewed the launch plan']]);
    expect(await ledger(engine)).toEqual([{ slug: 'meetings/sync', state: 'extracted', reason: null }]);
    const offsite = await operationsByName.chronicle_day.handler(ctx, { date: day(30) }) as unknown[];
    expect(offsite).toEqual([]);
  }), 120_000);

  test('same-day events are kept, to the end of the page\'s day', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/sync', meeting(BODY, `date: ${PAGE_DAY}\nstart: ${PAGE_DAY}T10:00:00Z\n`));
    const r = await runOnce(engine, async () => ({ events: [
      ev(PAGE_DAY, 'The sync itself'),
      ev(`${PAGE_DAY}T23:30:00Z`, 'Late follow-up call', 'call'),
    ] }));
    expect(r.details).toMatchObject({ events_written: 2, events_dropped: {} });
    expect((await events(engine)).map((e) => e.day)).toEqual([PAGE_DAY, PAGE_DAY]);
  }), 120_000);

  test('an ended calendar invite still produces its meeting event', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'calendar/standup', `---\ntype: calendar-event\ntitle: Standup\ndate: ${PAGE_DAY}\nstart: ${PAGE_DAY}T16:00:00Z\nend: ${PAGE_DAY}T16:30:00Z\n---\n\n${BODY}`);
    // An ended invite is projected without the judge (invite-projection.ts); the date screen keeps its event.
    const r = await runOnce(engine, async () => { throw new Error('an ended invite must not reach the judge'); });
    expect(r.details).toMatchObject({ judged: 0, extracted: 1, events_written: 1, events_dropped: {} });
    expect((await events(engine)).map((e) => [e.day, e.what])).toEqual([[PAGE_DAY, 'Scheduled: Standup']]);
  }), 120_000);

  test('a multi-day conversation runs to its last message', () => brain(async ({ engine, ctx }) => {
    const chat = [`**Alice** (${day(-4)} 9:30 PM): Can we move the launch review?`,
      `**Bob** (${day(-3)} 10:05 AM): Yes, moved it and shipped the beta build.`,
      `**Alice** (${day(-3)} 10:07 AM): Great, thanks for shipping it.`].join('\n\n');
    await put(ctx, 'conversations/launch', `---\ntype: conversation\ntitle: Launch chat\ndate: ${day(-4)}\n---\n\n${chat}\n`);
    const r = await runOnce(engine, async () => ({ events: [
      ev(day(-4), 'Alice asked to move the launch review', 'event'),
      ev(day(-3), 'Bob shipped the beta build', 'work'),
      ev(day(-2), 'Launch review', 'meeting'),
    ] }));
    expect(r.details).toMatchObject({ events_written: 2, events_dropped: { future_dated: 1 } });
    expect((await events(engine)).map((e) => e.day).sort()).toEqual([day(-4), day(-3)]);
  }), 120_000);

  test('re-extraction retires the old generation even when every new proposal is dropped', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/sync', meeting());
    await runOnce(engine, async () => ({ events: [ev(PAGE_DAY, 'Alice and Bob reviewed the launch plan')] }));
    await put(ctx, 'meetings/sync', meeting(`${BODY} Wording changed.`));
    const r = await runOnce(engine, async () => ({ events: [ev(day(10), 'Offsite planning session')] }));
    expect(r.details).toMatchObject({ judged: 1, no_events: 1, events_written: 0, events_retired: 1,
      events_dropped: { future_dated: 1 }, reasons: { future_dated: 1 } });
    expect((await events(engine)).map((e) => [e.what, e.deleted])).toEqual([['Alice and Bob reviewed the launch plan', true]]);
    expect((await ledger(engine)).map((row) => [row.state, row.reason])).toEqual([['extracted', null], ['extracted', 'future_dated']]);
  }), 120_000);
});

describe('CL-2: no invented days', () => {
  test('"back in 2024" never becomes a 2024-01-01 event', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/sync', meeting(`${BODY} Back in 2024 Alice ran the first pilot; last month the pilot closed.`));
    const r = await runOnce(engine, async () => ({ events: [
      ev('2024', 'Alice ran the first pilot', 'work'),
      ev('2024-03', 'The pilot closed', 'milestone'),
    ] }));
    expect(r.details).toMatchObject({ judged: 1, no_events: 1, events_written: 0,
      events_dropped: { date_imprecise: 2 }, reasons: { date_imprecise: 1 } });
    expect(await events(engine)).toEqual([]);
    expect(await operationsByName.chronicle_day.handler(ctx, { date: '2024-01-01' })).toEqual([]);
    expect(await ledger(engine)).toEqual([{ slug: 'meetings/sync', state: 'extracted', reason: 'date_imprecise' }]);
  }), 120_000);

  test('the direct extractor reports drops and keeps the dated events', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/sync', meeting());
    const r = await runChronicleExtract(engine, { slug: 'meetings/sync', judge: async () => ({ events: [
      ev(PAGE_DAY, 'The sync itself'), ev('2024', 'Pilot', 'work'), ev(day(5), 'Offsite', 'travel'),
    ] }) });
    expect(r).toMatchObject({ status: 'extracted', events_written: 1, events_dropped: { date_imprecise: 1, future_dated: 1 } });
    const none = await runChronicleExtract(engine, { slug: 'meetings/sync', judge: async () => ({ events: [ev(day(5), 'Offsite', 'travel')] }) });
    expect(none).toMatchObject({ status: 'no_events', reason: 'future_dated', events_written: 0, events_dropped: { future_dated: 1 } });
  }), 120_000);
});

describe('cutoff arithmetic', () => {
  const ctxFor = (frontmatter: Record<string, unknown>, body = BODY) =>
    chronicleJudgeContext({ slug: 'meetings/x', type: 'meeting', title: 'X', compiled_truth: body, frontmatter });
  const now = new Date('2026-10-04T12:00:00Z');

  test('a date-only page keeps its own day in any brain timezone', () => {
    const ctx = ctxFor({ date: '2026-04-18' });
    expect(chronicleEventCutoff(ctx, 'America/Los_Angeles', now)).toBe('2026-04-18');
    expect(chronicleEventCutoff(ctx, 'Asia/Tokyo', now)).toBe('2026-04-18');
    const { kept, dropped } = screenChronicleProposals([
      ev('2026-04-18T22:00:00-07:00', 'Late call'), ev('2026-04-19', 'Next day'), ev('2026-04', 'Sometime in April'),
    ], ctx, 'America/Los_Angeles', now, { maxEvents: 25 });
    expect(kept.map((k) => k.what)).toEqual(['Late call']);
    expect(dropped).toEqual({ future_dated: 1, date_imprecise: 1 });
  });

  test('a meeting\'s end extends the day in the brain timezone; nothing passes today', () => {
    expect(chronicleEventCutoff(ctxFor({ start: '2026-04-18T23:00:00Z', end: '2026-04-19T01:00:00Z' }), 'UTC', now)).toBe('2026-04-19');
    expect(chronicleEventCutoff(ctxFor({ start: '2026-04-18T23:00:00Z', end: '2026-04-19T01:00:00Z' }), 'America/Los_Angeles', now)).toBe('2026-04-18');
    expect(chronicleEventCutoff(ctxFor({ date: '2026-12-01' }), 'UTC', now)).toBe('2026-10-04');
    expect(chronicleEventCutoff(ctxFor({}), 'UTC', now)).toBe('2026-10-04');
  });
});
