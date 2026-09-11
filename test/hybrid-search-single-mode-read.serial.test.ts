/**
 * #4359 — hybridSearchCached() and the bare hybridSearch() it calls on a
 * miss/disabled outcome each independently call `loadSearchModeConfig(engine)`
 * (mode.ts). That's a second DB-plane config round trip on every
 * `hybridSearchCached` call, AND — if `search.mode` / `search.searchLimit` /
 * another per-key override changes between the two reads — a desync: the
 * cache row gets keyed (`knobsHash`) from the outer (stale) config read while
 * its actual size/contents come from the inner (newer) read.
 *
 * Context (checked before writing these tests, per the coordinator's note):
 * `semanticResultCacheAvailable()` (query-cache.ts) is hardcoded `false` right
 * now, so `hybridSearchCached` never actually reads a HIT or writes a cache
 * row in this repo's current state — every call takes the miss/disabled
 * branch. That does NOT make the double config read moot: both reads happen
 * unconditionally, at the top of each function, regardless of whether the
 * semantic result cache itself is live. These tests exercise ONLY the
 * miss/disabled path (no cache HIT, no cache row write) and pin the read
 * count directly — they do not depend on the cache being enabled, and they
 * stay meaningful once it's turned back on (that's exactly when the desync
 * this fix closes becomes observable again).
 *
 * Seam: `loadSearchModeConfig` itself, module-mocked so the count and the
 * returned snapshot are fully decoupled from the OTHER config reads
 * `hybridSearch`/`hybridSearchCached` also perform (loadConfigWithEngine for
 * the embedding column, loadEngineIntentPatterns, loadCacheConfig, ...) —
 * none of those are part of this bug or this fix.
 */

import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test';
import * as realMode from '../src/core/search/mode.ts';
import type { ResolveSearchModeInput } from '../src/core/search/mode.ts';

// Capture the REAL function reference before mock.module runs. `realMode` is
// a live ES module namespace object — once mock.module replaces the module
// registry entry for this specifier, `realMode.loadSearchModeConfig` (looked
// up by property access at call time) resolves to the MOCK, not the
// original, and calling through it from inside the mock recurses forever.
// The captured local binding is a plain function reference, unaffected by
// later mutation of the namespace object's properties.
const originalLoadSearchModeConfig = realMode.loadSearchModeConfig;

let loadSearchModeConfigCallCount = 0;
/** When set, `loadSearchModeConfig` returns entries from this list by call
 *  index (clamped to the last entry) instead of delegating to the real
 *  engine read — lets a test simulate a config value that CHANGES between
 *  reads without needing a real config table mutation mid-request. */
let overrideSequence: ResolveSearchModeInput[] | null = null;

mock.module('../src/core/search/mode.ts', () => ({
  ...realMode,
  loadSearchModeConfig: async (engine: Parameters<typeof realMode.loadSearchModeConfig>[0]) => {
    const callIndex = loadSearchModeConfigCallCount;
    loadSearchModeConfigCallCount++;
    if (overrideSequence) {
      const idx = Math.min(callIndex, overrideSequence.length - 1);
      return overrideSequence[idx];
    }
    return originalLoadSearchModeConfig(engine);
  },
}));

// Import AFTER mocking (Bun resolves both static and dynamic `import()` of a
// mocked specifier to the mock — hybrid.ts's `await import('./mode.ts')`
// call sites pick this up too).
const { hybridSearch, hybridSearchCached } = await import('../src/core/search/hybrid.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');

let engine: InstanceType<typeof PGLiteEngine>;
const savedKey = process.env.OPENAI_API_KEY;
const KEYWORD = 'gbrain4359singlemoderead';
const PAGE_COUNT = 15;

beforeAll(async () => {
  // Force keyword-only fallback (no embedding provider) — cache lookup is
  // already unconditionally skipped by semanticResultCacheAvailable()===false
  // (see file header), so this just keeps the fixture simple/fast; it is not
  // load-bearing for the discrimination itself.
  delete process.env.OPENAI_API_KEY;

  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  for (let i = 0; i < PAGE_COUNT; i++) {
    const slug = `widgets/${i}`;
    const truth = `${KEYWORD} entry number ${i}, a widget.`;
    await engine.putPage(slug, { type: 'note', title: `Widget ${i}`, compiled_truth: truth });
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: truth, chunk_source: 'compiled_truth' },
    ]);
  }
});

afterAll(async () => {
  // Restore exactly what was there — an initial empty string must come back
  // as an empty string, not be dropped (savedKey === '' is falsy).
  if (savedKey !== undefined) process.env.OPENAI_API_KEY = savedKey;
  try { await engine.disconnect(); } catch { /* ignore */ }
  // Put the real loader back so a combined (non-serial) bun test run that
  // loads this file first does not hand the counting mock to later files.
  // `realMode` is the live namespace whose `loadSearchModeConfig` now
  // resolves to the mock, so re-registering the namespace alone would NOT
  // restore it — the captured original function reference must be spliced in.
  mock.module('../src/core/search/mode.ts', () => ({
    ...realMode,
    loadSearchModeConfig: originalLoadSearchModeConfig,
  }));
});

afterEach(() => {
  loadSearchModeConfigCallCount = 0;
  overrideSequence = null;
});

describe('#4359 — one search-mode config read per hybridSearchCached call', () => {
  test('cache miss/disabled through hybridSearchCached loads search-mode config exactly once', async () => {
    const results = await hybridSearchCached(engine, KEYWORD, {
      limit: 5,
      autocut: false,
      relationalRetrieval: false,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(loadSearchModeConfigCallCount).toBe(1);
  });

  test('bare hybridSearch (no internal field) still loads its own config exactly once — regression guard for direct callers (eval replay / eval-longmemeval / ops)', async () => {
    const results = await hybridSearch(engine, KEYWORD, {
      limit: 5,
      autocut: false,
      relationalRetrieval: false,
    });
    expect(results.length).toBeGreaterThan(0);
    expect(loadSearchModeConfigCallCount).toBe(1);
  });

  test('desync guard: the cache-key resolution and the actual returned result set agree on the SAME config snapshot, even when the underlying config changes mid-request', async () => {
    // Simulates `search.searchLimit` changing between hybridSearchCached's
    // own read (used to build knobsHash / the HIT-path limit) and whatever
    // read the inner hybridSearch performs: call #1 (whichever site makes
    // it first) sees searchLimit=3, call #2 (if one happens) sees
    // searchLimit=9. Pre-fix, hybridSearchCached reads once (call #1, limit
    // 3 — what the cache key would reflect) and the inner hybridSearch it
    // calls on the miss reads AGAIN independently (call #2, limit 9 — what
    // actually gets sliced and returned/would-be-cached), producing a
    // request whose returned result count doesn't match its own cache-key
    // resolution. Post-fix there is only ever ONE read (limit 3, threaded
    // into the inner call), so the returned count always agrees with it.
    overrideSequence = [
      { mode: 'conservative', overrides: { searchLimit: 3 } },
      { mode: 'conservative', overrides: { searchLimit: 9 } },
    ];
    const results = await hybridSearchCached(engine, KEYWORD, {
      autocut: false,
      relationalRetrieval: false,
    });
    expect(results.length).toBe(3);
  });
});
