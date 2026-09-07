/**
 * v0.48.2 — `gbrain search … --explain` renders the retrieval-meta header
 * lines (`degraded: reranker_skipped (no_key)`), because formatResult now
 * threads the captured `_meta.retrieval` into formatResultsExplain. Before
 * this, the only CLI call site passed results alone and the header was
 * unreachable from the CLI (the formatter was only ever tested directly).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { formatResult, captureRetrievalMeta, resetRetrievalMetaForTests } from '../src/cli.ts';
import { getCliOptions, setCliOptions, _resetCliOptionsForTest } from '../src/core/cli-options.ts';
import type { SearchResult } from '../src/core/types.ts';

function r(slug: string, score: number): SearchResult {
  return {
    slug, page_id: 1, title: slug, type: 'note', chunk_text: `body of ${slug}`,
    chunk_source: 'compiled_truth', chunk_id: 1000, chunk_index: 0, score, stale: false, source_id: 'default',
  } as SearchResult;
}

afterEach(() => {
  resetRetrievalMetaForTests();
  _resetCliOptionsForTest();
});

describe('formatResult --explain threads the captured retrieval meta', () => {
  test('a reranker_skipped stamp shows up as the degraded header', () => {
    setCliOptions({ ...getCliOptions(), explain: true });
    captureRetrievalMeta('retrieval', {
      returned_count: 1, retrieved_count: 1,
      degraded: [{ stage: 'reranker_skipped', reason: 'no_key' }],
    });
    const out = formatResult('search', [r('alice-foo', 1.5)], {});
    expect(out.startsWith('degraded: reranker_skipped (no_key)\n\n1. alice-foo')).toBe(true);
  });

  test('a clean run prints no header', () => {
    setCliOptions({ ...getCliOptions(), explain: true });
    captureRetrievalMeta('retrieval', { returned_count: 1, retrieved_count: 1, degraded: [] });
    const out = formatResult('search', [r('alice-foo', 1.5)], {});
    expect(out.startsWith('1. alice-foo')).toBe(true);
  });

  test('without --explain the plain renderer is unchanged', () => {
    captureRetrievalMeta('retrieval', { degraded: [{ stage: 'reranker_skipped', reason: 'no_key' }] });
    const out = formatResult('search', [r('alice-foo', 1.5)], {});
    expect(out).toContain('alice-foo');
    expect(out).not.toContain('degraded:');
  });
});
