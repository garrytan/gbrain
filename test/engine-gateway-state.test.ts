/**
 * GBRA-283 B3a (#8499 item 2): the gateway's adaptive memory belongs to the engine whose call taught it. The batch
 * shrink factor, the once-per-model no_key rerank audit row and the structured-output rejection memory are per engine
 * for engines opened from settings (the process keeps its own), and an engine's query-embedding cache entries go
 * when it disconnects. Every provider is a transport stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  __getShrinkStateForTests, __setEmbedTransportForTests, __setGenerateObjectTransportForTests, __setGenerateTextTransportForTests,
  configureGateway, embed, embedQuery, expand, rerank, resetGateway,
} from '../src/core/ai/gateway.ts';
import { __queryEmbedCacheKeysForTests } from '../src/core/ai/query-embed-cache.ts';
import { readRecentRerankFailures } from '../src/core/rerank-audit.ts';
import { openEngine, withEngineScope, withLocalScope, type EngineSettings } from '../src/core/engine-open.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const key = (label: string) => `sk-${label}-${randomBytes(12).toString('hex')}`;
const open = (ai: EngineSettings['ai'], embedding = { model: 'voyage:voyage-3-large', dimensions: 1024 }) =>
  openEngine({ embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() }, embedding, ai });
const closeAll = (...engines: BrainEngine[]) => Promise.all(engines.map(engine => engine.disconnect()));
const vectors = (values: string[], dims: number) => ({ embeddings: values.map(() => Array.from({ length: dims }, (_, i) => (i % 5) + 1)), usage: { tokens: 1 } });
const TOKEN_LIMIT = new Error("Request to model 'voyage-3-large' failed. The max allowed tokens per submitted batch is 120000.");

afterEach(() => {
  __setEmbedTransportForTests(null);
  __setGenerateObjectTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

describe('per-engine adaptive gateway state', () => {
  test('a batch shrink learned in one engine\'s scope stays with that engine', async () => {
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      if (values.length === 4) throw TOKEN_LIMIT;
      return vectors(values, 1024);
    }) as any);
    configureGateway({ embedding_model: 'voyage:voyage-3-large', embedding_dimensions: 1024, env: { VOYAGE_API_KEY: key('process') } });
    const a = await open({ providers: { voyage: { apiKey: key('a') } } });
    const b = await open({ providers: { voyage: { apiKey: key('b') } } });
    try {
      await withEngineScope(a, () => embed(['a', 'b', 'c', 'd']));
      expect(withEngineScope(a, () => __getShrinkStateForTests('voyage'))?.factor).toBe(0.25);
      expect(withEngineScope(b, () => __getShrinkStateForTests('voyage'))).toBeUndefined();
      expect(withLocalScope(() => __getShrinkStateForTests('voyage'))).toBeUndefined();
    } finally {
      await closeAll(a, b);
    }
  }, 60_000);

  test('a structured-output rejection on one engine does not switch another engine to the text path', async () => {
    const objectCalls: string[] = [];
    __setGenerateObjectTransportForTests((async () => {
      objectCalls.push('object');
      throw new Error('This server does not support response_format json_schema');
    }) as any);
    __setGenerateTextTransportForTests((async () => ({ content: [{ type: 'text', text: '{"queries":["alternative"]}' }], text: '{"queries":["alternative"]}', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } })) as any);
    const ai = (): EngineSettings['ai'] => ({ providers: { ollama: { baseUrl: 'http://127.0.0.1:11434/v1' } }, models: { expansion: 'ollama:qwen2.5-coder:14b' } });
    const a = await open(ai());
    const b = await open(ai());
    try {
      await withEngineScope(a, () => expand('first question'));
      await withEngineScope(a, () => expand('second question'));
      expect(objectCalls).toEqual(['object']);
      await withEngineScope(b, () => expand('first question on b'));
      expect(objectCalls).toEqual(['object', 'object']);
    } finally {
      await closeAll(a, b);
    }
  }, 60_000);

  test('each engine writes its own once-per-model no_key rerank audit row', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-gateway-state-'));
    await withEnv({ GBRAIN_HOME: home, GBRAIN_AUDIT_DIR: undefined }, async () => {
      const ai = (): EngineSettings['ai'] => ({ providers: { voyage: { baseUrl: 'https://rerank-a.example/v1' } }, models: { reranker: 'voyage:rerank-3-lite' } });
      const a = await open(ai());
      const b = await open(ai());
      const noKeyRows = () => readRecentRerankFailures().filter(row => row.reason === 'no_key').length;
      try {
        const attempt = (engine: BrainEngine) => withEngineScope(engine, () => rerank({ query: 'q', documents: ['one'] }).catch(error => error.reason));
        expect(await attempt(a)).toBe('no_key');
        expect(await attempt(a)).toBe('no_key');
        expect(noKeyRows()).toBe(1);
        expect(await attempt(b)).toBe('no_key');
        expect(noKeyRows()).toBe(2);
      } finally {
        await closeAll(a, b);
      }
    });
  }, 60_000);

  test('an engine\'s query-embedding cache entries are dropped when it disconnects', async () => {
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => vectors(values, 1024)) as any);
    const a = await open({ providers: { voyage: { apiKey: key('a') } } });
    const b = await open({ providers: { voyage: { apiKey: key('b') } } });
    try {
      const before = __queryEmbedCacheKeysForTests().length;
      await withEngineScope(a, () => embedQuery('a question'));
      await withEngineScope(a, () => embedQuery('another question'));
      await withEngineScope(b, () => embedQuery('a question'));
      expect(__queryEmbedCacheKeysForTests().length).toBe(before + 3);
      await a.disconnect();
      expect(__queryEmbedCacheKeysForTests().length).toBe(before + 1);
    } finally {
      await closeAll(a, b);
    }
  }, 60_000);
});
