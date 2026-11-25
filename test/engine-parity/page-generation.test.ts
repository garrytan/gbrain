/**
 * BrainEngine parity: the per-page generation counter (`pages.generation`), read through the pinned-question reads.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a page's generation moves exactly as the SQL engines' trigger moves it (src/schema.sql,
 *    PAGE_GENERATION_BUMP_FN_SQL): an insert takes MAX(generation over every page, soft-deleted ones included) + 1; an
 *    update adds one when a watched column changes (compiled_truth, timeline, frontmatter, deleted_at, title, type,
 *    page_kind, content_hash, contextual_retrieval_mode, corpus_generation) or, on a page whose body is NULL, when its
 *    body_generation moves; nothing else moves it. One statement adds at most one. A purge lowers the highest
 *    generation, and the next insert takes the number the purge freed. PGLite, Postgres and Rust read the same numbers.
 *  - Regression: the Rust store kept no counter and read every page as generation 1, so a pin's evidence watermark, a
 *    receipt's page revision check and the freshness read answered differently on a Rust brain.
 *  - Why existing coverage misses it: the SQL engines' trigger is exercised only through the query cache and the pin
 *    refresh, on PGLite; no test compares the numbers across engines.
 *  - Seam: real engines, typed members only. The generation is read through readQuestionPageRow (live pages),
 *    lockQuestionEvidenceRows (any page, soft-deleted ones too) and readQuestionEvidenceClock (the highest).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { pageMeta, publishSegmentedPage, segmentText, stageGeneration, flipInput } from '../helpers/page-body-fixtures.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const page = (title: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'note' as const, title, compiled_truth: `body of ${title}`, timeline: '', frontmatter: {}, ...extra });

/** The generation of every page named, soft-deleted ones included, by slug; and the highest generation of the brain. */
async function gens(engine: BrainEngine, ids: Record<string, number>) {
  const slugs = Object.keys(ids);
  const rows = await engine.lockQuestionEvidenceRows('page', slugs.map(s => ids[s]!));
  const byId = new Map(rows.map(r => [Number(r.id), Number(r.generation)]));
  return { pages: Object.fromEntries(slugs.map(s => [s, byId.get(ids[s]!) ?? null])), clock: (await engine.readQuestionEvidenceClock('default')).generation };
}

const METHODS = ['putPage', 'lockQuestionEvidenceRows', 'readQuestionEvidenceClock'] as const;

describe('the per-page generation counter on every engine', () => {
  parityTest('an insert takes the highest generation of the brain plus one', {
    methods: [...METHODS, 'readQuestionPageRow'],
  }, async (engine) => {
    const ids: Record<string, number> = {};
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) ids[slug] = (await engine.putPage(slug, page(slug))).id;
    const seen = await gens(engine, ids);
    const live = await engine.readQuestionPageRow('default', 'notes/b');
    expect(seen).toEqual({ pages: { 'notes/a': 1, 'notes/b': 2, 'notes/c': 3 }, clock: 3 });
    expect(live?.generation).toBe(2);
    return { seen, live: live && { generation: live.generation, archived: live.archived, body_storage: live.body_storage } };
  });

  parityTest('a change to any watched column adds one, and a rewrite that changes none adds nothing', {
    methods: METHODS,
  }, async (engine) => {
    const { id } = await engine.putPage('notes/a', page('a'));
    const ids = { 'notes/a': id };
    const steps: Array<[string, number | null]> = [];
    const step = async (label: string) => steps.push([label, (await gens(engine, ids)).pages['notes/a'] ?? null]);
    await step('insert');
    await engine.putPage('notes/a', page('a'));
    await step('identical rewrite');
    await engine.putPage('notes/a', page('a', { compiled_truth: 'a new body' }));
    await step('compiled_truth');
    await engine.putPage('notes/a', page('a', { compiled_truth: 'a new body', timeline: '- 2026-01-01: it began' }));
    await step('timeline');
    await engine.putPage('notes/a', page('a', { compiled_truth: 'a new body', timeline: '- 2026-01-01: it began', frontmatter: { k: 'v' } }));
    await step('frontmatter');
    await engine.putPage('notes/a', page('a retitled', { compiled_truth: 'a new body', timeline: '- 2026-01-01: it began', frontmatter: { k: 'v' } }));
    await step('title');
    await engine.putPage('notes/a', page('a retitled', { type: 'person', compiled_truth: 'a new body', timeline: '- 2026-01-01: it began', frontmatter: { k: 'v' } }));
    await step('type');
    await engine.putPage('notes/a', page('a retitled', { type: 'person', page_kind: 'code', compiled_truth: 'a new body', timeline: '- 2026-01-01: it began', frontmatter: { k: 'v' } }));
    await step('page_kind');
    await engine.putPage('notes/a', page('a retitled', { type: 'person', page_kind: 'code', content_hash: 'hash-two', compiled_truth: 'a new body', timeline: '- 2026-01-01: it began', frontmatter: { k: 'v' } }));
    await step('content_hash');
    expect(steps.map(([, g]) => g)).toEqual([1, 1, 2, 3, 4, 5, 6, 7, 8]);
    return steps;
  });

  parityTest('writes that change no watched column leave the generation alone', {
    methods: [...METHODS, 'addTag', 'removeTag', 'updateSlug'],
  }, async (engine) => {
    const { id } = await engine.putPage('notes/a', page('a'));
    const ids = { 'notes/b': id };
    const seen: Array<[string, number | null]> = [];
    const step = async (label: string) => seen.push([label, (await gens(engine, ids)).pages['notes/b'] ?? null]);
    await engine.addTag('notes/a', 'one');
    await step('addTag');
    await engine.removeTag('notes/a', 'one');
    await step('removeTag');
    // The file path and the effective date are written by the same upsert as the body, and the trigger does not watch them.
    await engine.putPage('notes/a', { ...page('a'), source_path: 'notes/a.md', effective_date: '2026-02-03' } as never);
    await step('source_path and effective_date');
    await engine.updateSlug('notes/a', 'notes/b');
    await step('updateSlug');
    expect(seen.map(([, g]) => g)).toEqual([1, 1, 1, 1]);
    return seen;
  });

  parityTest('one statement adds one generation however many watched columns it changes', {
    methods: METHODS,
  }, async (engine) => {
    const { id } = await engine.putPage('notes/a', page('a'));
    await engine.putPage('notes/a', { ...page('another title', { compiled_truth: 'another body', timeline: '- 2026-01-01: x', frontmatter: { k: 'v' } }), type: 'person' } as never);
    const seen = await gens(engine, { 'notes/a': id });
    expect(seen.pages['notes/a']).toBe(2);
    return seen;
  });

  parityTest('a soft delete and a restore each add one; deleting a deleted page adds nothing', {
    methods: [...METHODS, 'softDeletePage', 'restorePage'],
  }, async (engine) => {
    const { id } = await engine.putPage('notes/a', page('a'));
    await engine.putPage('notes/other', page('other'));
    const ids = { 'notes/a': id };
    const seen: Array<[string, number | null, number]> = [];
    const step = async (label: string) => { const g = await gens(engine, ids); seen.push([label, g.pages['notes/a'] ?? null, g.clock]); };
    await step('insert');
    await engine.softDeletePage('notes/a');
    await step('soft delete');
    await engine.softDeletePage('notes/a');
    await step('soft delete again');
    await engine.restorePage('notes/a');
    await step('restore');
    // A soft-deleted page still counts toward the highest generation: the next insert takes the number above it.
    await engine.softDeletePage('notes/a');
    await step('soft delete the page that holds the highest generation');
    const next = (await engine.putPage('notes/next', page('next'))).id;
    const inserted = (await gens(engine, { 'notes/next': next })).pages['notes/next'] ?? null;
    seen.push(['insert after it', inserted, -1]);
    // An update adds one to the page's own generation (the other page's insert took 2), so two pages can share a number.
    expect(seen.map(([, g]) => g)).toEqual([1, 2, 2, 3, 4, 5]);
    return seen;
  });

  parityTest('purging the page that holds the highest generation frees its number for the next insert', {
    methods: [...METHODS, 'deletePage'],
  }, async (engine) => {
    const ids: Record<string, number> = {};
    for (const slug of ['notes/a', 'notes/b', 'notes/c']) ids[slug] = (await engine.putPage(slug, page(slug))).id;
    await engine.putPage('notes/a', page('a', { compiled_truth: 'edited' }));
    const before = await gens(engine, ids);
    await engine.deletePage('notes/a');
    const afterFirst = await gens(engine, { 'notes/b': ids['notes/b']!, 'notes/c': ids['notes/c']! });
    await engine.deletePage('notes/c');
    const afterSecond = await gens(engine, { 'notes/b': ids['notes/b']! });
    const next = (await engine.putPage('notes/d', page('d'))).id;
    const inserted = await gens(engine, { 'notes/b': ids['notes/b']!, 'notes/d': next });
    expect(before).toEqual({ pages: { 'notes/a': 2, 'notes/b': 2, 'notes/c': 3 }, clock: 3 });
    expect(afterFirst.clock).toBe(3);
    expect(afterSecond.clock).toBe(2);
    expect(inserted.pages['notes/d']).toBe(3);
    return { before, afterFirst, afterSecond, inserted };
  });

  parityTest('a purged soft-deleted page that held the highest generation frees its number too', {
    methods: [...METHODS, 'softDeletePage', 'deletePage'],
  }, async (engine) => {
    const a = (await engine.putPage('notes/a', page('a'))).id;
    await engine.putPage('notes/b', page('b'));
    await engine.softDeletePage('notes/b');
    await engine.softDeletePage('notes/b');
    const before = (await gens(engine, { 'notes/a': a })).clock;
    await engine.deletePage('notes/b');
    const after = (await gens(engine, { 'notes/a': a })).clock;
    const next = (await engine.putPage('notes/c', page('c'))).id;
    const inserted = (await gens(engine, { 'notes/c': next })).pages['notes/c'];
    expect([before, after, inserted]).toEqual([3, 1, 2]);
    return { before, after, inserted };
  });

  parityTest('a contextual retrieval stamp is one watched change, alone or with a body change', {
    methods: [...METHODS],
  }, async (engine) => {
    const { id } = await engine.putPage('notes/a', page('a'));
    const ids = { 'notes/a': id };
    const seen: Array<[string, number | null]> = [];
    const step = async (label: string) => seen.push([label, (await gens(engine, ids)).pages['notes/a'] ?? null]);
    await step('insert');
    await engine.putPage('notes/a', page('a'), { contextualRetrieval: { mode: 'title', corpusGeneration: 'g1' } });
    await step('stamp on an identical page');
    await engine.putPage('notes/a', page('a'), { contextualRetrieval: { mode: 'title', corpusGeneration: 'g1' } });
    await step('the same stamp again');
    await engine.putPage('notes/a', page('a'), { contextualRetrieval: { mode: 'title', corpusGeneration: 'g2' } });
    await step('a new corpus generation');
    await engine.putPage('notes/a', page('a'), { contextualRetrieval: { mode: 'none', corpusGeneration: 'g3' } });
    await step('mode none writes nothing');
    await engine.putPage('notes/a', page('a'));
    await step('no stamp keeps the stored one');
    await engine.putPage('notes/a', page('a', { compiled_truth: 'edited' }), { contextualRetrieval: { mode: 'per_chunk_synopsis', corpusGeneration: 'g9' } });
    await step('stamp and body change in one statement');
    expect(seen.map(([, g]) => g)).toEqual([1, 2, 2, 3, 3, 3, 4]);
    return seen;
  });

  parityTest('stamping the contextual retrieval state alone adds one when it changes and nothing when it does not', {
    methods: [...METHODS, 'updatePageContextualRetrievalState'],
  }, async (engine) => {
    const { id } = await engine.putPage('notes/a', page('a'));
    const ids = { 'notes/a': id };
    const seen: Array<[string, number | null]> = [];
    const step = async (label: string) => seen.push([label, (await gens(engine, ids)).pages['notes/a'] ?? null]);
    await engine.updatePageContextualRetrievalState('notes/a', 'default', 'title', 'g1');
    await step('first stamp');
    await engine.updatePageContextualRetrievalState('notes/a', 'default', 'title', 'g1');
    await step('same stamp');
    await engine.updatePageContextualRetrievalState('notes/a', 'default', 'title', 'g2');
    await step('corpus generation moves');
    await engine.updatePageContextualRetrievalState('notes/a', 'default', 'none', null);
    await step('back to none');
    expect(seen.map(([, g]) => g)).toEqual([2, 2, 3, 4]);
    return seen;
  });

  parityTest('a segmented page: the shell insert, a publish, a republish that moves only the body generation, and a seal', {
    methods: [...METHODS, 'createSegmentedPageShell', 'flipBodyGeneration', 'sealSegmentedPage'],
  }, async (engine) => {
    await engine.putPage('notes/first', page('first'));
    const texts = [segmentText('# One\nfirst segment about quillwort\n'), segmentText('## Two\nsecond segment about heron\n')];
    const { pageId, occurrences } = await publishSegmentedPage(engine, 'notes/seg', texts);
    const ids = { 'notes/seg': pageId };
    const seen: Array<[string, number | null]> = [];
    const step = async (label: string) => seen.push([label, (await gens(engine, ids)).pages['notes/seg'] ?? null]);
    await step('shell, then the first publish');
    await engine.sealSegmentedPage(pageId);
    await step('seal');
    // The same texts again as generation 2: the body columns are NULL on both sides and the content hash is the same,
    // so only body_generation moves.
    const staged = await stageGeneration(engine, { pageId, slug: 'notes/seg', genFrom: 2, texts });
    await engine.transaction(async tx => {
      await tx.flipBodyGeneration(flipInput(pageId, 1, staged.stagingId, texts, { closeOccurrences: occurrences, retireChunkOccurrences: [] }));
      await tx.setBodyStagingState(staged.stagingId, 'committed');
    });
    await step('republish at generation 2');
    const shell = await engine.createSegmentedPageShell('notes/seg-two', pageMeta(), { sourceId: 'default' });
    const second = await gens(engine, { 'notes/seg-two': shell.id });
    seen.push(['second shell', second.pages['notes/seg-two'] ?? null]);
    // The shell insert is 2 (after notes/first) and its first publish adds one; the seal adds nothing; the republish adds
    // one through body_generation alone; the next shell takes the highest generation (4) plus one.
    expect(seen.map(([, g]) => g)).toEqual([3, 3, 4, 5]);
    return seen;
  });
});
