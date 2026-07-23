/**
 * #1626 — hybridSearch's text-vector arm must not fail DARK.
 *
 * The arm only runs when the embedding provider probed available, so a throw
 * inside it (embed timeout, transient pooler error on searchVector) is a real
 * failure. Pre-fix, a bare `catch {}` swallowed it and the run silently
 * collapsed to keyword-only — under `--source __all__` on a strained pooler
 * that read as a non-deterministic "No results". The fix logs the swallowed
 * reason via warnOncePerProcess while keeping the keyword fallback.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hybridSearch } from '../src/core/search/hybrid.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { _resetWarnOnceForTests } from '../src/core/utils.ts';

let engine: PGLiteEngine;
const origWarn = console.warn;

beforeAll(async () => {
  // Pin the gateway to OpenAI with a stub key (put-page-provenance pattern):
  // embed() runs instantiateEmbedding — which requires OPENAI_API_KEY — BEFORE
  // the stubbed transport is reached. Without this, a keyless CI environment
  // throws the config error instead of the transport's, and the assertion on
  // the swallowed reason fails. The key never leaves the process.
  configureGateway({
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
  });
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('people/alice-example', {
    type: 'person',
    title: 'Alice Example',
    compiled_truth: 'Alice Example is a test person for the vector-arm warn test.',
  });
});

afterAll(async () => {
  console.warn = origWarn;
  __setEmbedTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

describe('hybridSearch vector-arm failure telemetry (#1626)', () => {
  test('embed failure logs the swallowed reason and falls back to keyword', async () => {
    _resetWarnOnceForTests();
    // Installing a transport makes isAvailable('embedding') true (test-seam
    // fast path), so the vector arm RUNS — and then throws.
    __setEmbedTransportForTests(() => {
      throw new Error('pooler exploded mid-fanout');
    });
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(' '));
    };
    try {
      const results = await hybridSearch(engine, 'alice');
      // Keyword fallback still returns results — fail-open preserved.
      expect(results.some((r) => r.slug === 'people/alice-example')).toBe(true);
    } finally {
      console.warn = origWarn;
      __setEmbedTransportForTests(null);
    }
    const armWarnings = warnings.filter((w) => w.includes('vector arm failed'));
    expect(armWarnings).toHaveLength(1);
    expect(armWarnings[0]).toContain('pooler exploded mid-fanout');
  });
});
