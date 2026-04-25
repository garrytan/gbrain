import { describe, test, expect } from 'bun:test';
import {
  normalizeSummary,
  looksLikePhi,
  looksLikePhoneOrIdShape,
  scoreCandidate,
  cosineSimilarity,
  clusterByEmbedding,
  rankCandidates,
  DEFAULT_CONFIG,
  type Cluster,
} from '../src/core/promotion.ts';
import type { TimelineEntry } from '../src/core/types.ts';

describe('normalizeSummary', () => {
  test('lowercases and strips trailing punctuation', () => {
    expect(normalizeSummary('Updated patient care plan.')).toBe('updated patient care plan');
  });

  test('collapses whitespace', () => {
    expect(normalizeSummary('  sync   completed  ')).toBe('sync completed');
  });

  test('empty string returns empty', () => {
    expect(normalizeSummary('')).toBe('');
  });
});

describe('looksLikePhoneOrIdShape (best-effort regex filter, NOT PHI detection)', () => {
  test('detects phone numbers', () => {
    expect(looksLikePhoneOrIdShape('Call patient at 555-123-4567')).toBe(true);
  });

  test('detects SSN-shaped patterns', () => {
    expect(looksLikePhoneOrIdShape('SSN: 123-45-6789')).toBe(true);
  });

  test('allows normal text', () => {
    expect(looksLikePhoneOrIdShape('sync completed for facility')).toBe(false);
  });

  test('allows safe patterns', () => {
    expect(looksLikePhoneOrIdShape('meeting with team about care coordination')).toBe(false);
  });

  test('looksLikePhi is the same function (deprecated alias preserved for compat)', () => {
    expect(looksLikePhi).toBe(looksLikePhoneOrIdShape);
  });
});

describe('scoreCandidate', () => {
  test('high recurrence and recent date scores well', () => {
    const today = new Date().toISOString().slice(0, 10);
    const score = scoreCandidate(6, today, 3);
    expect(score).toBeGreaterThan(0.5);
  });

  test('low recurrence scores lower than high recurrence', () => {
    const today = new Date().toISOString().slice(0, 10);
    const lowScore = scoreCandidate(1, today, 1);
    const highScore = scoreCandidate(6, today, 3);
    expect(lowScore).toBeLessThan(highScore);
  });

  test('old entries decay', () => {
    const twoWeeksAgo = new Date(Date.now() - 13 * 86400000).toISOString().slice(0, 10);
    const recentScore = scoreCandidate(6, new Date().toISOString().slice(0, 10), 3);
    const oldScore = scoreCandidate(6, twoWeeksAgo, 3);
    expect(recentScore).toBeGreaterThan(oldScore);
  });
});

describe('cosineSimilarity', () => {
  test('identical vectors return 1', () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  test('orthogonal vectors return 0', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  test('opposite vectors return -1', () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  test('zero vector returns 0', () => {
    const a = new Float32Array([1, 2, 3]);
    const z = new Float32Array([0, 0, 0]);
    expect(cosineSimilarity(a, z)).toBe(0);
  });

  test('different lengths throws', () => {
    const a = new Float32Array([1, 2]);
    const b = new Float32Array([1, 2, 3]);
    expect(() => cosineSimilarity(a, b)).toThrow();
  });
});

describe('clusterByEmbedding', () => {
  function makeEmbedded(slug: string, date: string, summary: string, embedding: number[]): {
    slug: string;
    entry: TimelineEntry;
    embedding: Float32Array;
  } {
    return {
      slug,
      entry: {
        id: Math.random(),
        page_id: 1,
        date,
        source: 'test',
        summary,
        detail: '',
        created_at: new Date(),
      },
      embedding: new Float32Array(embedding),
    };
  }

  test('clusters identical embeddings together', () => {
    const today = new Date().toISOString().slice(0, 10);
    const entries = [
      makeEmbedded('a', today, 'A', [1, 0, 0]),
      makeEmbedded('b', today, 'B', [1, 0, 0]),
      makeEmbedded('c', today, 'C', [1, 0, 0]),
    ];
    const clusters = clusterByEmbedding(entries, 0.85);
    expect(clusters.length).toBe(1);
    expect(clusters[0].entries.length).toBe(3);
  });

  test('separates orthogonal embeddings', () => {
    const today = new Date().toISOString().slice(0, 10);
    const entries = [
      makeEmbedded('a', today, 'A', [1, 0, 0]),
      makeEmbedded('b', today, 'B', [0, 1, 0]),
      makeEmbedded('c', today, 'C', [0, 0, 1]),
    ];
    const clusters = clusterByEmbedding(entries, 0.85);
    expect(clusters.length).toBe(3);
  });

  test('canonical is the most-recent member', () => {
    const entries = [
      makeEmbedded('a', '2026-04-01', 'older summary', [1, 0, 0]),
      makeEmbedded('b', '2026-04-15', 'most recent summary', [1, 0, 0]),
      makeEmbedded('c', '2026-04-10', 'middle summary', [1, 0, 0]),
    ];
    const clusters = clusterByEmbedding(entries, 0.85);
    expect(clusters.length).toBe(1);
    expect(clusters[0].canonical).toBe('most recent summary');
  });

  test('unions transitively (A~B, B~C → all one cluster)', () => {
    const today = new Date().toISOString().slice(0, 10);
    const entries = [
      makeEmbedded('a', today, 'A', [1, 0, 0]),
      makeEmbedded('b', today, 'B', [0.95, 0.31, 0]),  // close to both
      makeEmbedded('c', today, 'C', [0.5, 0.86, 0]),    // close to B but not to A
    ];
    const clusters = clusterByEmbedding(entries, 0.85);
    // A~B (sim ~0.95), B~C (sim ~0.78 — borderline). Test asserts the
    // transitive union behavior when threshold catches both pairs.
    // Use a slightly looser threshold to ensure both edges fire:
    const looser = clusterByEmbedding(entries, 0.7);
    expect(looser.length).toBe(1);
    expect(looser[0].entries.length).toBe(3);
  });

  test('threshold clamps to [0, 1]', () => {
    const today = new Date().toISOString().slice(0, 10);
    const entries = [
      makeEmbedded('a', today, 'A', [1, 0]),
      makeEmbedded('b', today, 'B', [0, 1]),
    ];
    // Anything above 1 still rejects orthogonal vectors (clamped to 1)
    const clusters = clusterByEmbedding(entries, 999);
    expect(clusters.length).toBe(2);
  });

  test('empty input returns empty', () => {
    const clusters = clusterByEmbedding([], 0.85);
    expect(clusters).toEqual([]);
  });

  test('single entry returns one cluster of size 1', () => {
    const today = new Date().toISOString().slice(0, 10);
    const entries = [makeEmbedded('a', today, 'A', [1, 0, 0])];
    const clusters = clusterByEmbedding(entries, 0.85);
    expect(clusters.length).toBe(1);
    expect(clusters[0].entries.length).toBe(1);
    expect(clusters[0].canonical).toBe('A');
  });
});

describe('rankCandidates (cluster-aware)', () => {
  function makeCluster(canonical: string, entries: { slug: string; date: string }[]): Cluster {
    return {
      cluster_id: canonical.slice(0, 16),
      canonical,
      entries: entries.map(e => ({
        slug: e.slug,
        entry: {
          id: Math.random(),
          page_id: 1,
          date: e.date,
          source: 'test',
          summary: canonical,
          detail: '',
          created_at: new Date(),
        },
      })),
    };
  }

  test('groups recurring entries into promotable candidates', () => {
    const today = new Date().toISOString().slice(0, 10);
    const clusters = [
      makeCluster('Sync completed for facility', [
        { slug: 'facility-a', date: today },
        { slug: 'facility-b', date: today },
        { slug: 'facility-a', date: today },
      ]),
    ];
    const candidates = rankCandidates(clusters, DEFAULT_CONFIG);
    expect(candidates.length).toBe(1);
    expect(candidates[0].recurrence).toBe(3);
    expect(candidates[0].reason).toBe('promotable');
  });

  test('rejects below-threshold entries', () => {
    const today = new Date().toISOString().slice(0, 10);
    const clusters = [
      makeCluster('One-off event', [{ slug: 'page-a', date: today }]),
    ];
    const candidates = rankCandidates(clusters, DEFAULT_CONFIG);
    expect(candidates.length).toBe(1);
    expect(candidates[0].reason).toContain('below threshold');
  });

  test('rejects sensitive-text patterns', () => {
    const today = new Date().toISOString().slice(0, 10);
    const clusters = [
      makeCluster('Patient ID 12345 updated', [
        { slug: 'page-a', date: today },
        { slug: 'page-b', date: today },
        { slug: 'page-a', date: today },
        { slug: 'page-c', date: today },
      ]),
    ];
    const candidates = rankCandidates(clusters, DEFAULT_CONFIG);
    expect(candidates.length).toBe(1);
    expect(candidates[0].reason).toContain('sensitive');
  });

  test('sorts by score descending', () => {
    const today = new Date().toISOString().slice(0, 10);
    const clusters = [
      makeCluster('low pattern', [
        { slug: 'page-a', date: today },
        { slug: 'page-a', date: today },
        { slug: 'page-a', date: today },
      ]),
      makeCluster('high pattern', [
        { slug: 'page-a', date: today },
        { slug: 'page-b', date: today },
        { slug: 'page-c', date: today },
        { slug: 'page-d', date: today },
        { slug: 'page-e', date: today },
        { slug: 'page-a', date: today },
      ]),
    ];
    const candidates = rankCandidates(clusters, DEFAULT_CONFIG);
    const promotable = candidates.filter(c => c.reason === 'promotable');
    expect(promotable.length).toBe(2);
    expect(promotable[0].score).toBeGreaterThan(promotable[1].score);
  });

  test('cluster_id is propagated to candidate', () => {
    const today = new Date().toISOString().slice(0, 10);
    const cluster = makeCluster('Sync completed', [
      { slug: 'a', date: today },
      { slug: 'b', date: today },
      { slug: 'c', date: today },
    ]);
    const candidates = rankCandidates([cluster], DEFAULT_CONFIG);
    expect(candidates[0].cluster_id).toBe(cluster.cluster_id);
  });
});
