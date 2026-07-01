import { describe, test, expect, beforeEach, afterAll } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  isAvailable,
  embed,
} from '../../src/core/ai/gateway.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { parseModelId, resolveRecipe } from '../../src/core/ai/model-resolver.ts';
import { AIConfigError } from '../../src/core/ai/errors.ts';
import { listRecipes } from '../../src/core/ai/recipes/index.ts';

afterAll(() => resetGateway());

describe('bedrock recipe registration', () => {
  test('bedrock recipe is registered with correct id and implementation', () => {
    const recipes = listRecipes();
    const bedrock = recipes.find(r => r.id === 'bedrock');
    expect(bedrock).toBeDefined();
    expect(bedrock!.implementation).toBe('native-bedrock');
    expect(bedrock!.tier).toBe('native');
  });

  test('bedrock recipe declares embedding touchpoint', () => {
    const recipes = listRecipes();
    const bedrock = recipes.find(r => r.id === 'bedrock')!;
    expect(bedrock.touchpoints.embedding).toBeDefined();
    expect(bedrock.touchpoints.embedding!.models).toContain('amazon.titan-embed-text-v2:0');
    expect(bedrock.touchpoints.embedding!.default_dims).toBe(1536);
  });

  test('bedrock recipe declares reranker touchpoint', () => {
    const recipes = listRecipes();
    const bedrock = recipes.find(r => r.id === 'bedrock')!;
    expect(bedrock.touchpoints.reranker).toBeDefined();
    expect(bedrock.touchpoints.reranker!.models).toContain('amazon.rerank-v1:0');
    expect(bedrock.touchpoints.reranker!.models).toContain('cohere.rerank-v3-5:0');
    expect(bedrock.touchpoints.reranker!.default_model).toBe('amazon.rerank-v1:0');
  });

  test('bedrock recipe declares chat touchpoint', () => {
    const recipes = listRecipes();
    const bedrock = recipes.find(r => r.id === 'bedrock')!;
    expect(bedrock.touchpoints.chat).toBeDefined();
    expect(bedrock.touchpoints.chat!.supports_tools).toBe(true);
    expect(bedrock.touchpoints.chat!.supports_subagent_loop).toBe(false);
    expect(bedrock.touchpoints.chat!.models).toContain('anthropic.claude-sonnet-4-6-20260101-v1:0');
    expect(bedrock.touchpoints.chat!.models).toContain('amazon.nova-pro-v1:0');
  });

  test('bedrock recipe requires AWS_REGION', () => {
    const recipes = listRecipes();
    const bedrock = recipes.find(r => r.id === 'bedrock')!;
    expect(bedrock.auth_env).toBeDefined();
    expect(bedrock.auth_env!.required).toContain('AWS_REGION');
  });

  test('bedrock recipe has optional key vars', () => {
    const recipes = listRecipes();
    const bedrock = recipes.find(r => r.id === 'bedrock')!;
    expect(bedrock.auth_env).toBeDefined();
    expect(bedrock.auth_env!.optional).toContain('AWS_ACCESS_KEY_ID');
    expect(bedrock.auth_env!.optional).toContain('AWS_SECRET_ACCESS_KEY');
    expect(bedrock.auth_env!.optional).toContain('AWS_SESSION_TOKEN');
  });
});

describe('bedrock model resolution', () => {
  test('parseModelId resolves bedrock prefix', () => {
    const parsed = parseModelId('bedrock:amazon.titan-embed-text-v2:0');
    expect(parsed.providerId).toBe('bedrock');
    expect(parsed.modelId).toBe('amazon.titan-embed-text-v2:0');
  });

  test('resolveRecipe finds bedrock recipe', () => {
    const { recipe, parsed } = resolveRecipe('bedrock:amazon.titan-embed-text-v2:0');
    expect(recipe.id).toBe('bedrock');
    expect(parsed.modelId).toBe('amazon.titan-embed-text-v2:0');
  });
});

describe('bedrock gateway availability', () => {
  beforeEach(() => resetGateway());

  test('embedding AVAILABLE when AWS_REGION is set', () => {
    configureGateway({
      embedding_model: 'bedrock:amazon.titan-embed-text-v2:0',
      embedding_dimensions: 1536,
      env: { AWS_REGION: 'us-east-1' },
    });
    expect(isAvailable('embedding')).toBe(true);
  });

  test('embedding UNAVAILABLE when AWS_REGION is missing', () => {
    configureGateway({
      embedding_model: 'bedrock:amazon.titan-embed-text-v2:0',
      embedding_dimensions: 1536,
      env: {},
    });
    expect(isAvailable('embedding')).toBe(false);
  });
});

describe('bedrock instantiateEmbedding errors', () => {
  beforeEach(() => resetGateway());

  test('embed throws AIConfigError when AWS_REGION is missing', async () => {
    configureGateway({
      embedding_model: 'bedrock:amazon.titan-embed-text-v2:0',
      embedding_dimensions: 1536,
      env: {},
    });
    try {
      await embed(['test']);
      expect(true).toBe(false); // should not reach
    } catch (err) {
      expect(err).toBeInstanceOf(AIConfigError);
      expect((err as AIConfigError).message).toContain('AWS_REGION');
    }
  });
});

describe('bedrock config env flow', () => {
  test('buildGatewayConfig maps aws_region from GBrainConfig to env.AWS_REGION', () => {
    // Temporarily clear process.env AWS vars so config-file values win the merge.
    const saved = {
      AWS_REGION: process.env.AWS_REGION,
      AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      AWS_SESSION_TOKEN: process.env.AWS_SESSION_TOKEN,
    };
    delete process.env.AWS_REGION;
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    delete process.env.AWS_SESSION_TOKEN;
    try {
      const gw = buildGatewayConfig({
        engine: 'pglite',
        aws_region: 'us-west-2',
        aws_access_key_id: 'AKIATEST123',
        aws_secret_access_key: 'secret123',
        aws_session_token: 'token456',
      });
      expect(gw.env.AWS_REGION).toBe('us-west-2');
      expect(gw.env.AWS_ACCESS_KEY_ID).toBe('AKIATEST123');
      expect(gw.env.AWS_SECRET_ACCESS_KEY).toBe('secret123');
      expect(gw.env.AWS_SESSION_TOKEN).toBe('token456');
    } finally {
      // Restore
      for (const [k, v] of Object.entries(saved)) {
        if (v !== undefined) process.env[k] = v;
        else delete process.env[k];
      }
    }
  });

  test('process.env.AWS_REGION flows through buildGatewayConfig', () => {
    // process.env is spread into the gateway env dict — process.env wins over config file
    const prev = process.env.AWS_REGION;
    try {
      process.env.AWS_REGION = 'eu-west-1';
      const gw = buildGatewayConfig({ engine: 'pglite' });
      expect(gw.env.AWS_REGION).toBe('eu-west-1');
    } finally {
      if (prev !== undefined) process.env.AWS_REGION = prev;
      else delete process.env.AWS_REGION;
    }
  });

  test('bedrock isAvailable returns true when config has aws_region', () => {
    resetGateway();
    const gw = buildGatewayConfig({
      engine: 'pglite',
      embedding_model: 'bedrock:amazon.titan-embed-text-v2:0',
      embedding_dimensions: 1536,
      aws_region: 'us-east-1',
    });
    configureGateway(gw);
    expect(isAvailable('embedding')).toBe(true);
  });
});
