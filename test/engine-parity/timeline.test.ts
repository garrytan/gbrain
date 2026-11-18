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
import { withWriteAttribution } from '../../src/core/persistence/context.ts';
import type { WriteAttribution } from '../../src/core/persistence/attribution.ts';
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
    'getTimeline under excludePrivate drops every row of a hidden page and each projection of a hidden event page',
    { methods: ['getTimeline', 'addTimelineEntry', 'upsertEventProjection', 'putPage', 'softDeletePage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'alt');
      const page = (slug: string, frontmatter: Record<string, unknown>, opts?: { sourceId?: string }) =>
        engine.putPage(slug, { type: 'person', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter }, opts);
      await page('people/alice-example', {});
      await page('people/alice-example', { visibility: 'private' }, { sourceId: 'alt' });
      await page('people/private-example', { visibility: 'private' });
      await page('people/readers-example', { readable_by: ['alice-example'] });
      await page('people/alias-example', { access: 'Restricted' });
      const event = (slug: string, frontmatter: Record<string, unknown>) =>
        engine.putPage(slug, {
          type: 'event', title: slug, compiled_truth: `${slug} body`, timeline: '',
          frontmatter: { ...frontmatter, event: { kind: 'meeting', who: ['people/alice-example'] } },
          effective_date: new Date('2026-06-18T09:00:00Z'), effective_date_source: 'event_date',
        });
      await event('life/events/open', {});
      await event('life/events/private', { visibility: 'private' });
      await event('life/events/readers', { readable_by: ['alice-example'] });
      await event('life/events/alias', { access: 'Restricted' });
      await event('life/events/open-deleted', {});
      await event('life/events/private-deleted', { visibility: 'private' });
      for (const [eventSlug, summary] of [
        ['life/events/open', 'open event'], ['life/events/private', 'private event'], ['life/events/readers', 'event with readers'],
        ['life/events/alias', 'restricted event'], ['life/events/open-deleted', 'open event, deleted later'],
        ['life/events/private-deleted', 'private event, deleted later'],
      ] as const) {
        await engine.upsertEventProjection({ depthSlug: 'people/alice-example', eventSlug, date: '2026-06-18', summary });
      }
      await engine.softDeletePage('life/events/open-deleted');
      await engine.softDeletePage('life/events/private-deleted');
      await engine.addTimelineEntry('people/alice-example', { date: '2026-06-17', summary: 'plain' });
      await engine.addTimelineEntry('people/alice-example', { date: '2026-06-16', summary: 'alt plain' }, { sourceId: 'alt' });
      for (const slug of ['people/private-example', 'people/readers-example', 'people/alias-example']) {
        await engine.addTimelineEntry(slug, { date: '2026-06-15', summary: `${slug} plain` });
      }
      const summaries = async (slug: string, opts?: Parameters<BrainEngine['getTimeline']>[1]) =>
        (await engine.getTimeline(slug, opts)).map((e) => `${new Date(e.date).toISOString().slice(0, 10)} ${e.summary}`);
      const all = await summaries('people/alice-example');
      const kept = await summaries('people/alice-example', { excludePrivate: true });
      const keptDefault = await summaries('people/alice-example', { sourceId: 'default', excludePrivate: true });
      const keptAlt = await summaries('people/alice-example', { sourceIds: ['alt'], excludePrivate: true });
      const keptLimited = await summaries('people/alice-example', { limit: 2, excludePrivate: true });
      const keptWindow = await summaries('people/alice-example', { after: '2026-06-17', before: '2026-06-18', excludePrivate: true });
      const hidden: Record<string, string[]> = {};
      for (const slug of ['people/private-example', 'people/readers-example', 'people/alias-example']) {
        hidden[slug] = await summaries(slug, { excludePrivate: true });
      }
      expect(all.length).toBe(8);
      // The event test reads the event page by id whatever its deleted state, as the SQL EXISTS does.
      expect(kept).toEqual(['2026-06-18 open event, deleted later', '2026-06-18 open event', '2026-06-17 plain']);
      expect(keptDefault).toEqual(kept);
      expect(keptAlt).toEqual([]);
      expect(Object.values(hidden)).toEqual([[], [], []]);
      return { all, kept, keptDefault, keptAlt, keptLimited, keptWindow, hidden };
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

  parityTest(
    'removeTimelineRows deletes only the rows that still match field for field, never an event projection or another page, and reports each deleted date',
    { methods: ['removeTimelineRows', 'listStoredTimelineRows', 'getTimeline', 'addTimelineEntry', 'upsertEventProjection', 'putPage', 'getPage'] },
    async (engine) => {
      await putPlain(engine, 'people/prune');
      await putPlain(engine, 'people/prune-other');
      await putEvent(engine, 'life/events/2026-07-01-001', '2026-07-01T09:00:00Z', { kind: 'meeting' });
      const pageId = Number((await engine.getPage('people/prune'))!.id);
      const otherId = Number((await engine.getPage('people/prune-other'))!.id);
      await engine.addTimelineEntry('people/prune', { date: '2026-01-02', source: 'cal', summary: 'drop me', detail: 'd1' });
      await engine.addTimelineEntry('people/prune', { date: '2026-02-03', source: 'cal', summary: 'edited since', detail: 'old text' });
      await engine.addTimelineEntry('people/prune', { date: '2026-03-04', source: 'note', summary: 'dropped but not removed', detail: '' });
      await engine.addTimelineEntry('people/prune', { date: '2026-04-05', source: 'note', summary: 'null source', detail: 'd4' });
      await engine.addTimelineEntry('people/prune', { date: '2026-05-06', source: 'note', summary: 'keep me', detail: 'd5' });
      await engine.addTimelineEntry('people/prune-other', { date: '2026-01-02', source: 'cal', summary: 'other page', detail: 'o1' });
      await engine.upsertEventProjection({ depthSlug: 'people/prune', eventSlug: 'life/events/2026-07-01-001', date: '2026-07-01', summary: 'Event row', detail: 'e1' });
      const stored = async (slug: string) => await engine.listStoredTimelineRows('default', slug);
      const idOf = async (slug: string, summary: string) => (await stored(slug)).find((r) => r.summary === summary)!.id;
      const event = (await engine.getTimeline('people/prune')).find((e) => e.summary === 'Event row')!;
      const row = async (summary: string, over: Record<string, unknown> = {}) => {
        const found = (await stored('people/prune')).find((r) => r.summary === summary)!;
        return { id: found.id, date: found.date, source: found.source, summary: found.summary, detail: found.detail ?? '', removed: false, ...over };
      };
      const attempt = await engine.removeTimelineRows(pageId, [
        await row('drop me', { removed: true }),
        await row('edited since', { detail: 'older text', removed: true }),
        await row('dropped but not removed'),
        await row('null source', { source: null }),
        { id: Number(event.id), date: '2026-07-01', source: event.source, summary: 'Event row', detail: 'e1', removed: true },
        { id: await idOf('people/prune-other', 'other page'), date: '2026-01-02', source: 'cal', summary: 'other page', detail: 'o1', removed: true },
        { id: 987654, date: '2026-01-02', source: 'cal', summary: 'never stored', detail: '', removed: true },
      ] as never);
      const left = async () => ({
        rows: (await stored('people/prune')).map((r) => r.summary).sort(),
        other: (await stored('people/prune-other')).map((r) => r.summary),
        event: (await engine.getTimeline('people/prune')).filter((e) => e.summary === 'Event row').length,
      });
      const afterAttempt = await left();
      const none = await engine.removeTimelineRows(pageId, []);
      const wrongPage = await engine.removeTimelineRows(otherId, [await row('keep me', { removed: true })]);
      // A removed row frees its dedup slot: the same entry can be added again.
      const readded = await engine.addTimelineEntry('people/prune', { date: '2026-01-02', source: 'cal', summary: 'drop me', detail: 'd1' });
      const duplicated = await engine.removeTimelineRows(pageId, [await row('keep me', { removed: true }), await row('keep me', { removed: true })]);
      const answers = { attempt, afterAttempt, none, wrongPage, readded, duplicated, final: await left() };
      expect(attempt.map((r) => r.date).sort()).toEqual(['2026-01-02', '2026-03-04']);
      expect(afterAttempt.event).toBe(1);
      expect(duplicated).toHaveLength(1);
      return answers;
    },
  );

  parityTest(
    'removeTimelineRows reads dates as dates and keeps the page order of the deleted rows',
    { methods: ['removeTimelineRows', 'listStoredTimelineRows', 'addTimelineEntry', 'putPage', 'getPage'] },
    async (engine) => {
      await putPlain(engine, 'people/prune-dates');
      const pageId = Number((await engine.getPage('people/prune-dates'))!.id);
      for (const [date, summary] of [['2026-09-03', 'c'], ['2026-09-01', 'a'], ['2026-09-02', 'b']]) {
        await engine.addTimelineEntry('people/prune-dates', { date: date!, source: 's', summary: summary!, detail: summary! });
      }
      const rows = await engine.listStoredTimelineRows('default', 'people/prune-dates');
      const byId = [...rows].sort((x, y) => x.id - y.id);
      // The recordset gives the date as another spelling Postgres casts to the same day, and names the rows out of order.
      const asks = [byId[2]!, byId[0]!, byId[1]!].map((r) => ({ id: r.id, date: r.date.replace(/-/g, '/'), source: r.source, summary: r.summary, detail: r.detail ?? '', removed: r.summary !== 'b' }));
      const removed = await engine.removeTimelineRows(pageId, asks);
      const left = (await engine.listStoredTimelineRows('default', 'people/prune-dates')).length;
      expect(left).toBe(0);
      return { removed: removed.map((r) => `${r.date}:${r.removed}`), left };
    },
  );

  parityTest(
    'updateTimelineDetails rewrites a detail only while the stored one is still the preimage, on the page own rows',
    { methods: ['updateTimelineDetails', 'listStoredTimelineRows', 'getTimeline', 'addTimelineEntry', 'upsertEventProjection', 'putPage', 'getPage'] },
    async (engine) => {
      await putPlain(engine, 'people/refresh');
      await putPlain(engine, 'people/refresh-other');
      await putEvent(engine, 'life/events/2026-07-02-001', '2026-07-02T09:00:00Z', { kind: 'meeting' });
      const pageId = Number((await engine.getPage('people/refresh'))!.id);
      for (const [summary, detail] of [['refresh me', 'before'], ['edited since', 'changed'], ['same text', 'same'], ['clear me', 'to clear'], ['first of two', 'twin']]) {
        await engine.addTimelineEntry('people/refresh', { date: '2026-02-03', source: 'cal', summary: summary!, detail: detail! });
      }
      await engine.addTimelineEntry('people/refresh-other', { date: '2026-02-03', source: 'cal', summary: 'other page', detail: 'before' });
      await engine.upsertEventProjection({ depthSlug: 'people/refresh', eventSlug: 'life/events/2026-07-02-001', date: '2026-07-02', summary: 'Event row', detail: 'before' });
      const stored = async (slug: string) => engine.listStoredTimelineRows('default', slug);
      const idOf = async (slug: string, summary: string) => (await stored(slug)).find((r) => r.summary === summary)!.id;
      const event = (await engine.getTimeline('people/refresh')).find((e) => e.summary === 'Event row')!;
      await engine.updateTimelineDetails(pageId, [
        { id: await idOf('people/refresh', 'refresh me'), detail: 'before', next: 'after' },
        { id: await idOf('people/refresh', 'edited since'), detail: 'earlier text', next: 'never written' },
        { id: await idOf('people/refresh', 'same text'), detail: 'same', next: 'same' },
        { id: await idOf('people/refresh', 'first of two'), detail: 'twin', next: 'first answer' },
        { id: await idOf('people/refresh', 'first of two'), detail: 'twin', next: 'second answer' },
        { id: await idOf('people/refresh-other', 'other page'), detail: 'before', next: 'moved' },
        { id: Number(event.id), detail: 'before', next: 'moved' },
        { id: 987654, detail: 'before', next: 'moved' },
      ]);
      await engine.updateTimelineDetails(pageId, []);
      const details = async (slug: string) => (await stored(slug)).map((r) => `${r.summary}=${r.detail}`).sort();
      const answers = {
        own: await details('people/refresh'), other: await details('people/refresh-other'),
        event: (await engine.getTimeline('people/refresh')).filter((e) => e.summary === 'Event row').map((e) => e.detail),
      };
      // A refresh that writes the same detail twice in one call, and the entry stays findable by date.
      expect(answers.own).toContain('refresh me=after');
      expect(answers.own).toContain('edited since=changed');
      expect(answers.event).toEqual(['before']);
      return answers;
    },
  );
});

/**
 * Timeline write receipts (persistence/attribution-schema.ts `gbrain_stamp_write_attribution`): an insert under a
 * principal stamps `write_*` and `last_*` with the request and the principal; an update keeps `write_*` and moves
 * `last_*` (and `last_written_at`) only when the row's content changed. Request ids are fixed text, so they compare
 * as values; `last_written_at` compares as a shape and as "moved or not".
 */
const RECEIPT_KEYS = [
  'write_request_id', 'write_principal_kind', 'write_principal_id',
  'last_write_request_id', 'last_write_principal_kind', 'last_write_principal_id',
] as const;
const REQUEST_A = '0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e01';
const REQUEST_B = '0b9c4f0e-1a2b-4c3d-8e4f-5a6b7c8d9e02';
const asActor = (requestId: string | null, kind: WriteAttribution['principal']['kind'], id: string): WriteAttribution =>
  ({ requestId, principal: { kind, id } });
/** Runs `fn` in one transaction under `attribution` (none: no principal set). */
async function attributed<T>(engine: BrainEngine, attribution: WriteAttribution | null, fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
  return engine.transaction(async (tx) => (attribution ? withWriteAttribution(tx, attribution, () => fn(tx)) : fn(tx)));
}
type Receipted = Record<string, unknown>;
const receiptOf = (entry: Receipted) => ({
  summary: entry.summary, ...pick(entry, RECEIPT_KEYS),
  last_written_at: entry.last_written_at === null ? null : entry.last_written_at instanceof Date ? 'Date' : typeof entry.last_written_at,
});
async function receipts(engine: BrainEngine, slug: string) {
  return ((await engine.getTimeline(slug)) as unknown as Receipted[]).map(receiptOf).sort((a, b) => String(a.summary).localeCompare(String(b.summary)));
}
const writtenAt = async (engine: BrainEngine, slug: string) => new Map(((await engine.getTimeline(slug)) as unknown as Receipted[])
  .map((e) => [String(e.summary), e.last_written_at instanceof Date ? e.last_written_at.getTime() : e.last_written_at]));

describe('engine parity: timeline write receipts', () => {
  parityTest(
    'a timeline insert under a principal stamps write_* and last_* with its request and principal, on every insert path',
    { methods: ['transaction', 'readTransactionSettings', 'applyTransactionSettings', 'addTimelineEntry', 'addTimelineEntriesBatch', 'upsertEventProjection', 'getTimeline', 'putPage'] },
    async (engine) => {
      await putPlain(engine, 'people/receipt');
      await putEvent(engine, 'life/events/2026-08-01-001', '2026-08-01T09:00:00Z', { kind: 'meeting' });
      await attributed(engine, asActor(REQUEST_A, 'application', 'host:test-a'), async (tx) => {
        await tx.addTimelineEntry('people/receipt', { date: '2026-08-01', source: 'cal', summary: 'single add', detail: 'one' });
        await tx.addTimelineEntriesBatch([{ slug: 'people/receipt', date: '2026-08-02', source: 'cal', summary: 'batch add', detail: 'two' }]);
        await tx.upsertEventProjection({ depthSlug: 'people/receipt', eventSlug: 'life/events/2026-08-01-001', date: '2026-08-01', summary: 'projected', detail: 'three' });
      });
      // A maintenance actor with no journal request: the request columns stay null, the principal is stamped.
      await attributed(engine, asActor(null, 'application', 'host:unregistered'), (tx) =>
        tx.addTimelineEntry('people/receipt', { date: '2026-08-03', summary: 'maintenance add' }));
      const rows = await receipts(engine, 'people/receipt');
      expect(rows.find((r) => r.summary === 'single add')).toMatchObject({ write_principal_id: 'host:test-a', last_write_request_id: REQUEST_A, last_written_at: 'Date' });
      expect(rows.find((r) => r.summary === 'maintenance add')).toMatchObject({ write_request_id: null, write_principal_kind: 'application', last_written_at: 'Date' });
      return rows;
    },
  );

  parityTest(
    'a timeline insert with no principal leaves every receipt column null',
    { methods: ['transaction', 'addTimelineEntry', 'addTimelineEntriesBatch', 'upsertEventProjection', 'getTimeline', 'putPage'] },
    async (engine) => {
      await putPlain(engine, 'people/unreceipted');
      await putEvent(engine, 'life/events/2026-08-04-001', '2026-08-04T09:00:00Z', { kind: 'meeting' });
      await engine.addTimelineEntry('people/unreceipted', { date: '2026-08-04', summary: 'plain add' });
      await attributed(engine, null, async (tx) => {
        await tx.addTimelineEntriesBatch([{ slug: 'people/unreceipted', date: '2026-08-05', summary: 'plain batch' }]);
        await tx.upsertEventProjection({ depthSlug: 'people/unreceipted', eventSlug: 'life/events/2026-08-04-001', date: '2026-08-04', summary: 'plain projection' });
      });
      const rows = await receipts(engine, 'people/unreceipted');
      for (const row of rows) expect(Object.values(pick(row, [...RECEIPT_KEYS, 'last_written_at']))).toEqual([null, null, null, null, null, null, null]);
      return rows;
    },
  );

  parityTest(
    'a timeline update keeps write_* and moves last_* and last_written_at only when the content changed',
    { methods: ['transaction', 'readTransactionSettings', 'applyTransactionSettings', 'addTimelineEntry', 'updateTimelineDetails', 'upsertEventProjection', 'listStoredTimelineRows', 'getTimeline', 'getPage', 'putPage'] },
    async (engine) => {
      await putPlain(engine, 'people/rewrite');
      await putEvent(engine, 'life/events/2026-08-06-001', '2026-08-06T09:00:00Z', { kind: 'meeting' });
      const pageId = Number((await engine.getPage('people/rewrite'))!.id);
      const first = asActor(REQUEST_A, 'application', 'host:test-a');
      const second = asActor(REQUEST_B, 'oauth_client', 'client:test-b');
      await attributed(engine, first, async (tx) => {
        await tx.addTimelineEntry('people/rewrite', { date: '2026-08-06', summary: 'detail moves', detail: 'before' });
        await tx.addTimelineEntry('people/rewrite', { date: '2026-08-06', summary: 'detail stays', detail: 'same' });
        await tx.addTimelineEntry('people/rewrite', { date: '2026-08-06', summary: 'unattributed edit', detail: 'before' });
        await tx.upsertEventProjection({ depthSlug: 'people/rewrite', eventSlug: 'life/events/2026-08-06-001', date: '2026-08-06', summary: 'projection', detail: 'before' });
      });
      const before = await writtenAt(engine, 'people/rewrite');
      const idOf = async (summary: string) => (await engine.listStoredTimelineRows('default', 'people/rewrite')).find((r) => r.summary === summary)!.id;
      const refresh = [
        { id: await idOf('detail moves'), detail: 'before', next: 'after' },
        { id: await idOf('detail stays'), detail: 'same', next: 'same' },
      ];
      const unattributed = await idOf('unattributed edit');
      await attributed(engine, second, async (tx) => {
        await tx.updateTimelineDetails(pageId, refresh);
        // The same projection again changes nothing; then a new detail moves it.
        await tx.upsertEventProjection({ depthSlug: 'people/rewrite', eventSlug: 'life/events/2026-08-06-001', date: '2026-08-06', summary: 'projection', detail: 'before' });
      });
      const afterSame = await writtenAt(engine, 'people/rewrite');
      const projectionKept = afterSame.get('projection') === before.get('projection');
      await attributed(engine, second, (tx) =>
        tx.upsertEventProjection({ depthSlug: 'people/rewrite', eventSlug: 'life/events/2026-08-06-001', date: '2026-08-06', summary: 'projection', detail: 'after' }));
      // An edit with no principal clears last_* and still moves last_written_at.
      await engine.updateTimelineDetails(pageId, [{ id: unattributed, detail: 'before', next: 'after' }]);
      const after = await writtenAt(engine, 'people/rewrite');
      // Two transactions can share a millisecond, so a moved time compares as not older; a kept one as equal.
      const kept = after.get('detail stays') === before.get('detail stays');
      const notOlder = [...before.keys()].every((k) => Number(after.get(k)) >= Number(before.get(k)));
      const rows = await receipts(engine, 'people/rewrite');
      expect(rows.find((r) => r.summary === 'detail moves')).toMatchObject({ write_request_id: REQUEST_A, last_write_request_id: REQUEST_B, last_write_principal_id: 'client:test-b' });
      expect(rows.find((r) => r.summary === 'detail stays')).toMatchObject({ write_request_id: REQUEST_A, last_write_request_id: REQUEST_A });
      expect(rows.find((r) => r.summary === 'unattributed edit')).toMatchObject({ write_principal_id: 'host:test-a', last_write_principal_kind: null, last_written_at: 'Date' });
      expect({ projectionKept, kept, notOlder }).toEqual({ projectionKept: true, kept: true, notOlder: true });
      return { rows, projectionKept, kept, notOlder };
    },
  );

  parityTest(
    'a write request that is not a UUID is kept by the setting and refuses the timeline write that reads it',
    { methods: ['transaction', 'applyTransactionSettings', 'readTransactionSettings', 'addTimelineEntry', 'getTimeline', 'putPage'] },
    async (engine) => {
      await putPlain(engine, 'people/bad-request');
      const names = ['gbrain.write_request', 'gbrain.write_principal_kind', 'gbrain.write_principal_id'];
      let kept: Array<string | null> = [];
      const outcome = await engine.transaction(async (tx) => {
        await tx.applyTransactionSettings(names, ['req-1', 'application', 'host:test-a']);
        kept = await tx.readTransactionSettings(names);
        await tx.addTimelineEntry('people/bad-request', { date: '2026-08-09', summary: 'refused add' });
      }).then(() => 'written', () => 'refused');
      return { kept, outcome, rows: (await engine.getTimeline('people/bad-request')).length };
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

describe('engine parity: excludePrivate on the chronicle reads', () => {
  /**
   * Depth pages and event pages for each rule of the page policy (`privatePagesFilterForCaller`), in `default`, and a
   * private depth page in `alt`. Under `excludePrivate` a row drops when its depth page is hidden, or when it projects
   * an event page that is hidden (`privateTimelineEventFilterForCaller`).
   */
  async function seedPrivacy(engine: BrainEngine, backend: Parameters<typeof createSource>[1]) {
    await createSource(engine, backend, 'alt');
    const depth = (slug: string, frontmatter: Record<string, unknown>, opts?: { sourceId?: string }) =>
      engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter }, opts);
    await depth('life/diary/open', {});
    await depth('life/diary/private', { visibility: 'private' });
    await depth('life/diary/readers', { readable_by: ['alice-example'] });
    await depth('life/diary/alias', { access: 'Restricted' });
    await depth('life/diary/alt-private', { visibility: 'private' }, { sourceId: 'alt' });
    await depth('life/diary/alt-open', {}, { sourceId: 'alt' });
    const event = (slug: string, effective: string, frontmatter: Record<string, unknown>, opts?: { sourceId?: string }) =>
      engine.putPage(slug, {
        type: 'event', title: slug, compiled_truth: `${slug} body`, timeline: '', frontmatter,
        effective_date: new Date(effective), effective_date_source: 'event_date',
      }, opts);
    const who = (kind: string, names: string[]) => ({ kind, who: names });
    await event('life/events/open-1', '2026-06-18T09:00:00Z', { event: who('meeting', ['people/alice-example']) });
    await event('life/events/private-1', '2026-06-19T09:00:00Z', { visibility: 'private', event: who('meeting', ['people/alice-example']) });
    await event('life/events/readers-1', '2026-06-18T11:00:00Z', { readable_by: ['alice-example'], event: who('commitment', ['people/charlie-example']) });
    await event('life/events/origin-private', '2026-06-18T12:00:00Z', {
      visibility: 'world', captured_via: 'life-chronicle:test', event: { kind: 'meeting', depth: 'life/diary/private', who: ['people/charlie-example'] },
    });
    await event('life/events/open-2', '2026-06-18T13:00:00Z', { event: who('meeting', ['people/charlie-example']) });
    await event('life/events/open-3', '2026-06-18T14:00:00Z', { event: who('commitment', ['people/charlie-example']) });
    await event('life/events/alt-1', '2026-06-18T15:00:00Z', { event: who('meeting', ['people/alice-example']) }, { sourceId: 'alt' });
    const project = (depthSlug: string, eventSlug: string, date: string, summary: string, sourceId?: string) =>
      engine.upsertEventProjection({ depthSlug, eventSlug, date, summary, ...(sourceId ? { sourceId } : {}) });
    await project('life/diary/open', 'life/events/open-1', '2026-06-18', 'open depth, open event');
    await project('life/diary/open', 'life/events/private-1', '2026-06-19', 'open depth, private event');
    await project('life/diary/open', 'life/events/readers-1', '2026-06-18', 'open depth, event with readers');
    await project('life/diary/open', 'life/events/origin-private', '2026-06-18', 'open depth, event from a private origin');
    await project('life/diary/private', 'life/events/open-2', '2026-06-18', 'private depth, open event');
    await project('life/diary/readers', 'life/events/open-3', '2026-06-18', 'depth with readers, open event');
    await project('life/diary/alt-private', 'life/events/alt-1', '2026-06-18', 'alt private depth', 'alt');
    for (const [slug, date, summary, sourceId] of [
      ['life/diary/open', '2026-06-18', 'open plain', undefined], ['life/diary/alias', '2026-06-18', 'alias plain', undefined],
      ['life/diary/open', '2025-06-18', 'open last year', undefined], ['life/diary/private', '2025-06-18', 'private last year', undefined],
      ['life/diary/alt-open', '2026-06-18', 'alt open plain', 'alt'], ['life/diary/alt-private', '2025-06-18', 'alt private last year', 'alt'],
    ] as const) {
      await engine.addTimelineEntry(slug, { date, source: 'diary', summary }, sourceId ? { sourceId } : undefined);
    }
    await engine.putPage('people/hidden-person', { type: 'person', title: 'Hidden', compiled_truth: 'Hidden.', timeline: '', frontmatter: { visibility: 'private' } });
    await engine.addTimelineEntry('people/hidden-person', { date: '2026-06-17', source: 'diary', summary: 'hidden own entry' });
  }

  const summaries = (rows: Pick<ChronicleTimelineRow, 'date' | 'summary'>[]) => rows.map((r) => `${r.date} ${r.summary}`);

  parityTest(
    'getTimelineForDate, getSince and getOnThisDay drop rows whose depth page or event page excludePrivate hides',
    { methods: ['putPage', 'upsertEventProjection', 'addTimelineEntry', 'getTimelineForDate', 'getSince', 'getOnThisDay'] },
    async (engine, backend) => {
      await seedPrivacy(engine, backend);
      const day = chronicle(await engine.getTimelineForDate('2026-06-18'));
      const dayKept = chronicle(await engine.getTimelineForDate('2026-06-18', { excludePrivate: true }));
      const weekKept = chronicle(await engine.getTimelineForDate('2026-06-18', { week: true, excludePrivate: true }));
      const dayScoped = chronicle(await engine.getTimelineForDate('2026-06-18', { sourceId: 'default', excludePrivate: true }));
      const dayAlt = chronicle(await engine.getTimelineForDate('2026-06-18', { sourceIds: ['alt'], excludePrivate: true }));
      const dayLimited = chronicle(await engine.getTimelineForDate('2026-06-18', { limit: 1, excludePrivate: true }));
      const since = chronicle(await engine.getSince('2026-06-18'));
      const sinceKept = chronicle(await engine.getSince('2026-06-18', { excludePrivate: true }));
      const sinceMeetings = chronicle(await engine.getSince('2026-06-18', { kind: 'meeting', excludePrivate: true }));
      const onThisDay = chronicle(await engine.getOnThisDay({ date: '2026-06-18' }));
      const onThisDayKept = chronicle(await engine.getOnThisDay({ date: '2026-06-18', excludePrivate: true }));
      const onThisDayAlt = chronicle(await engine.getOnThisDay({ date: '2026-06-18', sourceId: 'alt', excludePrivate: true }));
      expect(summaries(dayKept)).toEqual(['2026-06-18 open plain', '2026-06-18 alt open plain', '2026-06-18 open depth, open event']);
      expect(summaries(day).length).toBe(9);
      expect(summaries(sinceKept)).toEqual(summaries(dayKept));
      expect(summaries(onThisDayKept)).toEqual(['2025-06-18 open last year']);
      expect(onThisDayAlt).toEqual([]);
      return { day, dayKept, weekKept, dayScoped, dayAlt, dayLimited, since, sinceKept, sinceMeetings, onThisDay, onThisDayKept, onThisDayAlt };
    },
  );

  parityTest(
    'getLastSeen skips sightings whose depth page or event page excludePrivate hides',
    { methods: ['putPage', 'upsertEventProjection', 'addTimelineEntry', 'getLastSeen'] },
    async (engine, backend) => {
      await seedPrivacy(engine, backend);
      const asof = '2026-06-25';
      const alice = await engine.getLastSeen('people/alice-example', { asof });
      const aliceKept = await engine.getLastSeen('people/alice-example', { asof, excludePrivate: true });
      const aliceDefault = await engine.getLastSeen('people/alice-example', { asof, sourceId: 'default', excludePrivate: true });
      const aliceAlt = await engine.getLastSeen('people/alice-example', { asof, sourceIds: ['alt'], excludePrivate: true });
      const charlie = await engine.getLastSeen('people/charlie-example', { asof });
      const charlieKept = await engine.getLastSeen('people/charlie-example', { asof, excludePrivate: true });
      const hidden = await engine.getLastSeen('people/hidden-person', { asof });
      const hiddenKept = await engine.getLastSeen('people/hidden-person', { asof, excludePrivate: true });
      expect(alice.last_event_slug).toBe('life/events/private-1');
      expect(aliceKept).toEqual({ entity_slug: 'people/alice-example', last_date: '2026-06-18', last_event_slug: 'life/events/open-1', days_ago: 7 });
      expect(charlieKept.last_date).toBeNull();
      expect(hiddenKept.last_date).toBeNull();
      return { alice, aliceKept, aliceDefault, aliceAlt, charlie, charlieKept, hidden, hiddenKept };
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

  parityTest(
    'getOntology and findOntologyConflicts drop rows whose provenance or entity page excludePrivate hides',
    { methods: ['putPage', 'mergeOntologyFact', 'getOntology', 'findOntologyConflicts'] },
    async (engine) => {
      const pages: Array<[string, string, Record<string, unknown>]> = [
        ['notes/open', 'note', {}],
        ['notes/private', 'note', { visibility: 'private' }],
        ['notes/readers', 'note', { readable_by: ['alice-example'] }],
        ['notes/alias', 'note', { confidentiality: ' Secret\t' }],
        ['atoms/origin-private', 'atom', { visibility: 'world', source_slug: 'notes/private' }],
        ['notes/lineage', 'note', { derived_from: 'notes/open.md' }],
        ['people/hidden-entity', 'person', { visibility: 'private' }],
      ];
      for (const [slug, type, frontmatter] of pages) {
        await engine.putPage(slug, { type: type as never, title: slug, compiled_truth: `About ${slug}.`, timeline: '', frontmatter });
      }
      const merge = (entitySlug: string, dimension: string, value: string, source: string, validFrom: string) =>
        engine.mergeOntologyFact({ entitySlug, dimension, value, source, validFrom, visibility: 'world' });
      // The newest role is on a private page; the read under excludePrivate falls back to the older visible one.
      await merge(SARAH, 'role', 'founder', 'notes/private', '2024-06-01');
      await merge(SARAH, 'role', 'advisor', 'notes/open', '2024-01-01');
      await merge(SARAH, 'employer', 'Acme', 'notes/readers', '2025-01-01');
      await merge(SARAH, 'location', 'SF', 'notes/alias', '2025-01-01');
      await merge(SARAH, 'expertise', 'fintech', 'atoms/origin-private', '2025-01-01');
      await merge(SARAH, 'relation', 'friend', 'notes/open', '2025-01-01');
      await merge('people/hidden-entity', 'role', 'cto', 'notes/open', '2025-01-01');
      const bob = 'people/bob-jones';
      await merge(bob, 'role', 'advisor', 'notes/open', '2026-05-01');
      await merge(bob, 'role', 'founder', 'notes/private', '2026-01-01');
      await merge(bob, 'employer', 'Acme', 'notes/open', '2026-05-01');
      await merge(bob, 'employer', 'Widget', 'notes/readers', '2026-01-01');
      await merge(bob, 'expertise', 'search', 'notes/open', '2026-05-01');
      await merge(bob, 'expertise', 'ranking', 'atoms/origin-private', '2026-01-01');
      await merge(bob, 'location', 'NYC', 'notes/open', '2026-05-01');
      await merge(bob, 'location', 'LA', 'notes/alias', '2026-01-01');
      await merge(bob, 'relation', 'peer', 'notes/open', '2026-05-01');
      await merge(bob, 'relation', 'mentor', 'notes/lineage', '2026-01-01');
      const all = values(await engine.getOntology(SARAH));
      const kept = values(await engine.getOntology(SARAH, { excludePrivate: true }));
      const hiddenEntity = values(await engine.getOntology('people/hidden-entity', { excludePrivate: true }));
      const conflicts = conflictView(await engine.findOntologyConflicts());
      const conflictsKept = conflictView(await engine.findOntologyConflicts({ excludePrivate: true }));
      expect(all.map((r) => `${r.dimension}=${r.value}`)).toEqual(['employer=Acme', 'expertise=fintech', 'location=SF', 'relation=friend', 'role=founder']);
      expect(kept.map((r) => `${r.dimension}=${r.value}`)).toEqual(['relation=friend', 'role=advisor']);
      expect(hiddenEntity).toEqual([]);
      expect(conflicts.map((c) => c.dimension)).toEqual(['employer', 'expertise', 'location', 'relation', 'role', 'role']);
      expect(conflictsKept.map((c) => c.dimension)).toEqual(['relation']);
      return { all, kept, hiddenEntity, conflicts, conflictsKept };
    },
  );
});
