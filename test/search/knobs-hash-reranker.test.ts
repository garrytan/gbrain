/**
 * v0.35.0.0 — knobsHash reranker-field participation tests.
 *
 * Pins:
 *  - KNOBS_HASH_VERSION === 3 (bumped 1→2 v0.35.0.0 for reranker; 2→3 v0.35.6.0
 *    for floor_ratio — codex outside-voice T1 cross-floor cache contamination).
 *  - All 5 new reranker fields participate in the hash:
 *      reranker_enabled, reranker_model, reranker_top_n_in,
 *      reranker_top_n_out, reranker_timeout_ms.
 *    Each one flipping changes the hash → no two reranker configs share
 *    a cache row.
 *  - top_n_out=null vs unset shows up as 'none' in the hash (no NaN).
 *  - Append-only convention (CDX2-F13): the existing 9 fields hash
 *    identically under v=2 as they did under v=1 for the same input
 *    when the reranker section is held constant. Reordering them
 *    would silently rebuild the hash for every existing row.
 *  - Mid-deploy invariant (CDX2-F12): the v=1 prefix in the hash input
 *    differs from the v=2 prefix; a tokenmax v=1 process and a v=2
 *    process produce distinct row IDs for the same (source_id, query).
 */

import { describe, test, expect } from 'bun:test';
import {
  knobsHash,
  KNOBS_HASH_VERSION,
  resolveSearchMode,
  MODE_BUNDLES,
  type ResolvedSearchKnobs,
} from '../../src/core/search/mode.ts';

/** Build a baseline resolved knob set with all reranker fields filled. */
function baseKnobs(): ResolvedSearchKnobs {
  return {
    ...MODE_BUNDLES.balanced,
    reranker_enabled: false,
    reranker_model: 'zeroentropyai:zerank-2',
    reranker_top_n_in: 30,
    reranker_top_n_out: null,
    reranker_timeout_ms: 5000,
    resolved_mode: 'balanced',
    mode_valid: true,
  };
}

describe('KNOBS_HASH_VERSION + version invariants', () => {
  test('version is 9 (…; 6→7 title_boost; 7→8 autocut; 8→9 archive-demote #1777)', () => {
    // v0.35.0.0: 1→2 to fold reranker fields. v0.35.6.0: 2→3 to fold
    // floor_ratio. v0.36 wave: piggybacks on v=3 with 7 cross-modal knobs
    // (D2) PLUS column + provider context (D8/CDX-2 cross-column isolation).
    // v0.40.4 (salem) + v0.39 T21 (master): 3→4 to fold graph_signals AND
    // schema_pack name + version (graph-on cache write cannot be served to
    // graph-off; cross-pack contamination structurally impossible).
    // v0.40.3.0 (D8): 4→5 to fold contextual_retrieval + kill switch,
    // sequenced behind salem's v=4 graph-signals.
    // v0.41.22.0 (type-unification): 5→6 to fold the alias_resolved
    // post-fusion boost. Cache rows written before the boost stage
    // cannot leak past the new stage. T2: 6→7 title_boost. v0.42.3.0: 7→8
    // autocut. issue #1777: 8→9 archive/ demote (search-exclude policy change
    // isn't in the hash, so the bump invalidates archive-excluded cache rows).
    expect(KNOBS_HASH_VERSION).toBe(9);
  });

  test('hash is 16 hex chars regardless of reranker config', () => {
    const a = knobsHash(baseKnobs());
    const b = knobsHash({ ...baseKnobs(), reranker_enabled: true });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('Each reranker field flips the hash (cache-row separation)', () => {
  test('reranker_enabled false vs true → different hash', () => {
    const off = knobsHash({ ...baseKnobs(), reranker_enabled: false });
    const on = knobsHash({ ...baseKnobs(), reranker_enabled: true });
    expect(off).not.toBe(on);
  });

  test('reranker_model differs → different hash', () => {
    const z2 = knobsHash({ ...baseKnobs(), reranker_model: 'zeroentropyai:zerank-2' });
    const z1 = knobsHash({ ...baseKnobs(), reranker_model: 'zeroentropyai:zerank-1' });
    const z1s = knobsHash({ ...baseKnobs(), reranker_model: 'zeroentropyai:zerank-1-small' });
    expect(new Set([z2, z1, z1s]).size).toBe(3);
  });

  test('reranker_top_n_in differs → different hash', () => {
    const a = knobsHash({ ...baseKnobs(), reranker_top_n_in: 30 });
    const b = knobsHash({ ...baseKnobs(), reranker_top_n_in: 50 });
    expect(a).not.toBe(b);
  });

  test('reranker_top_n_out null vs 10 → different hash', () => {
    const noTrunc = knobsHash({ ...baseKnobs(), reranker_top_n_out: null });
    const trunc10 = knobsHash({ ...baseKnobs(), reranker_top_n_out: 10 });
    expect(noTrunc).not.toBe(trunc10);
  });

  test('reranker_timeout_ms differs → different hash (CDX2-F14)', () => {
    // CDX2-F14: a timeout change (5s → 100ms) changes search behavior
    // (more fail-opens) so stale cache rows must invalidate. Without
    // this field in parts[], the rows would silently match.
    const t5 = knobsHash({ ...baseKnobs(), reranker_timeout_ms: 5000 });
    const t1 = knobsHash({ ...baseKnobs(), reranker_timeout_ms: 1000 });
    expect(t5).not.toBe(t1);
  });
});

describe('mid-deploy invariant (CDX2-F12)', () => {
  test('tokenmax-with-reranker vs tokenmax-without-reranker → distinct hashes', () => {
    // tokenmax mode bundle has reranker on. An operator who flips it off
    // via `gbrain config set search.reranker.enabled false` produces a
    // different cache row, not a shared one.
    const tokenmaxOn = knobsHash(resolveSearchMode({ mode: 'tokenmax' }));
    const tokenmaxOff = knobsHash(resolveSearchMode({
      mode: 'tokenmax',
      overrides: { reranker_enabled: false },
    }));
    expect(tokenmaxOn).not.toBe(tokenmaxOff);
  });

  test('conservative vs balanced vs tokenmax → 3 distinct hashes', () => {
    const c = knobsHash(resolveSearchMode({ mode: 'conservative' }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    const t = knobsHash(resolveSearchMode({ mode: 'tokenmax' }));
    expect(new Set([c, b, t]).size).toBe(3);
  });
});

describe('determinism + stability', () => {
  test('same input → same hash (re-call)', () => {
    const k = baseKnobs();
    expect(knobsHash(k)).toBe(knobsHash(k));
  });

  test('same mode bundle → same hash across resolveSearchMode calls', () => {
    const a = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    const b = knobsHash(resolveSearchMode({ mode: 'balanced' }));
    expect(a).toBe(b);
  });

  test('top_n_out=null renders as "none" in parts[] (no NaN)', () => {
    // CDX2-F15 + F16 + F14 collide here. The parts[] line is
    // `rro=${knobs.reranker_top_n_out ?? 'none'}` — null must produce a
    // stable string token, never `NaN` or `null`.
    const h1 = knobsHash({ ...baseKnobs(), reranker_top_n_out: null });
    const h2 = knobsHash({ ...baseKnobs(), reranker_top_n_out: null });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('append-only convention (CDX2-F13)', () => {
  test('parts[] order in source: reranker fields appear AFTER the existing 9', async () => {
    const src = await Bun.file(
      new URL('../../src/core/search/mode.ts', import.meta.url),
    ).text();
    // Locate the parts[] declaration. The existing 9 fields end with
    // `lim=${knobs.searchLimit}`. The 5 new fields must appear AFTER
    // that line. Reordering would silently rebuild the hash for every
    // existing v=2 cache row.
    const limIdx = src.indexOf('lim=${knobs.searchLimit}');
    const rrIdx = src.indexOf('rr=${knobs.reranker_enabled');
    expect(limIdx).toBeGreaterThan(0);
    expect(rrIdx).toBeGreaterThan(0);
    expect(rrIdx).toBeGreaterThan(limIdx);
  });

  test('v=3 additions: col= and prov= appear AFTER the reranker block', async () => {
    // v0.36 D8: cache-key contamination across embedding columns + providers.
    // The two new tokens must sit at the bottom of parts[] so existing v=2
    // hashes can only differ in those positions — keeping the append-only
    // chain auditable for future v=4 readers.
    const src = await Bun.file(
      new URL('../../src/core/search/mode.ts', import.meta.url),
    ).text();
    const rrtIdx = src.indexOf('rrt=${knobs.reranker_timeout_ms');
    const colIdx = src.indexOf('col=${ctx?.embeddingColumn');
    const provIdx = src.indexOf('prov=${ctx?.embeddingModel');
    expect(rrtIdx).toBeGreaterThan(0);
    expect(colIdx).toBeGreaterThan(rrtIdx);
    expect(provIdx).toBeGreaterThan(colIdx);
  });

  test('v=3 fields participate: column flip changes the hash', () => {
    const k = baseKnobs();
    const defaultCol = knobsHash(k, { embeddingColumn: 'embedding', embeddingModel: 'openai:text-embedding-3-large' });
    const voyageCol = knobsHash(k, { embeddingColumn: 'embedding_voyage', embeddingModel: 'voyage:voyage-3-large' });
    expect(defaultCol).not.toBe(voyageCol);
  });

  test('v=3 fields participate: same column + different provider → different hash', () => {
    const k = baseKnobs();
    const a = knobsHash(k, { embeddingColumn: 'embedding', embeddingModel: 'openai:text-embedding-3-large' });
    const b = knobsHash(k, { embeddingColumn: 'embedding', embeddingModel: 'openai:text-embedding-3-small' });
    expect(a).not.toBe(b);
  });

  test('v=3 fields fall back to embedding/default when ctx undefined', () => {
    // Backward-compat: callers that don't know the column (e.g. telemetry
    // helpers) should still produce a stable hash matching the default
    // 'embedding' + 'default' provider pair.
    const k = baseKnobs();
    const bare = knobsHash(k);
    const explicit = knobsHash(k, { embeddingColumn: 'embedding', embeddingModel: 'default' });
    expect(bare).toBe(explicit);
  });
});
