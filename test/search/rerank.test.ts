/**
 * v0.35.0.0+ applyReranker tests.
 *
 * Pins:
 *  - reorder by reranker score (the happy path)
 *  - preserve un-reranked tail order (recall protection)
 *  - fail-open on every RerankError reason (audit-logged, results pass through)
 *  - topNOut=null preserves full length (CDX2-F16 — semantic distinction
 *    between null and undefined)
 *  - empty input passes through
 *  - rerankerFn test seam used over gateway.rerank
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { __setSunsetClockForTests } from '../../src/core/ai/gateway.ts';

// Pin a pre-sunset clock: the auth-audit test below reaches the REAL
// gateway.rerank with zerank-2; past ZEROENTROPY_SUNSET_DATE the short-circuit
// would fire before the missing-key check and flip the audited reason from
// 'auth' to 'sunset_short_circuit' — a deterministic wall-clock time bomb.
beforeEach(() => __setSunsetClockForTests(() => new Date('2026-09-01T00:00:00Z')));
afterEach(() => __setSunsetClockForTests(null));
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyReranker, type RerankerOpts } from '../../src/core/search/rerank.ts';
import { RerankError, type RerankResult } from '../../src/core/ai/gateway.ts';
import { BudgetExhausted } from '../../src/core/budget/budget-tracker.ts';
import { readRecentRerankFailures } from '../../src/core/rerank-audit.ts';
import type { SearchResult } from '../../src/core/types.ts';
import { withEnv } from '../helpers/with-env.ts';

function makeResult(slug: string, score: number, chunk: string): SearchResult {
  return {
    slug,
    page_id: 0,
    title: slug,
    type: 'note',
    chunk_text: chunk,
    chunk_source: 'compiled_truth',
    chunk_id: 0,
    chunk_index: 0,
    score,
    stale: false,
  };
}

// Setup: gateway must be configured so the rerank-audit logger doesn't
// trip on missing env. We can call configureGateway with a minimal stub.
// NOTE: this stub omits embedding_model, so the gateway falls back to the
// v0.37 default (zeroentropyai:zembed-1 / 1280-d). Without the afterAll
// reset below it would LEAK that default to the next file in the shard
// process — a sibling that runs initSchema in beforeAll would build a
// vector(1280) column and then mismatch on 1536-d fixtures. resetGateway
// in afterAll restores the empty slot so the legacy-embedding preload
// re-pins OpenAI/1536 for the next file.
beforeAll(async () => {
  const { configureGateway } = await import('../../src/core/ai/gateway.ts');
  configureGateway({
    env: { ZEROENTROPY_API_KEY: 'test-key' },
  });
});

afterAll(async () => {
  const { resetGateway } = await import('../../src/core/ai/gateway.ts');
  resetGateway();
});

describe('applyReranker — happy path', () => {
  test('reorders top-N by reranker relevance score', async () => {
    const results = [
      makeResult('a', 1.0, 'doc a'),
      makeResult('b', 0.9, 'doc b'),
      makeResult('c', 0.8, 'doc c'),
    ];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 3,
      topNOut: null,
      rerankerFn: async () => [
        { index: 2, relevanceScore: 0.99 }, // c wins
        { index: 0, relevanceScore: 0.5 },  // a second
        { index: 1, relevanceScore: 0.1 },  // b last
      ],
    };
    const out = await applyReranker('q', results, opts);
    expect(out.map(r => r.slug)).toEqual(['c', 'a', 'b']);
  });

  test('un-reranked tail preserves original RRF order', async () => {
    const results = [
      makeResult('head1', 1.0, 'h1'),
      makeResult('head2', 0.9, 'h2'),
      makeResult('tail1', 0.5, 't1'),
      makeResult('tail2', 0.4, 't2'),
    ];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 2,
      topNOut: null,
      rerankerFn: async () => [
        { index: 1, relevanceScore: 0.99 },
        { index: 0, relevanceScore: 0.5 },
      ],
    };
    const out = await applyReranker('q', results, opts);
    // Head reordered: head2 first, head1 second. Tail unchanged: tail1, tail2.
    expect(out.map(r => r.slug)).toEqual(['head2', 'head1', 'tail1', 'tail2']);
  });

  test('stamps rerank_score onto reordered items', async () => {
    const results = [makeResult('a', 1.0, 'a')];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 1,
      topNOut: null,
      rerankerFn: async () => [{ index: 0, relevanceScore: 0.42 }],
    };
    const out = await applyReranker('q', results, opts);
    expect((out[0] as any).rerank_score).toBe(0.42);
  });
});

describe('applyReranker — CDX2-F16 null vs undefined semantics', () => {
  test('topNOut=null preserves full reordered list', async () => {
    const results = Array.from({ length: 50 }, (_, i) => makeResult(`p${i}`, 1 - i * 0.01, `c${i}`));
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async (input) => input.documents.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.01 })),
    };
    const out = await applyReranker('q', results, opts);
    // tokenmax mode has searchLimit=50 — null must preserve all 50.
    expect(out.length).toBe(50);
  });

  test('topNOut=10 truncates to 10', async () => {
    const results = Array.from({ length: 30 }, (_, i) => makeResult(`p${i}`, 1 - i * 0.01, `c${i}`));
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: 10,
      rerankerFn: async (input) => input.documents.map((_, i) => ({ index: i, relevanceScore: 1 - i * 0.01 })),
    };
    const out = await applyReranker('q', results, opts);
    expect(out.length).toBe(10);
  });
});

describe('applyReranker — fail-open on every RerankError reason', () => {
  test.each([
    'auth' as const,
    'rate_limit' as const,
    'network' as const,
    'timeout' as const,
    'payload_too_large' as const,
    'unknown' as const,
  ])('fail-open on RerankError reason=%s', async (reason) => {
    const results = [
      makeResult('a', 1.0, 'a'),
      makeResult('b', 0.5, 'b'),
    ];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 2,
      topNOut: null,
      rerankerFn: async () => {
        throw new RerankError('forced', reason);
      },
    };
    // Must not throw; must return input unchanged.
    const out = await applyReranker('q', results, opts);
    expect(out).toEqual(results);
  });

  test('missing gateway reranker API key fail-opens and audits auth', async () => {
    const { configureGateway } = await import('../../src/core/ai/gateway.ts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-search-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        configureGateway({
          reranker_model: 'zeroentropyai:zerank-2',
          env: {},
        });

        const results = [makeResult('a', 1.0, 'doc a')];
        const out = await applyReranker('q', results, {
          enabled: true,
          topNIn: 1,
          topNOut: null,
          model: 'zeroentropyai:zerank-2',
        });

        expect(out).toEqual(results);
        const failures = readRecentRerankFailures(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.reason).toBe('auth');
        expect(failures[0]!.error_summary).toContain('ZEROENTROPY_API_KEY');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      configureGateway({ env: { ZEROENTROPY_API_KEY: 'test-key' } });
    }
  });

  test('fail-open on non-RerankError throw too', async () => {
    const results = [makeResult('a', 1.0, 'a')];
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 1,
      topNOut: null,
      rerankerFn: async () => {
        throw new Error('arbitrary');
      },
    };
    const out = await applyReranker('q', results, opts);
    expect(out).toEqual(results);
  });

  test('#3628: BudgetExhausted fail-opens and audits budget instead of unknown', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-budget-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        const results = [makeResult('a', 1.0, 'a')];
        const out = await applyReranker('q', results, {
          enabled: true,
          topNIn: 1,
          topNOut: null,
          model: 'acmecorp:unpriced-reranker-v9',
          rerankerFn: async () => {
            throw new BudgetExhausted('rerank budget missing pricing', {
              reason: 'no_pricing',
              spent: 0,
              cap: 1,
              modelId: 'acmecorp:unpriced-reranker-v9',
            });
          },
        });

        expect(out).toEqual(results);
        const failures = readRecentRerankFailures(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.reason).toBe('budget');
        expect(failures[0]!.error_summary).toContain('missing pricing');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('fail-open on malformed reranker response (empty results array)', async () => {
    // #4648: this pass-through now writes an audit row — scope it to a
    // tmpdir so the default audit dir stays clean for sibling tests.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-failopen-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        const results = [makeResult('a', 1.0, 'a')];
        const opts: RerankerOpts = {
          enabled: true,
          topNIn: 1,
          topNOut: null,
          rerankerFn: async () => [],
        };
        const out = await applyReranker('q', results, opts);
        expect(out).toEqual(results);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('applyReranker — #4648 success-shaped pass-throughs leave a trace', () => {
  test('empty result set for a non-empty batch: audit row (empty_result_set) + onPassThrough + unchanged results', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-empty-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        const results = [makeResult('a', 1.0, 'doc a'), makeResult('b', 0.5, 'doc b')];
        const seen: string[] = [];
        const out = await applyReranker('q', results, {
          enabled: true,
          topNIn: 2,
          topNOut: null,
          model: 'acmecorp:rerank-x',
          // HTTP 200 `{"results":[]}` — a legal answer at least one
          // OpenAI-shaped endpoint gives; previously the unaudited path.
          rerankerFn: async () => [],
          onPassThrough: (reason) => { seen.push(reason); },
        });
        expect(out).toEqual(results);
        expect(seen).toEqual(['empty_result_set']);
        const failures = readRecentRerankFailures(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.reason).toBe('empty_result_set');
        expect(failures[0]!.doc_count).toBe(2);
        expect(failures[0]!.error_summary).toContain('unreranked');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('non-array result shape: audit row (malformed_shape) + onPassThrough + unchanged results', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-malformed-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        const results = [makeResult('a', 1.0, 'doc a')];
        const seen: string[] = [];
        const out = await applyReranker('q', results, {
          enabled: true,
          topNIn: 1,
          topNOut: null,
          rerankerFn: async () => (null as unknown as RerankResult[]),
          onPassThrough: (reason) => { seen.push(reason); },
        });
        expect(out).toEqual(results);
        expect(seen).toEqual(['malformed_shape']);
        const failures = readRecentRerankFailures(1);
        expect(failures).toHaveLength(1);
        expect(failures[0]!.reason).toBe('malformed_shape');
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('stderr note fires once per process per reason (warnOncePerProcess)', async () => {
    const { _resetWarnOnceForTests } = await import('../../src/core/utils.ts');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-once-'));
    const warnings: string[] = [];
    const origWarn = console.warn;
    console.warn = ((...args: unknown[]) => { warnings.push(args.map(String).join(' ')); }) as typeof console.warn;
    try {
      _resetWarnOnceForTests();
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        const opts: RerankerOpts = {
          enabled: true,
          topNIn: 1,
          topNOut: null,
          rerankerFn: async () => [],
        };
        await applyReranker('q1', [makeResult('a', 1.0, 'a')], opts);
        await applyReranker('q2', [makeResult('b', 1.0, 'b')], opts);
      });
      const passThroughNotes = warnings.filter((w) => w.includes('passed through in RRF order'));
      expect(passThroughNotes).toHaveLength(1);
    } finally {
      console.warn = origWarn;
      _resetWarnOnceForTests();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('a throwing onPassThrough never breaks search', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-throwcb-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        const results = [makeResult('a', 1.0, 'doc a')];
        const out = await applyReranker('q', results, {
          enabled: true,
          topNIn: 1,
          topNOut: null,
          rerankerFn: async () => [],
          onPassThrough: () => { throw new Error('meta stamping bug'); },
        });
        expect(out).toEqual(results);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('enabled=false pass-through stays silent (no audit row, no callback — "off" is not "died")', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gbrain-rerank-off-'));
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: tmpDir }, async () => {
        const results = [makeResult('a', 1.0, 'doc a')];
        const seen: string[] = [];
        const out = await applyReranker('q', results, {
          enabled: false,
          topNIn: 1,
          topNOut: null,
          rerankerFn: async () => [],
          onPassThrough: (reason) => { seen.push(reason); },
        });
        expect(out).toEqual(results);
        expect(seen).toEqual([]);
        expect(readRecentRerankFailures(1)).toHaveLength(0);
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('applyReranker — pass-through cases', () => {
  test('enabled=false passes through unchanged (no rerankerFn call)', async () => {
    const results = [makeResult('a', 1.0, 'a'), makeResult('b', 0.5, 'b')];
    let called = false;
    const opts: RerankerOpts = {
      enabled: false,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => { called = true; return []; },
    };
    const out = await applyReranker('q', results, opts);
    expect(out).toEqual(results);
    expect(called).toBe(false);
  });

  test('empty results passes through immediately', async () => {
    let called = false;
    const opts: RerankerOpts = {
      enabled: true,
      topNIn: 30,
      topNOut: null,
      rerankerFn: async () => { called = true; return []; },
    };
    const out = await applyReranker('q', [], opts);
    expect(out).toEqual([]);
    expect(called).toBe(false);
  });
});
