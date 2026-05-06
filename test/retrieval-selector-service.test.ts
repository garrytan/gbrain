import { describe, expect, test } from 'bun:test';
import {
  normalizeRetrievalSelector,
  parseAnchoredRetrievalPath,
  retrievalSelectorId,
  selectorFromRouteRead,
  selectorFromSearchResult,
} from '../src/core/services/retrieval-selector-service.ts';
import type { SearchResult } from '../src/core/types.ts';

describe('retrieval selector service', () => {
  test('normalizes page selectors with default scope and stable id', () => {
    const selector = normalizeRetrievalSelector({
      kind: 'page',
      slug: 'systems/mbrain',
    });

    expect(selector.scope_id).toBe('workspace:default');
    expect(selector.selector_id).toBe('page:workspace:default:systems/mbrain');
    expect(selector.slug).toBe('systems/mbrain');
  });

  test('rejects caller selector_id that does not match the normalized selector target', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'page',
      slug: 'systems/mbrain',
      selector_id: 'page:workspace:default:systems/other',
    })).toThrow('selector_id does not match selector target');
  });

  test('normalizes section selectors and preserves line metadata', () => {
    const selector = normalizeRetrievalSelector({
      kind: 'section',
      scope_id: 'workspace:default',
      slug: 'systems/mbrain',
      section_id: 'systems/mbrain#overview/runtime',
      path: 'systems/mbrain.md#overview/runtime',
      line_start: 8,
      line_end: 12,
      source_refs: ['User, direct message, 2026-05-07 09:00 KST'],
    });

    expect(selector.selector_id).toBe('section:workspace:default:systems/mbrain#overview/runtime');
    expect(selector.line_start).toBe(8);
    expect(selector.line_end).toBe(12);
    expect(selector.source_refs).toEqual(['User, direct message, 2026-05-07 09:00 KST']);
  });

  test('normalizes selectors with char offsets and stable char-range id suffix', () => {
    const selector = normalizeRetrievalSelector({
      kind: 'compiled_truth',
      slug: 'concepts/retrieval',
      char_start: 12,
      char_end: 48,
    });

    expect(selector.selector_id).toBe('compiled_truth:workspace:default:concepts/retrieval@chars:12:48');
    expect(retrievalSelectorId(selector)).toBe('compiled_truth:workspace:default:concepts/retrieval@chars:12:48');
  });

  test('adds source_ref selector target suffix only when a disambiguator is present', () => {
    expect(retrievalSelectorId({
      kind: 'source_ref',
      source_ref: 'User, shared source, 2026-05-07 KST',
    })).toBe('source_ref:workspace:default:User, shared source, 2026-05-07 KST');

    expect(retrievalSelectorId({
      kind: 'source_ref',
      source_ref: 'User, shared source, 2026-05-07 KST',
      slug: 'concepts/b',
    })).toBe('source_ref:workspace:default:User, shared source, 2026-05-07 KST@target:concepts/b');

    expect(retrievalSelectorId({
      kind: 'source_ref',
      source_ref: 'User, shared source, 2026-05-07 KST',
      path: 'concepts/b.md#compiled-truth',
    })).toBe('source_ref:workspace:default:User, shared source, 2026-05-07 KST@target:concepts/b.md');

    expect(retrievalSelectorId({
      kind: 'source_ref',
      source_ref: 'User, shared source, 2026-05-07 KST',
      slug: 'concepts/b',
      section_id: 'concepts/b#compiled-truth',
      char_start: 2,
      char_end: 12,
    })).toBe(
      'source_ref:workspace:default:User, shared source, 2026-05-07 KST@target:concepts/b#compiled-truth@chars:2:12',
    );
  });

  test('rejects selectors that do not identify a target', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'section',
      slug: 'systems/mbrain',
    })).toThrow('section selector requires section_id');

    expect(() => normalizeRetrievalSelector({
      kind: 'page',
    })).toThrow('page selector requires slug');
  });

  test('rejects invalid char offset ranges', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'compiled_truth',
      slug: 'concepts/retrieval',
      char_start: -1,
    })).toThrow('selector char_start must be a nonnegative integer');

    expect(() => normalizeRetrievalSelector({
      kind: 'compiled_truth',
      slug: 'concepts/retrieval',
      char_end: 1.5,
    })).toThrow('selector char_end must be a nonnegative integer');

    expect(() => normalizeRetrievalSelector({
      kind: 'compiled_truth',
      slug: 'concepts/retrieval',
      char_start: 4,
      char_end: 4,
    })).toThrow('selector char_start must be < char_end');
  });

  test('rejects line_span selectors with non-positive line_start', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'line_span',
      slug: 'systems/mbrain',
      line_start: 0,
      line_end: 5,
    })).toThrow('line_span selector requires positive integer line_start');
  });

  test('rejects line_span selectors with non-integer line_start', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'line_span',
      slug: 'systems/mbrain',
      line_start: 1.5,
      line_end: 5,
    })).toThrow('line_span selector requires positive integer line_start');
  });

  test('rejects line_span selectors with non-integer line_end', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'line_span',
      slug: 'systems/mbrain',
      line_start: 1,
      line_end: 5.5,
    })).toThrow('line_span selector requires positive integer line_end');
  });

  test('rejects line_span selectors with line_start after line_end', () => {
    expect(() => normalizeRetrievalSelector({
      kind: 'line_span',
      slug: 'systems/mbrain',
      line_start: 6,
      line_end: 5,
    })).toThrow('line_span selector requires line_start <= line_end');
  });

  test('parses anchored page paths into page path and heading path', () => {
    expect(parseAnchoredRetrievalPath('systems/mbrain.md#overview/runtime')).toEqual({
      page_path: 'systems/mbrain.md',
      fragment: 'overview/runtime',
    });

    expect(parseAnchoredRetrievalPath('systems/mbrain.md')).toBeNull();
  });

  test('converts route reads to canonical selectors', () => {
    const selector = selectorFromRouteRead({
      node_id: 'section:systems/mbrain#overview/runtime',
      node_kind: 'section',
      label: 'Runtime',
      page_slug: 'systems/mbrain',
      path: 'systems/mbrain.md',
      section_id: 'systems/mbrain#overview/runtime',
    });

    expect(selector.kind).toBe('section');
    expect(selector.slug).toBe('systems/mbrain');
    expect(selector.section_id).toBe('systems/mbrain#overview/runtime');
  });

  test('converts search results into compiled-truth or timeline selectors', () => {
    const result: SearchResult = {
      slug: 'concepts/retrieval',
      page_id: 10,
      title: 'Retrieval',
      type: 'concept',
      chunk_text: 'Retrieval chunks are candidates.',
      chunk_source: 'compiled_truth',
      score: 2.5,
      stale: false,
    };

    const selector = selectorFromSearchResult(result);

    expect(selector.kind).toBe('compiled_truth');
    expect(selector.slug).toBe('concepts/retrieval');
    expect(selectorSelectorId(selector)).toBe('compiled_truth:workspace:default:concepts/retrieval');
  });

  test('converts timeline search results to timeline range selectors', () => {
    const result: SearchResult = {
      slug: 'concepts/retrieval',
      page_id: 10,
      title: 'Retrieval',
      type: 'concept',
      chunk_text: '- **2026-05-07** | Retrieval selector task started.',
      chunk_source: 'timeline',
      score: 2.5,
      stale: false,
    };

    const selector = selectorFromSearchResult(result);

    expect(selector.kind).toBe('timeline_range');
    expect(selector.slug).toBe('concepts/retrieval');
    expect(selector.freshness).toBe('current');
  });

  test('converts frontmatter search results to page selectors', () => {
    const result: SearchResult = {
      slug: 'concepts/retrieval',
      page_id: 10,
      title: 'Retrieval',
      type: 'concept',
      chunk_text: 'title: Retrieval',
      chunk_source: 'frontmatter',
      score: 2.5,
      stale: false,
    };

    const selector = selectorFromSearchResult(result);

    expect(selector.kind).toBe('page');
    expect(selector.slug).toBe('concepts/retrieval');
  });

  test('marks selectors from stale search results as stale', () => {
    const result: SearchResult = {
      slug: 'concepts/retrieval',
      page_id: 10,
      title: 'Retrieval',
      type: 'concept',
      chunk_text: 'Retrieval chunks are candidates.',
      chunk_source: 'compiled_truth',
      score: 2.5,
      stale: true,
    };

    const selector = selectorFromSearchResult(result);

    expect(selector.kind).toBe('compiled_truth');
    expect(selector.freshness).toBe('stale');
  });
});

function selectorSelectorId(selector: Parameters<typeof retrievalSelectorId>[0]): string {
  return retrievalSelectorId(selector);
}
