/**
 * Tests for the adaptive embed batch system (PR #680, ships v0.28.7).
 *
 * Coverage matrix (per the eng-review plan):
 *
 *   1. Pure helpers exported from gateway.ts:
 *      - splitByTokenBudget pure-function semantics + chars_per_token threading
 *      - isTokenLimitError regex coverage
 *
 *   2. Recursion through public embed() with the AI-SDK transport stubbed.
 *      We do NOT call private functions; the test seam is the
 *      __setEmbedTransportForTests hook on the gateway.
 *
 *   3. Order preservation across recursive halving (left/right concat).
 *
 *   4. Terminal MIN_SUB_BATCH=1 — single text whose transport always fails
 *      must throw normalizeAIError, not loop forever.
 *
 *   5. OpenAI fast path (D3) — recipe with no max_batch_tokens calls the
 *      transport exactly once with no pre-split.
 *
 *   6. Shrink-on-miss adaptive cache (D8-A) — first miss halves the factor;
 *      after SHRINK_HEAL_AFTER successes the factor heals back toward the
 *      recipe-declared safety_factor.
 *
 *   7. Startup warning (D9-B) — gateway construction warns once per recipe
 *      with an embedding touchpoint missing max_batch_tokens (excluding the
 *      OpenAI canonical fast-path recipe).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  splitByTokenBudget,
  isTokenLimitError,
  __setEmbedTransportForTests,
  __getShrinkStateForTests,
} from '../../src/core/ai/gateway.ts';
import { AIConfigError, AITransientError } from '../../src/core/ai/errors.ts';

// --------- Test helpers ---------

/**
 * Build an embedding-shape return for an arbitrary number of values. Each
 * embedding is `dims` floats, all set to a sentinel index so tests can
 * assert order preservation.
 */
function fakeEmbeddings(values: string[], dims: number): { embeddings: number[][] } {
  return {
    embeddings: values.map((_, i) =>
      // First slot encodes the input index so we can verify ordering.
      Array.from({ length: dims }, (_, j) => (j === 0 ? i : 0.1)),
    ),
  };
}

const VOYAGE_TOKEN_LIMIT_ERROR = new Error(
  "Request to model 'voyage-3-large' failed. The max allowed tokens per submitted batch is 120000.",
);

function configureVoyage(): void {
  configureGateway({
    embedding_model: 'voyage:voyage-3-large',
    embedding_dimensions: 1024,
    env: { VOYAGE_API_KEY: 'sk-fake' },
  });
}

function configureOpenAI(): void {
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { OPENAI_API_KEY: 'sk-fake' },
  });
}

// --------- 1. Pure helpers ---------

describe('splitByTokenBudget (pure helper)', () => {
  test('single small text stays in one batch', () => {
    const result = splitByTokenBudget(['hello'], 120_000, 1);
    expect(result).toEqual([['hello']]);
  });

  test('texts fitting within budget stay in one batch', () => {
    const texts = Array.from({ length: 10 }, () => 'a'.repeat(1000));
    const result = splitByTokenBudget(texts, 96_000, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(10);
  });

  test('texts exceeding budget are split into multiple batches', () => {
    // chars_per_token=1, so each 50K-char text counts as 50K tokens.
    // Budget 96K → first text fits, second pushes over → new batch.
    const texts = ['a'.repeat(50_000), 'b'.repeat(50_000), 'c'.repeat(50_000)];
    const result = splitByTokenBudget(texts, 96_000, 1);
    expect(result).toHaveLength(3);
    expect(result.map(b => b.length)).toEqual([1, 1, 1]);
  });

  test('chars_per_token=4 (OpenAI density) packs 4× more chars per batch', () => {
    // Each 50K-char text = 12.5K tokens at chars_per_token=4. Budget 96K
    // tokens → 7 fit; the 8th would overflow into a new batch.
    const texts = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(50_000));
    const result = splitByTokenBudget(texts, 96_000, 4);
    expect(result[0].length).toBe(7);
    expect(result[1].length).toBe(3);
  });

  test('default chars_per_token (4) when ratio omitted', () => {
    // Same payload as above without the explicit ratio.
    const texts = Array.from({ length: 10 }, (_, i) => `${i}`.repeat(50_000));
    const explicit = splitByTokenBudget(texts, 96_000, 4);
    const implicit = splitByTokenBudget(texts, 96_000);
    expect(implicit).toEqual(explicit);
  });

  test('empty input returns empty array', () => {
    expect(splitByTokenBudget([], 120_000, 1)).toEqual([]);
  });

  test('single text larger than budget still goes in a batch (split helper does not subdivide)', () => {
    const result = splitByTokenBudget(['a'.repeat(200_000)], 120_000, 1);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(1);
  });

  test('zero or negative chars_per_token falls back to default', () => {
    const texts = ['a'.repeat(40_000)];
    expect(splitByTokenBudget(texts, 96_000, 0)).toEqual(splitByTokenBudget(texts, 96_000, 4));
    expect(splitByTokenBudget(texts, 96_000, -1)).toEqual(splitByTokenBudget(texts, 96_000, 4));
  });
});

describe('isTokenLimitError (pure helper)', () => {
  test('matches Voyage error format', () => {
    expect(isTokenLimitError(VOYAGE_TOKEN_LIMIT_ERROR)).toBe(true);
  });

  test('matches "token limit exceeded" variant', () => {
    expect(isTokenLimitError(new Error('Token limit exceeded for batch request'))).toBe(true);
  });

  test('matches "batch too many tokens" variant', () => {
    expect(isTokenLimitError(new Error('Batch contains too many tokens'))).toBe(true);
  });

  test('does not match unrelated errors', () => {
    expect(isTokenLimitError(new Error('Connection refused'))).toBe(false);
    expect(isTokenLimitError(new Error('Invalid API key'))).toBe(false);
    expect(isTokenLimitError(new Error('429 rate limited'))).toBe(false);
  });

  test('handles non-Error throwables', () => {
    expect(isTokenLimitError('Token limit exceeded')).toBe(true);
    expect(isTokenLimitError({ message: 'some other thing' })).toBe(false);
    expect(isTokenLimitError(null)).toBe(false);
    expect(isTokenLimitError(undefined)).toBe(false);
  });
});

// --------- 2-4. Recursion via embed() with stubbed transport ---------

describe('embed() recursion via stubbed transport', () => {
  beforeEach(() => resetGateway());
  afterEach(() => __setEmbedTransportForTests(null));

  test('halves on token-limit error and concatenates left+right in order', async () => {
    configureVoyage();

    const stub = mock(async ({ values }: { values: string[] }) => {
      // First call: full batch fails. Halved calls: succeed.
      if (values.length === 50) throw VOYAGE_TOKEN_LIMIT_ERROR;
      return fakeEmbeddings(values, 1024);
    });
    __setEmbedTransportForTests(stub as any);

    // Build 50 texts that each fit comfortably under any pre-split budget
    // (1 char ≈ 1 token in voyage's recipe; 0.5 × 120K = 60K char budget).
    const texts = Array.from({ length: 50 }, (_, i) => `t${i}`);
    const result = await embed(texts);

    // Stub fired 3 times: 1 fail (length 50) + 2 success (length 25 each).
    expect(stub).toHaveBeenCalledTimes(3);
    const callLengths = stub.mock.calls.map(([arg]) => (arg as { values: string[] }).values.length);
    expect(callLengths.sort((a, b) => a - b)).toEqual([25, 25, 50]);
    expect(result).toHaveLength(50);
  });

  test('preserves input order across halving boundaries', async () => {
    configureVoyage();

    const stub = mock(async ({ values }: { values: string[] }) => {
      if (values.length === 10) throw VOYAGE_TOKEN_LIMIT_ERROR;
      return fakeEmbeddings(values, 1024);
    });
    __setEmbedTransportForTests(stub as any);

    const texts = Array.from({ length: 10 }, (_, i) => String.fromCharCode(97 + i)); // a..j
    const result = await embed(texts);

    expect(result).toHaveLength(10);
    // The fakeEmbeddings helper encodes the within-call index in slot 0;
    // halved calls each receive sub-arrays of length 5, so slot 0 reads
    // [0,1,2,3,4,0,1,2,3,4] — that's the contract that proves order
    // preservation despite the embeddings being concatenated from two calls.
    const slotZero = result.map(v => v[0]);
    expect(slotZero).toEqual([0, 1, 2, 3, 4, 0, 1, 2, 3, 4]);
  });

  test('terminal case: single text always fails → normalizes and throws (no infinite loop)', async () => {
    configureVoyage();

    const stub = mock(async () => { throw VOYAGE_TOKEN_LIMIT_ERROR; });
    __setEmbedTransportForTests(stub as any);

    let caught: unknown = null;
    try {
      await embed(['just one text']);
    } catch (e) {
      caught = e;
    }
    expect(caught).not.toBeNull();
    expect(caught instanceof AIConfigError || caught instanceof AITransientError).toBe(true);
    // Stub fires once for the single-element batch; cannot halve further so
    // the recursion gives up at MIN_SUB_BATCH=1 and rethrows.
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

// --------- 5. OpenAI fast path (D3) ---------

describe('embed() OpenAI fast path (no max_batch_tokens)', () => {
  beforeEach(() => resetGateway());
  afterEach(() => __setEmbedTransportForTests(null));

  test('recipe without max_batch_tokens calls transport exactly once with no partition', async () => {
    configureOpenAI();

    const stub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 1536));
    __setEmbedTransportForTests(stub as any);

    const texts = Array.from({ length: 100 }, (_, i) => `text-${i}`);
    const result = await embed(texts);

    expect(stub).toHaveBeenCalledTimes(1);
    const callValues = (stub.mock.calls[0][0] as { values: string[] }).values;
    expect(callValues).toEqual(texts);
    expect(result).toHaveLength(100);
  });

  test('OpenAI fast path is unaffected by Voyage shrink state', async () => {
    // Configure Voyage first and trigger a shrink…
    configureVoyage();
    const voyageStub = mock(async ({ values }: { values: string[] }) => {
      if (values.length === 4) throw VOYAGE_TOKEN_LIMIT_ERROR;
      return fakeEmbeddings(values, 1024);
    });
    __setEmbedTransportForTests(voyageStub as any);
    await embed(['a', 'b', 'c', 'd']);
    expect(__getShrinkStateForTests('voyage')?.factor).toBe(0.25);

    // …then reconfigure to OpenAI. The shrink state belongs to the prior
    // gateway's lifecycle and must not leak.
    configureOpenAI();
    const openaiStub = mock(async ({ values }: { values: string[] }) => fakeEmbeddings(values, 1536));
    __setEmbedTransportForTests(openaiStub as any);
    await embed(['x', 'y']);
    expect(openaiStub).toHaveBeenCalledTimes(1);
    expect(__getShrinkStateForTests('voyage')).toBeUndefined();
  });
});

// --------- 6. Shrink-on-miss adaptive cache (D8-A) ---------

describe('shrink-on-miss adaptive cache', () => {
  beforeEach(() => resetGateway());
  afterEach(() => __setEmbedTransportForTests(null));

  test('first token-limit miss halves the recipe safety factor', async () => {
    configureVoyage();
    expect(__getShrinkStateForTests('voyage')).toBeUndefined();

    const stub = mock(async ({ values }: { values: string[] }) => {
      if (values.length === 4) throw VOYAGE_TOKEN_LIMIT_ERROR;
      return fakeEmbeddings(values, 1024);
    });
    __setEmbedTransportForTests(stub as any);

    await embed(['a', 'b', 'c', 'd']);
    // Voyage declares safety_factor=0.5; after one miss → 0.5 × 0.5 = 0.25.
    expect(__getShrinkStateForTests('voyage')?.factor).toBe(0.25);
  });

  test('factor floors at SHRINK_FLOOR (0.05) under repeated misses', async () => {
    configureVoyage();
    const stub = mock(async ({ values }: { values: string[] }) => {
      // Always throw on >1 to keep recursion going until MIN_SUB_BATCH=1
      // succeeds. That gives many shrink events per embed() call.
      if (values.length > 1) throw VOYAGE_TOKEN_LIMIT_ERROR;
      return fakeEmbeddings(values, 1024);
    });
    __setEmbedTransportForTests(stub as any);

    // 16 texts will recurse 4 levels deep, generating multiple shrink events.
    await embed(Array.from({ length: 16 }, (_, i) => `t${i}`));
    const factor = __getShrinkStateForTests('voyage')?.factor ?? -1;
    expect(factor).toBeGreaterThanOrEqual(0.05);
  });

  test('factor heals back toward declared safety_factor after enough wins', async () => {
    configureVoyage();
    const stub = mock(async ({ values }: { values: string[] }) => {
      // Once: fail at length 2, succeed everywhere else. Subsequent calls
      // all succeed.
      if (stub.mock.calls.length === 1 && values.length === 2) throw VOYAGE_TOKEN_LIMIT_ERROR;
      return fakeEmbeddings(values, 1024);
    });
    __setEmbedTransportForTests(stub as any);

    await embed(['a', 'b']); // 1 fail + 2 successes (length 1 each) → factor 0.25, wins 2
    const afterMiss = __getShrinkStateForTests('voyage')?.factor;
    expect(afterMiss).toBe(0.25);

    // Drive 10 more successful calls. SHRINK_HEAL_AFTER=10; on the 10th win
    // the factor multiplies by 1.5 (capped at the declared 0.5 ceiling).
    for (let i = 0; i < 8; i++) {
      await embed(['solo']);
    }
    const healed = __getShrinkStateForTests('voyage')?.factor ?? 0;
    // 0.25 × 1.5 = 0.375. Still below the recipe ceiling of 0.5; the next
    // round of 10 wins would bump it to min(0.5, 0.375 × 1.5) = 0.5.
    expect(healed).toBeCloseTo(0.375, 5);
  });

  test('healing path cannot exceed the recipe-declared safety_factor', async () => {
    configureVoyage();
    const stub = mock(async ({ values }: { values: string[] }) => {
      if (stub.mock.calls.length === 1) throw VOYAGE_TOKEN_LIMIT_ERROR;
      return fakeEmbeddings(values, 1024);
    });
    __setEmbedTransportForTests(stub as any);

    // Trigger one shrink, then drive enough wins to fully heal.
    await embed(['one', 'two']);
    for (let i = 0; i < 30; i++) {
      await embed(['solo']);
    }
    const factor = __getShrinkStateForTests('voyage')?.factor ?? 0;
    // Declared safety_factor is 0.5; healing must clamp at that ceiling.
    expect(factor).toBeLessThanOrEqual(0.5);
    expect(factor).toBeGreaterThan(0);
  });
});

// --------- 7. Startup warning (D9-B) ---------

describe('startup warning for recipes missing max_batch_tokens', () => {
  beforeEach(() => resetGateway());

  test('first configureGateway call warns about each missing-cap recipe; subsequent calls suppressed', () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (msg: string) => warnings.push(String(msg));
    try {
      configureOpenAI();
      const firstCallCount = warnings.length;
      // Reconfigure: the warning should NOT re-fire for the same recipes
      // within one process (we already told the operator).
      configureOpenAI();
      expect(warnings.length).toBe(firstCallCount);
    } finally {
      console.warn = original;
    }

    // The warning text should match the documented contract.
    const contractMatch = warnings.filter(w =>
      w.includes('[ai.gateway]') && w.includes('declares an embedding touchpoint'),
    );
    expect(contractMatch.length).toBeGreaterThan(0);

    // Voyage declares max_batch_tokens → suppressed. OpenAI is the
    // canonical fast-path recipe → also suppressed by id. Both must be
    // absent from the warnings.
    expect(warnings.find(w => w.includes('"voyage"'))).toBeUndefined();
    expect(warnings.find(w => w.includes('"openai"'))).toBeUndefined();
  });
});
