/**
 * The search reads whose catch used to turn an engine capability refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: segment-region dedup (search/dedup.ts segmentRegions), the image-vector probe
 *    (image-vector-presence.ts), the query-cache gate's page snapshot (query-cache-gate.ts), the semantic query cache's
 *    lookup, store and clear (query-cache.ts) and the two-pass walk's near-symbol lookup (two-pass.ts) keep their
 *    fail-open answer for an ordinary failure (a missing table, a lost connection) but let an
 *    `engine_capability_missing` refusal through, so a brain whose engine cannot serve the read refuses instead of
 *    answering a default.
 *  - Regression: each catch answered the default for any error, so on a Rust brain search read as "has images",
 *    dropped its segment regions, missed the cache and walked without its anchors, with no sign of a refusal.
 *  - Why existing coverage misses it: the search tests run on engines that never refuse; the Rust parity file
 *    test/engine-parity/search-refusal-swallows.test.ts reaches only the sites a real Rust engine reaches.
 *  - Seam: an engine stub whose reads throw either the typed refusal or an ordinary error; no database.
 */
import { describe, expect, test } from 'bun:test';
import { OperationError } from '../src/core/ops/contract.ts';
import { segmentRegions } from '../src/core/search/dedup.ts';
import { brainHasImageVectors } from '../src/core/search/image-vector-presence.ts';
import { buildPageGenerationsSnapshot } from '../src/core/search/query-cache-gate.ts';
import { SemanticQueryCache } from '../src/core/search/query-cache.ts';
import { expandAnchors } from '../src/core/search/two-pass.ts';
import type { SearchResult } from '../src/core/types.ts';

const refusal = () => Object.assign(new OperationError('engine_capability_missing', 'This brain\'s engine does not support executeRaw yet'), { code: 'engine_capability_missing' });
const ordinary = () => Object.assign(new Error('relation "query_cache" does not exist'), { code: '42P01' });

/** An engine whose every read throws `fail()`. */
function failing(fail: () => Error): never {
  const throwIt = async () => { throw fail(); };
  return {
    kind: 'pglite', executeRaw: throwIt, readSegmentRegions: throwIt, keywordBoundedRead: throwIt, hasChunkImageVectors: throwIt,
    clearQueryCache: throwIt, getEdgesByChunk: throwIt, getConfigValues: throwIt,
  } as never;
}

/** Five hits on one page, so the region read runs (more than MAX_PER_PAGE hits on a page). */
const hits = Array.from({ length: 5 }, (_, i) => ({ slug: 'notes/a', source_id: 'default', page_id: 1, chunk_id: i + 1, chunk_index: i, score: 1 }) as SearchResult);
const embedding = new Float32Array(1536).fill(0.01);

const reads: Array<[string, (engine: never) => Promise<unknown>]> = [
  ['segmentRegions', (e) => segmentRegions(e, hits)],
  ['brainHasImageVectors', (e) => brainHasImageVectors(e, Date.now() + Math.random())],
  ['buildPageGenerationsSnapshot', (e) => buildPageGenerationsSnapshot(e, [1, 2])],
  ['SemanticQueryCache.lookup', (e) => new SemanticQueryCache(e).lookup(embedding, { sourceId: 'default', knobsHash: 'k', queryText: 'q' })],
  ['SemanticQueryCache.store', (e) => new SemanticQueryCache(e).store('q', embedding, [], {} as never, { sourceId: 'default', knobsHash: 'k' })],
  ['SemanticQueryCache.clear', (e) => new SemanticQueryCache(e).clear()],
  ['expandAnchors nearSymbol', (e) => expandAnchors(e, hits.slice(0, 1), { nearSymbol: 'mod.x', sourceId: 'default' })],
  ['expandAnchors walk', (e) => expandAnchors(e, hits.slice(0, 1), { walkDepth: 1 })],
];

describe('search reads let an engine capability refusal through', () => {
  for (const [name, read] of reads) {
    test(`${name}: a capability refusal rejects, an ordinary failure keeps its fail-open answer`, async () => {
      const refused = await read(failing(refusal)).then(() => 'resolved', (e: { code?: string }) => e.code);
      const ordinaryOutcome = await read(failing(ordinary)).then(() => 'resolved', (e: { code?: string }) => `rejected ${e.code}`);
      expect({ refused, ordinary: ordinaryOutcome }).toEqual({ refused: 'engine_capability_missing', ordinary: 'resolved' });
    });
  }
});
