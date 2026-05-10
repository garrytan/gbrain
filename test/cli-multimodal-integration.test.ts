// v0.28.11 (PR #719, D5): cli connectEngine() DB→gateway plumbing.
//
// The unit tests for loadConfigWithEngine and embedMultimodal cover their
// own contracts but don't exercise the cli.ts glue that ties them together.
// Codex F3 flagged this as the actual bug site. This file drives the same
// merge + reconfigure sequence connectEngine() runs and asserts the gateway
// observed the DB-set value through buildGatewayConfig.
//
// PGLite-only: in-memory engine, no DATABASE_URL needed.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { loadConfigWithEngine, type GBrainConfig } from '../src/core/config.ts';
import {
  configureGateway,
  getEmbeddingModel,
  getMultimodalModel,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import type { AIGatewayConfig } from '../src/core/ai/types.ts';

// Mirror the cli.ts buildGatewayConfig helper exactly. Keeping a copy here
// (instead of exporting from cli.ts) is intentional: the test asserts the
// shape of the contract, not the helper's identity. If cli.ts drifts, the
// e2e behavior these tests care about (DB-set value lands in gateway) still
// holds, but a helper-shape test would also catch the drift in PR review.
function buildGatewayConfig(c: GBrainConfig): AIGatewayConfig {
  const env = { ...process.env };
  if (!env.OPENAI_API_KEY && c.openai_api_key) env.OPENAI_API_KEY = c.openai_api_key;
  if (!env.ANTHROPIC_API_KEY && c.anthropic_api_key) env.ANTHROPIC_API_KEY = c.anthropic_api_key;
  return {
    embedding_model: c.embedding_model,
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    base_urls: c.provider_base_urls,
    env,
  };
}

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
  resetGateway();
  // Clear any prior config rows so tests are independent. setConfig with
  // empty string is treated as undefined by loadConfigWithEngine (per
  // dbStr semantics), so this is safe to call between tests.
  await engine.setConfig('embedding_multimodal_model', '');
});

describe('cli connectEngine — embedding_multimodal_model DB→gateway plumbing', () => {
  test('DB-set multimodal_model flows to gateway via merge + reconfigure', async () => {
    await engine.setConfig('embedding_multimodal_model', 'voyage:voyage-multimodal-3');

    const baseConfig: GBrainConfig = {
      engine: 'pglite',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
    };

    // First call mirrors cli.ts:715 (pre-engine-connect).
    configureGateway(buildGatewayConfig(baseConfig));
    expect(getMultimodalModel()).toBeUndefined();

    // Second call mirrors cli.ts:776 (post-DB-merge).
    const merged = await loadConfigWithEngine(engine, baseConfig);
    expect(merged).not.toBeNull();
    configureGateway(buildGatewayConfig(merged!));

    // Primary embedding_model stays put (file/env wins); multimodal_model
    // arrived via DB.
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');
    expect(getMultimodalModel()).toBe('voyage:voyage-multimodal-3');
  });

  test('file value wins over DB value (env > file > DB precedence at gateway level)', async () => {
    await engine.setConfig('embedding_multimodal_model', 'voyage:voyage-3-large');

    const baseConfig: GBrainConfig = {
      engine: 'pglite',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      embedding_multimodal_model: 'voyage:voyage-multimodal-3', // file plane
    };

    const merged = await loadConfigWithEngine(engine, baseConfig);
    configureGateway(buildGatewayConfig(merged!));

    expect(getMultimodalModel()).toBe('voyage:voyage-multimodal-3');
  });

  test('un-gated re-config: merged DB has no multimodal_model → gateway still gets re-configured', async () => {
    // Codex F5 was about whether the un-gated re-config weakens an
    // intentional contract. This test pins the actual behavior (D6 = B):
    // re-config always fires when merge succeeds, even when no DB key
    // changed. Schema-sizing fields stay stable because loadConfigWithEngine
    // respects file/env first.
    const baseConfig: GBrainConfig = {
      engine: 'pglite',
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
    };

    configureGateway(buildGatewayConfig(baseConfig));
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');

    const merged = await loadConfigWithEngine(engine, baseConfig);
    configureGateway(buildGatewayConfig(merged!));

    // Primary model unchanged (DB had no override); the re-config is a
    // semantic no-op for these fields.
    expect(getEmbeddingModel()).toBe('openai:text-embedding-3-large');
    expect(getMultimodalModel()).toBeUndefined();
  });
});
