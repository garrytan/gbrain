/**
 * PR #5922 takeover (#4530 follow-up) — hosted encoders declare their
 * per-INPUT token caps so the chunker splits to a size the model accepts.
 *
 * DashScope rejects any single input over 2,048 tokens on text-embedding-v1
 * / v2 (8,192 on v3 / v4) with a 400 that fails the whole batch; master
 * declared nothing, so its cap was unenforced. The same audit found Google
 * gemini-embedding-001 (2,048; silently TRUNCATES over the cap by default,
 * which is a lossy vector, not an error) and Zhipu embedding-2 / embedding-3
 * (512 / 3,072). Each figure is the vendor's documented per-input limit.
 *
 * The chunk cap is floor(limit × EMBED_INPUT_SAFETY), never above
 * DEFAULT_MAX_CHUNK_TOKENS (so an 8K+ limit changes nothing).
 */
import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  resolveMaxChunkTokens,
  maxInputTokensForModel,
  EMBED_INPUT_SAFETY,
} from '../src/core/embedding-input-limit.ts';
import { DEFAULT_MAX_CHUNK_TOKENS } from '../src/core/chunkers/token-estimate.ts';
import { estimateEmbedTokens } from '../src/core/chunkers/token-estimate.ts';
import { healOversizedChunks } from '../src/core/embed-oversize-heal.ts';
import { dashscope } from '../src/core/ai/recipes/dashscope.ts';
import { google } from '../src/core/ai/recipes/google.ts';
import { zhipu } from '../src/core/ai/recipes/zhipu.ts';
import { openai } from '../src/core/ai/recipes/openai.ts';
import { mistral } from '../src/core/ai/recipes/mistral.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';

const withoutChunkTokenEnv = <T>(fn: () => T | Promise<T>) =>
  withEnv({ GBRAIN_MAX_CHUNK_TOKENS: undefined }, fn);

beforeEach(() => resetGateway());
afterAll(() => {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...process.env } });
});

const cap = (limit: number) => Math.min(DEFAULT_MAX_CHUNK_TOKENS, Math.floor(limit * EMBED_INPUT_SAFETY));

describe('DashScope per-input caps (PR #5922)', () => {
  test('the recipe declares 2048 for v1/v2 and 8192 for v3', () => {
    expect(maxInputTokensForModel(dashscope, 'text-embedding-v1')).toBe(2048);
    expect(maxInputTokensForModel(dashscope, 'text-embedding-v2')).toBe(2048);
    expect(maxInputTokensForModel(dashscope, 'text-embedding-v3')).toBe(8192);
  });

  test('v2 chunks at 1228 estimated tokens; v3 keeps the 2000 default (8192 × 0.6 is above it)', async () => {
    await withoutChunkTokenEnv(() => {
      configureGateway({ embedding_model: 'dashscope:text-embedding-v2', embedding_dimensions: 1024, env: { DASHSCOPE_API_KEY: 'k' } });
      expect(resolveMaxChunkTokens()).toBe(1228);
      expect(resolveMaxChunkTokens()).toBe(cap(2048));
      configureGateway({ embedding_model: 'dashscope:text-embedding-v3', embedding_dimensions: 1024, env: { DASHSCOPE_API_KEY: 'k' } });
      expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
    });
  });

  test('a stored CJK-dense chunk over the v2 cap is split by the heal pass, never truncated', async () => {
    await withoutChunkTokenEnv(() => {
      configureGateway({ embedding_model: 'dashscope:text-embedding-v2', embedding_dimensions: 1024, env: { DASHSCOPE_API_KEY: 'k' } });
      const sentence = '阿里云百炼平台提供多种文本向量模型，用于检索、聚类和分类任务，支持中英文混合输入。';
      const text = Array.from({ length: 30 }, (_, i) => `${sentence} 第${i}段。`).join('\n\n');
      // Between the v2 cap and the 2000 default: only the declaration makes this split.
      expect(estimateEmbedTokens(text)).toBeGreaterThan(resolveMaxChunkTokens());
      expect(estimateEmbedTokens(text)).toBeLessThan(DEFAULT_MAX_CHUNK_TOKENS);
      const healed = healOversizedChunks([{ chunk_index: 0, chunk_text: text, chunk_source: 'compiled_truth', token_count: 0 }]);
      expect(healed.changed).toBe(true);
      expect(healed.chunks.length).toBeGreaterThan(1);
      for (const c of healed.chunks) expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(resolveMaxChunkTokens());
      expect(healed.chunks.map(c => c.chunk_text).join('')).toContain('第29段');
    });
  });
});

describe('hosted encoder audit ([R13])', () => {
  test('Google gemini-embedding-001 declares 2048 (the endpoint silently truncates past it); gemini-embedding-2 stays undeclared', () => {
    expect(maxInputTokensForModel(google, 'gemini-embedding-001')).toBe(2048);
    expect(maxInputTokensForModel(google, 'gemini-embedding-2')).toBeUndefined();
  });

  test('Zhipu embedding-2 declares 512 and embedding-3 declares 3072', () => {
    expect(maxInputTokensForModel(zhipu, 'embedding-2')).toBe(512);
    expect(maxInputTokensForModel(zhipu, 'embedding-3')).toBe(3072);
  });

  test('OpenAI (8191) and Mistral (8192) declare caps above the default chunk size, so their chunking is unchanged', async () => {
    expect(maxInputTokensForModel(openai, 'text-embedding-3-large')).toBe(8191);
    expect(maxInputTokensForModel(openai, 'text-embedding-3-small')).toBe(8191);
    expect(maxInputTokensForModel(mistral, 'mistral-embed')).toBe(8192);
    await withoutChunkTokenEnv(() => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'k' } });
      expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
      configureGateway({ embedding_model: 'mistral:mistral-embed', embedding_dimensions: 1024, env: { MISTRAL_API_KEY: 'k' } });
      expect(resolveMaxChunkTokens()).toBe(DEFAULT_MAX_CHUNK_TOKENS);
    });
  });

  test('effective chunk caps for the models whose chunking changes', async () => {
    await withoutChunkTokenEnv(() => {
      configureGateway({ embedding_model: 'google:gemini-embedding-001', embedding_dimensions: 768, env: { GOOGLE_GENERATIVE_AI_API_KEY: 'k' } });
      expect(resolveMaxChunkTokens()).toBe(1228);
      configureGateway({ embedding_model: 'zhipu:embedding-2', embedding_dimensions: 1024, env: { ZHIPUAI_API_KEY: 'k' } });
      expect(resolveMaxChunkTokens()).toBe(307);
      configureGateway({ embedding_model: 'zhipu:embedding-3', embedding_dimensions: 1024, env: { ZHIPUAI_API_KEY: 'k' } });
      expect(resolveMaxChunkTokens()).toBe(1843);
    });
  });

  test('every declared cap is a positive integer keyed by a model the recipe lists', () => {
    for (const recipe of [dashscope, google, zhipu, openai, mistral]) {
      const table = recipe.touchpoints.embedding!.max_input_tokens!;
      for (const [model, limit] of Object.entries(table)) {
        expect(Number.isInteger(limit) && limit > 0).toBe(true);
        expect(recipe.touchpoints.embedding!.models).toContain(model);
      }
    }
  });
});
