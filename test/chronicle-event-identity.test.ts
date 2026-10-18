/**
 * Life Chronicle same-day event identity (event-identity.ts).
 *
 * Protects: two distinct proposals that share who, what and day on one depth
 * page publish as two events; the slug set does not depend on proposal order;
 * a correction leaves the other events' slugs alone; a page extracted before
 * disambiguation keeps its event slug when an extractor-version bump
 * reprocesses it; the day is the brain timezone's day.
 * Fails when: a collision collapses two events into one page, reordering or
 * a correction moves an unrelated event to another slug, or reprocessing a
 * legacy page retires and recreates its existing event.
 * Existing coverage: chronicle-auto-phase pins reconciliation with distinct
 * summaries only; nothing exercised two proposals with one base slug.
 * Seams: injected judge (`runPhaseChronicle({ judge })`).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { runPhaseChronicle } from '../src/core/cycle/chronicle.ts';
import { runChronicleBackfill } from '../src/core/chronicle/backfill.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { buildChronicleEvents, type ChronicleEventProposal, type ChronicleJudge } from '../src/core/chronicle/extract-events.ts';
import { assignChronicleEventSlugs } from '../src/core/chronicle/event-identity.ts';
import { managedBrain, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase } from './helpers/test-backends.ts';

const databaseUrl = process.env.GBRAIN_TEST_BACKEND === 'postgres' ? requirePostgresTestDatabase() : undefined;
const brain = (run: (b: ManagedBrain) => Promise<void>) => managedBrain(run, { databaseUrl });

const today = new Date().toISOString().slice(0, 10);
const BODY = 'Alice and Bob reviewed the launch plan and agreed on the next steps for the beta. '.repeat(3);
const meeting = (body = BODY) => `---\ntype: meeting\ntitle: Day notes\ndate: ${today}\n---\n\n${body}`;
const call = (when: string, extra: Partial<ChronicleEventProposal> = {}): ChronicleEventProposal =>
  ({ when, who: ['people/alice-example'], what: 'Call with alice-example', kind: 'call', ...extra });
const MORNING = call(`${today}T09:00:00Z`);
const AFTERNOON = call(`${today}T16:00:00Z`);

async function put(ctx: OperationContext, slug: string, content: string) {
  const current = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await operationsByName.put_page.handler(ctx, { slug, content, ...(current ? { expected_revision: current.revision } : {}) });
}
async function settle(engine: BrainEngine) {
  await engine.executeRaw("UPDATE chronicle_page_state SET next_attempt_at=now()-interval '1 second', decided_at=now()-interval '1 hour' WHERE state='pending'");
}
async function judged(engine: BrainEngine, events: ChronicleEventProposal[]) {
  await settle(engine);
  let calls = 0;
  const judge: ChronicleJudge = async () => { calls++; return { events }; };
  const r = await runPhaseChronicle(engine, { judge });
  return { calls, details: r.details };
}
async function eventPages(engine: BrainEngine) {
  return engine.executeRaw<{ id: number; slug: string; when: string; what: string; deleted: boolean }>(
    `SELECT id, slug, frontmatter->'event'->>'when' AS "when", frontmatter->'event'->>'what' AS what, deleted_at IS NOT NULL AS deleted
       FROM pages WHERE type='event' ORDER BY slug`);
}
const live = async (engine: BrainEngine) => (await eventPages(engine)).filter((e) => !e.deleted);
const at = (whenIso: string) => new Date(whenIso).toISOString();

function slugsFor(proposals: ChronicleEventProposal[], tz = 'UTC', existing = new Map<string, string>()) {
  const ctx = { input: {} as never, effectiveDate: today, attendees: [], pageDates: [new Date(`${today}T23:59:59Z`)] };
  const { events: built, dropped } = buildChronicleEvents(proposals, ctx, { slug: 'meetings/day', visibility: 'world', contentHash: 'h' }, { tz, now: new Date(`${today}T23:59:59Z`), maxEvents: 25 });
  expect(dropped).toEqual({});
  return { legacy: built.map((e) => e.slug), assigned: assignChronicleEventSlugs(built, existing).map((e) => e.slug) };
}

describe('assignment (no database)', () => {
  test('collision count on a proposal fixture: legacy slugs vs disambiguated slugs', () => {
    const fixture: ChronicleEventProposal[] = [
      MORNING, AFTERNOON,
      call(`${today}T11:00:00Z`, { what: 'Standup with the beta team', who: ['people/bob-example'], kind: 'meeting' }),
      call(`${today}T15:00:00Z`, { what: 'Standup with the beta team', who: ['people/bob-example'], kind: 'meeting', where: 'Room 2' }),
      call(`${today}T15:00:00Z`, { what: 'Standup with the beta team', who: ['people/bob-example'], kind: 'meeting', where: 'Room 3' }),
      call(`${today}T12:00:00Z`, { what: 'Lunch with carol-example', who: ['people/carol-example'], kind: 'meal' }),
    ];
    const { legacy, assigned } = slugsFor(fixture);
    const collisions = (slugs: string[]) => slugs.length - new Set(slugs).size;
    expect({ proposals: fixture.length, before: collisions(legacy), after: collisions(assigned) }).toEqual({ proposals: 6, before: 3, after: 0 });
    // Every group keeps its legacy base slug for exactly one member.
    expect(new Set(assigned.filter((s) => legacy.includes(s))).size).toBe(new Set(legacy).size);
  });

  test('reordered proposals produce the same slug set, and the earliest keeps the base slug', () => {
    const forward = slugsFor([MORNING, AFTERNOON]);
    const reverse = slugsFor([AFTERNOON, MORNING]);
    expect(forward.assigned[0]).toBe(forward.legacy[0]);
    expect(forward.assigned[1]).toMatch(new RegExp(`^${forward.legacy[0]}-[0-9a-f]{6}$`));
    expect(reverse.assigned).toEqual([forward.assigned[1], forward.assigned[0]]);
  });

  test('identical copies keep their count with an ordinal suffix', () => {
    const { legacy, assigned } = slugsFor([MORNING, MORNING]);
    expect(assigned).toEqual([legacy[0], `${legacy[0]}-2`]);
  });

  test('timezone boundary: the day is the brain timezone\'s day', () => {
    const lateNight = call('2026-10-01T23:30:00-07:00');
    const nextMorning = call('2026-10-02T09:00:00-07:00');
    const pacific = slugsFor([lateNight, nextMorning], 'America/Los_Angeles');
    expect(pacific.assigned.map((s) => s.slice('life/events/'.length, 'life/events/'.length + 10))).toEqual(['2026-10-01', '2026-10-02']);
    expect(pacific.assigned).toEqual(pacific.legacy);
    // In UTC both instants fall on 2026-10-02 and share a base slug; they still publish as two events.
    const utc = slugsFor([lateNight, nextMorning], 'UTC');
    expect(new Set(utc.legacy).size).toBe(1);
    expect(new Set(utc.assigned).size).toBe(2);
  });
});

describe('publication through the chronicle phase', () => {
  test('two same-day calls publish as two events; reordering changes nothing; a correction moves only the corrected event', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/day', meeting());
    expect((await judged(engine, [MORNING, AFTERNOON])).details).toMatchObject({ events_written: 2 });
    const first = await live(engine);
    expect(first.map((e) => e.when).map(at).sort()).toEqual([at(MORNING.when), at(AFTERNOON.when)]);

    await put(ctx, 'meetings/day', meeting(`${BODY} Reordered.`));
    expect((await judged(engine, [AFTERNOON, MORNING])).details).toMatchObject({ events_written: 2, events_retired: 0 });
    expect(await live(engine)).toEqual(first);

    // The morning call's summary is corrected: it leaves the group, and the afternoon call keeps its slug.
    await put(ctx, 'meetings/day', meeting(`${BODY} Corrected.`));
    const corrected = { ...MORNING, what: 'Call with alice-example about the beta' };
    expect((await judged(engine, [corrected, AFTERNOON])).details).toMatchObject({ events_written: 2, events_retired: 1 });
    const after = await live(engine);
    const afternoon = first.find((e) => at(e.when) === at(AFTERNOON.when))!;
    expect(after.find((e) => e.what === AFTERNOON.what)).toEqual(afternoon);
    expect(after.map((e) => e.what).sort()).toEqual([AFTERNOON.what, corrected.what]);
  }), 120_000);

  test('a legacy page reprocessed after the extractor-version bump keeps its event slug', () => brain(async ({ engine, ctx }) => {
    // Before disambiguation, both calls landed on one base slug and the last proposal won it.
    await put(ctx, 'meetings/day', meeting());
    await judged(engine, [AFTERNOON]);
    const [legacy] = await live(engine);
    await engine.executeRaw('UPDATE chronicle_page_state SET extractor_version=1');

    // A managed brain leaves the re-decision to backfill; the run then judges the page once more.
    const queued = await runChronicleBackfill(engine, { yes: true });
    expect(queued).toMatchObject({ queued: 1, already_done: 0 });
    const run = await judged(engine, [MORNING, AFTERNOON]);
    expect(run.calls).toBe(1);
    expect(run.details).toMatchObject({ events_written: 2, events_retired: 0 });
    const events = await eventPages(engine);
    expect(events.every((e) => !e.deleted)).toBe(true);
    expect(events.find((e) => e.slug === legacy.slug)).toEqual(legacy);
    const separated = events.find((e) => e.slug !== legacy.slug)!;
    expect(separated.slug).toMatch(new RegExp(`^${legacy.slug}-[0-9a-f]{6}$`));
    expect(at(separated.when)).toBe(at(MORNING.when));
  }), 120_000);

  test('an operator-edited colliding event stays the operator\'s; its sibling still publishes', () => brain(async ({ engine, ctx }) => {
    await put(ctx, 'meetings/day', meeting());
    await judged(engine, [MORNING, AFTERNOON]);
    const before = await live(engine);
    const morning = before.find((e) => at(e.when) === at(MORNING.when))!;
    const page = (await engine.readPageSnapshot(morning.slug, { sourceId: 'default' }))!;
    const { serializePageToMarkdown } = await import('../src/core/markdown.ts');
    await operationsByName.put_page.handler(ctx, { slug: morning.slug, expected_revision: page.revision,
      content: serializePageToMarkdown({ ...page.page, compiled_truth: 'Call with alice-example (the operator confirmed it).' }, page.tags) });
    const edited = (await engine.readPageSnapshot(morning.slug, { sourceId: 'default' }))!;
    await put(ctx, 'meetings/day', meeting(`${BODY} Again.`));
    await judged(engine, [AFTERNOON, MORNING]);
    const after = (await engine.readPageSnapshot(morning.slug, { sourceId: 'default' }))!;
    expect(after.page.content_hash).toBe(edited.page.content_hash);
    expect((await live(engine)).map((e) => e.slug)).toEqual(before.map((e) => e.slug));
  }), 120_000);
});

describe.skipIf(databaseUrl !== undefined)('unmanaged brain', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('an extractor-version bump re-queues an already-extracted page automatically', async () => {
    await engine.setConfig('chronicle.auto_settle_seconds', '0');
    await engine.setConfig('chronicle.activated_at', new Date(Date.now() - 60_000).toISOString());
    await engine.putPage('meetings/day', { type: 'meeting', title: 'Day notes', compiled_truth: BODY, frontmatter: { date: today } });
    expect((await judged(engine, [AFTERNOON])).calls).toBe(1);
    const [legacy] = await live(engine);
    expect((await judged(engine, [MORNING, AFTERNOON])).calls).toBe(0);
    await engine.executeRaw('UPDATE chronicle_page_state SET extractor_version=1');
    const run = await judged(engine, [MORNING, AFTERNOON]);
    expect(run.calls).toBe(1);
    const events = await live(engine);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.slug === legacy.slug)).toEqual(legacy);
  }, 120_000);
});
