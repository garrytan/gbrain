/**
 * BrainEngine parity — chunks family (chunk storage, paging, stale/embedding
 * bookkeeping, signatures, chunkless-page healing, embedding state).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: every chunk read/write/bookkeeping method returns the same
 *    observable result on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; a Rust arm later through test/engine-parity/harness.ts).
 *  - Regression: an engine that drifts on chunk replacement, the stale-embedding
 *    predicate, the model-swap signature sweeps or the chunkless-page safety net
 *    (what `embed --stale` and `gbrain doctor` read) silently leaves pages
 *    un-embedded or re-embeds a whole brain.
 *  - Why existing coverage misses it: test/e2e/engine-parity.test.ts skips
 *    without Postgres and covers search/graph; the per-engine chunk tests never
 *    compare two engines on one scenario.
 *  - Seam: none for the cases. Typed methods only (no executeRaw: D18); the
 *    sealed-projection fixture goes through chunk-fixtures.ts (see its header).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { Chunk, ChunkInput } from '../../src/core/types.ts';
import { basisEmbedding, createSource, parityArms, pick, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const CHUNK_KEYS = ['chunk_index', 'chunk_text', 'chunk_source', 'token_count', 'embedded_at', 'embedding_is_null', 'modality', 'language', 'symbol_name', 'symbol_type'] as const;

function view(rows: Chunk[]) {
  return rows.map((c) => pick(c, CHUNK_KEYS));
}

/** Index of a unit vector's hot axis, or null (null vector / not a unit vector). */
function axis(v: Float32Array | null | undefined): number | null {
  if (!v) return null;
  let hot = -1;
  for (let i = 0; i < v.length; i++) {
    if (v[i] === 1) {
      if (hot !== -1) return null;
      hot = i;
    } else if (v[i] !== 0) return null;
  }
  return hot === -1 ? null : hot;
}

const PAGE = (title: string, body: string, timeline = '') => ({ type: 'note' as const, title, compiled_truth: body, timeline });

describe('engine parity: chunks', () => {
  parityTest(
    'a fresh brain records the embedding model it was created with, and a chunk with no model of its own carries it',
    { methods: ['getConfig', 'putPage', 'upsertChunks', 'getChunks'] },
    async (engine) => {
      const config = {
        embedding_model: await engine.getConfig('embedding_model'),
        embedding_dimensions: await engine.getConfig('embedding_dimensions'),
        chunk_strategy: await engine.getConfig('chunk_strategy'),
      };
      expect(config.embedding_model).toBeTruthy();
      expect(config.embedding_dimensions).toBeTruthy();
      await engine.putPage('notes/modelled', PAGE('Modelled', 'a body with no embedding.'));
      await engine.upsertChunks('notes/modelled', [chunk(0, 'a body with no embedding.')]);
      const models = (await engine.getChunks('notes/modelled', { includeUnsealed: true })).map((c) => c.model);
      expect(models).toEqual([config.embedding_model!]);
      return { config, models };
    },
  );

  parityTest(
    'upsertChunks stores chunks that getChunks serves only once the projection is sealed',
    { methods: ['putPage', 'upsertChunks', 'getChunks'] },
    async (engine) => {
      await engine.putPage('notes/chunky', PAGE('Chunky', 'first body text. second body text.', '- 2026-01-01: a timeline line'));
      const inputs: ChunkInput[] = [
        chunk(0, 'first body text.', { embedding: basisEmbedding(5), token_count: 4 }),
        chunk(1, 'second body text.'),
        { chunk_index: 2, chunk_text: '- 2026-01-01: a timeline line', chunk_source: 'timeline' },
        { chunk_index: 3, chunk_text: 'function f() {}', chunk_source: 'fenced_code', language: 'typescript', symbol_name: 'f', symbol_type: 'function' },
      ];
      await engine.upsertChunks('notes/chunky', inputs);
      const hidden = await engine.getChunks('notes/chunky');
      expect(hidden).toEqual([]);
      const unsealed = view(await engine.getChunks('notes/chunky', { includeUnsealed: true }));
      expect(unsealed.map((c) => c.chunk_index)).toEqual([0, 1, 2, 3]);
      expect(unsealed[0]!.embedding_is_null).toBe(false);
      expect(unsealed[1]!.embedding_is_null).toBe(true);
      expect(unsealed[3]).toMatchObject({ chunk_source: 'fenced_code', language: 'typescript', symbol_name: 'f', symbol_type: 'function' });

      await installChunks(engine, 'notes/chunky', inputs);
      const sealed = view(await engine.getChunks('notes/chunky'));
      expect(sealed).toEqual(unsealed);
      const missing = await engine.getChunks('notes/nobody');
      expect(missing).toEqual([]);
      return { hidden, unsealed, sealed, missing };
    },
  );

  parityTest(
    'getChunks under requireSafeChunks reads a sealed page chunked below the safe fence as no chunks',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'getChunks'] },
    async (engine) => {
      await engine.putPage('notes/fenced', PAGE('Fenced', 'fenced body text.'));
      await installChunks(engine, 'notes/fenced', [chunk(0, 'fenced body text.', { embedding: basisEmbedding(2) })]);
      const read = async (requireSafeChunks: boolean) =>
        (await engine.getChunks('notes/fenced', { includeEmbedding: true, requireSafeChunks })).map((c) => [c.chunk_index, c.embedding != null]);
      const safe = { off: await read(false), on: await read(true) };
      await engine.setChunkerVersion('notes/fenced', 3);
      const short = { off: await read(false), on: await read(true) };
      expect(safe).toEqual({ off: [[0, true]], on: [[0, true]] });
      expect(short).toEqual({ off: [[0, true]], on: [] });
      return { safe, short };
    },
  );

  parityTest(
    'sealChunks replaces and seals chunks at the current revision; it refuses a stale revision, a deleted page and an unknown page',
    { methods: ['putPage', 'readPageSnapshot', 'sealChunks', 'getChunks', 'searchKeyword', 'softDeletePage'] },
    async (engine) => {
      await engine.putPage('notes/sealed', PAGE('Sealed', 'a heliotrope paragraph. a second line.'));
      const first = await engine.readPageSnapshot('notes/sealed');
      await engine.sealChunks('notes/sealed', [chunk(0, 'a heliotrope paragraph.'), chunk(1, 'a second line.')], { expectedRevision: first!.revision });
      const sealed = view(await engine.getChunks('notes/sealed'));
      expect(sealed.map((c) => c.chunk_text)).toEqual(['a heliotrope paragraph.', 'a second line.']);
      const found = (await engine.searchKeyword('heliotrope', { limit: 5 })).map((r) => [r.slug, r.chunk_text]);
      expect(found).toEqual([['notes/sealed', 'a heliotrope paragraph.']]);

      await engine.putPage('notes/sealed', PAGE('Sealed', 'a marigold paragraph only.'));
      const refusal = async (run: () => Promise<void>) => {
        try { await run(); return 'sealed'; } catch (e) { return e instanceof Error && /changed after it was read|not found/i.test(e.message) ? 'refused' : String(e); }
      };
      const stale = await refusal(() => engine.sealChunks('notes/sealed', [chunk(0, 'stale text')], { expectedRevision: first!.revision }));
      const afterStale = view(await engine.getChunks('notes/sealed', { includeUnsealed: true })).map((c) => c.chunk_text);
      expect([stale, afterStale]).toEqual(['refused', ['a heliotrope paragraph.', 'a second line.']]);
      // The page edit unsealed the projection, so search serves nothing until the new chunks are sealed.
      const unsealedSearch = (await engine.searchKeyword('heliotrope', { limit: 5 })).map((r) => r.slug);
      await engine.sealChunks('notes/sealed', [chunk(0, 'a marigold paragraph only.')]);
      const resealed = (await engine.searchKeyword('marigold', { limit: 5 })).map((r) => [r.slug, r.chunk_text]);
      const oldText = (await engine.searchKeyword('heliotrope', { limit: 5 })).map((r) => r.slug);
      expect([resealed, oldText]).toEqual([[['notes/sealed', 'a marigold paragraph only.']], []]);

      const unknown = await refusal(() => engine.sealChunks('notes/nobody', [chunk(0, 'x')]));
      await engine.softDeletePage('notes/sealed');
      const deleted = await refusal(() => engine.sealChunks('notes/sealed', [chunk(0, 'x')]));
      expect([unknown, deleted]).toEqual(['refused', 'refused']);
      return { sealed, found, stale, afterStale, unsealedSearch, resealed, oldText, unknown, deleted };
    },
  );

  parityTest(
    'sealChunks rolls back as one unit: a chunk write that fails after the old chunks were deleted leaves the old sealed set searchable',
    { methods: ['putPage', 'readPageSnapshot', 'sealChunks', 'getChunks', 'searchKeyword'] },
    async (engine) => {
      await engine.putPage('notes/rollback', PAGE('Rollback', 'a periwinkle paragraph. a second line.'));
      await engine.sealChunks('notes/rollback', [chunk(0, 'a periwinkle paragraph.'), chunk(1, 'a second line.')]);
      const before = view(await engine.getChunks('notes/rollback', { includeUnsealed: true }));
      const revision = (await engine.readPageSnapshot('notes/rollback'))!.revision;

      // sealChunks deletes the old chunks before it writes the new ones; an embedding of the wrong
      // width makes that write fail, so only the transaction can bring the old chunks back.
      let failed = false;
      try {
        await engine.sealChunks('notes/rollback', [chunk(0, 'a cerulean replacement.', { embedding: basisEmbedding(0, 8) })]);
      } catch {
        failed = true;
      }
      const after = view(await engine.getChunks('notes/rollback', { includeUnsealed: true }));
      const sealedAfter = view(await engine.getChunks('notes/rollback'));
      const found = (await engine.searchKeyword('periwinkle', { limit: 5 })).map((r) => [r.slug, r.chunk_text]);
      const leaked = (await engine.searchKeyword('cerulean', { limit: 5 })).map((r) => r.slug);
      const revisionAfter = (await engine.readPageSnapshot('notes/rollback'))!.revision;
      expect(failed).toBe(true);
      expect(after).toEqual(before);
      expect(sealedAfter).toEqual(before);
      expect(found).toEqual([['notes/rollback', 'a periwinkle paragraph.']]);
      expect(leaked).toEqual([]);
      expect(revisionAfter).toBe(revision);

      // The engine stays usable: a valid seal on the same page still lands.
      await engine.sealChunks('notes/rollback', [chunk(0, 'a cerulean replacement.')]);
      const replaced = (await engine.searchKeyword('cerulean', { limit: 5 })).map((r) => [r.slug, r.chunk_text]);
      expect(replaced).toEqual([['notes/rollback', 'a cerulean replacement.']]);
      return { before, after, sealedAfter, found, leaked, sameRevision: revisionAfter === revision, replaced };
    },
  );

  parityTest(
    'upsertChunks replaces a page chunk set: edited text, new indexes, dropped tail',
    { methods: ['upsertChunks', 'getChunks', 'getChunkPage'] },
    async (engine) => {
      await seedPage(engine, {
        slug: 'notes/replace',
        input: PAGE('Replace', 'one two three'),
        chunks: [chunk(0, 'one', { embedding: basisEmbedding(1) }), chunk(1, 'two', { embedding: basisEmbedding(2) }), chunk(2, 'three', { embedding: basisEmbedding(3) })],
      });
      const before = view(await engine.getChunks('notes/replace'));
      expect(before.map((c) => c.chunk_text)).toEqual(['one', 'two', 'three']);

      // Same index, edited text, no vector: the stale vector must not survive on the edited chunk.
      await engine.upsertChunks('notes/replace', [chunk(0, 'one'), chunk(1, 'two EDITED')]);
      const after = await engine.getChunks('notes/replace', { includeUnsealed: true, includeEmbedding: true });
      const afterView = after.map((c) => ({ ...pick(c, ['chunk_index', 'chunk_text', 'embedding_is_null'] as const), axis: axis(c.embedding) }));
      const page = await engine.getChunkPage('notes/replace', { fromIndex: 0, limit: 10 });
      expect(afterView).toEqual([
        { chunk_index: 0, chunk_text: 'one', embedding_is_null: false, axis: 1 },
        { chunk_index: 1, chunk_text: 'two EDITED', embedding_is_null: true, axis: null },
      ]);
      expect([page.total_chunks, page.max_chunk_index]).toEqual([2, 1]);
      return { before, afterView, pageTotal: page.total_chunks, pageMax: page.max_chunk_index };
    },
  );

  // Review finding outside-voice#2: upsertChunks matches a stored chunk to the new set by its source and text, not its
  // index (moveDisplacedChunksAndPrune), so a chunk inserted above an embedded one shifts it down with its id and vector.
  parityTest(
    'upsertChunks keeps the id and vector of an embedded chunk that a new chunk above it shifts down',
    { methods: ['upsertChunks', 'getChunks'] },
    async (engine) => {
      await seedPage(engine, {
        slug: 'notes/shift',
        input: PAGE('Shift', 'kept passage. tail passage. swap a. swap b.'),
        chunks: [
          chunk(0, 'kept passage.', { embedding: basisEmbedding(3) }),
          chunk(1, 'tail passage.', { embedding: basisEmbedding(4) }),
          chunk(2, 'swap a.', { embedding: basisEmbedding(5) }),
          chunk(3, 'swap b.', { embedding: basisEmbedding(6) }),
          chunk(4, 'same text, other source', { embedding: basisEmbedding(7) }),
        ],
      });
      const read = () => engine.getChunks('notes/shift', { includeUnsealed: true, includeEmbedding: true });
      const before = await read();
      const idOf = new Map(before.map((c) => [c.chunk_text, c.id]));
      const embeddedAt = new Map(before.map((c) => [c.chunk_text, String(c.embedded_at)]));
      // A new intro at 0 shifts the rest down; the last two swap; a timeline chunk repeats a compiled_truth chunk's text.
      await engine.upsertChunks('notes/shift', [
        chunk(0, 'a new intro.'),
        chunk(1, 'kept passage.'),
        chunk(2, 'tail passage.'),
        chunk(3, 'swap b.'),
        chunk(4, 'swap a.'),
        { chunk_index: 5, chunk_text: 'same text, other source', chunk_source: 'timeline' },
      ]);
      const after = (await read()).map((c) => ({
        chunk_index: c.chunk_index,
        chunk_text: c.chunk_text,
        chunk_source: c.chunk_source,
        axis: axis(c.embedding),
        sameId: idOf.get(c.chunk_text) === c.id,
        sameEmbeddedAt: c.embedded_at !== null && embeddedAt.get(c.chunk_text) === String(c.embedded_at),
      }));
      return { after };
    },
  );

  parityTest(
    'getChunks includeEmbedding returns stored vectors; getChunksWithEmbeddings reads the full rows',
    { methods: ['getChunks', 'getChunksWithEmbeddings'] },
    async (engine) => {
      await seedPage(engine, {
        slug: 'notes/vectors',
        input: PAGE('Vectors', 'alpha beta'),
        chunks: [chunk(0, 'alpha', { embedding: basisEmbedding(11) }), chunk(1, 'beta')],
      });
      const without = await engine.getChunks('notes/vectors');
      expect(without.every((c) => c.embedding === null)).toBe(true);
      const withVec = await engine.getChunks('notes/vectors', { includeEmbedding: true });
      expect(axis(withVec[0]!.embedding)).toBe(11);
      expect(withVec[1]!.embedding).toBeNull();
      const full = await engine.getChunksWithEmbeddings('notes/vectors');
      expect(axis(full[0]!.embedding)).toBe(11);
      const none = await engine.getChunksWithEmbeddings('notes/nobody');
      expect(none).toEqual([]);
      return {
        without: without.map((c) => c.embedding),
        withVec: withVec.map((c) => ({ chunk_index: c.chunk_index, axis: axis(c.embedding) })),
        full: full.map((c) => ({ chunk_index: c.chunk_index, chunk_text: c.chunk_text, axis: axis(c.embedding) })),
        none,
      };
    },
  );

  parityTest(
    'getChunkPage pages by chunk_index range and reports total and max index',
    { methods: ['getChunkPage'] },
    async (engine) => {
      await seedPage(engine, {
        slug: 'notes/paged',
        input: PAGE('Paged', 'a b c d e'),
        chunks: ['a', 'b', 'c', 'd', 'e'].map((t, i) => chunk(i, `chunk ${t}`)),
      });
      const first = await engine.getChunkPage('notes/paged', { fromIndex: 0, limit: 2 });
      const second = await engine.getChunkPage('notes/paged', { fromIndex: 2, limit: 2 });
      const tail = await engine.getChunkPage('notes/paged', { fromIndex: 4, limit: 10 });
      const past = await engine.getChunkPage('notes/paged', { fromIndex: 50, limit: 10 });
      const absent = await engine.getChunkPage('notes/nobody', { fromIndex: 0, limit: 10 });
      const shape = (p: typeof first) => ({ texts: p.chunks.map((c) => c.chunk_text), total: p.total_chunks, max: p.max_chunk_index });
      expect(shape(first)).toEqual({ texts: ['chunk a', 'chunk b'], total: 5, max: 4 });
      expect(shape(tail)).toEqual({ texts: ['chunk e'], total: 5, max: 4 });
      expect(shape(absent)).toEqual({ texts: [], total: 0, max: null });
      return { first: shape(first), second: shape(second), tail: shape(tail), past: shape(past), absent: shape(absent) };
    },
  );

  parityTest(
    'getChunkWindows reads requested chunk ranges for authorized sealed pages only',
    { methods: ['putPage', 'getChunkWindows', 'softDeletePage'] },
    async (engine) => {
      const alpha = await engine.putPage('notes/win-alpha', PAGE('Win alpha', 'a0 a1 a2 a3'));
      await installChunks(engine, 'notes/win-alpha', [0, 1, 2, 3].map((i) => chunk(i, `alpha chunk ${i}`)));
      const beta = await engine.putPage('notes/win-beta', PAGE('Win beta', 'b0 b1'));
      await installChunks(engine, 'notes/win-beta', [chunk(0, 'beta chunk 0'), { chunk_index: 1, chunk_text: '- beta timeline', chunk_source: 'timeline' }]);
      const gone = await engine.putPage('notes/win-gone', PAGE('Win gone', 'g0'));
      await installChunks(engine, 'notes/win-gone', [chunk(0, 'gone chunk 0')]);
      await engine.softDeletePage('notes/win-gone');

      const slugOf = new Map([[alpha.id, 'win-alpha'], [beta.id, 'win-beta'], [gone.id, 'win-gone']]);
      const view = (pages: Awaited<ReturnType<typeof engine.getChunkWindows>>) => sorted(
        pages.map((p) => ({
          slug: slugOf.get(p.page_id),
          sealed: p.sealed,
          max_chunk_index: p.max_chunk_index,
          row_limited: p.row_limited,
          compiled_truth: p.compiled_truth,
          chunks: p.chunks.map((c) => `${c.chunk_index}:${c.chunk_source}:${c.chunk_text}`),
        })),
        (p) => String(p.slug),
      );
      const requests = [
        { page_id: alpha.id, from_index: 1, to_index: 2, priority: 0 },
        { page_id: beta.id, from_index: 0, to_index: 5, priority: 1 },
        { page_id: gone.id, from_index: 0, to_index: 5, priority: 2 },
      ];
      const all = view(await engine.getChunkWindows(requests, { chunkSources: ['compiled_truth', 'timeline'], maxRows: 50 }));
      expect(all.map((p) => p.slug)).toEqual(['win-alpha', 'win-beta']);
      expect(all[0]!.chunks).toEqual(['1:compiled_truth:alpha chunk 1', '2:compiled_truth:alpha chunk 2']);
      const lowDetail = view(await engine.getChunkWindows(requests, { chunkSources: ['compiled_truth'], maxRows: 50 }));
      expect(lowDetail[1]!.chunks).toEqual(['0:compiled_truth:beta chunk 0']);
      const capped = view(await engine.getChunkWindows(requests, { chunkSources: ['compiled_truth', 'timeline'], maxRows: 2 }));
      expect(capped.some((p) => p.row_limited)).toBe(true);
      const empty = await engine.getChunkWindows([], { chunkSources: ['compiled_truth'], maxRows: 10 });
      expect(empty).toEqual([]);
      return { all, lowDetail, capped, empty };
    },
  );

  parityTest(
    'countStaleChunks, sumStaleChunkChars and listStaleChunks agree on which chunks lack a vector',
    { methods: ['countStaleChunks', 'sumStaleChunkChars', 'listStaleChunks'] },
    async (engine) => {
      await seedPage(engine, {
        slug: 'notes/stale-a',
        input: PAGE('Stale A', 'x'),
        chunks: [chunk(0, 'aaaa', { embedding: basisEmbedding(1) }), chunk(1, 'bbbbbb'), chunk(2, 'cc')],
      });
      await seedPage(engine, {
        slug: 'notes/stale-b',
        input: PAGE('Stale B', 'x'),
        chunks: [chunk(0, 'dddddddd'), chunk(1, 'eeeeeeeeee', { embedding: basisEmbedding(2) })],
      });
      await seedPage(engine, { slug: 'notes/fully-embedded', input: PAGE('Fully embedded', 'x'), chunks: [chunk(0, 'ffff', { embedding: basisEmbedding(3) })] });

      const count = await engine.countStaleChunks();
      const chars = await engine.sumStaleChunkChars();
      const rows = await engine.listStaleChunks();
      const rowView = rows.map((r) => ({ slug: r.slug, chunk_index: r.chunk_index, chunk_text: r.chunk_text, source_id: r.source_id }));
      expect(count).toBe(3);
      expect(chars).toBe('bbbbbb'.length + 'cc'.length + 'dddddddd'.length);
      expect(sorted(rowView, (r) => `${r.slug}/${r.chunk_index}`).map((r) => `${r.slug}/${r.chunk_index}`)).toEqual(['notes/stale-a/1', 'notes/stale-a/2', 'notes/stale-b/0']);

      // Keyset paging walks the same rows in (page_id, chunk_index) order, one at a time.
      const walked: string[] = [];
      let cursor: { afterPageId?: number; afterChunkIndex?: number } = {};
      for (let guard = 0; guard < 10; guard++) {
        const batch = await engine.listStaleChunks({ batchSize: 1, ...cursor });
        if (batch.length === 0) break;
        walked.push(`${batch[0]!.slug}/${batch[0]!.chunk_index}`);
        cursor = { afterPageId: batch[0]!.page_id, afterChunkIndex: batch[0]!.chunk_index };
      }
      expect(walked).toEqual(['notes/stale-a/1', 'notes/stale-a/2', 'notes/stale-b/0']);

      const scopedMiss = await engine.countStaleChunks({ sourceId: 'no-such-source' });
      const scopedHit = await engine.countStaleChunks({ sourceId: 'default' });
      const scopedChars = await engine.sumStaleChunkChars({ sourceId: 'no-such-source' });
      expect([scopedMiss, scopedHit, scopedChars]).toEqual([0, 3, 0]);
      return { count, chars, walked, scopedMiss, scopedHit, scopedChars };
    },
  );

  parityTest(
    'setPageEmbeddingSignature drives signature-aware stale counts and invalidateStaleSignatureEmbeddings',
    { methods: ['setPageEmbeddingSignature', 'countStaleChunks', 'sumStaleChunkChars', 'invalidateStaleSignatureEmbeddings', 'getChunks'] },
    async (engine) => {
      const NEW = 'model-new:1536';
      const embedded = (text: string, axisIdx: number) => [chunk(0, text, { embedding: basisEmbedding(axisIdx) })];
      await seedPage(engine, { slug: 'notes/sig-current', input: PAGE('Sig current', 'x'), chunks: embedded('current', 1) });
      await seedPage(engine, { slug: 'notes/sig-old', input: PAGE('Sig old', 'x'), chunks: embedded('oldmodel', 2) });
      await seedPage(engine, { slug: 'notes/sig-null', input: PAGE('Sig null', 'x'), chunks: embedded('nullsig', 3) });
      await seedPage(engine, { slug: 'notes/sig-pending', input: PAGE('Sig pending', 'x'), chunks: [chunk(0, 'pending')] });
      await engine.setPageEmbeddingSignature('notes/sig-current', { signature: NEW });
      await engine.setPageEmbeddingSignature('notes/sig-old', { signature: 'model-old:768' });
      await engine.setPageEmbeddingSignature('notes/sig-pending', { signature: NEW });
      // No-op for a page that does not exist.
      await engine.setPageEmbeddingSignature('notes/nobody', { signature: NEW });

      const plain = await engine.countStaleChunks();
      const drift = await engine.countStaleChunks({ signature: NEW });
      const driftWithNull = await engine.countStaleChunks({ signature: NEW, includeNullSignature: true });
      const driftChars = await engine.sumStaleChunkChars({ signature: NEW });
      const driftCharsWithNull = await engine.sumStaleChunkChars({ signature: NEW, includeNullSignature: true });
      // plain: only the unembedded chunk. drift: + the old-model page. NULL signature is grandfathered unless asked for.
      expect({ plain, drift, driftWithNull }).toEqual({ plain: 1, drift: 2, driftWithNull: 3 });
      expect({ driftChars, driftCharsWithNull }).toEqual({ driftChars: 'pending'.length + 'oldmodel'.length, driftCharsWithNull: 'pending'.length + 'oldmodel'.length + 'nullsig'.length });

      const scopedMiss = await engine.invalidateStaleSignatureEmbeddings({ signature: NEW, sourceId: 'no-such-source' });
      const invalidated = await engine.invalidateStaleSignatureEmbeddings({ signature: NEW });
      const again = await engine.invalidateStaleSignatureEmbeddings({ signature: NEW });
      const afterDrift = await engine.countStaleChunks({ signature: NEW });
      const invalidatedNull = await engine.invalidateStaleSignatureEmbeddings({ signature: NEW, includeNullSignature: true });
      const afterNull = await engine.countStaleChunks({ signature: NEW, includeNullSignature: true });
      expect({ scopedMiss, invalidated, again, afterDrift, invalidatedNull, afterNull }).toEqual({ scopedMiss: 0, invalidated: 1, again: 0, afterDrift: 2, invalidatedNull: 1, afterNull: 3 });

      const state = async (slug: string) => view(await engine.getChunks(slug)).map((c) => ({ embedding_is_null: c.embedding_is_null, embedded_at: c.embedded_at }));
      const states = {
        current: await state('notes/sig-current'),
        old: await state('notes/sig-old'),
        nullsig: await state('notes/sig-null'),
      };
      expect(states.current[0]!.embedding_is_null).toBe(false);
      expect(states.old).toEqual([{ embedding_is_null: true, embedded_at: null }]);
      expect(states.nullsig).toEqual([{ embedding_is_null: true, embedded_at: null }]);
      return { plain, drift, driftWithNull, driftChars, driftCharsWithNull, scopedMiss, invalidated, again, afterDrift, invalidatedNull, afterNull, states };
    },
  );

  parityTest(
    'turning a page from a contextual retrieval tier back to none drops its vectors and signature',
    { methods: ['putPage', 'sealChunks', 'setPageEmbeddingSignature', 'updatePageContextualRetrievalState', 'getChunks', 'countStaleChunks', 'searchVector'] },
    async (engine) => {
      const NEW = 'model-new:1536';
      const embedded = (text: string, axisIdx: number) => [chunk(0, text, { embedding: basisEmbedding(axisIdx) })];
      // titled: title -> none, the tier's vectors go. plain: none with no tier before, nothing goes.
      // skipped: an embed_skip page keeps its rows. resynopsis: per_chunk_synopsis -> none, like titled.
      await seedPage(engine, { slug: 'notes/cr-titled', input: PAGE('Titled', 'x'), chunks: embedded('titled', 1) });
      await seedPage(engine, { slug: 'notes/cr-plain', input: PAGE('Plain', 'x'), chunks: embedded('plain', 2) });
      await seedPage(engine, { slug: 'notes/cr-skipped', input: { ...PAGE('Skipped', 'x'), frontmatter: { embed_skip: true } }, chunks: embedded('skipped', 3) });
      await seedPage(engine, { slug: 'notes/cr-synopsis', input: PAGE('Synopsis', 'x'), chunks: embedded('synopsis', 4) });
      for (const slug of ['notes/cr-titled', 'notes/cr-plain', 'notes/cr-skipped', 'notes/cr-synopsis']) {
        await engine.setPageEmbeddingSignature(slug, { signature: NEW });
      }
      const query = basisEmbedding(1);
      const hits = async () => sorted((await engine.searchVector(query, { limit: 10 })).map((r) => r.slug));
      // The first search warms whatever the engine keeps between reads.
      const searchBefore = await hits();
      await engine.updatePageContextualRetrievalState('notes/cr-titled', 'default', 'title', 'gen-1');
      await engine.updatePageContextualRetrievalState('notes/cr-skipped', 'default', 'title', 'gen-1');
      await engine.updatePageContextualRetrievalState('notes/cr-synopsis', 'default', 'per_chunk_synopsis', 'gen-1');
      const staleWhileTiered = await engine.countStaleChunks({ signature: NEW });
      for (const slug of ['notes/cr-titled', 'notes/cr-plain', 'notes/cr-skipped', 'notes/cr-synopsis']) {
        await engine.updatePageContextualRetrievalState(slug, 'default', 'none', null);
      }
      const vectorless = async (slug: string) => view(await engine.getChunks(slug)).map((c) => c.embedding_is_null);
      const after = {
        titled: await vectorless('notes/cr-titled'),
        plain: await vectorless('notes/cr-plain'),
        skipped: await vectorless('notes/cr-skipped'),
        synopsis: await vectorless('notes/cr-synopsis'),
        // a NULL signature is grandfathered unless asked for, so the reset pages count only with includeNullSignature
        stale: await engine.countStaleChunks({ signature: NEW }),
        staleWithNull: await engine.countStaleChunks({ signature: NEW, includeNullSignature: true }),
        search: await hits(),
      };
      expect(staleWhileTiered).toBe(0);
      expect(after.titled).toEqual([true]);
      expect(after.synopsis).toEqual([true]);
      expect(after.plain).toEqual([false]);
      expect(after.stale).toBe(2);
      expect(after.search).not.toContain('notes/cr-titled');
      return { searchBefore, staleWhileTiered, after };
    },
  );

  parityTest(
    'invalidateContentDriftEmbeddings leaves vectors whose text still matches their embed-time hash',
    { methods: ['invalidateContentDriftEmbeddings', 'countStaleChunks', 'upsertChunks'] },
    async (engine) => {
      await seedPage(engine, { slug: 'notes/drift', input: PAGE('Drift', 'x'), chunks: [chunk(0, 'steady text', { embedding: basisEmbedding(4) }), chunk(1, 'no vector yet')] });
      // Rewriting a chunk through upsertChunks re-stamps its hash (or clears its vector), so typed writes never drift.
      await engine.upsertChunks('notes/drift', [chunk(0, 'steady text', { embedding: basisEmbedding(4) }), chunk(1, 'rewritten', { embedding: basisEmbedding(6) })]);
      const before = await engine.countStaleChunks();
      const swept = await engine.invalidateContentDriftEmbeddings();
      const sweptScoped = await engine.invalidateContentDriftEmbeddings({ sourceId: 'default' });
      const after = await engine.countStaleChunks();
      expect({ before, swept, sweptScoped, after }).toEqual({ before: 0, swept: 0, sweptScoped: 0, after: 0 });
      return { before, swept, sweptScoped, after };
    },
  );

  parityTest(
    'countChunklessPagesWithContent and listChunklessPagesWithContent find pages that were never chunked',
    { methods: ['putPage', 'countChunklessPagesWithContent', 'listChunklessPagesWithContent', 'softDeletePage'] },
    async (engine) => {
      const withBody = await engine.putPage('notes/never-chunked', PAGE('Never chunked', 'has body text'));
      const timelineOnly = await engine.putPage('notes/timeline-only', PAGE('Timeline only', '', '- 2026-02-02: only a timeline'));
      const skipped = await engine.putPage('notes/embed-skipped', { ...PAGE('Embed skipped', 'big body'), frontmatter: { embed_skip: { reason: 'oversize', bytes: 10 } } });
      await engine.putPage('notes/empty-body', PAGE('Empty body', ''));
      await seedPage(engine, { slug: 'notes/chunked', input: PAGE('Chunked', 'chunked body'), chunks: [chunk(0, 'chunked body')] });
      await engine.putPage('notes/deleted-chunkless', PAGE('Deleted chunkless', 'deleted body'));
      await engine.softDeletePage('notes/deleted-chunkless');
      await engine.putPage('notes/quarantined', { ...PAGE('Quarantined', 'quarantined body'), frontmatter: { quarantine: { reason: 'test' } } });

      const slugOf = new Map([[withBody.id, 'notes/never-chunked'], [timelineOnly.id, 'notes/timeline-only'], [skipped.id, 'notes/embed-skipped']]);
      const count = await engine.countChunklessPagesWithContent();
      const rows = await engine.listChunklessPagesWithContent();
      const names = rows.map((r) => r.slug);
      expect(count).toBe(3);
      expect(sorted(names)).toEqual(['notes/embed-skipped', 'notes/never-chunked', 'notes/timeline-only']);
      const timelineRow = rows.find((r) => r.slug === 'notes/timeline-only')!;
      expect(pick(timelineRow, ['source_id', 'compiled_truth', 'timeline'] as const)).toEqual({ source_id: 'default', compiled_truth: '', timeline: '- 2026-02-02: only a timeline' });

      // Keyset paging in page-id order, one page per call.
      const walked: string[] = [];
      let afterPageId: number | undefined;
      for (let guard = 0; guard < 10; guard++) {
        const batch = await engine.listChunklessPagesWithContent({ batchSize: 1, afterPageId });
        if (batch.length === 0) break;
        walked.push(slugOf.get(batch[0]!.id)!);
        afterPageId = batch[0]!.id;
      }
      expect(walked).toEqual(['notes/never-chunked', 'notes/timeline-only', 'notes/embed-skipped']);

      const scopedMiss = await engine.countChunklessPagesWithContent({ sourceId: 'no-such-source' });
      const scopedMissList = await engine.listChunklessPagesWithContent({ sourceId: 'no-such-source' });
      const scopedHit = await engine.countChunklessPagesWithContent({ sourceId: 'default' });
      expect([scopedMiss, scopedMissList.length, scopedHit]).toEqual([0, 0, 3]);
      return { count, names: sorted(names), timelineRow: pick(timelineRow, ['source_id', 'compiled_truth', 'timeline'] as const), walked, scopedMiss, scopedHit };
    },
  );

  parityTest(
    'readEmbeddingStateCounts and listEmbeddingStateRows classify every chunk and chunkless page',
    { methods: ['putPage', 'softDeletePage', 'readEmbeddingStateCounts', 'listEmbeddingStateRows'] },
    async (engine) => {
      await seedPage(engine, { slug: 'notes/st-embedded', input: PAGE('St embedded', 'x'), chunks: [chunk(0, 'embedded text', { embedding: basisEmbedding(1) })] });
      await seedPage(engine, { slug: 'notes/st-mixed', input: PAGE('St mixed', 'x'), chunks: [chunk(0, 'mixed a', { embedding: basisEmbedding(2) }), chunk(1, 'mixed b')] });
      await seedPage(engine, { slug: 'notes/st-pending', input: PAGE('St pending', 'x'), chunks: [chunk(0, 'pending text')] });
      await seedPage(engine, {
        slug: 'notes/st-keyword-only',
        input: { ...PAGE('St keyword only', 'x'), frontmatter: { embed_skip: { reason: 'oversize', bytes: 99 } } },
        chunks: [chunk(0, 'keyword only text')],
      });
      await seedPage(engine, {
        slug: 'notes/st-quarantined',
        input: { ...PAGE('St quarantined', 'x'), frontmatter: { quarantine: { reason: 'junk' } } },
        chunks: [chunk(0, 'quarantined text')],
      });
      await seedPage(engine, { slug: 'notes/st-deleted', input: PAGE('St deleted', 'x'), chunks: [chunk(0, 'deleted text', { embedding: basisEmbedding(3) })] });
      await engine.softDeletePage('notes/st-deleted');
      await engine.putPage('notes/st-chunkless', PAGE('St chunkless', 'body with text'));
      await engine.putPage('notes/st-empty', PAGE('St empty', ''));

      const full = await engine.readEmbeddingStateCounts({ mode: 'full', purgeWindowHours: 72 });
      const fullView = { basis: full.basis, counts: full.counts, omitted: full.omitted, eligible_embedded: full.eligible_embedded, deleted_overdue: full.deleted_overdue, embed_skip_pages: full.embed_skip_pages, embed_skip_marker_bytes: full.embed_skip_marker_bytes };
      expect(full.counts).toEqual({ embedded: 2, pending: 2, keyword_only: 1, quarantined: 1, empty: 1, deleted_page_chunks: 1, chunkless_healable: 1 });
      const ops = await engine.readEmbeddingStateCounts({ mode: 'ops', purgeWindowHours: 72 });
      // ops mode reads only index-backed counts; `embedded` is the planner's row estimate, so it is not compared.
      const { embedded: _estimated, ...opsCounts } = ops.counts;
      const opsView = { basis: ops.basis, omitted: ops.omitted, opsCounts, active_column: ops.active_column };
      const scoped = await engine.readEmbeddingStateCounts({ mode: 'full', sourceIds: ['no-such-source'], purgeWindowHours: 72 });
      expect(Object.values(scoped.counts).every((n) => n === 0)).toBe(true);

      const rows = await engine.listEmbeddingStateRows({ states: ['embedded', 'pending', 'keyword_only', 'quarantined', 'empty', 'deleted_page_chunks', 'chunkless_healable'], limit: 50, purgeWindowHours: 72 });
      const rowView = rows.map((r) => pick(r, ['slug', 'source_id', 'state', 'chunks', 'bytes', 'embed_skip_reason', 'marker_bytes', 'quarantine_reason', 'deleted_at', 'overdue'] as const));
      const pendingOnly = await engine.listEmbeddingStateRows({ states: ['pending'], limit: 50, purgeWindowHours: 72 });
      const bySlug = await engine.listEmbeddingStateRows({ slugs: ['notes/st-mixed'], states: ['embedded', 'pending'], limit: 50, purgeWindowHours: 72 });
      const limited = await engine.listEmbeddingStateRows({ states: ['embedded', 'pending'], limit: 2, purgeWindowHours: 72 });
      expect(pendingOnly.map((r) => r.slug)).toEqual(['notes/st-mixed', 'notes/st-pending']);
      expect(bySlug.map((r) => `${r.state}:${r.chunks}`)).toEqual(['embedded:1', 'pending:1']);
      expect(limited.length).toBe(2);
      return { fullView, opsView, scopedCounts: scoped.counts, rows: rowView, pendingOnly: pendingOnly.map((r) => r.slug), bySlug: bySlug.map((r) => `${r.state}:${r.chunks}`), limited: limited.map((r) => `${r.state}:${r.slug}`) };
    },
  );

  parityTest(
    'deleteChunks removes every chunk of one page and leaves the others',
    { methods: ['deleteChunks', 'getChunks', 'countStaleChunks', 'countChunklessPagesWithContent'] },
    async (engine) => {
      await seedPage(engine, { slug: 'notes/del-a', input: PAGE('Del A', 'a body'), chunks: [chunk(0, 'a0', { embedding: basisEmbedding(1) }), chunk(1, 'a1')] });
      await seedPage(engine, { slug: 'notes/del-b', input: PAGE('Del B', 'b body'), chunks: [chunk(0, 'b0')] });
      await engine.deleteChunks('notes/del-a');
      const a = await engine.getChunks('notes/del-a', { includeUnsealed: true });
      const b = view(await engine.getChunks('notes/del-b'));
      // The page is chunkless again, so the safety net sees it; the other page keeps its chunk.
      const chunkless = await engine.countChunklessPagesWithContent();
      const stale = await engine.countStaleChunks();
      expect({ a, bTexts: b.map((c) => c.chunk_text), chunkless, stale }).toEqual({ a: [], bTexts: ['b0'], chunkless: 1, stale: 1 });
      // Deleting from a missing page or a missing source is a harmless no-op.
      await engine.deleteChunks('notes/nobody');
      await engine.deleteChunks('notes/del-b', { sourceId: 'no-such-source' });
      const bAfter = (await engine.getChunks('notes/del-b')).map((c) => c.chunk_text);
      expect(bAfter).toEqual(['b0']);
      return { a, b: b.map((c) => c.chunk_text), chunkless, stale, bAfter };
    },
  );

  parityTest(
    'the same slug in two sources keeps separate chunk sets under sourceId scoping',
    { methods: ['getChunks', 'getChunkPage', 'deleteChunks', 'countStaleChunks', 'listStaleChunks', 'countChunklessPagesWithContent'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      await seedPage(engine, { slug: 'notes/shared', input: PAGE('Shared default', 'default body'), chunks: [chunk(0, 'default zero'), chunk(1, 'default one', { embedding: basisEmbedding(1) })] });
      await seedPage(engine, { slug: 'notes/shared', input: PAGE('Shared work', 'work body'), chunks: [chunk(0, 'work zero')] }, { sourceId: 'work' });

      const texts = async (opts?: { sourceId?: string; sourceIds?: string[] }) => (await engine.getChunks('notes/shared', opts)).map((c) => c.chunk_text);
      const implicitDefault = await texts();
      const work = await texts({ sourceId: 'work' });
      const federated = await texts({ sourceIds: ['default', 'work'] });
      const workPage = await engine.getChunkPage('notes/shared', { sourceId: 'work', fromIndex: 0, limit: 10 });
      expect(implicitDefault).toEqual(['default zero', 'default one']);
      expect(work).toEqual(['work zero']);
      // The two pages' chunk 0 tie on document order; the source id breaks the tie.
      expect(federated).toEqual(['default zero', 'work zero', 'default one']);
      expect(workPage.total_chunks).toBe(1);

      const staleDefault = await engine.countStaleChunks({ sourceId: 'default' });
      const staleWork = await engine.countStaleChunks({ sourceId: 'work' });
      const staleAll = await engine.countStaleChunks();
      const staleRows = (await engine.listStaleChunks({ sourceId: 'work' })).map((r) => `${r.source_id}:${r.slug}/${r.chunk_index}`);
      expect({ staleDefault, staleWork, staleAll, staleRows }).toEqual({ staleDefault: 1, staleWork: 1, staleAll: 2, staleRows: ['work:notes/shared/0'] });

      await engine.deleteChunks('notes/shared', { sourceId: 'work' });
      const workAfter = await texts({ sourceId: 'work' });
      const defaultAfter = await texts();
      const chunklessWork = await engine.countChunklessPagesWithContent({ sourceId: 'work' });
      const chunklessDefault = await engine.countChunklessPagesWithContent({ sourceId: 'default' });
      expect({ workAfter, defaultAfter, chunklessWork, chunklessDefault }).toEqual({ workAfter: [], defaultAfter: ['default zero', 'default one'], chunklessWork: 1, chunklessDefault: 0 });
      return { implicitDefault, work, federated, staleDefault, staleWork, staleAll, staleRows, workAfter, defaultAfter, chunklessWork, chunklessDefault };
    },
  );

  // MCP get_chunks under a token that reads several sources (getChunkPage), and getChunks over several sources, merge
  // the pages in document order, and the source id breaks a tie in byte order whatever the database collation: en_US
  // ignores the hyphen and puts `cob` before `co-op`, byte order puts `co-op` first.
  parityTest(
    'getChunks and getChunkPage over several sources break a document-order tie by source id in byte order',
    { methods: ['getChunks', 'getChunkPage'] },
    async (engine, backend) => {
      for (const id of ['cob', 'co-op']) await createSource(engine, backend, id);
      await seedPage(engine, { slug: 'notes/tie', input: PAGE('Tie cob', 'cob body'), chunks: [chunk(0, 'cob 0'), chunk(1, 'cob 1'), chunk(2, 'cob 2')] }, { sourceId: 'cob' });
      await seedPage(engine, { slug: 'notes/tie', input: PAGE('Tie co-op', 'co-op body'), chunks: [chunk(0, 'co-op 0'), chunk(1, 'co-op 1')] }, { sourceId: 'co-op' });
      const all = (await engine.getChunks('notes/tie', { sourceIds: ['cob', 'co-op'] })).map((c) => c.chunk_text);
      expect(all).toEqual(['co-op 0', 'cob 0', 'co-op 1', 'cob 1', 'cob 2']);
      const page = await engine.getChunkPage('notes/tie', { sourceIds: ['cob', 'co-op', 'cob'], fromIndex: 1, limit: 5 });
      const paged = { texts: page.chunks.map((c) => c.chunk_text), total: page.total_chunks, max: page.max_chunk_index };
      expect(paged).toEqual({ texts: ['co-op 1', 'cob 1', 'cob 2'], total: 5, max: 2 });
      const one = (await engine.getChunkPage('notes/tie', { sourceIds: ['co-op', 'missing'], fromIndex: 0, limit: 1 })).chunks.map((c) => c.chunk_text);
      expect(one).toEqual(['co-op 0']);
      return { all, paged, one };
    },
  );

  parityTest(
    'getChunks with requireSafeChunks reads no chunks of a page chunked before the fence chunker version',
    { methods: ['putPage', 'sealChunks', 'setChunkerVersion', 'getChunks'] },
    async (engine) => {
      for (const slug of ['notes/fence-safe', 'notes/fence-short']) {
        await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'Body.', timeline: '' });
        await installChunks(engine, slug, [chunk(0, `About ${slug}.`), chunk(1, 'Second.')]);
      }
      await engine.setChunkerVersion('notes/fence-short', 3);
      const read = async (slug: string, requireSafeChunks?: boolean) =>
        view(await engine.getChunks(slug, { sourceId: 'default', includeEmbedding: true, ...(requireSafeChunks === undefined ? {} : { requireSafeChunks }) }));
      const out = {
        safe: await read('notes/fence-safe', true),
        short: await read('notes/fence-short', true),
        shortOff: await read('notes/fence-short', false),
        shortDefault: await read('notes/fence-short'),
      };
      expect(out.safe).toHaveLength(2);
      expect(out.short).toEqual([]);
      expect(out.shortOff).toHaveLength(2);
      return out;
    },
  );

  parityTest(
    'getChunks under requireSafeChunks reads only a page whose chunks were cut at the safe fence chunker version',
    { methods: ['getChunks', 'setChunkerVersion', 'upsertChunks', 'sealChunks'] },
    async (engine) => {
      await seedPage(engine, { slug: 'notes/safe', input: PAGE('Safe', 'safe zero. safe one.'), chunks: [chunk(0, 'safe zero.', { embedding: basisEmbedding(2) }), chunk(1, 'safe one.')] });
      const texts = async (opts?: { includeUnsealed?: boolean; requireSafeChunks?: boolean; includeEmbedding?: boolean; sourceId?: string }) =>
        (await engine.getChunks('notes/safe', opts)).map((c) => c.chunk_text);
      // The read import-chunk-reuse.ts makes before it reuses stored vectors.
      const reuse = (await engine.getChunks('notes/safe', { sourceId: 'default', includeEmbedding: true, requireSafeChunks: true }))
        .map((c) => [c.chunk_text, axis(c.embedding)]);
      const sealedSafe = await texts({ requireSafeChunks: true });
      expect({ reuse, sealedSafe }).toEqual({ reuse: [['safe zero.', 2], ['safe one.', null]], sealedSafe: ['safe zero.', 'safe one.'] });

      await engine.setChunkerVersion('notes/safe', 3);
      const oldVersion = { safe: await texts({ requireSafeChunks: true }), unsealedSafe: await texts({ includeUnsealed: true, requireSafeChunks: true }), plain: await texts(), notRequired: await texts({ requireSafeChunks: false }) };
      expect(oldVersion).toEqual({ safe: [], unsealedSafe: [], plain: ['safe zero.', 'safe one.'], notRequired: ['safe zero.', 'safe one.'] });

      await engine.setChunkerVersion('notes/safe', 4);
      const restored = await texts({ requireSafeChunks: true });
      // An unsealed fragment write cannot certify the fence boundary, so the page reads as unsafe until the next seal.
      await engine.upsertChunks('notes/safe', [chunk(0, 'a fragment.')]);
      const fragment = { safe: await texts({ includeUnsealed: true, requireSafeChunks: true }), unsealed: await texts({ includeUnsealed: true }) };
      await engine.sealChunks('notes/safe', [chunk(0, 'resealed.')]);
      const resealed = await texts({ requireSafeChunks: true });
      const missing = await engine.getChunks('notes/nobody', { requireSafeChunks: true });
      expect({ restored, fragment, resealed, missing }).toEqual({ restored: ['safe zero.', 'safe one.'], fragment: { safe: [], unsealed: ['a fragment.'] }, resealed: ['resealed.'], missing: [] });
      return { reuse, sealedSafe, oldVersion, restored, fragment, resealed, missing };
    },
  );
});

