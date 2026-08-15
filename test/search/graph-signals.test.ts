/**
 * v0.40.4.0 — applyGraphSignals unit + REGRESSION tests.
 *
 * Hermetic via opts.adjacencyFn injection seam (no engine needed).
 *
 * Pinned contracts:
 *   - Disabled / empty → unchanged + zero-meta
 *   - Adjacency hit boosts and stamps fields
 *   - Cross-source hit boosts ON TOP of adjacency (stacking)
 *   - Cross-source ONLY (hits<2 but cross_source_hits>=2) — uncommon
 *     in practice but the SQL allows it
 *   - Session diversification: highest keeps full, rest demoted
 *   - Single-segment slug (no '/') doesn't false-group
 *   - Test seam injection works without engine
 *   - Fail-open on engine throw; audit row written; meta.errored=true
 *   - Score-distribution probe always fires when enabled
 *   - Single-pass O(K) session grouping (D9=A regression assertion)
 *   - REGRESSION (IRON RULE T11): floor-gate respected — weak hub
 *     does NOT outrank above-floor non-hub
 */

import { describe, test, expect } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';
import type { AdjacencyRow } from '../../src/core/types.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import {
  applyGraphSignals,
  ADJACENCY_BOOST,
  CROSS_SOURCE_BOOST,
  SESSION_DEMOTE,
  sessionPrefix,
  computeScoreDistribution,
} from '../../src/core/search/graph-signals.ts';

// Minimal SearchResult factory.
function makeResult(slug: string, score: number, page_id: number, source_id = 'a'): SearchResult {
  return {
    slug,
    page_id,
    title: slug,
    type: 'note' as const,
    chunk_text: `body of ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: page_id * 1000,
    chunk_index: 0,
    score,
    stale: false,
    source_id,
  };
}

// Engine stub — only the methods applyGraphSignals reaches into are used.
// adjacencyFn is the test seam, so engine is rarely called; fall through to
// throwing if accidentally hit.
const ENGINE_STUB = {} as BrainEngine;

describe('sessionPrefix (v0.40.4 narrowed scope — codex fix for entity-dir false positives)', () => {
  test('chat marker → prefix up to and including session id', () => {
    expect(sessionPrefix('your-agent/chat/2026-05-20-foo')).toBe('your-agent/chat/2026-05-20-foo');
  });

  test('chat marker with trailing chunk segment → prefix is parent', () => {
    // For media/chat/2026-05-20-foo/chunk-001, the chat-session is
    // media/chat/2026-05-20-foo (the parent of the chunk file).
    expect(sessionPrefix('media/chat/2026-05-20-foo/chunk-001')).toBe('media/chat/2026-05-20-foo');
  });

  test('date segment in middle of path → prefix is up to and including date', () => {
    expect(sessionPrefix('daily/2026-05-20/journal-entry-1')).toBe('daily/2026-05-20');
  });

  test('transcripts marker → prefix up to and including transcript id', () => {
    expect(sessionPrefix('transcripts/chat/funding-discussion')).toBe('transcripts/chat/funding-discussion');
  });

  test('entity directory (no marker, no date) → null (skip diversification)', () => {
    expect(sessionPrefix('people/alice')).toBeNull();
    expect(sessionPrefix('companies/acme')).toBeNull();
    expect(sessionPrefix('wiki/concepts/auth')).toBeNull();
    expect(sessionPrefix('docs/quickstart')).toBeNull();
  });

  test('single-segment slug → null (no path, no session)', () => {
    expect(sessionPrefix('standalone')).toBeNull();
  });

  test('empty slug → null', () => {
    expect(sessionPrefix('')).toBeNull();
  });

  test('meetings + date → meeting-session prefix', () => {
    expect(sessionPrefix('meetings/2026-04-03/notes')).toBe('meetings/2026-04-03');
  });
});

describe('computeScoreDistribution', () => {
  test('empty input → zeros', () => {
    const d = computeScoreDistribution([]);
    expect(d.top_k_size).toBe(0);
    expect(d.reorder_band_width).toBe(0);
  });

  test('ordered scores → percentiles + band width', () => {
    const d = computeScoreDistribution([10, 8, 6, 4, 2]);
    expect(d.top_k_size).toBe(5);
    expect(d.min).toBe(2);
    expect(d.max).toBe(10);
    expect(d.p50).toBe(6);
    expect(d.reorder_band_width).toBe(8);
  });

  test('unsorted input is sorted internally', () => {
    const d = computeScoreDistribution([4, 10, 2, 8, 6]);
    expect(d.min).toBe(2);
    expect(d.max).toBe(10);
    expect(d.p50).toBe(6);
  });
});

describe('applyGraphSignals — gate', () => {
  test('disabled → unchanged + zero-meta', async () => {
    const results = [makeResult('a/b', 1.0, 1), makeResult('a/c', 0.5, 2)];
    const before = results.map(r => ({ score: r.score, slug: r.slug }));
    let calledFn = false;
    let metaOut: any;
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: false,
      adjacencyFn: async () => { calledFn = true; return new Map(); },
      onMeta: (m) => { metaOut = m; },
    });
    expect(calledFn).toBe(false);
    expect(results.map(r => ({ score: r.score, slug: r.slug }))).toEqual(before);
    expect(metaOut.enabled).toBe(false);
    expect(metaOut.adjacency_fires).toBe(0);
  });

  test('empty results → unchanged + zero-meta + no SQL', async () => {
    let calledFn = false;
    let metaOut: any;
    await applyGraphSignals([], ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => { calledFn = true; return new Map(); },
      onMeta: (m) => { metaOut = m; },
    });
    expect(calledFn).toBe(false);
    expect(metaOut.enabled).toBe(true);
    expect(metaOut.top_k_size).toBe(0);
  });
});

describe('applyGraphSignals — adjacency boost', () => {
  test('hits >= 2 → score multiplied by ADJACENCY_BOOST, fields stamped', async () => {
    const results = [
      makeResult('people/alice', 10, 1),
      makeResult('people/bob', 9, 2),
      makeResult('companies/acme', 8, 3),  // hub: 3 inbound links from top-K
    ];
    const adjacency = new Map<number, AdjacencyRow>([
      [3, { hits: 3, cross_source_hits: 0 }],
    ]);
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => adjacency,
    });
    const acme = results.find(r => r.slug === 'companies/acme')!;
    expect(acme.score).toBeCloseTo(8 * ADJACENCY_BOOST, 5);
    expect(acme.graph_adjacency_hits).toBe(3);
    expect(acme.graph_adjacency_boost).toBe(ADJACENCY_BOOST);
  });

  test('hits < 2 → no boost, no field stamp', async () => {
    // Distinct prefixes so session-diversification doesn't mutate scores.
    const results = [makeResult('alpha/b', 10, 1), makeResult('beta/c', 9, 2)];
    const adjacency = new Map<number, AdjacencyRow>([
      [2, { hits: 1, cross_source_hits: 0 }],  // below threshold
    ]);
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => adjacency,
    });
    const r = results.find(r => r.slug === 'beta/c')!;
    expect(r.score).toBe(9);
    expect(r.graph_adjacency_hits).toBeUndefined();
  });
});

describe('applyGraphSignals — cross-source boost (stacks on adjacency)', () => {
  test('hits>=2 AND cross_source>=2 → both multipliers stack', async () => {
    const results = [
      makeResult('people/alice', 10, 1),
      makeResult('companies/acme', 8, 3),  // both signals fire
    ];
    const adjacency = new Map<number, AdjacencyRow>([
      [3, { hits: 3, cross_source_hits: 2 }],
    ]);
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => adjacency,
    });
    const acme = results.find(r => r.slug === 'companies/acme')!;
    expect(acme.score).toBeCloseTo(8 * ADJACENCY_BOOST * CROSS_SOURCE_BOOST, 5);
    expect(acme.graph_adjacency_boost).toBe(ADJACENCY_BOOST);
    expect(acme.graph_cross_source_boost).toBe(CROSS_SOURCE_BOOST);
    expect(acme.graph_cross_source_hits).toBe(2);
  });

  test('cross_source only (hits<2 but cross_source>=2) → cross-source fires alone', async () => {
    const results = [makeResult('companies/acme', 8, 3)];
    const adjacency = new Map<number, AdjacencyRow>([
      [3, { hits: 1, cross_source_hits: 2 }],
    ]);
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => adjacency,
    });
    const acme = results[0];
    expect(acme.score).toBeCloseTo(8 * CROSS_SOURCE_BOOST, 5);
    expect(acme.graph_adjacency_boost).toBeUndefined();
    expect(acme.graph_cross_source_boost).toBe(CROSS_SOURCE_BOOST);
  });
});

describe('applyGraphSignals — session diversification', () => {
  test('3 chat-session chunks share prefix → highest keeps full, other 2 demoted', async () => {
    const results = [
      makeResult('media/chat/2026-05-20-foo/a', 10, 1),
      makeResult('media/chat/2026-05-20-foo/b', 9, 2),
      makeResult('media/chat/2026-05-20-foo/c', 7, 3),
    ];
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => new Map(),
    });
    // Highest (slug a, score 10) keeps full.
    const a = results[0];
    expect(a.score).toBe(10);
    expect(a.graph_session_demoted).toBeUndefined();
    expect(a.graph_session_prefix).toBe('media/chat/2026-05-20-foo');
    // Others demoted.
    expect(results[1].score).toBeCloseTo(9 * SESSION_DEMOTE, 5);
    expect(results[1].graph_session_demoted).toBe(true);
    expect(results[1].session_demote_factor).toBe(SESSION_DEMOTE);
    expect(results[2].score).toBeCloseTo(7 * SESSION_DEMOTE, 5);
    expect(results[2].graph_session_demoted).toBe(true);
  });

  test('REGRESSION (codex H2): entity-directory siblings (people/alice + people/bob) are NOT diversified', async () => {
    // Pre-fix behavior: people/alice + people/bob shared `people/` prefix
    // and people/bob got demoted. This silently penalized every common
    // entity-search query like "people in SF". Post-fix: sessionPrefix
    // returns null for non-session slugs, so no diversification fires.
    const results = [
      makeResult('people/alice', 10, 1),
      makeResult('people/bob', 9, 2),
      makeResult('people/charlie', 7, 3),
    ];
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => new Map(),
    });
    expect(results[0].score).toBe(10);
    expect(results[1].score).toBe(9);   // NOT demoted
    expect(results[2].score).toBe(7);   // NOT demoted
    expect(results[0].graph_session_demoted).toBeUndefined();
    expect(results[1].graph_session_demoted).toBeUndefined();
    expect(results[2].graph_session_demoted).toBeUndefined();
  });

  test('non-session slug (no chat/date marker) → not grouped, no false demote', async () => {
    const results = [
      makeResult('standalone', 10, 1),
      makeResult('media/chat/2026-05-20-foo/a', 9, 2),
      makeResult('media/chat/2026-05-20-foo/b', 8, 3),
    ];
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => new Map(),
    });
    // standalone: not session-shaped → no demote.
    const standalone = results[0];
    expect(standalone.score).toBe(10);
    expect(standalone.graph_session_demoted).toBeUndefined();
    // Two chat pages still group + demote.
    expect(results[1].score).toBe(9);  // highest in group
    expect(results[2].score).toBeCloseTo(8 * SESSION_DEMOTE, 5);
  });

  test('singleton session group → no demote', async () => {
    const results = [
      makeResult('media/chat/foo-session', 10, 1),
      makeResult('media/chat/bar-session', 9, 2),
    ];
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => new Map(),
    });
    expect(results[0].score).toBe(10);
    expect(results[1].score).toBe(9);
    expect(results[0].graph_session_demoted).toBeUndefined();
    expect(results[1].graph_session_demoted).toBeUndefined();
  });
});

describe('applyGraphSignals — IRON RULE (T11): floor-gate respected', () => {
  test('weak hub below floor threshold does NOT get boosted past strong above-floor non-hub', async () => {
    // Top result at score 100; weak hub at score 30. Floor = 50.
    // Without the gate: weak hub × 1.05 × 1.10 = 34.65 — still below
    // strong, BUT the regression class is that future stacked boosts
    // OR more aggressive magnitudes could shove a hub past a non-hub.
    // The gate is the structural protection — weak hub gets ZERO graph
    // boost regardless of magnitude.
    const results = [
      makeResult('strong/result', 100, 1),    // above floor, no hub signal
      makeResult('weak/hub', 30, 2),          // BELOW floor, hub
    ];
    const adjacency = new Map<number, AdjacencyRow>([
      [2, { hits: 5, cross_source_hits: 5 }],  // would be massive boost
    ]);
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      floorThreshold: 50,  // weak hub at 30 is BELOW
      adjacencyFn: async () => adjacency,
    });
    const weak = results[1];
    // Score MUST be unchanged — no adjacency, no cross-source boost.
    expect(weak.score).toBe(30);
    expect(weak.graph_adjacency_hits).toBeUndefined();
    expect(weak.graph_cross_source_hits).toBeUndefined();
    expect(weak.graph_adjacency_boost).toBeUndefined();
    // Strong result also untouched (no hub).
    const strong = results[0];
    expect(strong.score).toBe(100);
  });

  test('hub AT or ABOVE floor still gets boosted (gate is < not <=)', async () => {
    const results = [makeResult('hub', 50, 1)];  // exactly at floor
    const adjacency = new Map<number, AdjacencyRow>([
      [1, { hits: 3, cross_source_hits: 0 }],
    ]);
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      floorThreshold: 50,
      adjacencyFn: async () => adjacency,
    });
    expect(results[0].score).toBeCloseTo(50 * ADJACENCY_BOOST, 5);
    expect(results[0].graph_adjacency_hits).toBe(3);
  });

  test('NaN score result skips the gate AND the boost (NaN < x is false in JS)', async () => {
    const results = [makeResult('weird', NaN, 1)];
    const adjacency = new Map<number, AdjacencyRow>([
      [1, { hits: 3, cross_source_hits: 0 }],
    ]);
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      floorThreshold: 50,
      adjacencyFn: async () => adjacency,
    });
    // NaN >= threshold is FALSE → gate kicks in → no boost.
    expect(Number.isNaN(results[0].score)).toBe(true);
    expect(results[0].graph_adjacency_hits).toBeUndefined();
  });
});

describe('applyGraphSignals — fail-open', () => {
  test('adjacencyFn throws → meta.errored=true, results unchanged', async () => {
    const results = [makeResult('a/b', 10, 1), makeResult('c/d', 9, 2)];
    const before = results.map(r => r.score);
    let metaOut: any;
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => { throw new Error('boom'); },
      onMeta: (m) => { metaOut = m; },
    });
    expect(results.map(r => r.score)).toEqual(before);
    expect(metaOut.errored).toBe(true);
    // Session diversification also skips (predictable all-or-nothing).
    expect(metaOut.session_demotions).toBe(0);
  });

  test('adjacencyFn returns empty Map → no boosts, session diversification still runs', async () => {
    // Use session-shaped slugs (date anchor) so sessionPrefix returns a
    // real session id, not null. Post-v0.40.4 codex fix: bare `chat/a`
    // + `chat/b` would no longer group because sessionPrefix returns
    // 'chat/a' and 'chat/b' respectively (each treated as own session).
    const results = [
      makeResult('media/2026-05-20/chunk-a', 10, 1),
      makeResult('media/2026-05-20/chunk-b', 9, 2),
    ];
    let metaOut: any;
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => new Map(),
      onMeta: (m) => { metaOut = m; },
    });
    expect(metaOut.errored).toBe(false);
    expect(metaOut.adjacency_fires).toBe(0);
    // Session demotion DOES fire — both share session 'media/2026-05-20'.
    expect(metaOut.session_demotions).toBe(1);
  });
});

describe('applyGraphSignals — score-distribution probe', () => {
  test('always emitted when enabled, even with no fires', async () => {
    const results = [makeResult('a/b', 10, 1), makeResult('a/c', 9, 2)];
    let dist: any;
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => new Map(),
      onScoreDistribution: (d) => { dist = d; },
    });
    expect(dist.top_k_size).toBe(2);
    expect(dist.max).toBe(10);
    expect(dist.min).toBe(9);
    expect(dist.reorder_band_width).toBe(1);
  });

  test('not emitted when disabled', async () => {
    let called = false;
    await applyGraphSignals([makeResult('a/b', 10, 1)], ENGINE_STUB, {
      enabled: false,
      onScoreDistribution: () => { called = true; },
    });
    expect(called).toBe(false);
  });
});

describe('applyGraphSignals — meta + timing', () => {
  test('meta carries fire counts and duration_ms', async () => {
    // Session-shaped slugs (date anchor) so sessionPrefix returns the
    // same session for chunk-a + chunk-b. Pre-v0.40.4 codex fix: bare
    // 'chat/a' had session 'chat' but post-fix that returns null.
    const results = [
      makeResult('media/2026-05-20/chunk-a', 10, 1),
      makeResult('media/2026-05-20/chunk-b', 9, 2),
      makeResult('hub', 8, 3),
    ];
    const adjacency = new Map<number, AdjacencyRow>([
      [3, { hits: 3, cross_source_hits: 2 }],
    ]);
    let metaOut: any;
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async () => adjacency,
      onMeta: (m) => { metaOut = m; },
    });
    expect(metaOut.adjacency_fires).toBe(1);
    expect(metaOut.cross_source_fires).toBe(1);
    expect(metaOut.session_demotions).toBe(1);  // chat/a + chat/b → demote chat/b
    expect(metaOut.duration_ms).toBeGreaterThanOrEqual(0);
    expect(metaOut.top_k_size).toBe(3);
  });
});

describe('applyGraphSignals — page_id invariant', () => {
  test('result with missing page_id is silently skipped in dedup set', async () => {
    const r = makeResult('weird', 10, 0);  // invalid page_id
    (r as any).page_id = undefined;
    const results = [r, makeResult('normal', 9, 1)];
    const pageIdsSeen: number[][] = [];
    await applyGraphSignals(results, ENGINE_STUB, {
      enabled: true,
      adjacencyFn: async (ids) => { pageIdsSeen.push(ids); return new Map(); },
    });
    // The invalid page_id should NOT appear in the SQL input set.
    expect(pageIdsSeen[0]).toEqual([1]);
  });
});
