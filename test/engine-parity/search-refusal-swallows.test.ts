/**
 * BrainEngine parity — the search reads that used to turn an engine refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the image-vector probe (search/image-vector-presence.ts, BrainEngine.hasChunkImageVectors) answers
 *    false on a text-only brain on every engine; the semantic query-cache clear (BrainEngine.clearQueryCache) answers
 *    0 on a brain with no cache rows on every engine; the two-pass code walk (search/two-pass.ts expandAnchors) adds
 *    the near-symbol anchor and the neighbor its unresolved edge names on every engine (the symbol lookups are the typed
 *    read listSymbolChunkIds, master's statements on PGLite and Postgres), and an engine that cannot run them refuses with engine_capability_missing instead of
 *    walking without them. Every engine arm returns
 *    the same rows or stops on the typed refusal (PGLite always; Postgres with DATABASE_URL; the Rust arm with
 *    GBRAIN_TEST_RUST_ARM=1).
 *  - Regression: each read sent raw SQL inside a catch that answered a default, so on a Rust brain the probe read as
 *    "has images", the clear read as 0 after a refusal, and the walk silently dropped its anchors and neighbors.
 *  - Why existing coverage misses it: the search tests run on PGLite and Postgres only, and no parity file reached
 *    these catches.
 *  - Seam: none. Real engines and typed methods only; the walk is called as hybrid search's rank stage calls it.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChunkInput, PageInput, SearchResult } from '../../src/core/types.ts';
import { brainHasImageVectors, forgetImageVectorPresence } from '../../src/core/search/image-vector-presence.ts';
import { SemanticQueryCache } from '../../src/core/search/query-cache.ts';
import { expandAnchors } from '../../src/core/search/two-pass.ts';
import { parityArms, sorted } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

function codePage(slug: string): PageInput {
  return { type: 'code', page_kind: 'code', title: slug, compiled_truth: `${slug} source`, timeline: '', frontmatter: { file: `${slug}.ts` } } as PageInput;
}

function sym(i: number, text: string, qualified: string): ChunkInput {
  return chunk(i, text, { language: 'typescript', symbol_name: qualified.split('.').pop(), symbol_type: 'function',
    symbol_name_qualified: qualified, start_line: 10 * (i + 1), end_line: 10 * (i + 1) + 5 } as Partial<ChunkInput>);
}

/** Chunk id -> `slug#index`, so ids (which differ between arms) are compared by label. */
async function labels(engine: BrainEngine, slugs: string[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  for (const slug of slugs) for (const c of await engine.getChunks(slug)) out.set(c.id, `${slug}#${c.chunk_index}`);
  return out;
}

describe('engine parity: search reads that must not swallow an engine refusal', () => {
  parityTest('the image-vector probe answers false on a text-only brain',
    { methods: ['putPage', 'sealChunks', 'hasChunkImageVectors'] }, async (engine) => {
      await engine.putPage('notes/text-only', { type: 'note', title: 'Text only', compiled_truth: 'Photos of the beach.', timeline: '' });
      await installChunks(engine, 'notes/text-only', [chunk(0, 'Photos of the beach.')]);
      forgetImageVectorPresence(engine);
      const out = { member: await engine.hasChunkImageVectors(), probe: await brainHasImageVectors(engine) };
      expect(out).toEqual({ member: false, probe: false });
      return out;
    });

  parityTest('the semantic query-cache clear answers 0 rows on a brain with no cache rows, for every source and for one',
    { methods: ['clearQueryCache'] }, async (engine) => {
      const cache = new SemanticQueryCache(engine);
      const out = { all: await cache.clear(), one: await cache.clear({ sourceId: 'default' }), member: await engine.clearQueryCache('default') };
      expect(out).toEqual({ all: 0, one: 0, member: 0 });
      return out;
    });

  parityTest('the two-pass walk adds the near-symbol anchor and the neighbor its unresolved edge names',
    { methods: ['putPage', 'sealChunks', 'getChunks', 'addCodeEdges', 'getEdgesByChunk', 'listSymbolChunkIds'] }, async (engine) => {
      await engine.putPage('src/a', codePage('src/a'));
      await installChunks(engine, 'src/a', [sym(0, 'function start() { helper(); }', 'mod.start'), sym(1, 'function other() {}', 'mod.other')]);
      await engine.putPage('src/b', codePage('src/b'));
      await installChunks(engine, 'src/b', [sym(0, 'function helper() {}', 'mod.helper'), sym(1, 'function anchor() {}', 'mod.anchor')]);
      const ids = await labels(engine, ['src/a', 'src/b']);
      const id = (label: string) => [...ids].find(([, l]) => l === label)![0];
      await engine.addCodeEdges([{ from_chunk_id: id('src/a#0'), from_symbol_qualified: 'mod.start', to_symbol_qualified: 'mod.helper', edge_type: 'calls' }]);
      const anchor = { chunk_id: id('src/a#0'), score: 1, slug: 'src/a' } as SearchResult;
      const view = (rows: Array<{ chunk_id: number; hop: number; source: string }>) => sorted(rows.map(r => `${ids.get(r.chunk_id)}:${r.hop}:${r.source}`));
      const out = {
        nearSymbol: view(await expandAnchors(engine, [anchor], { nearSymbol: 'mod.anchor', sourceId: 'default' })),
        walk: view(await expandAnchors(engine, [anchor], { walkDepth: 1, sourceId: 'default' })),
        // The typed lookup itself (below its limit, so every engine returns the same rows): scoped by source, any source
        // when none is named. Sorted: the SQL engines return rows in plan order.
        targets: sorted((await engine.listSymbolChunkIds('edge_targets', ['mod.helper', 'mod.anchor', 'mod.none'], 'default')).map(id => ids.get(id)!)),
        near: (await engine.listSymbolChunkIds('near_symbol', ['mod.anchor'])).map(id => ids.get(id)),
        otherSource: await engine.listSymbolChunkIds('near_symbol', ['mod.helper'], 'no-such-source'),
      };
      expect(out.targets).toEqual(['src/b#0', 'src/b#1']);
      expect(out.near).toEqual(['src/b#1']);
      expect(out.otherSource).toEqual([]);
      expect(out.nearSymbol).toEqual(['src/a#0:0:anchor', 'src/b#1:0:anchor']);
      expect(out.walk).toEqual(['src/a#0:0:anchor', 'src/b#0:1:neighbor']);
      return out;
    });
});
