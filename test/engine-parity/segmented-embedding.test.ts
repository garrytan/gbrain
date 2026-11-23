/**
 * BrainEngine parity — embedding a segmented page (`src/core/page-body/segmented-embedding.ts`): the page read, the
 * unsealed probe, the dry-run counts, the keyset listing of stale rows, the recorded inputs, the vector install, the
 * live segments and one segment's rows; and the vector reuse a replace makes from the rows it retires
 * (`readRetiredChunkVectors`, then `stageSegmentChunks` with the reused vectors).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on a sealed segmented page, every arm reads the same page, the same counts, the same stale rows newest
 *    first, the same live segments and segment rows; an install puts the vectors on the rows with the same index and
 *    text, refuses a stale or mismatched one, and the counts and recorded inputs follow; a replace that keeps half the
 *    body copies the vectors of the unchanged retired rows onto the new rows, with the same vectors and inputs
 *    (PGLite always; Postgres with DATABASE_URL; Rust with GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: an engine that refuses one statement of the segmented embed (each was raw SQL) stops the embed on
 *    that engine; the Rust engine has no SQL dialect, so each must be a typed member. A retired-vector read that
 *    returns nothing, or a staging that drops a reused vector, leaves the replaced page with more stale rows.
 *  - Why existing coverage misses it: test/large-pages/segmented-embedding*.test.ts run on PGLite and Postgres only,
 *    on a fixture written with raw SQL, never compared across arms.
 *  - Seam: the leaf functions are called directly. embedSegmentedRows and embedSegmentedPage also take the page's
 *    embedding lease and per-page budget (page-embedding-lease.ts, page-embedding-budget.ts), which keep raw SQL of
 *    their own, so a whole embed is not compared here. The page is written through the string import's staging, as
 *    in segmented-rewrite.test.ts. Page, chunk and occurrence ids are never compared.
 */
import { describe, expect } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import { embeddingInputHash, plainEmbeddingTier } from '../../src/core/embedding-input-hash.ts';
import { readPageBodyPolicy } from '../../src/core/page-body/limits.ts';
import { countSegmentedEmbedRows, installSegmentedVectors, listLiveEmbedSegments, listSegmentChunkRows, listSegmentedStaleRows,
  readSealedSegmentedEmbedPage, readSegmentedEmbedPage, type SegmentedEmbedPage, type SegmentedStaleRow } from '../../src/core/page-body/segmented-embedding.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';
import { sealSegmentedPage, stageSegmentedImport } from '../../src/core/persistence/segmented-apply.ts';
import { parseEmbedding } from '../../src/core/utils.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { parityArms } from './harness.ts';

const { parityTest } = parityArms(testBackends());

const sha = (text: string) => createHash('sha256').update(text).digest('hex');
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** Write `truth` as the segmented body of `slug` through the string import's staging (see segmented-rewrite.test.ts). */
async function stagedPage(engine: BrainEngine, slug: string, truth: string) {
  const existing = await engine.getPage(slug);
  const meta = { title: slug, type: 'note' as const, frontmatter: {}, page_kind: 'markdown' as const };
  const staged = await stageSegmentedImport(engine, { slug, sourceId: 'default', existing, policy: await readPageBodyPolicy(engine), baseRevision: null,
    page: { title: slug, type: 'note', compiled_truth: truth, timeline: '', frontmatter: {}, tags: [] }, chunking: { quarantined: false, corpusGeneration: null, tier: 'none' } });
  await engine.transaction(async tx => {
    if (existing) await tx.createVersion(slug, { sourceId: 'default' });
    const applied = await staged.apply(tx, meta, { mode: 'none', corpusGeneration: null });
    if (applied.complete) await sealSegmentedPage(tx, applied.pageId);
  });
  expect(await staged.afterCommit(engine)).toBe(true);
}

/** A unit vector of the write column's width, distinct per chunk index. */
const unit = (dims: number, index: number) => Float32Array.from({ length: dims }, (_, i) => (i === index % dims ? 1 : 0));

/** The page a segmented embed reads, without its id. */
const pageView = (page: SegmentedEmbedPage | null) => page && { ...page, id: typeof page.id === 'number' && page.id > 0 };

/** Stale rows as text hashes in listing order, with their rank in chunk_index order (indexes are the store's to pick). */
const rowsView = (rows: readonly SegmentedStaleRow[]) => ({
  count: rows.length, texts: sha(rows.map(row => `${row.chunk_source}\0${row.chunk_text}`).join('\n')),
  descending: rows.every((row, i) => i === 0 || rows[i - 1]!.chunk_index > row.chunk_index),
});

/** Install a vector, with its real recorded input, on each of `rows`; returns how many rows took one. */
async function install(engine: BrainEngine, page: SegmentedEmbedPage, rows: readonly SegmentedStaleRow[], opts: { replacing?: boolean } = {}) {
  const target = await embeddingWriteTarget(engine);
  const provenance = embeddingInputContext(target, page.title, null, []);
  const tier = plainEmbeddingTier(page.contextual_retrieval_mode);
  return installSegmentedVectors(engine, page, target, rows.map(row => {
    const hash = embeddingInputHash(provenance, tier, row);
    return { chunk_index: row.chunk_index, chunk_text: row.chunk_text, vector: unit(target.column.dimensions, row.chunk_index), hash,
      expected: opts.replacing ? hash : null };
  }));
}

/** Every live row of the page, newest first, through the keyset listing. */
async function allRows(engine: BrainEngine, pageId: number, includeEmbedded: boolean) {
  const rows: SegmentedStaleRow[] = [];
  for (let before: number | null = null; ;) {
    const batch = await listSegmentedStaleRows(engine, pageId, 'embedding', { beforeChunkIndex: before, limit: 200, includeEmbedded });
    if (batch.length === 0) return rows;
    rows.push(...batch);
    before = batch[batch.length - 1]!.chunk_index;
  }
}

describe('engine parity: segmented embedding', () => {
  parityTest('a segmented embed reads the sealed page, lists its stale rows, installs vectors and refuses a stale install',
    { methods: ['setConfig', 'getPage', 'transaction', 'softDeletePage', 'lockPageKeys', 'readSegmentedEmbedPage', 'hasLiveSegmentedPage',
      'countSegmentedEmbedRows', 'listSegmentedStaleRows', 'readSegmentChunkInputHashes', 'installSegmentedVectors', 'listLiveEmbedSegments',
      'listSegmentChunkRows'], timeout: 600_000 },
    async (engine) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      await stagedPage(engine, 'notes/embed', conversationBody(1300 * 1024, { seed: 41 }));
      const ref = { slug: 'notes/embed', source_id: 'default', body_storage: 'segmented' as const };
      const page = (await readSealedSegmentedEmbedPage(engine, ref, true))!;
      expect(page).not.toBeNull();
      const byId = await readSegmentedEmbedPage(engine, { id: page.id });
      const counts = await countSegmentedEmbedRows(engine, page.id);
      const first = await listSegmentedStaleRows(engine, page.id, 'embedding', { beforeChunkIndex: null, limit: 5 });
      const next = await listSegmentedStaleRows(engine, page.id, 'embedding', { beforeChunkIndex: first[first.length - 1]!.chunk_index, limit: 5 });
      const segments = await listLiveEmbedSegments(engine, page.id);
      const newest = await listSegmentChunkRows(engine, page.id, segments[0]!.occurrenceId);
      const oldest = await listSegmentChunkRows(engine, page.id, segments[segments.length - 1]!.occurrenceId);
      const onlyNewest = await listSegmentedStaleRows(engine, page.id, 'embedding', { beforeChunkIndex: null, limit: 1000, occurrenceIds: [segments[0]!.occurrenceId] });

      const installed = await install(engine, page, first);
      // The same vectors again, read before the first install: each row's recorded input moved, so none installs.
      const stale = await install(engine, page, first);
      // A row whose text is not the stored text takes nothing.
      const mismatched = await install(engine, page, [{ ...next[0]!, chunk_text: `${next[0]!.chunk_text} (edited)` }]);
      // A writer that read the recorded input it replaces installs over it.
      const replaced = await install(engine, page, first.slice(0, 2), { replacing: true });
      const after = {
        counts: await countSegmentedEmbedRows(engine, page.id),
        stale: rowsView(await listSegmentedStaleRows(engine, page.id, 'embedding', { beforeChunkIndex: null, limit: 5 })),
        withEmbedded: rowsView(await listSegmentedStaleRows(engine, page.id, 'embedding', { beforeChunkIndex: null, limit: 5, includeEmbedded: true })),
        newest: (await listSegmentChunkRows(engine, page.id, segments[0]!.occurrenceId)).map(row => row.embedding_input_hash !== null),
        inputs: (await engine.readSegmentChunkInputHashes(page.id, [...first, next[0]!].map(row => row.chunk_index)))
          .map(row => ({ chunk_index: Number(row.chunk_index), hash: row.embedding_input_hash })).sort((x, y) => x.chunk_index - y.chunk_index),
        live: { page: await engine.hasLiveSegmentedPage('default', 'notes/embed'), missing: await engine.hasLiveSegmentedPage('default', 'notes/none') },
      };
      // A title change after the read moves the page, so the install refuses the whole batch.
      const moved = await install(engine, { ...page, title: 'another title' }, next);
      await engine.softDeletePage('notes/embed');
      const deleted = { read: await readSegmentedEmbedPage(engine, { id: page.id }), sealed: await readSealedSegmentedEmbedPage(engine, ref, true),
        live: await engine.hasLiveSegmentedPage('default', 'notes/embed') };
      return {
        page: pageView(page), byId: pageView(byId), counts, first: rowsView(first), next: rowsView(next),
        keyset: first[first.length - 1]!.chunk_index > next[0]!.chunk_index,
        segments: { count: segments.length, sha256: sha(segments.map(s => hex(s.sha256)).join(',')), entryStates: sha(JSON.stringify(segments.map(s => s.entryState))) },
        newest: { rows: newest.length, texts: sha(newest.map(r => `${r.chunk_source}\0${r.chunk_text}`).join('\n')), inputs: newest.map(r => r.embedding_input_hash),
          ordered: newest.every((r, i) => i === 0 || newest[i - 1]!.chunk_index < r.chunk_index) },
        oldest: { rows: oldest.length, texts: sha(oldest.map(r => `${r.chunk_source}\0${r.chunk_text}`).join('\n')) },
        onlyNewest: rowsView(onlyNewest), installed, stale, mismatched, replaced, after, moved, deleted,
      };
    });

  parityTest('a replace that keeps half the body carries the vectors of the unchanged retired rows onto the new rows',
    { methods: ['setConfig', 'getPage', 'transaction', 'createVersion', 'lockPageKeys', 'readSegmentedEmbedPage', 'listSegmentedStaleRows',
      'installSegmentedVectors', 'readRetiredChunkVectors', 'stageSegmentChunks'], timeout: 600_000 },
    async (engine) => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const half = conversationBody(700 * 1024, { seed: 51 });
      await stagedPage(engine, 'notes/reuse', `${half}\n\n${conversationBody(700 * 1024, { seed: 52 })}`);
      const page = (await readSealedSegmentedEmbedPage(engine, { slug: 'notes/reuse', source_id: 'default', body_storage: 'segmented' }, true))!;
      const rows = await allRows(engine, page.id, false);
      let installed = 0;
      for (let at = 0; at < rows.length; at += 200) installed += await install(engine, page, rows.slice(at, at + 200));
      const before = await countSegmentedEmbedRows(engine, page.id);
      await stagedPage(engine, 'notes/reuse', `${half}\n\n${conversationBody(700 * 1024, { seed: 53 })}`);
      const replaced = (await readSealedSegmentedEmbedPage(engine, { slug: 'notes/reuse', source_id: 'default', body_storage: 'segmented' }, true))!;
      const after = await countSegmentedEmbedRows(engine, replaced.id);
      expect(after.stale).toBeLessThan(after.total);
      // The vectors on the kept rows are the ones installed on the same text before the replace.
      const kept = (await allRows(engine, replaced.id, true)).filter(row => rows.some(old => old.chunk_text === row.chunk_text));
      const vectors = await engine.readRetiredChunkVectors(replaced.id, (await listLiveEmbedSegments(engine, replaced.id)).map(s => s.occurrenceId), 'embedding');
      const target = await embeddingWriteTarget(engine);
      const byText = new Map(rows.map(row => [row.chunk_text, row.chunk_index]));
      const carried = vectors.filter(v => byText.has(v.chunk_text));
      return {
        rows: rows.length, installed, before, after, kept: kept.length,
        vectors: { rows: vectors.length, carried: carried.length,
          same: carried.every(v => { const got = parseEmbedding(v.embedding)!; const want = unit(target.column.dimensions, byText.get(v.chunk_text)!);
            return got.length === want.length && got.every((x, i) => x === want[i]); }),
          inputs: carried.every(v => v.embedding_input_hash !== null), models: [...new Set(vectors.map(v => v.model))],
          page: vectors[0] && { mode: vectors[0].contextual_retrieval_mode, slug: vectors[0].slug, source_id: vectors[0].source_id, corpus: vectors[0].corpus_generation } },
      };
    });
});
