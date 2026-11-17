/**
 * BrainEngine parity — timeline family (timeline entries, Life Chronicle date
 * reads, event projections) and the per-entity ontology that rides `facts`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every timeline write/read and every ontology merge/read
 *    returns the same observable result on every engine arm (PGLite always;
 *    Postgres with DATABASE_URL; a Rust arm later through
 *    test/engine-parity/harness.ts).
 *  - Regression: an engine that drifts on timeline dedup, date-window
 *    filtering, intra-day ordering, "on this day" / last-seen date math,
 *    event-projection upsert, or ontology supersession and conflict
 *    detection — the reads behind `gbrain timeline`, the chronicle and
 *    "what do I know about X".
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    entirely without Postgres and covers only getTimeline windows; the
 *    chronicle/ontology unit tests run on PGLite alone.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 *    Entry ids and page ids are never returned.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChronicleTimelineRow, OntologyConflict } from '../../src/core/types.ts';
import { createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const ENTRY_KEYS = ['date', 'source', 'summary', 'detail'] as const;
const CHRONICLE_KEYS = ['date', 'summary', 'detail', 'source', 'page_slug', 'event_slug', 'effective_date', 'kind'] as const;
const chronicle = (rows: ChronicleTimelineRow[]) => rows.map((r) => pick(r, CHRONICLE_KEYS));

async function putPlain(engine: BrainEngine, slug: string, opts?: { sourceId?: string }) {
  return engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '' }, opts);
}

/** An event page the chronicle reads order by its effective_date. */
async function putEvent(engine: BrainEngine, slug: string, effective: string, event: { kind: string; who?: string[] }, opts?: { sourceId?: string }) {
  return engine.putPage(slug, {
    type: 'event', title: slug, compiled_truth: `${slug} body`, timeline: '',
    frontmatter: { event },
    effective_date: new Date(effective), effective_date_source: 'event_date',
  }, opts);
}

/** Depth pages + three events across three days; projections via upsertEventProjection. */
async function seedChronicle(engine: BrainEngine) {
  await putPlain(engine, 'life/diary/2026-06-18');
  await putPlain(engine, 'life/diary/2026-06-20');
  await putEvent(engine, 'life/events/2026-06-18-001', '2026-06-18T09:00:00Z', { kind: 'meeting', who: ['people/sarah-chen'] });
  await putEvent(engine, 'life/events/2026-06-18-002', '2026-06-18T15:00:00Z', { kind: 'commitment', who: ['people/sarah-chen'] });
  await putEvent(engine, 'life/events/2026-06-20-001', '2026-06-20T10:00:00Z', { kind: 'meeting', who: ['people/bob-jones'] });
  // Insert the later event first: reads must still order by effective_date.
  await engine.upsertEventProjection({ depthSlug: 'life/diary/2026-06-18', eventSlug: 'life/events/2026-06-18-002', date: '2026-06-18', summary: 'Promised the deck', detail: 'd2' });
  await engine.upsertEventProjection({ depthSlug: 'life/diary/2026-06-18', eventSlug: 'life/events/2026-06-18-001', date: '2026-06-18', summary: 'Met Sarah', detail: 'd1' });
  await engine.upsertEventProjection({ depthSlug: 'life/diary/2026-06-20', eventSlug: 'life/events/2026-06-20-001', date: '2026-06-20', summary: 'Call with Bob', detail: 'd3' });
}

describe('engine parity: timeline entries', () => {
  parityTest(
    'addTimelineEntry inserts, dedups on (date, summary) and reports whether a row was written',
    { methods: ['addTimelineEntry', 'getTimeline', 'putPage'] },
    async (engine) => {
      await putPlain(engine, 'people/alice');
      const first = await engine.addTimelineEntry('people/alice', { date: '2026-01-02', source: 'cal', summary: 'Joined Acme', detail: 'day one' });
      const dup = await engine.addTimelineEntry('people/alice', { date: '2026-01-02', source: 'cal', summary: 'Joined Acme', detail: 'day one' });
      const later = await engine.addTimelineEntry('people/alice', { date: '2026-03-04', summary: 'Promoted' });
      await engine.addTimelineEntry('people/alice', { date: '2025-12-31', source: 'note', summary: 'Interviewed', detail: 'phone screen' });
      expect(first).toBe(true);
      expect(dup).toBe(false);
      expect(later).toBe(true);
      let missingPage = 'no error';
      try {
        await engine.addTimelineEntry('people/nobody', { date: '2026-01-01', summary: 'ghost' });
      } catch (error) {
        missingPage = 'threw';
      }
      expect(missingPage).toBe('threw');
      const skipped = await engine.addTimelineEntry('people/nobody', { date: '2026-01-01', summary: 'ghost' }, { skipExistenceCheck: true });
      const entries = (await engine.getTimeline('people/alice')).map((e) => pick(e, ENTRY_KEYS));
      return { first, dup, later, missingPage, skipped, entries };
    },
  );

  parityTest(
    'getTimeline orders newest first and applies limit and the after/before window',
    { methods: ['getTimeline', 'addTimelineEntry', 'putPage'] },
    async (engine) => {
      await putPlain(engine, 'people/bob');
      for (const [date, summary] of [['2026-01-10', 'jan'], ['2026-02-10', 'feb'], ['2026-03-10', 'mar'], ['2026-04-10', 'apr']]) {
        await engine.addTimelineEntry('people/bob', { date: date!, summary: summary! });
      }
      const summaries = async (opts?: Parameters<BrainEngine['getTimeline']>[1]) => (await engine.getTimeline('people/bob', opts)).map((e) => e.summary);
      const all = await summaries();
      const limited = await summaries({ limit: 2 });
      const after = await summaries({ after: '2026-02-10' });
      const before = await summaries({ before: '2026-03-10' });
      const window = await summaries({ after: '2026-01-15', before: '2026-04-01' });
      const missing = await summaries({ sourceId: 'no-such-source' });
      expect(missing).toEqual([]);
      expect(await engine.getTimeline('people/nobody')).toEqual([]);
      return { all, limited, after, before, window, missing };
    },
  );

  parityTest(
    'addTimelineEntriesBatch counts inserted rows, drops missing pages and replays as no-ops',
    { methods: ['addTimelineEntriesBatch', 'getTimeline', 'putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'alt');
      await putPlain(engine, 'batch/one');
      await putPlain(engine, 'batch/two');
      await putPlain(engine, 'batch/one', { sourceId: 'alt' });
      const batch = [
        { slug: 'batch/one', date: '2026-05-01', summary: 'one-a', detail: 'x', source: 'import' },
        { slug: 'batch/one', date: '2026-05-02', summary: 'one-b' },
        { slug: 'batch/two', date: '2026-05-01', summary: 'two-a' },
        { slug: 'batch/missing', date: '2026-05-01', summary: 'ghost' },
        { slug: 'batch/one', date: '2026-05-03', summary: 'alt-only', source_id: 'alt' },
      ];
      const first = await engine.addTimelineEntriesBatch(batch);
      const replay = await engine.addTimelineEntriesBatch(batch);
      const empty = await engine.addTimelineEntriesBatch([]);
      expect(first).toBe(4);
      expect(replay).toBe(0);
      const one = (await engine.getTimeline('batch/one', { sourceId: 'default' })).map((e) => pick(e, ENTRY_KEYS));
      const alt = (await engine.getTimeline('batch/one', { sourceId: 'alt' })).map((e) => e.summary);
      const two = (await engine.getTimeline('batch/two')).map((e) => e.summary);
      return { first, replay, empty, one, alt, two };
    },
  );
});

describe('engine parity: chronicle reads and event projection', () => {
  parityTest(
    'upsertEventProjection updates in place on the same (event, date) and refuses missing pages',
    { methods: ['upsertEventProjection', 'getTimelineForDate', 'putPage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'alt');
      await putPlain(engine, 'life/diary/2026-06-01');
      await putEvent(engine, 'life/events/2026-06-01-standup', '2026-06-01T09:00:00Z', { kind: 'standup', who: ['people/alice'] });
      const base = { depthSlug: 'life/diary/2026-06-01', eventSlug: 'life/events/2026-06-01-standup', date: '2026-06-01' };
      const first = await engine.upsertEventProjection({ ...base, summary: 'Standup', detail: 'v1' });
      const again = await engine.upsertEventProjection({ ...base, summary: 'Standup (revised)', detail: 'v2' });
      const nextDay = await engine.upsertEventProjection({ ...base, date: '2026-06-02', summary: 'Standup follow-up' });
      const noDepth = await engine.upsertEventProjection({ ...base, depthSlug: 'life/diary/nope', summary: 'x' });
      const noEvent = await engine.upsertEventProjection({ ...base, eventSlug: 'life/events/nope', summary: 'x' });
      const wrongSource = await engine.upsertEventProjection({ ...base, summary: 'x', sourceId: 'alt' });
      expect([first, again, nextDay]).toEqual([{ projected: true }, { projected: true }, { projected: true }]);
      expect([noDepth, noEvent, wrongSource]).toEqual([{ projected: false }, { projected: false }, { projected: false }]);
      const day1 = chronicle(await engine.getTimelineForDate('2026-06-01'));
      const day2 = chronicle(await engine.getTimelineForDate('2026-06-02'));
      expect(day1).toHaveLength(1);
      return { first, again, nextDay, noDepth, noEvent, wrongSource, day1, day2 };
    },
  );

  parityTest(
    'getTimelineForDate returns one day or its ISO week, ordered by event effective_date',
    { methods: ['getTimelineForDate', 'upsertEventProjection', 'putPage'] },
    async (engine) => {
      await seedChronicle(engine);
      const day = chronicle(await engine.getTimelineForDate('2026-06-18'));
      const week = chronicle(await engine.getTimelineForDate('2026-06-18', { week: true }));
      const limited = chronicle(await engine.getTimelineForDate('2026-06-18', { limit: 1 }));
      const empty = await engine.getTimelineForDate('2026-06-19');
      const otherSource = await engine.getTimelineForDate('2026-06-18', { sourceId: 'no-such-source' });
      expect(day.map((r) => r.event_slug)).toEqual(['life/events/2026-06-18-001', 'life/events/2026-06-18-002']);
      expect(week.map((r) => r.date)).toEqual(['2026-06-18', '2026-06-18', '2026-06-20']);
      expect(empty).toEqual([]);
      expect(otherSource).toEqual([]);
      return { day, week, limited, empty, otherSource };
    },
  );

  parityTest(
    'getSince filters by lower-bound date and event kind',
    { methods: ['getSince', 'upsertEventProjection', 'putPage'] },
    async (engine) => {
      await seedChronicle(engine);
      const since19 = chronicle(await engine.getSince('2026-06-19'));
      const since18 = chronicle(await engine.getSince('2026-06-18'));
      const commitments = chronicle(await engine.getSince('2026-06-18', { kind: 'commitment' }));
      const meetings = chronicle(await engine.getSince('2026-06-01', { kind: 'meeting', limit: 1 }));
      const future = await engine.getSince('2030-01-01');
      expect(since19.map((r) => r.event_slug)).toEqual(['life/events/2026-06-20-001']);
      expect(commitments.map((r) => r.event_slug)).toEqual(['life/events/2026-06-18-002']);
      expect(future).toEqual([]);
      return { since19, since18, commitments, meetings, future };
    },
  );

  parityTest(
    'getOnThisDay returns the same month-day from prior years only',
    { methods: ['getOnThisDay', 'addTimelineEntry', 'putPage'] },
    async (engine) => {
      await putPlain(engine, 'life/diary/history');
      for (const [date, summary] of [
        ['2024-06-18', 'two years ago'], ['2025-06-18', 'last year'], ['2026-06-18', 'this year'],
        ['2025-06-19', 'wrong day'], ['2023-06-18', 'three years ago'],
      ]) await engine.addTimelineEntry('life/diary/history', { date: date!, source: 'diary', summary: summary! });
      const rows = chronicle(await engine.getOnThisDay({ date: '2026-06-18' }));
      const limited = chronicle(await engine.getOnThisDay({ date: '2026-06-18', limit: 2 }));
      const otherSource = await engine.getOnThisDay({ date: '2026-06-18', sourceId: 'no-such-source' });
      const noMatch = await engine.getOnThisDay({ date: '2026-12-25' });
      expect(rows.map((r) => r.date)).not.toContain('2026-06-18');
      expect(rows.map((r) => r.date)).not.toContain('2025-06-19');
      expect(otherSource).toEqual([]);
      expect(noMatch).toEqual([]);
      return { rows, limited, otherSource, noMatch };
    },
  );

  parityTest(
    'getLastSeen finds an entity via its own page or an event who, bounded by asof',
    { methods: ['getLastSeen', 'upsertEventProjection', 'addTimelineEntry', 'putPage'] },
    async (engine) => {
      await seedChronicle(engine);
      await putPlain(engine, 'people/own-page');
      await engine.addTimelineEntry('people/own-page', { date: '2026-06-10', summary: 'Own entry' });
      const viaEvent = await engine.getLastSeen('people/sarah-chen', { asof: '2026-06-25' });
      const viaOwn = await engine.getLastSeen('people/own-page', { asof: '2026-06-25' });
      const beforeLatest = await engine.getLastSeen('people/bob-jones', { asof: '2026-06-19' });
      const never = await engine.getLastSeen('people/nobody', { asof: '2026-06-25' });
      const otherSource = await engine.getLastSeen('people/sarah-chen', { asof: '2026-06-25', sourceId: 'no-such-source' });
      expect(viaEvent).toEqual({ entity_slug: 'people/sarah-chen', last_date: '2026-06-18', last_event_slug: 'life/events/2026-06-18-002', days_ago: 7 });
      expect(never.last_date).toBeNull();
      expect(never.days_ago).toBeNull();
      return { viaEvent, viaOwn, beforeLatest, never, otherSource };
    },
  );
});

describe('engine parity: ontology', () => {
  const SARAH = 'people/sarah-chen';
  const values = (rows: Awaited<ReturnType<BrainEngine['getOntology']>>) =>
    sorted(rows.map((r) => pick(r, ['dimension', 'value', 'confidence', 'source', 'valid_from', 'valid_to', 'status'])), (r) => r.dimension);
  const conflictView = (rows: OntologyConflict[]) =>
    rows.map((c) => ({ entity_slug: c.entity_slug, dimension: c.dimension, values: sorted(c.values.map((v) => `${v.value}|${v.source}|${v.confidence}`)) }));

  parityTest(
    'mergeOntologyFact inserts, dedups, corroborates and forward-supersedes; getOntology reads asof',
    { methods: ['mergeOntologyFact', 'getOntology'] },
    async (engine) => {
      const inserted = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01', confidence: 0.8 });
      const noop = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a', validFrom: '2024-01-01', confidence: 0.8 });
      const corroborated = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/b', validFrom: '2024-01-01' });
      const superseded = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'meetings/c', validFrom: '2026-05-01' });
      const alias = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'job_role', value: 'advisor', source: 'meetings/d', validFrom: '2026-05-01' });
      const actions = [inserted, noop, corroborated, superseded, alias].map((r) => ({ action: r.action, hasFact: r.factId !== null, hasSuperseded: r.supersededId !== null }));
      expect(actions.map((a) => a.action).slice(0, 4)).toEqual(['inserted', 'noop', 'corroborated', 'superseded_prior']);
      const now = values(await engine.getOntology(SARAH));
      const past = values(await engine.getOntology(SARAH, { asof: '2025-01-01' }));
      const beforeAll = values(await engine.getOntology(SARAH, { asof: '2020-01-01' }));
      const highConfidence = values(await engine.getOntology(SARAH, { minConfidence: 0.99 }));
      const unknown = await engine.getOntology('people/nobody');
      expect(now[0]).toMatchObject({ dimension: 'role', value: 'advisor' });
      expect(past[0]).toMatchObject({ dimension: 'role', value: 'founder' });
      expect(unknown).toEqual([]);
      return { actions, now, past, beforeAll, highConfidence, unknown };
    },
  );

  parityTest(
    'novel dimensions quarantine; includeQuarantined and visibility filters change what getOntology returns',
    { methods: ['mergeOntologyFact', 'getOntology'] },
    async (engine) => {
      const vibe = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'vibe', value: 'chaotic', source: 'meetings/a' });
      const explicit = await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'investor', source: 'meetings/a', status: 'quarantined' });
      await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'location', value: 'SF', source: 'meetings/b', visibility: 'private' });
      await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'employer', value: 'Acme', source: 'meetings/b', visibility: 'world' });
      const current = values(await engine.getOntology(SARAH));
      const withQuarantined = values(await engine.getOntology(SARAH, { includeQuarantined: true }));
      const worldOnly = values(await engine.getOntology(SARAH, { visibility: ['world'] }));
      const scoped = values(await engine.getOntology(SARAH, { sourceId: 'no-such-source' }));
      expect(current.map((r) => r.dimension)).not.toContain('vibe');
      expect(withQuarantined.find((r) => r.dimension === 'vibe')?.status).toBe('quarantined');
      return { vibe: vibe.action, explicit: explicit.action, current, withQuarantined, worldOnly, scoped };
    },
  );

  parityTest(
    'findOntologyConflicts surfaces a backdated disagreement but not a forward supersession',
    { methods: ['findOntologyConflicts', 'mergeOntologyFact'] },
    async (engine) => {
      // Forward supersession: not a conflict.
      await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'm/a', validFrom: '2024-01-01' });
      await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'advisor', source: 'm/b', validFrom: '2026-05-01' });
      // Backdated conflicting value: inserted without rewriting the prior, surfaces as a conflict.
      const bob = 'people/bob-jones';
      await engine.mergeOntologyFact({ entitySlug: bob, dimension: 'role', value: 'advisor', source: 'm/a', validFrom: '2026-05-01', confidence: 0.9 });
      const backdated = await engine.mergeOntologyFact({ entitySlug: bob, dimension: 'role', value: 'founder', source: 'm/b', validFrom: '2026-01-01', confidence: 0.6 });
      expect(backdated.action).toBe('inserted');
      const conflicts = conflictView(await engine.findOntologyConflicts());
      const confident = conflictView(await engine.findOntologyConflicts({ minConfidence: 0.8 }));
      const worldOnly = conflictView(await engine.findOntologyConflicts({ visibility: ['world'] }));
      const otherSource = conflictView(await engine.findOntologyConflicts({ sourceId: 'no-such-source' }));
      expect(conflicts.map((c) => c.entity_slug)).toEqual([bob]);
      expect(otherSource).toEqual([]);
      return { conflicts, confident, worldOnly, otherSource };
    },
  );

  parityTest(
    'discoverOntologyDimensions rolls up entities and observations per dimension',
    { methods: ['discoverOntologyDimensions', 'mergeOntologyFact'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'alt');
      await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'founder', source: 'meetings/a' });
      await engine.mergeOntologyFact({ entitySlug: 'people/bob-jones', dimension: 'role', value: 'advisor', source: 'meetings/b' });
      await engine.mergeOntologyFact({ entitySlug: 'people/bob-jones', dimension: 'employer', value: 'Acme', source: 'meetings/b' });
      await engine.mergeOntologyFact({ entitySlug: SARAH, dimension: 'role', value: 'partner', source: 'meetings/z', sourceId: 'alt' });
      const view = (rows: Awaited<ReturnType<BrainEngine['discoverOntologyDimensions']>>) => sorted(rows, (r) => r.dimension);
      const all = view(await engine.discoverOntologyDimensions());
      const defaultOnly = view(await engine.discoverOntologyDimensions({ sourceId: 'default' }));
      const federated = view(await engine.discoverOntologyDimensions({ sourceIds: ['alt'] }));
      const missing = await engine.discoverOntologyDimensions({ sourceId: 'no-such-source' });
      expect(defaultOnly.find((d) => d.dimension === 'role')?.entities).toBe(2);
      expect(missing).toEqual([]);
      return { all, defaultOnly, federated, missing };
    },
  );
});
