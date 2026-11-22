/**
 * BrainEngine parity — the import path's chunk, tag, alias, origin and seal
 * writes (the statements `importFromContent` used to run through executeRaw).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each typed write the default import path makes (keep-set chunk
 *    delete, chunker-version stamp, text seal, in-place chunk moves, the reuse
 *    read, frontmatter tag prune and batched tag add, derived-alias replace,
 *    origin refresh, seal-state read) leaves the same observable rows on every
 *    engine arm (PGLite always; Postgres with DATABASE_URL; a Rust arm later
 *    through test/engine-parity/harness.ts).
 *  - Regression: an engine that clears the text seal on the keep-set delete,
 *    deletes tags an explicit add owns, drops frontmatter aliases with the
 *    derived ones, or crosses sources would corrupt re-imports silently.
 *  - Why existing coverage misses it: test/import-file.test.ts and friends
 *    drive these statements through importFromContent on one engine at a time;
 *    nothing compares two engines on the statements themselves.
 *  - Seam: none. Real engines, typed methods only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { createSource, parityArms, pick } from './harness.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const NOTE = { type: 'note' as const, title: 'Import note', compiled_truth: 'alpha beta gamma', timeline: '' };

describe('engine parity: import-path writes', () => {
  parityTest(
    'deleteChunksExcept keeps the named rows and the text seal, in one source only',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'deleteChunksExcept'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      for (const sourceId of ['default', 'work']) {
        await engine.putPage('notes/keep', NOTE, { sourceId });
        await installChunks(engine, 'notes/keep', [chunk(0, 'zero'), chunk(1, 'one'), chunk(2, 'two')], { sourceId });
      }
      const before = await engine.getChunks('notes/keep', { sourceId: 'default' });
      const keep = before.filter((c) => c.chunk_text !== 'one').map((c) => c.id);
      await engine.deleteChunksExcept('notes/keep', keep, { sourceId: 'default' });
      // The seal survives (getChunks serves sealed projections only), unlike deleteChunks.
      const kept = await engine.getChunks('notes/keep', { sourceId: 'default' });
      expect(kept.map((c) => c.chunk_text)).toEqual(['zero', 'two']);
      expect((await engine.getChunks('notes/keep', { sourceId: 'work' })).map((c) => c.chunk_text)).toEqual(['zero', 'one', 'two']);
      // An empty keep-set deletes every chunk of that page; the sealed read still answers (empty) rather than refusing.
      await engine.deleteChunksExcept('notes/keep', [], { sourceId: 'work' });
      const work = await engine.getChunks('notes/keep', { sourceId: 'work' });
      expect(work).toEqual([]);
      return { kept: kept.map((c) => `${c.chunk_index}:${c.chunk_text}`), work };
    },
  );

  parityTest(
    'setChunkerVersion stamps one page; getPageSealState reads it back and answers null for a deleted or unknown page',
    { methods: ['putPage', 'getPage', 'setChunkerVersion', 'getPageSealState', 'softDeletePage'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await engine.putPage('notes/ver', NOTE);
      await engine.putPage('notes/ver', NOTE, { sourceId: 'work' });
      const page = (await engine.getPage('notes/ver'))!;
      const other = (await engine.getPage('notes/ver', { sourceId: 'work' }))!;
      const otherBefore = await engine.getPageSealState(other.id);
      await engine.setChunkerVersion('notes/ver', 7, { sourceId: 'default' });
      const stamped = await engine.getPageSealState(page.id);
      expect(stamped).toEqual({ chunker_version: 7 });
      expect(await engine.getPageSealState(other.id)).toEqual(otherBefore);
      await engine.softDeletePage('notes/ver');
      const deleted = await engine.getPageSealState(page.id);
      const unknown = await engine.getPageSealState(2_000_000_000);
      expect(deleted).toBeNull();
      expect(unknown).toBeNull();
      return { stamped, deleted, unknown, otherUnchanged: true };
    },
  );

  parityTest(
    'writeTextProjectionSeal seals only at the page revision and serves the chunks afterwards',
    { methods: ['putPage', 'upsertChunks', 'getChunks', 'readPageSnapshot', 'writeTextProjectionSeal', 'searchTitles'] },
    async (engine) => {
      await engine.putPage('notes/seal', { ...NOTE, title: 'Zebrafish seal' });
      await engine.upsertChunks('notes/seal', [chunk(0, 'sealed body text')]);
      const snapshot = (await engine.readPageSnapshot('notes/seal'))!;
      const hiddenBefore = await engine.getChunks('notes/seal');
      expect(hiddenBefore).toEqual([]);
      // A revision the page does not hold seals nothing.
      await engine.writeTextProjectionSeal('notes/seal', { sourceId: 'default', revision: '00000000-0000-0000-0000-000000000000', timelineText: '' });
      const stillHidden = await engine.getChunks('notes/seal');
      expect(stillHidden).toEqual([]);
      await engine.writeTextProjectionSeal('notes/seal', { sourceId: 'default', revision: snapshot.revision, timelineText: '' });
      const served = await engine.getChunks('notes/seal');
      expect(served.map((c) => c.chunk_text)).toEqual(['sealed body text']);
      // The rebuilt page search vector carries the title.
      const hits = await engine.searchTitles('zebrafish', { limit: 5 });
      expect(hits.map((h) => h.slug)).toEqual(['notes/seal']);
      return { stillHidden, served: served.map((c) => c.chunk_text), hits: hits.map((h) => h.slug) };
    },
  );

  parityTest(
    'moveChunkIndexes swaps two kept chunks through a parking index and rewrites their spans',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'moveChunkIndexes'] },
    async (engine) => {
      await engine.putPage('notes/moves', NOTE);
      await installChunks(engine, 'notes/moves', [
        chunk(0, 'first', { projected_byte_start: 0, projected_byte_end: 5 }),
        chunk(1, 'second', { projected_byte_start: 6, projected_byte_end: 12 }),
      ]);
      const [a, b] = await engine.getChunks('notes/moves');
      const pageId = a!.page_id;
      // Wave 1 parks b at -2 (keeps its span); wave 2 lands a at 1 with a new span; wave 3 lands b at 0.
      await engine.moveChunkIndexes(pageId, [
        [{ id: b!.id, from: 1, to: -2 }],
        [{ id: a!.id, from: 0, to: 1, projected_byte_start: 7, projected_byte_end: 12 }],
        [{ id: b!.id, from: -2, to: 0, projected_byte_start: 0, projected_byte_end: 6 }],
      ]);
      await engine.moveChunkIndexes(pageId, []);
      const after = (await engine.getChunks('notes/moves')).map((c) => pick(c, ['chunk_index', 'chunk_text', 'projected_byte_start', 'projected_byte_end'] as const));
      expect(after).toEqual([
        { chunk_index: 0, chunk_text: 'second', projected_byte_start: 0, projected_byte_end: 6 },
        { chunk_index: 1, chunk_text: 'first', projected_byte_start: 7, projected_byte_end: 12 },
      ]);
      return after;
    },
  );

  parityTest(
    'getChunkReuseRows reports each stored chunk\'s recorded input and embedding flags, per source',
    { methods: ['putPage', 'upsertChunks', 'getChunkReuseRows'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await engine.putPage('notes/reuse', NOTE);
      await engine.putPage('notes/reuse', NOTE, { sourceId: 'work' });
      await engine.upsertChunks('notes/reuse', [chunk(0, 'no vector yet'), chunk(1, 'also none')]);
      await engine.upsertChunks('notes/reuse', [chunk(0, 'other source')], { sourceId: 'work' });
      const rows = (await engine.getChunkReuseRows('notes/reuse', { sourceId: 'default' })).sort((x, y) => x.chunk_index - y.chunk_index);
      const work = await engine.getChunkReuseRows('notes/reuse', { sourceId: 'work' });
      const none = await engine.getChunkReuseRows('notes/missing', { sourceId: 'default' });
      expect(rows.map((r) => [r.chunk_index, r.unembedded, r.text_only, r.embedding_input_hash])).toEqual([[0, true, false, null], [1, true, false, null]]);
      expect(work).toHaveLength(1);
      expect(none).toEqual([]);
      return { rows, work, none };
    },
  );

  parityTest(
    'pruneFrontmatterTags and addPageTagsById keep explicitly added tags and adopt only frontmatter claims',
    { methods: ['putPage', 'getPage', 'addPageTagsById', 'pruneFrontmatterTags', 'getTags'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await engine.putPage('notes/tags', NOTE);
      await engine.putPage('notes/tags', NOTE, { sourceId: 'work' });
      const page = (await engine.getPage('notes/tags'))!;
      const other = (await engine.getPage('notes/tags', { sourceId: 'work' }))!;
      await engine.addPageTagsById(page.id, []);
      await engine.addPageTagsById(page.id, ['fm-keep', 'fm-drop', 'fm-keep'], { tagSource: 'frontmatter' });
      await engine.addPageTagsById(page.id, ['claimed', 'fm-drop']);
      await engine.addPageTagsById(other.id, ['fm-drop'], { tagSource: 'frontmatter' });
      const added = await engine.getTags('notes/tags');
      expect(added).toEqual(['claimed', 'fm-drop', 'fm-keep']);
      // 'fm-drop' was then claimed by an explicit add, so a prune never deletes it.
      await engine.pruneFrontmatterTags('notes/tags', ['claimed'], { sourceId: 'default' });
      const pruned = await engine.getTags('notes/tags');
      expect(pruned).toEqual(['claimed', 'fm-drop']);
      // Another source's frontmatter tag is untouched by the default source's prune.
      expect(await engine.getTags('notes/tags', { sourceId: 'work' })).toEqual(['fm-drop']);
      await engine.pruneFrontmatterTags('notes/tags', [], { sourceId: 'work' });
      const workPruned = await engine.getTags('notes/tags', { sourceId: 'work' });
      expect(workPruned).toEqual([]);
      return { added, pruned, workPruned };
    },
  );

  parityTest(
    'replaceDerivedAliases swaps derived rows only and stays in its source',
    { methods: ['putPage', 'setPageAliases', 'replaceDerivedAliases', 'resolveAliases'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme makes things.', timeline: '' });
      await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: 'Acme makes things.', timeline: '' }, { sourceId: 'work' });
      const flat = (m: Map<string, Array<{ slug: string; source_id: string }>>) => [...m].map(([k, v]) => [k, v.map((r) => `${r.source_id}:${r.slug}`)]);
      const query = ['acme', 'acme inc', 'acme corp', 'fm alias'];
      await engine.setPageAliases('companies/acme', 'default', ['fm alias']);
      await engine.replaceDerivedAliases('companies/acme', 'default', [
        { alias_norm: 'acme', origin: 'declared', case_sensitive: false, alias_text: 'Acme' },
        { alias_norm: 'acme inc', origin: 'subject', case_sensitive: false, alias_text: 'Acme Inc' },
      ]);
      await engine.replaceDerivedAliases('companies/acme', 'work', [{ alias_norm: 'acme corp', origin: 'declared', case_sensitive: true, alias_text: 'Acme Corp' }]);
      const first = flat(await engine.resolveAliases(query, { sourceId: 'default' }));
      expect(first).toEqual([['acme', ['default:companies/acme']], ['acme inc', ['default:companies/acme']], ['fm alias', ['default:companies/acme']]]);
      await engine.replaceDerivedAliases('companies/acme', 'default', [{ alias_norm: 'acme corp', origin: 'declared', case_sensitive: false, alias_text: 'Acme Corp' }]);
      const second = flat(await engine.resolveAliases(query, { sourceId: 'default' }));
      expect(second).toEqual([['acme corp', ['default:companies/acme']], ['fm alias', ['default:companies/acme']]]);
      await engine.replaceDerivedAliases('companies/acme', 'default', []);
      const cleared = flat(await engine.resolveAliases(query, { sourceId: 'default' }));
      expect(cleared).toEqual([['fm alias', ['default:companies/acme']]]);
      const work = flat(await engine.resolveAliases(query, { sourceId: 'work' }));
      expect(work).toEqual([['acme corp', ['work:companies/acme']]]);
      return { first, second, cleared, work };
    },
  );

  parityTest(
    'refreshPageOrigin records a live page\'s file path and fills a missing source URI without clobbering one',
    { methods: ['putPage', 'getPage', 'refreshPageOrigin', 'softDeletePage'] },
    async (engine) => {
      await engine.putPage('notes/origin', NOTE);
      await engine.putPage('notes/gone', NOTE);
      await engine.refreshPageOrigin('notes/origin', { sourceId: 'default', sourcePath: 'notes/origin.md', sourceUri: 'file:///brain/notes/origin.md' });
      const first = pick((await engine.getPage('notes/origin'))!, ['source_path', 'source_uri'] as const);
      expect(first).toEqual({ source_path: 'notes/origin.md', source_uri: 'file:///brain/notes/origin.md' });
      // No URI given: the path moves, the stored URI stays.
      await engine.refreshPageOrigin('notes/origin', { sourceId: 'default', sourcePath: 'moved/origin.md', sourceUri: null });
      const second = pick((await engine.getPage('notes/origin'))!, ['source_path', 'source_uri'] as const);
      expect(second).toEqual({ source_path: 'moved/origin.md', source_uri: 'file:///brain/notes/origin.md' });
      // A deleted page is never touched.
      await engine.softDeletePage('notes/gone');
      await engine.refreshPageOrigin('notes/gone', { sourceId: 'default', sourcePath: 'gone.md' });
      const gone = pick((await engine.getPage('notes/gone', { includeDeleted: true }))!, ['source_path'] as const);
      expect(gone.source_path ?? null).toBeNull();
      return { first, second, gone: gone.source_path ?? null };
    },
  );
});
