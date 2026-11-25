/**
 * BrainEngine parity: the timeline reads and delete of engine-sql/timeline-reads.ts, which doctor
 * (effective_date_health, timeline_history), the canonical projection, `gbrain repair timeline` and
 * `extract timeline --prune-orphans` used to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres
 *    with DATABASE_URL; the Rust arm through test/engine-parity/harness.ts): the effective-date
 *    sample counts and fallback rows, the largest entry id, a page's own rows in date order, the
 *    rows a projection delete removes, the batched own-row read, the segmented residual, the
 *    comment-markup count and the orphan prune's page walk.
 *  - Regression: an engine whose read drifts gives a different doctor finding, a projection that
 *    keeps or drops the wrong row, a repair plan with a different residual or markup count, or a
 *    prune that skips or revisits a page.
 *  - Why existing coverage misses it: the caller tests run these statements on PGLite only and
 *    never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw). Page and entry ids are serial and
 *    engine-dependent, so every case maps them to slugs or to their offset from the first id.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { EffectiveDateSource, PageInput } from '../../src/core/types.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pageMeta } from '../helpers/page-body-fixtures.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { createSource, parityArms, sorted } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const YEAR_MS = 365 * 24 * 3600 * 1000;

function page(title: string, extra: Partial<PageInput> = {}): PageInput {
  return { type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra };
}

async function dated(engine: BrainEngine, slug: string, date: Date | null, source: EffectiveDateSource | null, frontmatter: Record<string, unknown> = {}) {
  return engine.putPage(slug, page(slug, { frontmatter, effective_date: date, effective_date_source: source }));
}

describe('engine parity: timeline reads', () => {
  parityTest(
    'sampleEffectiveDates and sampleEffectiveDateSources read the newest pages, soft-deleted ones included',
    { methods: ['putPage', 'softDeletePage', 'sampleEffectiveDates', 'sampleEffectiveDateSources'] },
    async (engine) => {
      const empty = { counts: await engine.sampleEffectiveDates(), rows: await engine.sampleEffectiveDateSources() };
      const now = Date.now();
      await dated(engine, 'notes/far-future', new Date(now + 2 * YEAR_MS), 'date');
      await dated(engine, 'notes/near-future', new Date(now + YEAR_MS / 2), 'date');
      await dated(engine, 'notes/old-inferred', new Date('1980-05-01T00:00:00Z'), 'filename');
      await dated(engine, 'notes/old-explicit', new Date('1975-01-01T00:00:00Z'), 'event_date');
      await dated(engine, 'notes/old-created', new Date('1985-01-01T00:00:00Z'), 'created');
      await dated(engine, 'notes/at-1990', new Date('1990-01-01T00:00:00Z'), 'filename');
      await dated(engine, 'notes/undated', null, null);
      await dated(engine, 'notes/fallback-date', new Date('2020-01-01T00:00:00Z'), 'fallback', { date: 'sometime' });
      await dated(engine, 'notes/fallback-published', new Date('2020-01-01T00:00:00Z'), 'fallback', { published: '2019-07-04' });
      await dated(engine, 'notes/fallback-plain', new Date('2020-01-01T00:00:00Z'), 'fallback', { status: 'draft' });
      await dated(engine, 'notes/filename-date', new Date('2020-01-01T00:00:00Z'), 'filename', { event_date: '2018-02-02' });
      await dated(engine, 'notes/fallback-gone', new Date('1970-06-01T00:00:00Z'), 'fallback', { event_date: 'bad' });
      await engine.softDeletePage('notes/fallback-gone');
      const counts = await engine.sampleEffectiveDates();
      const rows = await engine.sampleEffectiveDateSources();
      expect(empty).toEqual({ counts: { future_dated: 0, pre_1990: 0 }, rows: [] });
      expect(counts).toEqual({ future_dated: 1, pre_1990: 2 });
      expect(rows.map(r => r.slug)).toEqual(['notes/fallback-gone', 'notes/fallback-published', 'notes/fallback-date']);
      for (const r of rows) {
        expect(r.created_at).toBeInstanceOf(Date);
        expect(r.updated_at).toBeInstanceOf(Date);
        expect(Number.isNaN(r.updated_at.getTime())).toBe(false);
      }
      return { empty, counts, rows: rows.map(r => ({ slug: r.slug, frontmatter: r.frontmatter })) };
    },
  );

  parityTest(
    'readMaxTimelineEntryId, listStoredTimelineRowsOrdered, storedTimelineRowsByPageIds and deleteTimelineRows see own rows only',
    { methods: ['putPage', 'addTimelineEntry', 'upsertEventProjection', 'readMaxTimelineEntryId', 'listStoredTimelineRowsOrdered',
      'storedTimelineRowsByPageIds', 'deleteTimelineRows'] },
    async (engine) => {
      const emptyMax = await engine.readMaxTimelineEntryId();
      const a = await engine.putPage('people/alice-example', page('Alice'));
      const b = await engine.putPage('people/bob-example', page('Bob'));
      await engine.putPage('life/events/2026-02-01-001', page('Event', { type: 'event', frontmatter: { event: { kind: 'meeting' } } }));
      await engine.addTimelineEntry('people/alice-example', { date: '2026-03-01', source: 'cal', summary: 'Later', detail: 'x' });
      await engine.addTimelineEntry('people/alice-example', { date: '2026-01-01', source: 'note', summary: 'Earlier', detail: '' });
      await engine.addTimelineEntry('people/alice-example', { date: '2026-03-01', source: 'cal', summary: 'Same day', detail: 'y' });
      await engine.addTimelineEntry('people/bob-example', { date: '2026-01-05', summary: 'Bob row' });
      const ownMax = await engine.readMaxTimelineEntryId();
      await engine.upsertEventProjection({ depthSlug: 'people/alice-example', eventSlug: 'life/events/2026-02-01-001', date: '2026-02-01', summary: 'Met', detail: 'event row' });
      const max = await engine.readMaxTimelineEntryId();
      const ordered = await engine.listStoredTimelineRowsOrdered(a.id);
      const base = Math.min(...ordered.map(r => r.id));
      const rel = <T extends { id: number }>(rows: T[]) => rows.map(r => ({ ...r, id: r.id - base }));
      const batched = await engine.storedTimelineRowsByPageIds([b.id, a.id, 999_999]);
      // Postgres sequences keep counting across cases (harness resetPostgres), so the raw page_id becomes a page label.
      const batchedRel = batched.map(({ page_id, ...r }) => ({ ...rel([r])[0]!, page: page_id === a.id ? 'alice' : page_id === b.id ? 'bob' : 'other' }))
        // The statement has no ORDER BY, so the engines may deliver the rows in different orders.
        .sort((x, y) => x.page.localeCompare(y.page) || x.id - y.id);
      const later = ordered.find(r => r.summary === 'Later')!;
      const earlier = ordered.find(r => r.summary === 'Earlier')!;
      const sameDay = ordered.find(r => r.summary === 'Same day')!;
      const deleted = await engine.deleteTimelineRows(a.id, [
        { ...later, removed: true },
        { ...earlier, date: '2026/01/01', removed: false },
        { ...sameDay, summary: 'Same day (edited)', removed: true },
        { id: max, date: '2026-02-01', source: 'life-chronicle:event:life/events/2026-02-01-001', summary: 'Met', detail: 'event row', removed: true },
      ]);
      const noneDeleted = await engine.deleteTimelineRows(b.id, [{ ...later, removed: true }]);
      const after = await engine.listStoredTimelineRowsOrdered(a.id);
      const maxAfter = await engine.readMaxTimelineEntryId();
      const none = {
        missingPage: await engine.listStoredTimelineRowsOrdered(999_999),
        noIds: await engine.storedTimelineRowsByPageIds([]),
        noDeletions: await engine.deleteTimelineRows(a.id, []),
      };
      expect(emptyMax).toBe(0);
      expect(max - ownMax).toBe(1);
      expect(ownMax).toBe(Math.max(...batched.map(r => r.id)));
      expect(maxAfter).toBe(max);
      expect(ordered.map(r => r.summary)).toEqual(['Earlier', 'Later', 'Same day']);
      expect(sorted(deleted, d => d.date)).toEqual([{ date: '2026-01-01', removed: false }, { date: '2026-03-01', removed: true }]);
      expect(after.map(r => r.summary)).toEqual(['Same day']);
      return {
        emptyMax, maxStep: max - ownMax, ownMax: ownMax - base, eventRowKept: maxAfter === max, ordered: rel(ordered), batched: batchedRel,
        deleted: sorted(deleted, d => d.date), noneDeleted, after: rel(after), none,
      };
    },
  );

  parityTest(
    'countSegmentedTimelinePages, countTimelineCommentMarkupRows and listTimelineOrphanPages read live own rows of the sources',
    { methods: ['putPage', 'createSegmentedPageShell', 'addTimelineEntry', 'upsertEventProjection', 'softDeletePage',
      'countSegmentedTimelinePages', 'countTimelineCommentMarkupRows', 'listTimelineOrphanPages'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const empty = {
        segmented: await engine.countSegmentedTimelinePages(['default', 'other'], 5),
        markup: await engine.countTimelineCommentMarkupRows(['default']),
        orphans: await engine.listTimelineOrphanPages({ afterId: 0, limit: 10 }),
      };
      const segA = await engine.createSegmentedPageShell('notes/seg-a', pageMeta('Seg A'), { sourceId: 'default' });
      await engine.createSegmentedPageShell('notes/seg-empty', pageMeta('Seg empty'), { sourceId: 'default' });
      await engine.createSegmentedPageShell('notes/seg-b', pageMeta('Seg B'), { sourceId: 'other' });
      await engine.createSegmentedPageShell('notes/seg-gone', pageMeta('Seg gone'), { sourceId: 'default' });
      await engine.putPage('notes/inline', page('Inline'));
      await engine.putPage('notes/inline-other', page('Inline other'), { sourceId: 'other' });
      await engine.putPage('notes/quiet', page('Quiet'));
      await engine.putPage('life/events/2026-04-01-001', page('Event', { type: 'event', frontmatter: { event: { kind: 'meeting' } } }));
      await engine.addTimelineEntry('notes/seg-a', { date: '2026-04-01', summary: 'Seg row one' });
      await engine.addTimelineEntry('notes/seg-a', { date: '2026-04-02', source: 'x -->', summary: 'Seg row two' });
      await engine.addTimelineEntry('notes/seg-b', { date: '2026-04-03', summary: 'Other <!-- hidden' }, { sourceId: 'other' });
      await engine.addTimelineEntry('notes/seg-gone', { date: '2026-04-04', summary: 'Gone <!-- row' });
      await engine.addTimelineEntry('notes/inline', { date: '2026-04-05', summary: 'Inline <!-- x --> row' });
      await engine.addTimelineEntry('notes/inline', { date: '2026-04-06', summary: 'Plain row' });
      await engine.addTimelineEntry('notes/inline-other', { date: '2026-04-07', summary: 'Other plain' }, { sourceId: 'other' });
      await engine.upsertEventProjection({ depthSlug: 'notes/quiet', eventSlug: 'life/events/2026-04-01-001', date: '2026-04-01', summary: 'Event <!-- row' });
      await engine.softDeletePage('notes/seg-gone');
      const segmented = {
        both: await engine.countSegmentedTimelinePages(['default', 'other'], 5),
        sampleOfOne: await engine.countSegmentedTimelinePages(['default', 'other'], 1),
        zeroSample: await engine.countSegmentedTimelinePages(['default'], 0),
        none: await engine.countSegmentedTimelinePages([], 5),
      };
      const markup = {
        default: await engine.countTimelineCommentMarkupRows(['default']),
        both: await engine.countTimelineCommentMarkupRows(['default', 'other']),
        none: await engine.countTimelineCommentMarkupRows([]),
      };
      const shape = (rows: Awaited<ReturnType<BrainEngine['listTimelineOrphanPages']>>) => rows.map(r => {
        expect(typeof r.revision).toBe('string');
        return { slug: r.slug, source_id: r.source_id, compiled_truth: r.compiled_truth, timeline: r.timeline, body_storage: r.body_storage };
      });
      const all = await engine.listTimelineOrphanPages({ afterId: 0, limit: 10 });
      const orphans = {
        all: shape(all),
        other: shape(await engine.listTimelineOrphanPages({ afterId: 0, limit: 10, sourceId: 'other' })),
        blankSource: shape(await engine.listTimelineOrphanPages({ afterId: 0, limit: 10, sourceId: '' })),
        afterFirst: shape(await engine.listTimelineOrphanPages({ afterId: segA.id, limit: 10 })),
        firstOnly: shape(await engine.listTimelineOrphanPages({ afterId: 0, limit: 1 })),
        zero: shape(await engine.listTimelineOrphanPages({ afterId: 0, limit: 0 })),
      };
      expect(empty).toEqual({ segmented: { pages: 0, rows: 0, sample: [] }, markup: 0, orphans: [] });
      expect(segmented.both.pages).toBe(2);
      expect(segmented.both.rows).toBe(3);
      expect(markup).toEqual({ default: 2, both: 3, none: 0 });
      expect(orphans.all.map(r => r.slug)).toEqual(['notes/seg-a', 'notes/seg-b', 'notes/inline', 'notes/inline-other']);
      return { empty, segmented, markup, orphans };
    },
  );
  parityTest(
    'deleteTimelineRows clears the keyword stale flag when it deletes the row that set it',
    { methods: ['putPage', 'addTimelineEntry', 'listStoredTimelineRowsOrdered', 'deleteTimelineRows', 'searchKeyword'] },
    async (engine, backend) => {
      const p = await engine.putPage('notes/zephyr', page('Zephyr'));
      await installChunks(engine, 'notes/zephyr', [chunk(0, 'zephyr quartz lantern')]);
      await new Promise(r => setTimeout(r, 5));
      await engine.addTimelineEntry('notes/zephyr', { date: '2026-05-01', summary: 'Added later' });
      const stale = async () => (await engine.searchKeyword('zephyr quartz', { limit: 5 })).map(r => ({ slug: r.slug, stale: !!r.stale }));
      const before = await stale();
      const [row] = await engine.listStoredTimelineRowsOrdered(p.id);
      const deleted = await engine.deleteTimelineRows(p.id, [{ ...row!, removed: true }]);
      const after = await stale();
      // Postgres keyword search reads no timeline_entries and always reports stale false (search.test.ts); PGLite and
      // the Rust arm mark the page stale until the row that set the flag is deleted.
      expect(before).toEqual([{ slug: 'notes/zephyr', stale: backend !== 'postgres' }]);
      expect(after).toEqual([{ slug: 'notes/zephyr', stale: false }]);
      return { found: before.map(r => r.slug), deleted, after };
    },
  );
});
