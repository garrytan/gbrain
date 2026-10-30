import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { embed as aiEmbed } from 'ai';
import { createVertex } from '@ai-sdk/google-vertex';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { type GBrainConfig, KNOWN_CONFIG_KEYS, loadConfig } from '../../src/core/config.ts';
import { mergedProviderEnv } from '../../src/core/ai/provider-env.ts';
import { dimsProviderOptions } from '../../src/core/ai/dims.ts';
import { withAIInvocationGuard, type AIInvocation } from '../../src/core/ai/invocation-guard.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { GcloudOAuth2Client } from '../../src/core/ai/vertex-auth.ts';
import { runConfig } from '../../src/commands/config.ts';
import {
  __setEmbedTransportForTests,
  configureGateway,
  embed,
  embedQuery,
  isAvailable,
  resetGateway,
} from '../../src/core/ai/gateway.ts';

const vertexConfig = {
  embedding_model: 'vertex:gemini-embedding-001',
  embedding_dimensions: 768,
  env: {
    GOOGLE_VERTEX_PROJECT: 'unit-project',
    GOOGLE_VERTEX_LOCATION: 'us-central1',
    GOOGLE_VERTEX_ACCOUNT: 'unit@example.test',
    GOOGLE_VERTEX_GCLOUD_PATH: process.execPath,
  },
};

const vertexEmbedding2Config = {
  ...vertexConfig,
  embedding_model: 'vertex:gemini-embedding-2',
};

async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete process.env[key];
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

beforeEach(() => resetGateway());
afterEach(() => {
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('Vertex embedding recipe', () => {
  test('registers the fixed Gemini recipe and explicit config keys', () => {
    const recipe = getRecipe('vertex')!;
    expect(recipe.implementation).toBe('native-vertex');
    expect(recipe.touchpoints.embedding).toMatchObject({
      models: ['gemini-embedding-001', 'gemini-embedding-2'],
      default_dims: 768,
      max_batch_items: 1,
      max_input_chars: 8000,
      max_input_tokens: { 'gemini-embedding-001': 2048, 'gemini-embedding-2': 8192 },
      cost_per_1m_tokens_usd: 0.15,
    });
    expect(KNOWN_CONFIG_KEYS).toContain('google_vertex_project');
    expect(KNOWN_CONFIG_KEYS).toContain('google_vertex_location');
    expect(KNOWN_CONFIG_KEYS).toContain('google_vertex_account');
    expect(KNOWN_CONFIG_KEYS).toContain('google_vertex_gcloud_path');
  });

  test('folds only non-secret project and location into the immutable gateway environment', () => {
    const env = mergedProviderEnv({
      google_vertex_project: 'config-project',
      google_vertex_location: 'us-central1',
      google_vertex_account: 'configured@example.test',
      google_vertex_gcloud_path: process.execPath,
    } as GBrainConfig, {});
    expect(env).toEqual({
      GOOGLE_VERTEX_PROJECT: 'config-project',
      GOOGLE_VERTEX_LOCATION: 'us-central1',
      GOOGLE_VERTEX_ACCOUNT: 'configured@example.test',
      GOOGLE_VERTEX_GCLOUD_PATH: process.execPath,
    });
  });

  test('config set persists every Vertex setting to the file plane and reloads the gateway snapshot', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-vertex-config-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const noEngine = {} as any;
        await runConfig(noEngine, ['set', 'google_vertex_project', 'config-project']);
        await runConfig(noEngine, ['set', 'google_vertex_location', 'us-central1']);
        await runConfig(noEngine, ['set', 'google_vertex_account', 'configured@example.test']);
        await runConfig(noEngine, ['set', 'google_vertex_gcloud_path', process.execPath]);

        const cfg = loadConfig()!;
        expect(buildGatewayConfig(cfg).env).toMatchObject({
          GOOGLE_VERTEX_PROJECT: 'config-project',
          GOOGLE_VERTEX_LOCATION: 'us-central1',
          GOOGLE_VERTEX_ACCOUNT: 'configured@example.test',
          GOOGLE_VERTEX_GCLOUD_PATH: process.execPath,
        });
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('uses explicit Vertex dimensions, retrieval task types, and no provider truncation', () => {
    expect(dimsProviderOptions('native-vertex', 'gemini-embedding-001', 768, 'document'))
      .toEqual({ vertex: {
        outputDimensionality: 768,
        taskType: 'RETRIEVAL_DOCUMENT',
        autoTruncate: false,
      } });
    expect(dimsProviderOptions('native-vertex', 'gemini-embedding-001', 768, 'query'))
      .toEqual({ vertex: {
        outputDimensionality: 768,
        taskType: 'RETRIEVAL_QUERY',
        autoTruncate: false,
      } });
  });

  test('uses Embedding 2 dimensions and no provider task options', () => {
    expect(dimsProviderOptions('native-vertex', 'gemini-embedding-2', 768, 'document'))
      .toEqual({ vertex: { outputDimensionality: 768, autoTruncate: false } });
    expect(dimsProviderOptions('native-vertex', 'gemini-embedding-2', 768, 'query'))
      .toEqual({ vertex: { outputDimensionality: 768, autoTruncate: false } });
  });

  test('uses the SDK Vertex endpoint, mock auth, dimensions, and document task', async () => {
    let authCalls = 0;
    let request: { url: string; headers: Headers; body: Record<string, unknown> } | undefined;
    const provider = createVertex({
      project: 'unit-project',
      location: 'us-central1',
      googleAuthOptions: {
        authClient: new GcloudOAuth2Client(process.execPath, 'unit@example.test', async (file, args, options) => {
          authCalls += 1;
          expect(file).toBe(process.execPath);
          expect(args).toEqual(['auth', 'print-access-token', '--account', 'unit@example.test']);
          expect(options).toEqual({ timeout: 30_000, maxBuffer: 4096, encoding: 'utf8', windowsHide: true });
          return { stdout: 'unit-access-token\n', stderr: '' };
        }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        request = {
          url: String(input),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        };
        return new Response(JSON.stringify({
          predictions: [{ embeddings: { values: new Array(768).fill(0.125), statistics: { token_count: 2 } } }],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });

    const result = await aiEmbed({
      model: provider.embeddingModel('gemini-embedding-001'),
      value: 'document body',
      providerOptions: dimsProviderOptions('native-vertex', 'gemini-embedding-001', 768, 'document'),
    });

    expect(result.embedding).toHaveLength(768);
    expect(authCalls).toBe(1);
    expect(request?.url).toBe(
      'https://us-central1-aiplatform.googleapis.com/v1beta1/projects/unit-project/locations/us-central1/publishers/google/models/gemini-embedding-001:predict',
    );
    expect(request?.headers.get('authorization')).toBe('Bearer unit-access-token');
    expect(request?.body).toEqual({
      instances: [{ content: 'document body', task_type: 'RETRIEVAL_DOCUMENT', title: undefined }],
      parameters: { outputDimensionality: 768, autoTruncate: false },
    });
  });

  test('uses the SDK embedContent body for Embedding 2 document and query text', async () => {
    let authCalls = 0;
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = createVertex({
      project: 'unit-project',
      location: 'global',
      googleAuthOptions: {
        authClient: new GcloudOAuth2Client(process.execPath, 'unit@example.test', async () => {
          authCalls += 1;
          return { stdout: 'unit-access-token\n', stderr: '' };
        }),
      },
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return new Response(JSON.stringify({
          embedding: { values: new Array(768).fill(0.125) },
          usageMetadata: { promptTokenCount: 2 },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });

    for (const value of ['title: none | text: document body', 'task: search result | query: query body']) {
      const result = await aiEmbed({
        model: provider.embeddingModel('gemini-embedding-2'),
        value,
        providerOptions: dimsProviderOptions('native-vertex', 'gemini-embedding-2', 768, 'query'),
      });
      expect(result.embedding).toHaveLength(768);
    }

    expect(authCalls).toBe(2);
    expect(requests).toEqual([
      {
        url: 'https://aiplatform.googleapis.com/v1beta1/projects/unit-project/locations/global/publishers/google/models/gemini-embedding-2:embedContent',
        body: {
          content: { parts: [{ text: 'title: none | text: document body' }] },
          embedContentConfig: { outputDimensionality: 768, autoTruncate: false },
        },
      },
      {
        url: 'https://aiplatform.googleapis.com/v1beta1/projects/unit-project/locations/global/publishers/google/models/gemini-embedding-2:embedContent',
        body: {
          content: { parts: [{ text: 'task: search result | query: query body' }] },
          embedContentConfig: { outputDimensionality: 768, autoTruncate: false },
        },
      },
    ]);
  });

  test('routes document and query calls through the Vertex options without a fallback', async () => {
    const calls: Array<{ modelId: string; provider: string; options: Record<string, unknown> }> = [];
    configureGateway(vertexConfig);
    __setEmbedTransportForTests(async ({ model, values, providerOptions }: any) => {
      calls.push({ modelId: model.modelId, provider: model.provider, options: providerOptions });
      return { embeddings: values.map(() => new Array(768).fill(0.25)) } as any;
    });

    await embed(['document']);
    await embedQuery('query');

    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      modelId: 'gemini-embedding-001',
      options: { vertex: { taskType: 'RETRIEVAL_DOCUMENT', outputDimensionality: 768, autoTruncate: false } },
    });
    expect(calls[1]).toMatchObject({
      modelId: 'gemini-embedding-001',
      options: { vertex: { taskType: 'RETRIEVAL_QUERY', outputDimensionality: 768, autoTruncate: false } },
    });
    expect(calls.every((call) => call.provider.includes('vertex'))).toBe(true);
  });

  test('formats Embedding 2 document and query text once without taskType', async () => {
    const calls: Array<{ modelId: string; values: string[]; options: Record<string, unknown> }> = [];
    configureGateway(vertexEmbedding2Config);
    __setEmbedTransportForTests(async ({ model, values, providerOptions }: any) => {
      calls.push({ modelId: model.modelId, values, options: providerOptions });
      return { embeddings: values.map(() => new Array(768).fill(0.25)) } as any;
    });

    await embed(['title: Existing title\nDocument body']);
    await embedQuery('where is the document?');

    expect(calls).toEqual([
      {
        modelId: 'gemini-embedding-2',
        values: ['title: none | text: title: Existing title\nDocument body'],
        options: { vertex: { outputDimensionality: 768, autoTruncate: false } },
      },
      {
        modelId: 'gemini-embedding-2',
        values: ['task: search result | query: where is the document?'],
        options: { vertex: { outputDimensionality: 768, autoTruncate: false } },
      },
    ]);
  });

  test('bounds formatted Vertex input admission by bytes and the model ceiling', async () => {
    const calls: AIInvocation[] = [];
    configureGateway(vertexEmbedding2Config);
    __setEmbedTransportForTests(async ({ values }: any) => ({
      embeddings: values.map(() => new Array(768).fill(0.25)),
    }) as any);

    await withAIInvocationGuard(async call => {
      calls.push(call);
      return { settle: async () => {} };
    }, () => embed(['document', '😀'.repeat(3990)]));

    expect(calls).toEqual([expect.objectContaining({
      operation: 'gateway.embed',
      kind: 'embedding',
      model: 'vertex:gemini-embedding-2',
      maxInputTokens: 28,
      maxOutputTokens: 0,
    }), expect.objectContaining({
      operation: 'gateway.embed',
      kind: 'embedding',
      model: 'vertex:gemini-embedding-2',
      maxInputTokens: 8192,
      maxOutputTokens: 0,
    })]);
  });

  test('fails closed when either explicit Vertex configuration value is missing', async () => {
    configureGateway({ ...vertexConfig, env: { GOOGLE_VERTEX_PROJECT: 'unit-project' } });
    expect(isAvailable('embedding')).toBe(false);
    await expect(embed(['document'])).rejects.toThrow('GOOGLE_VERTEX_PROJECT, GOOGLE_VERTEX_LOCATION, GOOGLE_VERTEX_ACCOUNT and GOOGLE_VERTEX_GCLOUD_PATH');
  });

  test('rejects an ambient Vertex API key before constructing a provider or calling the transport', async () => {
    let calls = 0;
    configureGateway({ ...vertexConfig, env: { ...vertexConfig.env, GOOGLE_VERTEX_API_KEY: 'ambient-key' } });
    __setEmbedTransportForTests(async () => {
      calls += 1;
      return { embeddings: [new Array(768).fill(0.25)] } as any;
    });
    await expect(embed(['document'])).rejects.toThrow('refuses GOOGLE_VERTEX_API_KEY');
    expect(calls).toBe(0);
  });

  test('rejects a process ambient Vertex API key before constructing a provider or calling the transport', async () => {
    let calls = 0;
    await withEnv({ GOOGLE_VERTEX_API_KEY: 'ambient-key' }, async () => {
      configureGateway(vertexConfig);
      __setEmbedTransportForTests(async () => {
        calls += 1;
        return { embeddings: [new Array(768).fill(0.25)] } as any;
      });
      await expect(embed(['document'])).rejects.toThrow('refuses GOOGLE_VERTEX_API_KEY');
    });
    expect(calls).toBe(0);
  });

  test('gcloud auth coalesces only concurrent requests and clears after success or failure', async () => {
    let calls = 0;
    let fail = false;
    const client = new GcloudOAuth2Client(process.execPath, 'unit@example.test', async () => {
      calls += 1;
      if (fail) throw new Error('private runner detail');
      await Promise.resolve();
      return { stdout: `access-token-${calls}\n`, stderr: '' };
    });
    await expect(Promise.all([client.getAccessToken(), client.getAccessToken()]))
      .resolves.toEqual([{ token: 'access-token-1' }, { token: 'access-token-1' }]);
    await expect(client.getAccessToken()).resolves.toEqual({ token: 'access-token-2' });
    fail = true;
    await expect(client.getAccessToken()).rejects.toThrow('Vertex gcloud access-token request failed.');
    fail = false;
    await expect(client.getAccessToken()).resolves.toEqual({ token: 'access-token-4' });
    expect(calls).toBe(4);
  });

  test.each(['', 'first-token\nsecond-token\n', `${'x'.repeat(4097)}\n`])(
    'rejects invalid gcloud token output without exposing it',
    async (stdout) => {
      const client = new GcloudOAuth2Client(process.execPath, 'unit@example.test', async () => ({ stdout, stderr: 'private stderr' }));
      await expect(client.getAccessToken()).rejects.toThrow('Vertex gcloud access-token response was invalid.');
    },
  );

  test('sanitizes gcloud execution errors and validates its explicit executable and account', async () => {
    const client = new GcloudOAuth2Client(process.execPath, 'unit@example.test', async () => {
      throw new Error('sensitive gcloud failure');
    });
    await expect(client.getAccessToken()).rejects.toThrow('Vertex gcloud access-token request failed.');
    expect(() => new GcloudOAuth2Client('gcloud', 'unit@example.test')).toThrow('existing executable absolute file');
    expect(() => new GcloudOAuth2Client(process.execPath, 'not-an-account')).toThrow('explicit email address');
  });

  test('rejects wrong-width vectors from the SDK transport', async () => {
    configureGateway(vertexConfig);
    __setEmbedTransportForTests(async ({ values }: any) => ({
      embeddings: values.map(() => new Array(767).fill(0.25)),
    }) as any);
    await expect(embed(['document'])).rejects.toThrow(/dimension|767|768/i);
  });

  test('preserves gemini-embedding-001 oversize rejection before transport', async () => {
    let calls = 0;
    configureGateway(vertexConfig);
    __setEmbedTransportForTests(async () => {
      calls += 1;
      return { embeddings: [new Array(768).fill(0.25)] } as any;
    });

    await expect(embed(['x'.repeat(8001)])).rejects.toThrow('exceeds 8000 characters');
    expect(calls).toBe(0);
  });

  test('rejects oversize formatted Embedding 2 inputs before transport', async () => {
    const values: string[][] = [];
    configureGateway(vertexEmbedding2Config);
    __setEmbedTransportForTests(async ({ values: sent }: any) => {
      values.push(sent);
      return { embeddings: sent.map(() => new Array(768).fill(0.25)) } as any;
    });

    await embed(['x'.repeat(7980)]);
    await embedQuery('x'.repeat(7971));
    await expect(embed(['x'.repeat(7981)])).rejects.toThrow('exceeds 8000 characters');
    await expect(embedQuery('x'.repeat(7972))).rejects.toThrow('exceeds 8000 characters');

    expect(values).toHaveLength(2);
    expect(values.map(([value]) => value.length)).toEqual([8000, 8000]);
  });
});
