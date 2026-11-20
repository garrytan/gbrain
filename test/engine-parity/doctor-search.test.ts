/**
 * BrainEngine parity: the doctor search-and-knowledge reads of engine-sql/doctor-search.ts, which doctor checks used
 * to run through `engine.executeRaw`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member returns the same answer on every engine arm (PGLite always; Postgres with DATABASE_URL; the
 *    Rust arm through test/engine-parity/harness.ts), so a doctor check reads the same finding on each.
 *  - Regression: an engine whose read drifts (or does not serve it) gives a different doctor status, message or health
 *    score per backend; a Rust brain refused every one of these reads with `raw_sql`, so the checks warned.
 *  - Why existing coverage misses it: the doctor check tests run these reads on PGLite only and never compare arms.
 *  - Seam: none. Typed methods only (no executeRaw) and the harness fixtures for sources. Page ids, timestamps and
 *    the order of an unordered read are never compared (rows are sorted, or reduced to what the check uses).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { PageInput } from '../../src/core/types.ts';
import { archiveSource, createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { bodyColumns, flipInput, segmentText, stageGeneration } from '../helpers/page-body-fixtures.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, extra: Partial<PageInput> = {}): PageInput => ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '', ...extra });
const put = (engine: BrainEngine, slug: string, extra: Partial<PageInput> = {}, sourceId = 'default') =>
  engine.putPage(slug, page(slug, extra), { sourceId });

/** A page stored in segments (its body columns are NULL), published at generation 1. */
async function segmentedPage(engine: BrainEngine, slug: string, text: string, sourceId = 'default'): Promise<void> {
  const meta = { type: 'note', title: slug };
  const texts = [segmentText(text)];
  const { id: pageId } = await engine.createSegmentedPageShell(slug, meta as never, { sourceId });
  const staged = await stageGeneration(engine, { pageId, slug, genFrom: 1, texts });
  await engine.transaction(async (tx) => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staged.stagingId, texts, { meta: meta as never, body: bodyColumns(texts) }));
    await tx.setBodyStagingState(staged.stagingId, 'committed');
  });
}

const HEADED = `intro\n## Heading\n${'long raw text '.repeat(90)}`; // over 1000 characters, with an H2

describe('doctor search reads', () => {
  parityTest(
    'listOrphanedAliasCounts counts redirects and page aliases whose page row is gone, and reads nothing for a live or soft-deleted target',
    { methods: ['putPage', 'updateSlug', 'deletePage', 'softDeletePage', 'setPageAliases', 'listOrphanedAliasCounts'] },
    async (engine) => {
      const empty = await engine.listOrphanedAliasCounts();
      await put(engine, 'notes/a');
      await engine.updateSlug('notes/a', 'notes/b');
      const live = await engine.listOrphanedAliasCounts();
      await engine.deletePage('notes/b');
      await engine.setPageAliases('people/ghost', 'default', ['ghost one', 'ghost two']);
      await put(engine, 'people/soft');
      await engine.setPageAliases('people/soft', 'default', ['soft one']);
      await engine.softDeletePage('people/soft');
      const rows = await engine.listOrphanedAliasCounts();
      expect({ empty, live, rows }).toEqual({ empty: [], live: [], rows: [{ source_id: 'default', slug_redirects: 1, page_aliases: 2 }] });
      return { empty, live, rows };
    },
  );

  parityTest(
    'readSoftDeletedAliasCounts counts alias rows of both tables whose page is soft-deleted',
    { methods: ['putPage', 'updateSlug', 'softDeletePage', 'setPageAliases', 'readSoftDeletedAliasCounts'] },
    async (engine) => {
      const empty = await engine.readSoftDeletedAliasCounts();
      await put(engine, 'notes/a');
      await put(engine, 'people/jane');
      await put(engine, 'people/live');
      await engine.updateSlug('notes/a', 'notes/b');
      await engine.setPageAliases('people/jane', 'default', ['jane']);
      await engine.setPageAliases('people/live', 'default', ['live one']);
      const before = await engine.readSoftDeletedAliasCounts();
      await engine.softDeletePage('notes/b');
      await engine.softDeletePage('people/jane');
      const after = await engine.readSoftDeletedAliasCounts();
      expect({ empty, before, after }).toEqual({
        empty: { slug_redirects: 0, page_aliases: 0 },
        before: { slug_redirects: 0, page_aliases: 0 },
        after: { slug_redirects: 1, page_aliases: 1 },
      });
      return { empty, before, after };
    },
  );

  parityTest(
    'listPageTypePairs lists each distinct source and type of the live pages, in source then type order',
    { methods: ['putPage', 'softDeletePage', 'listPageTypePairs'] },
    async (engine) => {
      const empty = await engine.listPageTypePairs();
      await put(engine, 'notes/a');
      await put(engine, 'notes/b');
      await put(engine, 'people/jane', { type: 'person' });
      await put(engine, 'people/gone', { type: 'ghost' as never });
      await engine.softDeletePage('people/gone');
      const rows = await engine.listPageTypePairs();
      expect({ empty, rows }).toEqual({ empty: [], rows: [{ source_id: 'default', type: 'note' }, { source_id: 'default', type: 'person' }] });
      return { empty, rows };
    },
  );

  parityTest(
    'listTruncatedMarkdownBodies lists pages whose body is under 30% of a raw content over 1000 characters with a heading',
    { methods: ['putPage', 'putRawData', 'softDeletePage', 'createSegmentedPageShell', 'listTruncatedMarkdownBodies'] },
    async (engine) => {
      const empty = await engine.listTruncatedMarkdownBodies();
      await put(engine, 'notes/cut', { compiled_truth: 'short' });
      await engine.putRawData('notes/cut', 'import', { content: HEADED });
      await put(engine, 'notes/whole', { compiled_truth: HEADED });
      await engine.putRawData('notes/whole', 'import', { content: HEADED });
      await put(engine, 'notes/no-heading', { compiled_truth: 'short' });
      await engine.putRawData('notes/no-heading', 'import', { content: 'plain text '.repeat(120) });
      await put(engine, 'notes/small-raw', { compiled_truth: 'x' });
      await engine.putRawData('notes/small-raw', 'import', { content: '## H\nshort raw' });
      await put(engine, 'notes/other-key', { compiled_truth: 'short' });
      await engine.putRawData('notes/other-key', 'import', { text: HEADED });
      await put(engine, 'notes/gone', { compiled_truth: 'short' });
      await engine.putRawData('notes/gone', 'import', { content: HEADED });
      await engine.softDeletePage('notes/gone');
      // A segmented page has no body column to compare, so this read leaves it to the segmented count.
      await segmentedPage(engine, 'notes/segmented', 'segment text');
      await engine.putRawData('notes/segmented', 'import', { content: HEADED });
      const rows = await engine.listTruncatedMarkdownBodies();
      expect(rows.map((r) => `${r.slug}:${r.body_len}:${r.raw_len}`).sort()).toEqual([
        `notes/cut:5:${HEADED.length}`,
        `notes/gone:5:${HEADED.length}`,
      ]);
      return { empty, rows: [...rows].sort((a, b) => a.slug.localeCompare(b.slug)) };
    },
  );

  parityTest(
    'countSegmentedMarkdownBodies counts segmented pages whose raw content is over 1000 characters with a heading',
    { methods: ['putPage', 'putRawData', 'createSegmentedPageShell', 'countSegmentedMarkdownBodies'] },
    async (engine) => {
      const empty = await engine.countSegmentedMarkdownBodies();
      await segmentedPage(engine, 'notes/seg-headed', 'segment text');
      await engine.putRawData('notes/seg-headed', 'import', { content: HEADED });
      await segmentedPage(engine, 'notes/seg-plain', 'segment text');
      await engine.putRawData('notes/seg-plain', 'import', { content: 'plain text '.repeat(120) });
      await segmentedPage(engine, 'notes/seg-no-raw', 'segment text');
      await put(engine, 'notes/inline', { compiled_truth: 'short' });
      await engine.putRawData('notes/inline', 'import', { content: HEADED });
      const count = await engine.countSegmentedMarkdownBodies();
      expect({ empty, count }).toEqual({ empty: 0, count: 1 });
      return { empty, count };
    },
  );

  parityTest(
    'listRecentPageBodies reads the bodies of the newest live pages, scoped to the sources, and countSegmentedRecentPages counts the segmented ones',
    { methods: ['putPage', 'softDeletePage', 'createSegmentedPageShell', 'listRecentPageBodies', 'countSegmentedRecentPages'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      const empty = [await engine.listRecentPageBodies(null), await engine.countSegmentedRecentPages(null)];
      await put(engine, 'notes/a', { compiled_truth: 'alpha', timeline: '- 2026-01-01 a' });
      await put(engine, 'notes/gone', { compiled_truth: 'gone' });
      await engine.softDeletePage('notes/gone');
      await put(engine, 'notes/b', { compiled_truth: 'beta' }, 'other');
      await segmentedPage(engine, 'notes/seg', 'segment text');
      await segmentedPage(engine, 'notes/seg-other', 'segment text', 'other');
      const key = (rows: Array<{ compiled_truth: string | null; timeline: string | null }>) => rows.map((r) => `${r.compiled_truth}|${r.timeline}`);
      const all = await engine.listRecentPageBodies(null);
      const other = await engine.listRecentPageBodies(['other']);
      const none = await engine.listRecentPageBodies([]);
      const counts = [await engine.countSegmentedRecentPages(null), await engine.countSegmentedRecentPages(['default']), await engine.countSegmentedRecentPages(['other']), await engine.countSegmentedRecentPages([])];
      // Newest first: the segmented pages come first (their body columns are NULL), then beta, then alpha.
      expect(key(all)).toEqual(['null|null', 'null|null', 'beta|', 'alpha|- 2026-01-01 a']);
      expect(key(other)).toEqual(['null|null', 'beta|']);
      expect({ none, counts }).toEqual({ none: [], counts: [2, 1, 1, 0] });
      return { empty, all: key(all), other: key(other), none, counts };
    },
  );

  parityTest(
    'countPagesHiddenByPrefix counts served, chunked, unquarantined pages in live sources whose slug matches the pattern',
    { methods: ['putPage', 'sealChunks', 'softDeletePage', 'countPagesHiddenByPrefix'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'other');
      await createSource(engine, backend, 'shelved');
      const empty = await engine.countPagesHiddenByPrefix('test/%', null);
      const chunked = async (slug: string, extra: Partial<PageInput> = {}, sourceId = 'default') => {
        await put(engine, slug, extra, sourceId);
        await installChunks(engine, slug, [chunk(0, `${slug} text`)], { sourceId });
      };
      await chunked('test/a');
      await chunked('test/b');
      await chunked('test_under/c');
      await chunked('notes/x');
      await chunked('test/other', {}, 'other');
      await chunked('test/shelved', {}, 'shelved');
      await chunked('test/quarantined', { frontmatter: { quarantine: { reason: 'junk' } } });
      await chunked('test/pinned', { frontmatter: { pinned_question: true } });
      await chunked('test/gone');
      await engine.softDeletePage('test/gone');
      await put(engine, 'test/unchunked');
      await archiveSource(engine, backend, 'shelved');
      const count = async (pattern: string, sourceIds: string[] | null) => engine.countPagesHiddenByPrefix(pattern, sourceIds);
      const counts = {
        prefix: await count('test/%', null),
        wildcard: await count('test_%', null),
        escaped: await count('test\\_%', null),
        default: await count('test/%', ['default']),
        other: await count('test/%', ['other']),
        shelved: await count('test/%', ['shelved']),
        both: await count('test/%', ['default', 'other']),
        none: await count('test/%', []),
        miss: await count('zzz/%', null),
      };
      expect(counts).toEqual({ prefix: 3, wildcard: 4, escaped: 1, default: 2, other: 1, shelved: 0, both: 3, none: 0, miss: 0 });
      return { empty, counts };
    },
  );
});
