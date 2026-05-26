/**
 * v0.40.4.0 — `gbrain search --explain` formatter.
 *
 * Pins output format for the per-stage attribution view. Stable shape so
 * scripts that grep `--explain` output don't break under refactors.
 */

import { describe, test, expect } from 'bun:test';
import type { SearchResult } from '../../src/core/types.ts';
import {
  formatResultExplain,
  formatResultsExplain,
} from '../../src/core/search/explain-formatter.ts';

function r(slug: string, score: number, extras: Partial<SearchResult> = {}): SearchResult {
  return {
    slug,
    page_id: 1,
    title: slug,
    type: 'note',
    chunk_text: `body of ${slug}`,
    chunk_source: 'compiled_truth',
    chunk_id: 1000,
    chunk_index: 0,
    score,
    stale: false,
    source_id: 'default',
    ...extras,
  };
}

describe('formatResultExplain — no boosts', () => {
  test('result with no attribution → "no boosts applied"', () => {
    const out = formatResultExplain(r('a/b', 1.5), 1);
    expect(out).toContain('1. a/b (score=1.5)');
    expect(out).toContain('base=1.5 (rrf+cosine)');
    expect(out).toContain('no boosts applied');
    expect(out).toContain('= final 1.5');
  });

  test('base_score equals score when no stage stamped base_score', () => {
    const out = formatResultExplain(r('a/b', 3.14), 1);
    expect(out).toContain('base=3.14');
  });
});

describe('formatResultExplain — every boost type', () => {
  test('backlink_boost renders', () => {
    const out = formatResultExplain(
      r('a/b', 1.5, { base_score: 1.0, backlink_boost: 1.5 }),
      1,
    );
    expect(out).toContain('+ backlink ×1.5');
    expect(out).not.toContain('no boosts applied');
  });

  test('salience_boost renders', () => {
    const out = formatResultExplain(
      r('a/b', 1.2, { base_score: 1.0, salience_boost: 1.2 }),
      1,
    );
    expect(out).toContain('+ salience ×1.2');
  });

  test('recency_boost renders', () => {
    const out = formatResultExplain(
      r('a/b', 1.3, { base_score: 1.0, recency_boost: 1.3 }),
      1,
    );
    expect(out).toContain('+ recency  ×1.3');
  });

  test('exact_match_boost renders', () => {
    const out = formatResultExplain(
      r('a/b', 2.0, { base_score: 1.0, exact_match_boost: 2.0 }),
      1,
    );
    expect(out).toContain('+ exact-match ×2');
  });

  test('graph_adjacency_boost + hits render', () => {
    const out = formatResultExplain(
      r('hub', 1.05, { base_score: 1.0, graph_adjacency_boost: 1.05, graph_adjacency_hits: 3 }),
      1,
    );
    expect(out).toContain('+ adjacency ×1.05 (hits=3)');
  });

  test('graph_cross_source_boost + cross_source_hits render', () => {
    const out = formatResultExplain(
      r('hub', 1.10, { base_score: 1.0, graph_cross_source_boost: 1.10, graph_cross_source_hits: 2 }),
      1,
    );
    expect(out).toContain('+ cross_source ×1.1 (other_sources=2)');
  });

  test('session_demote_factor renders as DEMOTE not boost', () => {
    const out = formatResultExplain(
      r('chat/b', 0.95, {
        base_score: 1.0,
        session_demote_factor: 0.95,
        graph_session_prefix: 'chat',
        graph_session_demoted: true,
      }),
      1,
    );
    expect(out).toContain('- session_demote ×0.95 (prefix=chat)');
  });

  test('reranker_delta positive renders as rank-up arrow', () => {
    const out = formatResultExplain(
      r('a/b', 1.0, { base_score: 1.0, reranker_delta: 2 }),
      1,
    );
    expect(out).toContain('↑ reranker rank +2');
  });

  test('reranker_delta negative renders as rank-down arrow', () => {
    const out = formatResultExplain(
      r('a/b', 1.0, { base_score: 1.0, reranker_delta: -1 }),
      1,
    );
    expect(out).toContain('↓ reranker rank -1');
  });

  test('reranker_delta = 0 → no rendering (no movement)', () => {
    const out = formatResultExplain(
      r('a/b', 1.0, { base_score: 1.0, reranker_delta: 0 }),
      1,
    );
    expect(out).not.toContain('reranker rank');
    expect(out).toContain('no boosts applied');
  });
});

describe('formatResultExplain — multi-stage stacking', () => {
  test('three boosts render as separate lines in order', () => {
    const out = formatResultExplain(
      r('hub', 1.5, {
        base_score: 1.0,
        backlink_boost: 1.1,
        salience_boost: 1.05,
        graph_adjacency_boost: 1.05,
        graph_adjacency_hits: 3,
      }),
      1,
    );
    const lines = out.split('\n');
    // base, +backlink, +salience, +adjacency, = final → 5 substantive lines + header.
    expect(lines.length).toBeGreaterThanOrEqual(6);
    expect(out).toMatch(/\+ backlink[\s\S]*\+ salience[\s\S]*\+ adjacency/);
  });
});

describe('formatResultsExplain — list rendering', () => {
  test('empty list', () => {
    expect(formatResultsExplain([])).toBe('No results.\n');
  });

  test('multiple results separated by blank lines, trailing newline', () => {
    const out = formatResultsExplain([
      r('a', 1.0),
      r('b', 0.9),
    ]);
    expect(out).toContain('1. a');
    expect(out).toContain('2. b');
    expect(out).toMatch(/\n\n2\./);  // blank line between entries
    expect(out.endsWith('\n')).toBe(true);
  });

  test('rank numbering is 1-based', () => {
    const out = formatResultsExplain([
      r('first', 10),
      r('second', 9),
      r('third', 8),
    ]);
    expect(out).toContain('1. first');
    expect(out).toContain('2. second');
    expect(out).toContain('3. third');
  });
});

describe('formatResultExplain — number formatting', () => {
  test('trailing zeros stripped', () => {
    const out = formatResultExplain(r('a/b', 1.0), 1);
    expect(out).toContain('score=1');
    expect(out).not.toContain('score=1.0000');
  });

  test('non-zero fractional digits preserved up to 4 places', () => {
    const out = formatResultExplain(r('a/b', 0.1234), 1);
    expect(out).toContain('score=0.1234');
  });

  test('NaN preserved as "NaN"', () => {
    const out = formatResultExplain(r('a/b', NaN), 1);
    expect(out).toContain('score=NaN');
  });
});
