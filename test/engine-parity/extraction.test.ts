/**
 * BrainEngine parity — extraction family (link/timeline extraction freshness
 * watermark, attendance-blocked marker, stale reserved frontmatter keys).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every extraction-watermark method returns the same observable
 *    result on every engine arm (PGLite always; Postgres with DATABASE_URL; a
 *    Rust arm later through test/engine-parity/harness.ts): which pages are
 *    stale, how a stamp or an attendance block changes that, and which pages
 *    still carry a parser-reserved frontmatter key.
 *  - Regression: an engine that drifts on the stale predicate (NULL stamp,
 *    older than the extractor version, edited since the stamp, soft-deleted or
 *    quarantined pages) makes `gbrain extract --stale` and the
 *    `links_extraction_lag` doctor check re-extract a whole brain or never
 *    extract an edited page.
 *  - Why existing coverage misses it: the per-engine extraction tests never
 *    compare two engines on one scenario, and test/e2e/engine-parity.test.ts
 *    does not touch the watermark.
 *  - Seam: none. Typed methods only (no executeRaw: D18). Timestamps are fixed
 *    far-future ISO strings so the cases do not depend on the wall clock.
 *    A `held` failure record and `wanted_links` rows have no typed writer, so
 *    those arms of the predicate are covered only as "no effect when absent".
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { createSource, parityArms, pick } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** Stamped far in the future: always at or after updated_at, so the page reads fresh. */
const FRESH = '2099-01-01T00:00:00.000Z';
/** Stamped far in the past: always before updated_at, so the page reads edited-since-stamp. */
const OLD = '2000-01-01T00:00:00.000Z';
/** An extractor version newer than FRESH, then older than FRESH. */
const VERSION_AFTER_FRESH = '2100-01-01T00:00:00.000Z';
const VERSION_BEFORE_FRESH = '2098-01-01T00:00:00.000Z';
const NO_SUCH_REVISION = '00000000-0000-0000-0000-000000000000';

const page = (title: string, body = `${title} body`, frontmatter: Record<string, unknown> = {}): PageInput => ({
  type: 'note',
  title,
  compiled_truth: body,
  timeline: '',
  frontmatter,
});

async function put(engine: BrainEngine, slug: string, input: PageInput, sourceId?: string) {
  return engine.putPage(slug, input, sourceId ? { sourceId } : undefined);
}

describe('engine parity: extraction', () => {
  parityTest(
    'countStalePagesForExtraction: NULL stamp, older-than-version and edited-since-stamp are stale; deleted and quarantined are not',
    { methods: ['putPage', 'markPagesExtractedBatch', 'softDeletePage', 'countStalePagesForExtraction', 'listStalePagesForExtraction'] },
    async (engine) => {
      await put(engine, 'notes/never', page('Never'));
      await put(engine, 'notes/fresh', page('Fresh'));
      await put(engine, 'notes/edited', page('Edited'));
      await put(engine, 'notes/gone', page('Gone'));
      await put(engine, 'notes/quarantined', page('Quarantined', 'q body', { quarantine: { reason: 'junk' } }));
      await engine.softDeletePage('notes/gone');

      const stale = async (versionTs?: string) => ({
        count: await engine.countStalePagesForExtraction(versionTs ? { versionTs } : undefined),
        slugs: (await engine.listStalePagesForExtraction({ batchSize: 50, ...(versionTs ? { versionTs } : {}) })).map((r) => r.slug),
      });

      // Nothing stamped: every live, non-quarantined page is stale.
      const unstamped = await stale();
      expect(unstamped).toEqual({ count: 3, slugs: ['notes/never', 'notes/fresh', 'notes/edited'] });

      const stamped = await engine.markPagesExtractedBatch(
        [{ slug: 'notes/fresh', source_id: 'default' }, { slug: 'notes/edited', source_id: 'default', extractedAt: OLD }],
        FRESH,
      );
      expect(stamped).toBe(2);

      // A far-future stamp is fresh; a far-past stamp is "edited since the stamp".
      const afterStamp = await stale();
      expect(afterStamp).toEqual({ count: 2, slugs: ['notes/never', 'notes/edited'] });
      // With an extractor version: the future stamp is still fresh against an older version...
      const olderVersion = await stale(VERSION_BEFORE_FRESH);
      expect(olderVersion).toEqual({ count: 2, slugs: ['notes/never', 'notes/edited'] });
      // ...and stale against a newer one.
      const newerVersion = await stale(VERSION_AFTER_FRESH);
      expect(newerVersion).toEqual({ count: 3, slugs: ['notes/never', 'notes/fresh', 'notes/edited'] });

      // Re-stamping the edited page clears it.
      expect(await engine.markPagesExtractedBatch([{ slug: 'notes/edited', source_id: 'default' }], FRESH)).toBe(1);
      const restamped = await stale();
      expect(restamped).toEqual({ count: 1, slugs: ['notes/never'] });

      return { unstamped, stamped, afterStamp, olderVersion, newerVersion, restamped };
    },
  );

  parityTest(
    'listStalePagesForExtraction pages by id keyset, scopes by source and carries the page content',
    { methods: ['putPage', 'markPagesExtractedBatch', 'countStalePagesForExtraction', 'listStalePagesForExtraction'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const a = await put(engine, 'notes/a', { ...page('A', 'alpha body', { mood: 'calm' }), timeline: '- 2026-01-01: alpha line' });
      await put(engine, 'notes/b', page('B'));
      await put(engine, 'notes/c', page('C'));
      await put(engine, 'notes/work-only', page('Work only'), 'work');

      const rows = await engine.listStalePagesForExtraction({ batchSize: 50 });
      const first = rows.find((r) => r.slug === 'notes/a')!;
      expect(first.id).toBe(a.id);
      const view = pick(first, ['slug', 'source_id', 'type', 'title', 'compiled_truth', 'timeline', 'frontmatter']);
      expect(view).toEqual({
        slug: 'notes/a',
        source_id: 'default',
        type: 'note',
        title: 'A',
        compiled_truth: 'alpha body',
        timeline: '- 2026-01-01: alpha line',
        frontmatter: { mood: 'calm' },
      });
      // The stamp-back string is a full-precision UTC ISO string.
      const isoShape = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(first.updated_at_iso);
      expect(isoShape).toBe(true);

      const slugsOf = (list: Array<{ slug: string }>) => list.map((r) => r.slug);
      const pageOne = await engine.listStalePagesForExtraction({ batchSize: 2 });
      const pageTwo = await engine.listStalePagesForExtraction({ batchSize: 2, afterPageId: pageOne[pageOne.length - 1]!.id });
      const pageThree = await engine.listStalePagesForExtraction({ batchSize: 2, afterPageId: pageTwo[pageTwo.length - 1]!.id });
      expect([slugsOf(pageOne), slugsOf(pageTwo), slugsOf(pageThree)]).toEqual([
        ['notes/a', 'notes/b'],
        ['notes/c', 'notes/work-only'],
        [],
      ]);

      const work = slugsOf(await engine.listStalePagesForExtraction({ batchSize: 50, sourceId: 'work' }));
      const defaultSource = slugsOf(await engine.listStalePagesForExtraction({ batchSize: 50, sourceId: 'default' }));
      const counts = {
        all: await engine.countStalePagesForExtraction(),
        work: await engine.countStalePagesForExtraction({ sourceId: 'work' }),
        default: await engine.countStalePagesForExtraction({ sourceId: 'default' }),
      };
      expect(work).toEqual(['notes/work-only']);
      expect(defaultSource).toEqual(['notes/a', 'notes/b', 'notes/c']);
      expect(counts).toEqual({ all: 4, work: 1, default: 3 });

      // `held: 'exclude'` and `wantedProducers` change nothing while no page is held and no wanted link exists.
      const heldExclude = await engine.countStalePagesForExtraction({ held: 'exclude' });
      const noWanted = await engine.countStalePagesForExtraction({ wantedProducers: ['nobody'] });
      const heldOnly = await engine.countStalePagesForExtraction({ held: 'only' });
      expect({ heldExclude, noWanted, heldOnly }).toEqual({ heldExclude: 4, noWanted: 4, heldOnly: 0 });

      // A stamp in one source leaves the other alone.
      await engine.markPagesExtractedBatch([{ slug: 'notes/work-only', source_id: 'work' }], FRESH);
      const afterWorkStamp = {
        all: await engine.countStalePagesForExtraction(),
        work: await engine.countStalePagesForExtraction({ sourceId: 'work' }),
      };
      expect(afterWorkStamp).toEqual({ all: 3, work: 0 });
      return { view, pages: [slugsOf(pageOne), slugsOf(pageTwo), slugsOf(pageThree)], work, defaultSource, counts, heldExclude, noWanted, heldOnly, afterWorkStamp };
    },
  );

  parityTest(
    'markPagesExtractedBatch returns the rows stamped: wrong-source and unknown refs match nothing, empty input is 0',
    { methods: ['putPage', 'markPagesExtractedBatch', 'countStalePagesForExtraction'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await put(engine, 'notes/shared', page('Shared'));
      await put(engine, 'notes/shared', page('Shared (work)'), 'work');
      await put(engine, 'notes/solo', page('Solo'));

      const empty = await engine.markPagesExtractedBatch([], FRESH);
      const wrongSource = await engine.markPagesExtractedBatch([{ slug: 'notes/solo', source_id: 'work' }], FRESH);
      const unknown = await engine.markPagesExtractedBatch([{ slug: 'notes/nope', source_id: 'default' }], FRESH);
      const beforeAny = {
        all: await engine.countStalePagesForExtraction(),
      };
      // One real ref, one wrong-source ref, one unknown ref: only the real one stamps.
      const mixed = await engine.markPagesExtractedBatch(
        [
          { slug: 'notes/solo', source_id: 'default' },
          { slug: 'notes/solo', source_id: 'work' },
          { slug: 'notes/nope', source_id: 'default' },
        ],
        FRESH,
      );
      // The same slug in two sources stamps per (slug, source_id), not per slug.
      const oneSource = await engine.markPagesExtractedBatch([{ slug: 'notes/shared', source_id: 'work' }], FRESH);
      const after = {
        all: await engine.countStalePagesForExtraction(),
        default: await engine.countStalePagesForExtraction({ sourceId: 'default' }),
        work: await engine.countStalePagesForExtraction({ sourceId: 'work' }),
      };
      expect({ empty, wrongSource, unknown, beforeAny, mixed, oneSource, after }).toEqual({
        empty: 0,
        wrongSource: 0,
        unknown: 0,
        beforeAny: { all: 3 },
        mixed: 1,
        oneSource: 1,
        after: { all: 1, default: 1, work: 0 },
      });
      return { empty, wrongSource, unknown, beforeAny, mixed, oneSource, after };
    },
  );

  parityTest(
    'readExtractionLagCounts counts live, actionable-stale, attendance-blocked and held pages in each statement shape',
    { methods: ['putPage', 'markPagesExtractedBatch', 'markPagesAttendanceBlocked', 'softDeletePage', 'readExtractionLagCounts'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await createSource(engine, backend, 'visitors', { guest: true });
      await put(engine, 'notes/never', page('Never'));
      await put(engine, 'notes/fresh', page('Fresh'));
      await put(engine, 'notes/edited', page('Edited'));
      const blocked = await put(engine, 'notes/blocked', page('Blocked'));
      await put(engine, 'notes/gone', page('Gone'));
      await put(engine, 'notes/quarantined', page('Quarantined', 'q body', { quarantine: { reason: 'junk' } }));
      await put(engine, 'notes/work-only', page('Work only'), 'work');
      await put(engine, 'notes/visitor', page('Visitor'), 'visitors');
      await engine.softDeletePage('notes/gone');
      expect(await engine.markPagesExtractedBatch(
        [{ slug: 'notes/fresh', source_id: 'default' }, { slug: 'notes/edited', source_id: 'default', extractedAt: OLD }], FRESH)).toBe(2);
      expect(await engine.markPagesAttendanceBlocked([{ slug: 'notes/blocked', source_id: 'default', revision: blocked.knowledge_revision! }])).toBe(1);

      const lag = async (q: Partial<Parameters<BrainEngine['readExtractionLagCounts']>[0]> = {}) => {
        const row = await engine.readExtractionLagCounts({ versionTs: VERSION_BEFORE_FRESH, attendance: true, held: true, guests: true, ...q });
        return row ? Object.fromEntries(Object.entries(row).map(([k, v]) => [k, Number(v)])) : row;
      };
      // One source: four live pages (deleted and quarantined are not counted); never and edited are stale, blocked waits.
      const scoped = await lag({ sourceId: 'default' });
      expect(scoped).toEqual({ total: 4, stale: 2, attendance_blocked: 1, held: 0 });
      // Before the attendance marker existed nothing was blocked, so the blocked page is stale.
      const noMarker = await lag({ sourceId: 'default', attendance: false, held: false });
      expect(noMarker).toEqual({ total: 4, stale: 3, attendance_blocked: 0, held: 0 });
      // A newer extractor version makes the fresh stamp stale too.
      const newerVersion = await lag({ sourceId: 'default', versionTs: VERSION_AFTER_FRESH });
      expect(newerVersion).toEqual({ total: 4, stale: 3, attendance_blocked: 1, held: 0 });
      // Brain-wide: the guest page counts as live but is never stale; before the guest migration it was.
      const brainWide = await lag();
      expect(brainWide).toEqual({ total: 6, stale: 3, attendance_blocked: 1, held: 0 });
      const noGuests = await lag({ guests: false });
      expect(noGuests).toEqual({ total: 6, stale: 4, attendance_blocked: 1, held: 0 });
      // No wanted links exist, so limiting their producers changes nothing.
      const bodyOnly = await lag({ sourceId: 'default', wantedProducers: ['body'] });
      expect(bodyOnly).toEqual(scoped);
      const emptySource = await lag({ sourceId: 'no-such-source' });
      expect(emptySource).toEqual({ total: 0, stale: 0, attendance_blocked: 0, held: 0 });
      return { scoped, noMarker, newerVersion, brainWide, noGuests, bodyOnly, emptySource };
    },
  );

  parityTest(
    'markPagesAttendanceBlocked marks a page at its revision; attendance narrows the stale set and an edit releases it',
    {
      methods: ['putPage', 'markPagesAttendanceBlocked', 'markPagesExtractedBatch', 'softDeletePage', 'countStalePagesForExtraction', 'listStalePagesForExtraction'],
    },
    async (engine) => {
      const a = await put(engine, 'notes/a', page('A'));
      const b = await put(engine, 'notes/b', page('B'));
      const c = await put(engine, 'notes/c', page('C'));
      await put(engine, 'notes/d', page('D'));
      for (const p of [a, b, c]) expect(typeof p.knowledge_revision).toBe('string');

      const counts = async () => ({
        all: await engine.countStalePagesForExtraction(),
        exclude: await engine.countStalePagesForExtraction({ attendance: 'exclude' }),
        blocked: await engine.countStalePagesForExtraction({ attendance: 'blocked' }),
      });
      const slugsExcluding = async () => (await engine.listStalePagesForExtraction({ batchSize: 50 })).map((r) => r.slug);
      const before = await counts();
      expect(before).toEqual({ all: 4, exclude: 4, blocked: 0 });

      // A stale revision marks nothing; an empty list marks nothing.
      const staleRevision = await engine.markPagesAttendanceBlocked([{ slug: 'notes/a', source_id: 'default', revision: NO_SUCH_REVISION }]);
      const empty = await engine.markPagesAttendanceBlocked([]);
      expect({ staleRevision, empty }).toEqual({ staleRevision: 0, empty: 0 });

      // Current revisions mark; a wrong-source ref and an unknown ref do not.
      const marked = await engine.markPagesAttendanceBlocked([
        { slug: 'notes/a', source_id: 'default', revision: a.knowledge_revision! },
        { slug: 'notes/b', source_id: 'default', revision: b.knowledge_revision! },
        { slug: 'notes/c', source_id: 'other', revision: c.knowledge_revision! },
        { slug: 'notes/nope', source_id: 'default', revision: a.knowledge_revision! },
      ]);
      expect(marked).toBe(2);
      const afterMark = await counts();
      expect(afterMark).toEqual({ all: 4, exclude: 2, blocked: 2 });
      // Plain listing (extraction itself) still sees the blocked pages.
      const listed = await slugsExcluding();
      expect(listed).toEqual(['notes/a', 'notes/b', 'notes/c', 'notes/d']);

      // A soft-deleted page cannot be marked.
      await engine.softDeletePage('notes/c');
      const deletedMark = await engine.markPagesAttendanceBlocked([{ slug: 'notes/c', source_id: 'default', revision: c.knowledge_revision! }]);
      expect(deletedMark).toBe(0);

      // An edit moves the revision past the marker: the page is stale and unblocked again.
      await put(engine, 'notes/a', page('A', 'A body, edited'));
      const afterEdit = await counts();
      expect(afterEdit).toEqual({ all: 3, exclude: 2, blocked: 1 });

      // Stamping publishes the page's links, which clears the marker with the watermark.
      const stamped = await engine.markPagesExtractedBatch([{ slug: 'notes/b', source_id: 'default' }], FRESH);
      expect(stamped).toBe(1);
      const afterStamp = await counts();
      expect(afterStamp).toEqual({ all: 2, exclude: 2, blocked: 0 });
      return { before, staleRevision, empty, marked, afterMark, listed, deletedMark, afterEdit, stamped, afterStamp };
    },
  );

  parityTest(
    'countStaleFrontmatterKeyPages, listStaleFrontmatterKeyPages and stripStaleFrontmatterKeys sweep parser-reserved keys per source',
    {
      methods: ['putPage', 'softDeletePage', 'getPage', 'countStaleFrontmatterKeyPages', 'listStaleFrontmatterKeyPages', 'stripStaleFrontmatterKeys'],
    },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const typed = await put(engine, 'notes/typed', page('Typed', 'b', { type: 'person', mood: 'calm' }));
      const multi = await put(engine, 'notes/multi', page('Multi', 'b', { title: 'T', tags: ['x'], slug: 's', keep: 1 }));
      await put(engine, 'notes/clean', page('Clean', 'b', { mood: 'calm' }));
      const gone = await put(engine, 'notes/gone', page('Gone', 'b', { slug: 'x' }));
      const work = await put(engine, 'notes/work-typed', page('Work typed', 'b', { tags: ['w'] }), 'work');
      await engine.softDeletePage('notes/gone');
      const slugById = new Map<number, string>([
        [typed.id, 'notes/typed'],
        [multi.id, 'notes/multi'],
        [gone.id, 'notes/gone'],
        [work.id, 'notes/work-typed'],
      ]);

      const counts = await engine.countStaleFrontmatterKeyPages({ sourceIds: ['default', 'work', 'absent'] });
      const noSources = await engine.countStaleFrontmatterKeyPages({ sourceIds: [] });
      expect({ counts, noSources }).toEqual({
        counts: [{ source_id: 'default', n: 2 }, { source_id: 'work', n: 1 }],
        noSources: [],
      });

      const listed = await engine.listStaleFrontmatterKeyPages({ sourceId: 'default', afterId: 0, limit: 10 });
      const view = listed.map((r) => ({ slug: r.slug, keys: r.keys, mapped: slugById.get(r.id) }));
      expect(view).toEqual([
        { slug: 'notes/typed', keys: ['type'], mapped: 'notes/typed' },
        { slug: 'notes/multi', keys: ['slug', 'tags', 'title'], mapped: 'notes/multi' },
      ]);
      const firstOnly = await engine.listStaleFrontmatterKeyPages({ sourceId: 'default', afterId: 0, limit: 1 });
      const rest = await engine.listStaleFrontmatterKeyPages({ sourceId: 'default', afterId: firstOnly[0]!.id, limit: 10 });
      const paged = [firstOnly.map((r) => r.slug), rest.map((r) => r.slug)];
      expect(paged).toEqual([['notes/typed'], ['notes/multi']]);

      // Stripping is source-scoped: an id from another source, a soft-deleted page and an empty list change nothing.
      const crossSource = await engine.stripStaleFrontmatterKeys({ sourceId: 'default', ids: [work.id] });
      const deleted = await engine.stripStaleFrontmatterKeys({ sourceId: 'default', ids: [gone.id] });
      const emptyIds = await engine.stripStaleFrontmatterKeys({ sourceId: 'default', ids: [] });
      expect({ crossSource, deleted, emptyIds }).toEqual({ crossSource: 0, deleted: 0, emptyIds: 0 });

      const stripped = await engine.stripStaleFrontmatterKeys({ sourceId: 'default', ids: [typed.id, multi.id] });
      expect(stripped).toBe(2);
      const afterStrip = await engine.countStaleFrontmatterKeyPages({ sourceIds: ['default', 'work'] });
      expect(afterStrip).toEqual([{ source_id: 'work', n: 1 }]);
      // Only the reserved keys go; other keys stay.
      const typedPage = await engine.getPage('notes/typed');
      const multiPage = await engine.getPage('notes/multi');
      const frontmatter = { typed: typedPage?.frontmatter, multi: multiPage?.frontmatter };
      expect(frontmatter).toEqual({ typed: { mood: 'calm' }, multi: { keep: 1 } });
      // A second sweep finds nothing left to change.
      const again = await engine.stripStaleFrontmatterKeys({ sourceId: 'default', ids: [typed.id, multi.id] });
      expect(again).toBe(0);
      return { counts, noSources, view, paged, crossSource, deleted, emptyIds, stripped, afterStrip, frontmatter, again };
    },
  );

  parityTest(
    'listQuarantinedSlugs names the live pages of one source that carry a quarantine key, whatever its value',
    { methods: ['putPage', 'softDeletePage', 'listQuarantinedSlugs'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await put(engine, 'notes/b', page('B', 'b body', { quarantine: { reason: 'junk_pattern' } }));
      await put(engine, 'notes/a', page('A', 'a body', { quarantine: null }));
      await put(engine, 'notes/plain', page('Plain', 'plain body', { content_flag: { reason: 'oversized' } }));
      await put(engine, 'notes/gone', page('Gone', 'gone body', { quarantine: true }));
      await engine.softDeletePage('notes/gone');
      await put(engine, 'notes/c', page('C', 'c body', { quarantine: true }), 'work');
      // The SQL engines return no set order, so the slugs are sorted here.
      const read = async (id: string) => (await engine.listQuarantinedSlugs(id)).sort();
      const observed = { default: await read('default'), work: await read('work'), missing: await read('missing') };
      expect(observed).toEqual({ default: ['notes/a', 'notes/b'], work: ['notes/c'], missing: [] });
      return observed;
    },
  );
});
