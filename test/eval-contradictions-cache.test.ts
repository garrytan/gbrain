/**
 * Cache wrapper tests — P2 with prompt-version + truncation in the key
 * (Codex fix). Hits the real PGLite engine end-to-end.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  buildCacheKey,
  hashContent,
  JudgeCache,
} from '../src/core/eval-contradictions/cache.ts';
import { PROMPT_VERSION, TRUNCATION_POLICY } from '../src/core/eval-contradictions/types.ts';
import type { JudgeVerdict } from '../src/core/eval-contradictions/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const verdictHit: JudgeVerdict = {
  contradicts: true,
  severity: 'medium',
  axis: 'MRR vs ARR',
  confidence: 0.85,
  resolution_kind: 'dream_synthesize',
};

describe('hashContent', () => {
  test('produces stable 64-char hex sha256', () => {
    const h = hashContent('hello');
    expect(h.length).toBe(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  test('different inputs hash differently', () => {
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });

  test('same input stable across calls', () => {
    expect(hashContent('test')).toBe(hashContent('test'));
  });
});

describe('buildCacheKey', () => {
  test('sorts hashes lex so (a, b) === (b, a)', () => {
    const k1 = buildCacheKey({ textA: 'first', textB: 'second', modelId: 'haiku' });
    const k2 = buildCacheKey({ textA: 'second', textB: 'first', modelId: 'haiku' });
    expect(k1).toEqual(k2);
  });

  test('includes the prompt_version + truncation_policy constants', () => {
    const k = buildCacheKey({ textA: 'x', textB: 'y', modelId: 'haiku' });
    expect(k.prompt_version).toBe(PROMPT_VERSION);
    expect(k.truncation_policy).toBe(TRUNCATION_POLICY);
  });

  test('model_id pass-through', () => {
    const k = buildCacheKey({ textA: 'x', textB: 'y', modelId: 'sonnet' });
    expect(k.model_id).toBe('sonnet');
  });
});

describe('JudgeCache wrapper', () => {
  test('miss returns null and increments misses', async () => {
    const cache = new JudgeCache({ engine, modelId: 'haiku-test' });
    const hit = await cache.lookup('text-a', 'text-b');
    expect(hit).toBeNull();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().hits).toBe(0);
  });

  test('store then lookup returns the verdict', async () => {
    const cache = new JudgeCache({ engine, modelId: 'haiku-test' });
    await cache.store('text-a', 'text-b', verdictHit);
    const hit = await cache.lookup('text-a', 'text-b');
    expect(hit).not.toBeNull();
    expect(hit?.contradicts).toBe(true);
    expect(hit?.severity).toBe('medium');
    expect(cache.stats().hits).toBe(1);
  });

  test('order-independence: (a,b) and (b,a) both hit', async () => {
    const cache = new JudgeCache({ engine, modelId: 'haiku-test' });
    await cache.store('first', 'second', verdictHit);
    const hit = await cache.lookup('second', 'first');
    expect(hit).not.toBeNull();
    expect(hit?.contradicts).toBe(true);
  });

  test('different model_id is a separate key', async () => {
    const cache1 = new JudgeCache({ engine, modelId: 'haiku-test' });
    const cache2 = new JudgeCache({ engine, modelId: 'sonnet-test' });
    await cache1.store('a', 'b', verdictHit);
    const hit = await cache2.lookup('a', 'b');
    expect(hit).toBeNull();
  });

  test('disabled cache always misses, never stores', async () => {
    const cache = new JudgeCache({ engine, modelId: 'haiku-test', disabled: true });
    await cache.store('a', 'b', verdictHit);
    const hit = await cache.lookup('a', 'b');
    expect(hit).toBeNull();
    // And a fresh non-disabled cache should also see nothing (store was a no-op).
    const fresh = new JudgeCache({ engine, modelId: 'haiku-test' });
    expect(await fresh.lookup('a', 'b')).toBeNull();
  });

  test('hit_rate computed correctly', async () => {
    const cache = new JudgeCache({ engine, modelId: 'haiku-test' });
    await cache.store('x', 'y', verdictHit);
    await cache.lookup('x', 'y');  // hit
    await cache.lookup('m', 'n');  // miss
    await cache.lookup('p', 'q');  // miss
    const s = cache.stats();
    expect(s.hits).toBe(1);
    expect(s.misses).toBe(2);
    expect(s.hit_rate).toBeCloseTo(1 / 3, 5);
  });

  test('lookup defends against corrupt cache rows (shape validation)', async () => {
    // Inject a row directly that doesn't match JudgeVerdict shape.
    const key = buildCacheKey({ textA: 'corrupt-a', textB: 'corrupt-b', modelId: 'haiku-test' });
    await engine.putContradictionCacheEntry({
      ...key,
      verdict: { unrelated_field: 'whatever' },
    });
    const cache = new JudgeCache({ engine, modelId: 'haiku-test' });
    const hit = await cache.lookup('corrupt-a', 'corrupt-b');
    expect(hit).toBeNull();
    expect(cache.stats().misses).toBe(1);
  });
});
