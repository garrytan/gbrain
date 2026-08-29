/**
 * v0.42.3.0 — autocut end-to-end through hybridSearch (the IRON-RULE
 * behavioral regression).
 *
 * Drives bare hybridSearch against PGLite with a stubbed rerankerFn so we
 * pin the behavior the pure-fn tests can't:
 *  - A cliff-shaped rerank → autocut trims the result set at the cliff.
 *  - A flat rerank → autocut declines (full set returned).
 *  - Reranker disabled → autocut is a no-op (no rerank scores to cut on),
 *    which is the load-bearing gate (no trustworthy signal without a reranker).
 *  - Per-call autocut:false forces the full top-K even with a cliff (ceiling).
 *  - Composes with adaptive-return without violating the never-empty floor.
 *  - `search.autocut_min_keep` config floors the cut (regression pin for the
 *    wiring gap where the search path hardcoded minKeep: 1 and the key was
 *    silently ignored).
 *
 * Serial because it mutates gateway global state (configureGateway +
 * __setEmbedTransportForTests). No API keys; embedding + reranker stubbed.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { hybridSearch } from '../../src/core/search/hybrid.ts';
import {
  configureGateway,
  resetGateway,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import type { PageInput, SearchOpts } from '../../src/core/types.ts';
import type { RerankInput, RerankResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

const DIMS = 1536;
const FAKE_EMB = Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0.01));

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // Seed 5 pages sharing a keyword so the candidate pool is 5 deep.
  const pages: Array<[string, PageInput, string]> = [
    ['notes/a', { type: 'note', title: 'A', compiled_truth: 'alpha keyword one' }, 'alpha keyword one chunk'],
    ['notes/b', { type: 'note', title: 'B', compiled_truth: 'alpha keyword two' }, 'alpha keyword two chunk'],
    ['notes/c', { type: 'note', title: 'C', compiled_truth: 'alpha keyword three' }, 'alpha keyword three chunk'],
    ['notes/d', { type: 'note', title: 'D', compiled_truth: 'alpha keyword four' }, 'alpha keyword four chunk'],
    ['notes/e', { type: 'note', title: 'E', compiled_truth: 'alpha keyword five' }, 'alpha keyword five chunk'],
  ];
  for (const [slug, page, chunkText] of pages) {
    await engine.putPage(slug, page);
    await engine.upsertChunks(slug, [
      { chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' },
    ]);
  }

  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: DIMS,
    env: { OPENAI_API_KEY: 'sk-test' },
  });
  __setEmbedTransportForTests(async (args: any) => ({
    embeddings: args.values.map(() => FAKE_EMB),
  }) as any);
});

afterAll(async () => {
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

// A reranker that assigns descending scores from a fixed array (by index).
function rerankerWithScores(scores: number[]) {
  return async (input: RerankInput): Promise<RerankResult[]> =>
    input.documents.map((_, i) => ({ index: i, relevanceScore: scores[i] ?? 0.01 }));
}

// balanced mode (the default) has autocut ON. We pass opts.reranker to stub
// the cross-encoder; resolvedMode.autocut stays true (no search.mode config).
function rerankerOpts(scores: number[]): SearchOpts['reranker'] {
  return {
    enabled: true,
    topNIn: 30,
    topNOut: null,
    rerankerFn: rerankerWithScores(scores),
  };
}

describe('autocut — fires on a real cliff', () => {
  test('cliff after rank 2 → result set trimmed to 2', async () => {
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: rerankerOpts([0.95, 0.9, 0.2, 0.15, 0.1]),
    });
    expect(out.length).toBe(2);
    expect(out.map((r) => r.rerank_score)).toEqual([0.95, 0.9]);
  });

  test('cliff after rank 1 → single obvious answer', async () => {
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: rerankerOpts([0.98, 0.12, 0.1, 0.08, 0.05]),
    });
    expect(out.length).toBe(1);
  });
});

describe('autocut — declines on a flat curve', () => {
  test('flat rerank scores → full set returned (no trim)', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: rerankerOpts([0.9, 0.88, 0.86, 0.84, 0.82]),
    });
    expect(out.length).toBe(baseline.length);
    expect(out.length).toBeGreaterThanOrEqual(3); // meaningful pool to NOT trim
  });
});

describe('autocut — no-op without a reranker (the load-bearing gate)', () => {
  test('reranker disabled → no trim even though autocut is on for the mode', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: { enabled: false, topNIn: 30, topNOut: null, rerankerFn: rerankerWithScores([0.95, 0.1]) },
    });
    // No rerank scores were stamped → autocut sees <2 finite scores → no-op.
    expect(out.length).toBe(baseline.length);
  });

  test('reranker fails open (throws) → no trim (fail-open + autocut no-op)', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: {
        enabled: true,
        topNIn: 30,
        topNOut: null,
        rerankerFn: async () => {
          throw new Error('upstream down');
        },
      },
    });
    expect(out.map((r) => r.slug)).toEqual(baseline.map((r) => r.slug));
  });
});

describe('autocut — ceiling override', () => {
  test('per-call autocut:false forces full top-K even with a cliff', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', { limit: 10 });
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      autocut: false,
      reranker: rerankerOpts([0.95, 0.9, 0.2, 0.15, 0.1]),
    });
    // Cliff present, but the override keeps the full reranked set.
    expect(out.length).toBe(baseline.length);
  });
});

describe('autocut — composes with adaptive-return (never-empty holds)', () => {
  test('adaptive-return + autocut both on → non-empty, bounded', async () => {
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      adaptiveReturn: true,
      reranker: rerankerOpts([0.95, 0.9, 0.2, 0.15, 0.1]),
    });
    expect(out.length).toBeGreaterThanOrEqual(1);
    expect(out.length).toBeLessThanOrEqual(2); // cliff caps at 2; adaptive may cap further
  });
});

describe('autocut — search.autocut_min_keep floors the cut (config wiring)', () => {
  // Widen the candidate pool to 7 (two extra page types so dedup's
  // type-diversity layer keeps everything). Runs LAST in this file — the
  // earlier describes' pool stays 5-deep. Two-cliff score curve:
  //   rank 1 → 2: gap 0.474 of top (the biggest cliff)
  //   rank 3 → 4: gap 0.400 of top (a second, smaller cliff)
  //   everywhere else: gaps ≈ 0.02 (below jumpRatio 0.20)
  // Both cliffs clear the default jumpRatio, so the chosen cut point is
  // purely a function of the resolved minKeep floor.
  const TWO_CLIFF = [0.95, 0.5, 0.48, 0.1, 0.08, 0.06, 0.04];

  beforeAll(async () => {
    const extra: Array<[string, PageInput, string]> = [
      ['decisions/f', { type: 'decision', title: 'F', compiled_truth: 'alpha keyword six' }, 'alpha keyword six chunk'],
      ['companies/g', { type: 'company', title: 'G', compiled_truth: 'alpha keyword seven' }, 'alpha keyword seven chunk'],
    ];
    for (const [slug, page, chunkText] of extra) {
      await engine.putPage(slug, page);
      await engine.upsertChunks(slug, [
        { chunk_index: 0, chunk_text: chunkText, chunk_source: 'compiled_truth' },
      ]);
    }
  });

  afterAll(async () => {
    await engine.unsetConfig('search.autocut_min_keep');
  });

  test('default floor 1: cuts at the biggest cliff — pre-fix behavior unchanged', async () => {
    const out = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      reranker: rerankerOpts(TWO_CLIFF),
    });
    expect(out.length).toBe(1);
    expect(out[0]?.rerank_score).toBe(0.95);
  });

  test('config floor 3: the same curve cuts at the SECOND cliff (floored, not disabled)', async () => {
    await engine.setConfig('search.autocut_min_keep', '3');
    try {
      const out = await hybridSearch(engine, 'alpha keyword', {
        limit: 10,
        reranker: rerankerOpts(TWO_CLIFF),
      });
      expect(out.length).toBe(3);
      expect(out.map((r) => r.rerank_score)).toEqual([0.95, 0.5, 0.48]);
    } finally {
      await engine.unsetConfig('search.autocut_min_keep');
    }
  });

  test('floor above the candidate pool: no legal cut point → full set returned', async () => {
    const baseline = await hybridSearch(engine, 'alpha keyword', {
      limit: 10,
      autocut: false,
      reranker: rerankerOpts(TWO_CLIFF),
    });
    expect(baseline.length).toBeGreaterThanOrEqual(4); // widened pool sanity
    await engine.setConfig('search.autocut_min_keep', '50');
    try {
      const out = await hybridSearch(engine, 'alpha keyword', {
        limit: 10,
        reranker: rerankerOpts(TWO_CLIFF),
      });
      expect(out.length).toBe(baseline.length);
    } finally {
      await engine.unsetConfig('search.autocut_min_keep');
    }
  });

  test("junk config ('0') is ignored — falls through to the bundle default of 1", async () => {
    await engine.setConfig('search.autocut_min_keep', '0');
    try {
      const out = await hybridSearch(engine, 'alpha keyword', {
        limit: 10,
        reranker: rerankerOpts(TWO_CLIFF),
      });
      expect(out.length).toBe(1);
    } finally {
      await engine.unsetConfig('search.autocut_min_keep');
    }
  });
});
