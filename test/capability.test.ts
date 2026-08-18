/**
 * [CX-P0.5] Keyless capability probe tests — config-plane detection matrix.
 *
 * Pure unit: no engine, no network, no gateway state. Config + env are
 * injected so the matrix is hermetic regardless of what keys the developer
 * machine or CI exports.
 */
import { describe, test, expect } from 'bun:test';
import {
  detectCapabilities,
  renderCapabilityReport,
} from '../src/core/capability.ts';
import type { GBrainConfig } from '../src/core/config.ts';

const cfg = (partial: Partial<GBrainConfig>): GBrainConfig =>
  ({ engine: 'pglite', ...partial }) as GBrainConfig;

describe('detectCapabilities — matrix', () => {
  test('no config, no keys → keyless / keyword-only', () => {
    const caps = detectCapabilities({ config: null, env: {} });
    expect(caps.embeddings.available).toBe(false);
    expect(caps.extraction.available).toBe(false);
    expect(caps.search).toBe('keyword-only');
    expect(caps.mode).toBe('keyless');
  });

  test('fake openai key in config (file plane) → keyed / semantic', () => {
    const caps = detectCapabilities({
      config: cfg({
        openai_api_key: 'sk-test-not-real',
        embedding_model: 'openai:text-embedding-3-small',
        chat_model: 'openai:gpt-4o-mini',
      }),
      env: {},
    });
    expect(caps.embeddings).toEqual({ available: true, provider: 'openai' });
    expect(caps.extraction).toEqual({ available: true, provider: 'openai' });
    expect(caps.search).toBe('semantic');
    expect(caps.mode).toBe('keyed');
  });

  test('env-only anthropic key → extraction keyed, embeddings still keyword-only', () => {
    // Default chat model is anthropic; default embedding model is
    // zeroentropyai — an Anthropic key alone unlocks extraction but NOT
    // semantic search.
    const caps = detectCapabilities({
      config: null,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    expect(caps.extraction).toEqual({ available: true, provider: 'anthropic' });
    expect(caps.embeddings.available).toBe(false);
    expect(caps.search).toBe('keyword-only');
    expect(caps.mode).toBe('keyed');
  });

  test('config-plane anthropic key folds into env names (daemon posture)', () => {
    const caps = detectCapabilities({
      config: cfg({ anthropic_api_key: 'sk-ant-file-plane' }),
      env: {},
    });
    expect(caps.extraction.available).toBe(true);
    expect(caps.mode).toBe('keyed');
  });

  test('empty-string env keys are dropped (#1249 posture) → keyless', () => {
    const caps = detectCapabilities({
      config: null,
      env: { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
    });
    expect(caps.mode).toBe('keyless');
  });

  test('GEMINI_API_KEY alias reaches the google recipe', () => {
    const caps = detectCapabilities({
      config: cfg({ chat_model: 'google:gemini-2.5-flash' }),
      env: { GEMINI_API_KEY: 'g-test' },
    });
    expect(caps.extraction).toEqual({ available: true, provider: 'google' });
  });

  test('unknown provider in model string → no throw; extraction falls back key-aware', () => {
    // Availability-aware fallback: an unknown chat pin is unservable, so the
    // effective-model resolution falls through to the key-aware tier default —
    // with an OpenAI key present, extraction is honestly AVAILABLE via openai
    // (an openai-only install with a garbage pin must still extract).
    const caps = detectCapabilities({
      config: cfg({
        embedding_model: 'not-a-provider:some-model',
        chat_model: 'also-not-real:x',
      }),
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    expect(caps.embeddings.available).toBe(false);
    expect(caps.extraction).toEqual({ available: true, provider: 'openai' });
    expect(caps.mode).toBe('keyed');
  });

  test('unknown provider pin + NO key → unavailable, not a throw', () => {
    const caps = detectCapabilities({
      config: cfg({
        embedding_model: 'not-a-provider:some-model',
        chat_model: 'also-not-real:x',
      }),
      env: {},
    });
    expect(caps.embeddings.available).toBe(false);
    expect(caps.extraction.available).toBe(false);
    expect(caps.mode).toBe('keyless');
  });

  test('openai-key-only, no config → extraction available via openai (key-aware default)', () => {
    const caps = detectCapabilities({ config: null, env: { OPENAI_API_KEY: 'sk-test' } });
    expect(caps.extraction).toEqual({ available: true, provider: 'openai' });
  });

  test('voyage key + voyage embedding pin → embeddings yes, extraction no, mode keyed', () => {
    // Init writes the voyage embedding pin to config; the Voyage key powers
    // semantic search but NOT extraction (no chat touchpoint).
    const caps = detectCapabilities({
      config: cfg({ embedding_model: 'voyage:voyage-4' }),
      env: { VOYAGE_API_KEY: 'pa-test' },
    });
    expect(caps.embeddings).toEqual({ available: true, provider: 'voyage' });
    expect(caps.extraction.available).toBe(false);
    expect(caps.mode).toBe('keyed');
  });

  test('GBRAIN_MODEL honored by the extraction probe (engine-free env override)', () => {
    // GBRAIN_MODEL names an openai model; only the OpenAI key is present →
    // available via openai even though the anthropic-first default would
    // otherwise win when both keys exist.
    const caps = detectCapabilities({
      config: null,
      env: { GBRAIN_MODEL: 'openai:gpt-4o-mini', OPENAI_API_KEY: 'sk-test', ANTHROPIC_API_KEY: 'sk-ant-test' },
    });
    expect(caps.extraction).toEqual({ available: true, provider: 'openai' });
  });
});

describe('renderCapabilityReport', () => {
  test('keyless report carries the honest degraded-mode copy + upsell', () => {
    const text = renderCapabilityReport(
      detectCapabilities({ config: null, env: {} }),
    );
    expect(text).toContain('keyless mode');
    expect(text).toContain('keyword-only');
    expect(text).toContain('agent-authored');
    expect(text).toContain('one optional key upgrades capabilities');
    expect(text).toContain('OpenAI: semantic search + auto-extraction');
  });

  test('keyed report names the providers and drops the upsell', () => {
    const text = renderCapabilityReport(
      detectCapabilities({
        config: cfg({
          openai_api_key: 'sk-test',
          embedding_model: 'openai:text-embedding-3-small',
          chat_model: 'openai:gpt-4o-mini',
        }),
        env: {},
      }),
    );
    expect(text).toContain('keyed mode');
    expect(text).toContain('openai');
    expect(text).not.toContain('one optional key upgrades capabilities');
  });
});
