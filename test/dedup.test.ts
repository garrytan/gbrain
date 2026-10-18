/**
 * Dedup pipeline unit tests — source-aware guarantee, layer interactions,
 * and compiled truth preservation.
 */

import { describe, test, expect } from 'bun:test';
import { dedupResults, MAX_PER_SEGMENTED_PAGE, SEGMENT_CLUSTER_BYTES } from '../src/core/search/dedup.ts';
import { applySnippetCap } from '../src/core/search/snippet-cap.ts';
import type { SearchResult } from '../src/core/types.ts';

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'test-page',
    page_id: 1,
    title: 'Test',
    type: 'concept',
    chunk_text: 'unique chunk text ' + Math.random(),
    chunk_source: 'compiled_truth',
    chunk_id: Math.floor(Math.random() * 10000),
    chunk_index: 0,
    score: 0.5,
    stale: false,
    ...overrides,
  };
}

describe('dedupResults', () => {
  test('basic dedup caps per page to 2', () => {
    const results = [
      makeResult({ slug: 'a', score: 0.9, chunk_text: 'first' }),
      makeResult({ slug: 'a', score: 0.8, chunk_text: 'second' }),
      makeResult({ slug: 'a', score: 0.7, chunk_text: 'third' }),
      makeResult({ slug: 'a', score: 0.6, chunk_text: 'fourth' }),
    ];
    const deduped = dedupResults(results);
    const aChunks = deduped.filter(r => r.slug === 'a');
    expect(aChunks.length).toBeLessThanOrEqual(2);
  });

  test('removes text-similar chunks WITHIN a page (v0.46.15 #3983 scope)', () => {
    const base = 'the quick brown fox jumps over the lazy dog while seventeen other animals watch from a nearby grassy hill in silence';
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.9, chunk_text: `${base} today` }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.8, chunk_text: `${base} now` }),
    ];
    const deduped = dedupResults(results);
    // Same page, near-identical text → intra-page collapse still fires.
    expect(deduped.filter(r => r.slug === 'a').length).toBe(1);
  });

  test('REGRESSION (#3983): near-duplicate text on DIFFERENT pages never deletes a page', () => {
    // Near-duplicate-record corpus: two deal memos sharing boilerplate.
    // The unscoped Jaccard drop silently deleted the second PAGE from the
    // result set — distinct pages are distinct answers.
    const results = [
      makeResult({ slug: 'deals/acme-seed', page_id: 1, score: 0.9, chunk_text: 'standard deal memo boilerplate terms valuation notes intro' }),
      makeResult({ slug: 'deals/widget-series-a', page_id: 2, score: 0.85, chunk_text: 'standard deal memo boilerplate terms valuation notes summary' }),
    ];
    const deduped = dedupResults(results);
    const pages = new Set(deduped.map(r => r.slug));
    expect(pages.has('deals/acme-seed')).toBe(true);
    expect(pages.has('deals/widget-series-a')).toBe(true);
  });

  test('enforces type diversity when mixed types present', () => {
    // Mix of person and concept types — diversity should cap person
    const results = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeResult({ slug: `p${i}`, page_id: i, score: 1 - i * 0.05, type: 'person', chunk_text: `person ${i} unique text content here` })
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        makeResult({ slug: `c${i}`, page_id: 100 + i, score: 0.4 - i * 0.05, type: 'concept', chunk_text: `concept ${i} unique text content here` })
      ),
    ];
    const deduped = dedupResults(results);
    const personCount = deduped.filter(r => r.type === 'person').length;
    const conceptCount = deduped.filter(r => r.type === 'concept').length;
    // With diversity enforcement, person shouldn't completely dominate
    expect(personCount).toBeGreaterThan(0);
    expect(conceptCount).toBeGreaterThan(0);
  });

  test('nightly-7 regression: preserves all three distinct note sessions', () => {
    const results = [
      makeResult({
        slug: 'chat/nightly-7-s1',
        page_id: 1,
        score: 0.8381,
        type: 'note',
        chunk_text: 'alice-example launched widget-co/payments in January',
      }),
      makeResult({
        slug: 'chat/nightly-7-s3',
        page_id: 3,
        score: 0.8280,
        type: 'note',
        chunk_text: 'alice-example launched widget-co/reporting in June',
      }),
      makeResult({
        slug: 'chat/nightly-7-s2',
        page_id: 2,
        score: 0.8213,
        type: 'note',
        chunk_text: 'alice-example launched widget-co/identity in March',
      }),
    ];

    expect(dedupResults(results).map(result => result.slug)).toEqual([
      'chat/nightly-7-s1',
      'chat/nightly-7-s3',
      'chat/nightly-7-s2',
    ]);
  });
});

describe('compiled truth guarantee', () => {
  test('swaps in compiled_truth when page has only timeline in results', () => {
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.9, chunk_source: 'timeline', chunk_text: 'timeline entry about meeting' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.8, chunk_source: 'timeline', chunk_text: 'another timeline entry here' }),
      makeResult({ slug: 'a', chunk_id: 3, score: 0.3, chunk_source: 'compiled_truth', chunk_text: 'compiled truth assessment of entity' }),
      makeResult({ slug: 'b', chunk_id: 4, score: 0.7, chunk_source: 'compiled_truth', chunk_text: 'page b compiled truth' }),
    ];
    const deduped = dedupResults(results);
    const aChunks = deduped.filter(r => r.slug === 'a');
    const hasCompiledTruth = aChunks.some(c => c.chunk_source === 'compiled_truth');
    expect(hasCompiledTruth).toBe(true);
  });

  test('adds the highest-scoring compiled_truth chunk; first seen wins a tie', () => {
    const timeline = (id: number, score: number) => makeResult({
      slug: 'a', chunk_id: id, score, chunk_source: 'timeline', chunk_text: `timeline entry number ${id}`,
    });
    const truth = (id: number, score: number) => makeResult({
      slug: 'a', chunk_id: id, score, chunk_source: 'compiled_truth', chunk_text: `compiled truth variant ${id}`,
    });
    const best = dedupResults([timeline(1, 0.9), timeline(2, 0.8), timeline(3, 0.7), truth(4, 0.2), truth(5, 0.4), truth(6, 0.3)]);
    expect(best.map(r => r.chunk_id)).toEqual([1, 2, 5]);
    const tie = dedupResults([timeline(1, 0.9), timeline(2, 0.8), timeline(3, 0.7), truth(7, 0.3), truth(8, 0.3)]);
    expect(tie.map(r => r.chunk_id)).toEqual([1, 2, 7]);
  });

  test('does not swap when page already has compiled_truth', () => {
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.9, chunk_source: 'compiled_truth', chunk_text: 'compiled assessment' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.8, chunk_source: 'timeline', chunk_text: 'timeline entry details' }),
    ];
    const deduped = dedupResults(results);
    const aChunks = deduped.filter(r => r.slug === 'a');
    // Should still have compiled_truth
    expect(aChunks.some(c => c.chunk_source === 'compiled_truth')).toBe(true);
  });

  test('does nothing when no compiled_truth exists for page', () => {
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.9, chunk_source: 'timeline', chunk_text: 'only timeline chunk one' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.8, chunk_source: 'timeline', chunk_text: 'only timeline chunk two' }),
    ];
    const deduped = dedupResults(results);
    // All timeline, no compiled_truth to swap in
    const aChunks = deduped.filter(r => r.slug === 'a');
    expect(aChunks.every(c => c.chunk_source === 'timeline')).toBe(true);
  });

  test('guarantee works across multiple pages', () => {
    const results = [
      // Page A: only timeline in top results, compiled_truth exists lower
      makeResult({ slug: 'a', chunk_id: 1, score: 0.95, chunk_source: 'timeline', chunk_text: 'a timeline high score' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.9, chunk_source: 'timeline', chunk_text: 'a timeline medium score' }),
      makeResult({ slug: 'a', chunk_id: 3, score: 0.2, chunk_source: 'compiled_truth', chunk_text: 'a compiled truth low score' }),
      // Page B: has compiled_truth already
      makeResult({ slug: 'b', chunk_id: 4, score: 0.85, chunk_source: 'compiled_truth', chunk_text: 'b compiled truth content' }),
      // Page C: only timeline, no compiled_truth at all
      makeResult({ slug: 'c', chunk_id: 5, score: 0.8, chunk_source: 'timeline', chunk_text: 'c timeline only entry' }),
    ];

    const deduped = dedupResults(results);

    // Page A should have compiled_truth guaranteed
    const aChunks = deduped.filter(r => r.slug === 'a');
    if (aChunks.length > 0) {
      expect(aChunks.some(c => c.chunk_source === 'compiled_truth')).toBe(true);
    }

    // Page B already had compiled_truth
    const bChunks = deduped.filter(r => r.slug === 'b');
    if (bChunks.length > 0) {
      expect(bChunks.some(c => c.chunk_source === 'compiled_truth')).toBe(true);
    }

    // Page C has no compiled_truth to swap in, so all timeline is fine
    const cChunks = deduped.filter(r => r.slug === 'c');
    if (cChunks.length > 0) {
      expect(cChunks.every(c => c.chunk_source === 'timeline')).toBe(true);
    }
  });
});

describe('edge cases', () => {
  test('empty input returns empty', () => {
    expect(dedupResults([])).toEqual([]);
  });

  test('single result passes through', () => {
    const result = makeResult({ chunk_text: 'single result here' });
    const deduped = dedupResults([result]);
    expect(deduped).toHaveLength(1);
  });

  test('respects custom maxPerPage option', () => {
    const results = Array.from({ length: 5 }, (_, i) =>
      makeResult({ slug: 'a', chunk_id: i + 100, score: 1 - i * 0.1, chunk_text: `chunk number ${i} with unique content` })
    );
    const deduped = dedupResults(results, { maxPerPage: 3 });
    expect(deduped.filter(r => r.slug === 'a').length).toBeLessThanOrEqual(3);
  });
});

// ─────────────────────────────────────────────────────────────────
// v0.18.0 Step 3 — source-aware dedup (REGRESSION-CRITICAL per Codex)
// ─────────────────────────────────────────────────────────────────
// Pre-v0.17 dedup collapsed on slug alone. Under multi-source
// uniqueness, two same-slug pages in different sources ARE different
// pages — collapsing them destroys cross-source recall. Codex flagged
// this as a regression-critical path in the outside-voice review.
describe('dedup — source-aware composite key (v0.18.0)', () => {
  test('same slug across two sources does NOT collapse via dedupBySource layer', () => {
    // Two pages, same slug, different sources. Both should survive
    // Layer 1 (top-3-per-page) because they are DIFFERENT pages.
    const results = [
      makeResult({ slug: 'topics/ai', source_id: 'wiki',   score: 0.9, chunk_text: 'wiki take on ai' }),
      makeResult({ slug: 'topics/ai', source_id: 'gstack', score: 0.85, chunk_text: 'gstack plans for ai' }),
    ];
    const deduped = dedupResults(results);
    // Both pages represented — one result each.
    const wikiHits = deduped.filter(r => r.source_id === 'wiki' && r.slug === 'topics/ai');
    const gstackHits = deduped.filter(r => r.source_id === 'gstack' && r.slug === 'topics/ai');
    expect(wikiHits.length).toBe(1);
    expect(gstackHits.length).toBe(1);
  });

  test('same slug + same source DOES collapse to maxPerPage', () => {
    // Control: same-source-same-slug behavior unchanged from pre-v0.17.
    const results = [
      makeResult({ slug: 'topics/ai', source_id: 'wiki', chunk_id: 1, score: 0.9, chunk_text: 'chunk one distinct content here' }),
      makeResult({ slug: 'topics/ai', source_id: 'wiki', chunk_id: 2, score: 0.8, chunk_text: 'chunk two also distinct words' }),
      makeResult({ slug: 'topics/ai', source_id: 'wiki', chunk_id: 3, score: 0.7, chunk_text: 'chunk three different terms again' }),
    ];
    const deduped = dedupResults(results);
    // Default maxPerPage=2 → only 2 of the 3 wiki:topics/ai chunks survive.
    const wikiHits = deduped.filter(r => r.source_id === 'wiki' && r.slug === 'topics/ai');
    expect(wikiHits.length).toBeLessThanOrEqual(2);
  });

  test('missing source_id defaults to "default" for backward compat', () => {
    // Pre-v0.17 brains (single source, rows with no source_id column)
    // still dedup correctly: the fallback key groups them all under
    // the 'default' source bucket.
    const results = [
      makeResult({ slug: 'topics/ai', chunk_id: 1, score: 0.9, chunk_text: 'chunk one distinct content words' }),
      makeResult({ slug: 'topics/ai', chunk_id: 2, score: 0.8, chunk_text: 'chunk two totally different phrasing' }),
      makeResult({ slug: 'topics/ai', chunk_id: 3, score: 0.7, chunk_text: 'chunk three new unique text here' }),
    ];
    const deduped = dedupResults(results);
    // All three should group as one page (no source_id → default), so
    // maxPerPage=2 cap applies.
    expect(deduped.length).toBeLessThanOrEqual(2);
  });

  test('compiled_truth guarantee scopes to (source_id, slug), not slug alone', () => {
    // Two pages, same slug, different sources. wiki's top-scoring chunk
    // is timeline; gstack has only compiled_truth. The guarantee must
    // swap in wiki's compiled_truth for wiki (without touching gstack)
    // and must NOT accidentally pull gstack's compiled_truth into wiki.
    const results = [
      makeResult({ slug: 'topics/ai', source_id: 'wiki',   score: 0.9, chunk_source: 'timeline',       chunk_id: 1, chunk_text: 'wiki timeline chunk content here' }),
      makeResult({ slug: 'topics/ai', source_id: 'wiki',   score: 0.5, chunk_source: 'compiled_truth', chunk_id: 2, chunk_text: 'wiki compiled truth content text' }),
      makeResult({ slug: 'topics/ai', source_id: 'gstack', score: 0.7, chunk_source: 'compiled_truth', chunk_id: 3, chunk_text: 'gstack compiled truth something else' }),
    ];
    const deduped = dedupResults(results);
    // Wiki ends up with a compiled_truth (swapped from its own source,
    // not gstack's).
    const wikiCompiledTruths = deduped.filter(
      r => r.source_id === 'wiki' && r.slug === 'topics/ai' && r.chunk_source === 'compiled_truth',
    );
    expect(wikiCompiledTruths.length).toBe(1);
    expect(wikiCompiledTruths[0].chunk_id).toBe(2); // wiki's own compiled_truth, NOT gstack's (id=3)
  });
});

describe('compiled truth guarantee keeps evidence and score order (read-path audit #11)', () => {
  test('appends the compiled_truth chunk instead of evicting a matching chunk, output stays score-sorted', () => {
    const results = [
      makeResult({ slug: 'a', chunk_id: 1, score: 0.95, chunk_source: 'timeline', chunk_text: 'alpha timeline first match text' }),
      makeResult({ slug: 'a', chunk_id: 2, score: 0.90, chunk_source: 'timeline', chunk_text: 'second different timeline evidence words' }),
      makeResult({ slug: 'b', chunk_id: 3, score: 0.80, chunk_source: 'compiled_truth', chunk_text: 'page b compiled truth summary' }),
      makeResult({ slug: 'a', chunk_id: 4, score: 0.10, chunk_source: 'compiled_truth', chunk_text: 'page a compiled truth summary' }),
    ];
    const out = dedupResults(results);
    expect(out.map(r => r.chunk_id)).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < out.length; i++) expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
  });
});

// Wave B PR 2 (spec 7.5): a segmented page keeps up to 2 chunks per occurrence cluster (occurrences more than
// SEGMENT_CLUSTER_BYTES apart are separate regions), at most MAX_PER_SEGMENTED_PAGE in all; inline pages keep 2.
// Fails when the regions are ignored (every page capped at 2), clusters split at or below 1 MiB, or the page total
// passes 6.
describe('segmented pages: two chunks per occurrence cluster, six per page', () => {
  const MIB = 1024 * 1024;
  const WORDS = ['amber', 'basil', 'cedar', 'delta', 'ember', 'fjord', 'grove', 'heron', 'iris', 'juniper', 'kelp', 'lotus'];
  /** Hits on page `slug`, one per stored occurrence position, in score order, each with distinct text. */
  function hits(slug: string, positions: number[], firstId: number): { results: SearchResult[]; regions: Map<number, number> } {
    const results = positions.map((_, i) => makeResult({ slug, page_id: firstId, chunk_id: firstId + i, chunk_index: 10 + i, score: 1 - i * 0.01,
      chunk_text: `${WORDS[i % WORDS.length]} ${WORDS[(i * 5 + 3) % WORDS.length]} passage ${i} ${'x'.repeat(i)}` }));
    return { results, regions: new Map(positions.map((at, i) => [firstId + i, at])) };
  }

  test('regions more than 1 MiB apart keep two chunks each, capped at six per page', () => {
    const { results, regions } = hits('chat/huge', [0, 0, 0, 3 * MIB, 3 * MIB, 3 * MIB, 6 * MIB, 6 * MIB, 9 * MIB, 9 * MIB, 12 * MIB, 12 * MIB], 100);
    const out = dedupResults(results, { regions });
    expect(MAX_PER_SEGMENTED_PAGE).toBe(6);
    expect(out.length).toBe(6);
    const perRegion = new Map<number, number>();
    for (const r of out) perRegion.set(regions.get(r.chunk_id)!, (perRegion.get(regions.get(r.chunk_id)!) ?? 0) + 1);
    expect([...perRegion.entries()].sort((a, b) => a[0] - b[0])).toEqual([[0, 2], [3 * MIB, 2], [6 * MIB, 2]]);
  });

  test('occurrences at most 1 MiB apart are one region; one byte further starts the next', () => {
    const near = hits('chat/near', [0, SEGMENT_CLUSTER_BYTES, 2 * SEGMENT_CLUSTER_BYTES, 3 * SEGMENT_CLUSTER_BYTES], 200);
    expect(dedupResults(near.results, { regions: near.regions }).length).toBe(2);
    const apart = hits('chat/apart', [0, 0, SEGMENT_CLUSTER_BYTES + 1, SEGMENT_CLUSTER_BYTES + 1, 2 * SEGMENT_CLUSTER_BYTES + 2], 300);
    expect(dedupResults(apart.results, { regions: apart.regions }).map(r => r.chunk_id).sort()).toEqual([300, 301, 302, 303, 304]);
  });

  test('inline pages keep two chunks, with or without regions for other pages', () => {
    const seg = hits('chat/huge', [0, 0, 3 * MIB, 3 * MIB], 400);
    const inline = hits('notes/inline', [0, 0, 0, 0, 0], 500).results;
    const out = dedupResults([...seg.results, ...inline], { regions: seg.regions });
    expect(out.filter(r => r.slug === 'notes/inline').map(r => r.chunk_id)).toEqual([500, 501]);
    expect(out.filter(r => r.slug === 'chat/huge').length).toBe(4);
    expect(dedupResults(inline).map(r => r.chunk_id)).toEqual([500, 501]);
    expect(dedupResults(seg.results).length).toBe(2);
  });

  test('every kept hit of a segmented page points at its own window', () => {
    const { results, regions } = hits('chat/huge', [0, 0, 3 * MIB, 3 * MIB, 6 * MIB, 6 * MIB], 600);
    const capped = applySnippetCap(dedupResults(results, { regions }), 10);
    expect(capped.length).toBe(6);
    for (const r of capped) expect(r.chunk_text).toContain(`get_page chat/huge around_chunk_id=${r.chunk_id}]`);
  });
});
