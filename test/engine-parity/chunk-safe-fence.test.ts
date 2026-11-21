/**
 * BrainEngine parity: a chunk write that is not a seal takes the page out of safe-chunk reads (review finding 5 of PR 9730).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: sealChunks stamps the page `chunker_version` at the safe fence chunker (4); an upsertChunks that changes the
 *    stored chunks (new text, source, modality or metadata, an index added or dropped) stamps it -1 (`chunkWriteInvalidations`)
 *    and one that repeats them leaves it. A page below the fence, or with no version, is not safe: `requireSafeChunks`
 *    searches and the sealed flag of getChunkWindows leave it out until the next sealChunks certifies it again. The Rust arm
 *    must answer each read the same.
 *  - Regression: the Rust store never stamped a version on seal or on a fragment write and read an absent version as safe,
 *    so a page whose chunks were edited after sealing stayed in excludePrivate / requireSafeChunks reads with unfenced text.
 *  - Why existing coverage misses it: search-privacy.test.ts and search.test.ts seal once and never write chunks again.
 *  - Seam: none (typed methods only).
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { withEngineScope } from '../../src/core/engine-scope.ts';
import { noteSchemaVersion } from '../../src/core/migrate-pending.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest, arms } = parityArms(testBackends());

const SLUG = 'notes/fence';

async function seed(engine: BrainEngine): Promise<number> {
  await seedPage(engine, {
    slug: SLUG,
    input: { type: 'note', title: 'Fence', compiled_truth: 'marmot burrow', timeline: '' },
    chunks: [chunk(0, 'marmot burrow ledger')],
  });
  return (await engine.getPage(SLUG))!.id;
}

/**
 * What each reader sees of the page now: keyword hits with and without the safe-chunk rule (`excludePrivate` asks for it, as a
 * served brain does, so the schema version the connect gate records is noted), and the chunk window.
 */
async function views(engine: BrainEngine, backend: string, pageId: number) {
  const own = arms().find((arm) => arm.backend === backend)!.engine;
  noteSchemaVersion(own, LATEST_SCHEMA_VERSION);
  const hits = async (safe: boolean) => withEngineScope(own, async () =>
    (await engine.searchKeyword('marmot', { limit: 10, ...(safe ? { excludePrivate: true } : {}) })).map((r) => `${r.slug}: ${r.chunk_text}`));
  const [window] = await engine.getChunkWindows([{ page_id: pageId, from_index: 0, to_index: 9, priority: 0 }],
    { chunkSources: ['compiled_truth'], maxRows: 20 });
  return {
    safe: await hits(true),
    plain: await hits(false),
    window: window ? { sealed: window.sealed, chunks: window.chunks.map((c) => c.chunk_text) } : null,
  };
}

const SEALED = (text: string) => ({ safe: [`${SLUG}: ${text}`], plain: [`${SLUG}: ${text}`], window: { sealed: true, chunks: [text] } });

describe('chunk writes and the safe fence stamp', () => {
  parityTest(
    'a sealed page reads as safe, and stays safe when upsertChunks repeats its chunks',
    { methods: ['sealChunks', 'upsertChunks', 'searchKeyword', 'getChunkWindows'] },
    async (engine, backend) => {
      const pageId = await seed(engine);
      const sealed = await views(engine, backend, pageId);
      expect(sealed).toEqual(SEALED('marmot burrow ledger'));
      await engine.upsertChunks(SLUG, [chunk(0, 'marmot burrow ledger')]);
      const repeated = await views(engine, backend, pageId);
      expect(repeated).toEqual(sealed);
      return { sealed, repeated };
    },
  );

  parityTest(
    'upsertChunks that changes a chunk takes the page out of safe-chunk reads until sealChunks runs again',
    { methods: ['sealChunks', 'upsertChunks', 'searchKeyword', 'getChunkWindows'] },
    async (engine, backend) => {
      const pageId = await seed(engine);
      await engine.upsertChunks(SLUG, [chunk(0, 'marmot burrow ledger edited')]);
      const edited = await views(engine, backend, pageId);
      expect(edited.safe).toEqual([]);
      expect(edited.plain).toEqual([`${SLUG}: marmot burrow ledger edited`]);
      expect(edited.window?.sealed).toBe(false);
      await engine.sealChunks(SLUG, [chunk(0, 'marmot burrow ledger edited')]);
      const resealed = await views(engine, backend, pageId);
      expect(resealed).toEqual(SEALED('marmot burrow ledger edited'));
      return { edited, resealed };
    },
  );

  parityTest(
    'upsertChunks that adds a chunk, drops one, or changes only its metadata also invalidates the stamp',
    { methods: ['sealChunks', 'upsertChunks', 'searchKeyword'] },
    async (engine, backend) => {
      const pageId = await seed(engine);
      const out: Record<string, unknown> = {};
      const steps: Array<[string, Parameters<BrainEngine['upsertChunks']>[1]]> = [
        ['added', [chunk(0, 'marmot burrow ledger'), chunk(1, 'marmot second ledger')]],
        ['dropped', [chunk(0, 'marmot burrow ledger')]],
        ['metadata', [chunk(0, 'marmot burrow ledger', { language: 'markdown' })]],
        // A null incoming field keeps the stored one, so this is a repeat.
        ['null metadata', [chunk(0, 'marmot burrow ledger', { language: null as unknown as undefined })]],
      ];
      for (const [name, chunks] of steps) {
        // Each step starts from a freshly sealed page of two chunks (or one), as the step needs.
        const base = name === 'dropped' ? [chunk(0, 'marmot burrow ledger'), chunk(1, 'marmot second ledger')] : [chunk(0, 'marmot burrow ledger')];
        await engine.sealChunks(SLUG, base);
        expect((await views(engine, backend, pageId)).safe.length).toBeGreaterThan(0);
        await engine.upsertChunks(SLUG, chunks);
        out[name] = (await views(engine, backend, pageId)).safe.length;
      }
      expect(out).toEqual({ added: 0, dropped: 0, metadata: 0, 'null metadata': 1 });
      return out;
    },
  );
});
