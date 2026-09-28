import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, embed, embedQuery, getQueryInstruction, resetGateway } from '../src/core/ai/gateway.ts';

import { runEval } from '../src/core/search/eval.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const task = 'Given a web search query, retrieve relevant passages that answer the query';
const originalFetch = globalThis.fetch;
let requests: Array<Record<string, any>> = [];

function configure(model = 'ollama:qwen3-embedding:4b', instruction?: string) {
  configureGateway({
    embedding_model: model,
    embedding_dimensions: 1024,
    env: {
      OLLAMA_BASE_URL: 'http://127.0.0.1:11434/v1',
      ...(instruction === undefined ? {} : { GBRAIN_QUERY_INSTRUCT: instruction }),
    },
  });
}

beforeEach(() => {
  requests = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const request = new Request(input, init);
    expect(new URL(request.url).pathname).toBe('/v1/embeddings');
    const body = await request.json() as Record<string, any>;
    requests.push(body);
    return Response.json({ object: 'list', model: body.model,
      data: body.input.map((_: string, index: number) => ({ object: 'embedding', index,
        embedding: Array(body.dimensions ?? 1024).fill(0.01) })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
  }) as typeof fetch;
  configure();
});
afterEach(() => { globalThis.fetch = originalFetch; resetGateway(); });

describe('Qwen query instruction at the provider wire boundary', () => {
  test('query is instructed, documents stay raw, and Matryoshka width survives the SDK', async () => {
    const query = 'Where is the source document?';
    expect((await embedQuery(query)).length).toBe(1024);
    await embed([query]);
    await embed([query], { inputType: 'document' });
    expect(requests[0].input).toEqual([`Instruct: ${task}\nQuery: ${query}`]);
    expect(requests[0].dimensions).toBe(1024);
    expect(requests[1].input).toEqual([query]);
    expect(requests[2].input).toEqual([query]);
  });

  test.each(['qwen3-embedding:8b', 'Qwen/Qwen3-Embedding-4B', 'qwen3-embedding', 'qwen3-embedding-0.6b'])
    ('recognizes supported family spelling %s without altering the wire model ID', async model => {
      configure('ollama:' + model);
      await embedQuery('query');
      expect(requests[0].model).toBe(model);
      expect(requests[0].input[0]).toBe(`Instruct: ${task}\nQuery: query`);
    });

  test('non-Qwen model override does not inherit the default model instruction', async () => {
    await embedQuery('query', { embeddingModel: 'ollama:bge-m3' });
    expect(requests[0].input).toEqual(['query']);
  });

  test('Qwen override receives the instruction when the default model is different', async () => {
    configure('ollama:bge-m3');
    await embedQuery('query', { embeddingModel: 'ollama:qwen3-embedding:4b' });
    expect(requests[0].input).toEqual([`Instruct: ${task}\nQuery: query`]);
  });

  test('configured empty instruction preserves endpoints that already template queries', async () => {
    configure('ollama:qwen3-embedding:4b', '');
    await embedQuery('query');
    expect(requests[0].input).toEqual(['query']);
  });

  test('configured task applies to queries only', async () => {
    configure('ollama:qwen3-embedding:4b', 'Retrieve relevant technical documentation');
    await embedQuery('query');
    await embed(['document']);
    expect(requests[0].input).toEqual(['Instruct: Retrieve relevant technical documentation\nQuery: query']);
    expect(requests[1].input).toEqual(['document']);
  });

  test('ambient instruction changes cannot override the configured snapshot', async () => {
    const previous = process.env.GBRAIN_QUERY_INSTRUCT;
    try {
      process.env.GBRAIN_QUERY_INSTRUCT = 'Changed after configuration';
      await embedQuery('query');
      expect(requests[0].input).toEqual([`Instruct: ${task}\nQuery: query`]);
    } finally {
      if (previous === undefined) delete process.env.GBRAIN_QUERY_INSTRUCT;
      else process.env.GBRAIN_QUERY_INSTRUCT = previous;
    }
  });

  test('cache instruction follows configured defaults, overrides, and opt-out', () => {
    expect(getQueryInstruction()).toBe(task);
    expect(getQueryInstruction('')).toBe(task);
    expect(getQueryInstruction('ollama:bge-m3')).toBeUndefined();
    configure('ollama:bge-m3', 'Find a relevant passage');
    expect(getQueryInstruction()).toBeUndefined();
    expect(getQueryInstruction('ollama:qwen3-embedding:4b')).toBe('Find a relevant passage');
    configure('ollama:qwen3-embedding:4b', '');
    expect(getQueryInstruction()).toBeUndefined();
    resetGateway();
    expect(getQueryInstruction()).toBeUndefined();
  });

  test('vector-only evaluation uses the query embedding path', async () => {
    const engine = { searchVector: async (vector: Float32Array) => {
      expect(vector.length).toBe(1024);
      return [{ slug: 'relevant-page' }];
    } } as unknown as BrainEngine;
    await runEval(engine, [{ query: 'evaluation query', relevant: ['relevant-page'] }], { strategy: 'vector' });
    expect(requests[0].input).toEqual([`Instruct: ${task}\nQuery: evaluation query`]);
  });

  test('instruction survives the input cap and Unicode remains intact', async () => {
    await embedQuery('😀'.repeat(6000));
    const text = requests[0].input[0] as string;
    expect(text.startsWith(`Instruct: ${task}\nQuery: `)).toBe(true);
    expect(text.isWellFormed()).toBe(true);
    expect(text.length).toBeLessThanOrEqual(8000);
  });
});
