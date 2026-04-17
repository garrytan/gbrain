import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { OpenAIProvider } from '../../src/core/embedding/providers/openai.ts';
import { OllamaProvider } from '../../src/core/embedding/providers/ollama.ts';
import { createProvider, resolveConfig, listProviders } from '../../src/core/embedding/factory.ts';

const mockCreate = mock(async (_args: any) => ({
  data: [{ index: 0, embedding: new Array(1536).fill(0.1) }],
}));

mock.module('openai', () => {
  class MockOpenAI {
    embeddings = { create: mockCreate };
    constructor(public config: any) {}
  }
  return {
    default: MockOpenAI,
    APIError: class APIError extends Error {
      constructor(public status: number, message: string, public headers?: any) {
        super(message);
      }
    },
  };
});

beforeEach(() => { mockCreate.mockClear(); });

afterEach(() => {
  delete process.env.EMBEDDING_PROVIDER;
  delete process.env.EMBEDDING_MODEL;
  delete process.env.EMBEDDING_DIMENSIONS;
  delete process.env.EMBEDDING_BASE_URL;
  delete process.env.OPENAI_BASE_URL;
});

describe('OpenAIProvider', () => {
  test('sends Matryoshka dimensions param for text-embedding-3-large', async () => {
    const p = new OpenAIProvider({ provider: 'openai' });
    expect(p.name).toBe('openai');
    expect(p.model).toBe('text-embedding-3-large');
    expect(p.dimensions).toBe(1536);
    await p.embed(['hello']);
    expect(mockCreate).toHaveBeenCalledWith({
      model: 'text-embedding-3-large',
      input: ['hello'],
      dimensions: 1536,
    });
  });

  test('omits dimensions param for non-text-embedding-3 models', async () => {
    const p = new OpenAIProvider({ provider: 'openai', model: 'text-embedding-ada-002', dimensions: 1536 });
    await p.embed(['hello']);
    const call = mockCreate.mock.calls[0][0];
    expect(call).not.toHaveProperty('dimensions');
    expect(call.model).toBe('text-embedding-ada-002');
  });

  test('rejects vectors of unexpected dimension', async () => {
    mockCreate.mockImplementationOnce(async () => ({
      data: [{ index: 0, embedding: new Array(768).fill(0.1) }],
    }));
    const p = new OpenAIProvider({ provider: 'openai', dimensions: 1536 });
    await expect(p.embed(['x'])).rejects.toThrow(/expected 1536-dim vector, got 768/);
  });
});

describe('OllamaProvider', () => {
  test('infers dimensions from known model registry', () => {
    const p = new OllamaProvider({ provider: 'ollama', model: 'nomic-embed-text' });
    expect(p.name).toBe('ollama');
    expect(p.model).toBe('nomic-embed-text');
    expect(p.dimensions).toBe(768);
  });

  test('throws when model is missing', () => {
    expect(() => new OllamaProvider({ provider: 'ollama' })).toThrow(/requires `model`/);
  });

  test('throws when dimensions cannot be inferred for unknown model', () => {
    expect(() => new OllamaProvider({ provider: 'ollama', model: 'mystery-model' })).toThrow(/cannot infer dimensions/);
  });

  test('omits dimensions param in API call', async () => {
    mockCreate.mockImplementationOnce(async () => ({
      data: [{ index: 0, embedding: new Array(768).fill(0.1) }],
    }));
    const p = new OllamaProvider({ provider: 'ollama', model: 'nomic-embed-text' });
    await p.embed(['hello']);
    const call = mockCreate.mock.calls[0][0];
    expect(call).not.toHaveProperty('dimensions');
    expect(call.model).toBe('nomic-embed-text');
  });

  test('uses default base URL http://localhost:11434/v1', () => {
    const p = new OllamaProvider({ provider: 'ollama', model: 'nomic-embed-text' });
    expect((p as any).client.config.baseURL).toBe('http://localhost:11434/v1');
  });

  test('rejects vectors of unexpected dimension', async () => {
    mockCreate.mockImplementationOnce(async () => ({
      data: [{ index: 0, embedding: new Array(1024).fill(0.1) }],
    }));
    const p = new OllamaProvider({ provider: 'ollama', model: 'nomic-embed-text' });
    await expect(p.embed(['x'])).rejects.toThrow(/expected 768-dim vector, got 1024/);
  });
});

describe('factory', () => {
  test('listProviders returns known names', () => {
    const names = listProviders();
    expect(names).toContain('openai');
    expect(names).toContain('ollama');
  });

  test('createProvider with explicit ollama config', () => {
    const p = createProvider({ provider: 'ollama', model: 'nomic-embed-text' });
    expect(p.name).toBe('ollama');
    expect(p.dimensions).toBe(768);
  });

  test('createProvider defaults to OpenAI when nothing specified', () => {
    const p = createProvider();
    expect(p.name).toBe('openai');
    expect(p.model).toBe('text-embedding-3-large');
    expect(p.dimensions).toBe(1536);
  });

  test('createProvider throws on unknown provider', () => {
    expect(() => createProvider({ provider: 'fictional' })).toThrow(/Unknown embedding provider/);
  });

  test('resolveConfig pulls from EMBEDDING_* env vars', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.EMBEDDING_MODEL = 'mxbai-embed-large';
    process.env.EMBEDDING_DIMENSIONS = '1024';
    process.env.EMBEDDING_BASE_URL = 'http://example.com/v1';
    const cfg = resolveConfig();
    expect(cfg).toMatchObject({
      provider: 'ollama',
      model: 'mxbai-embed-large',
      dimensions: 1024,
      baseUrl: 'http://example.com/v1',
    });
  });

  test('resolveConfig override beats env', () => {
    process.env.EMBEDDING_MODEL = 'env-model';
    const cfg = resolveConfig({ provider: 'openai', model: 'override-model' });
    expect(cfg.model).toBe('override-model');
  });
});
