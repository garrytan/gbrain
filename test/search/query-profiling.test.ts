import { describe, expect, test } from 'bun:test';
import { trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import type { BrainEngine } from '../../src/core/engine.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';

import {
  classifyProfileError,
  profileOperation,
  profileStage,
  resetProfileProviderForTests,
  setProfileProviderForTests,
} from '../../src/core/search/profiling.ts';

function installMemoryProvider() {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  provider.register({ contextManager: new AsyncLocalStorageContextManager() });
  setProfileProviderForTests(provider);
  return { exporter, provider };
}

describe('query profiling', () => {
  test('creates a bounded operation and child stage hierarchy', async () => {
    const { exporter } = installMemoryProvider();

    await profileOperation('query', {
      brain_id: 'brain-123',
      operation: 'query',
      query: 'must never be exported',
    }, async () => profileStage('keyword', {
      outcome: 'success',
      provider_url: 'https://secret.example.test',
      result_count: 2,
    }, async () => ['ok']));

    const spans = exporter.getFinishedSpans();
    expect(spans.map((span) => span.name)).toEqual([
      'gbrain.search.keyword',
      'gbrain.operation.query',
    ]);
    expect(spans[0]?.parentSpanContext?.spanId).toBe(spans[1]?.spanContext().spanId);
    expect(spans[0]?.attributes).toMatchObject({ outcome: 'success', result_count: 2 });
    expect(spans[0]?.attributes['langfuse.observation.input']).toBe(
      JSON.stringify({ outcome: 'success', result_count: 2 }),
    );
    expect(spans[0]?.attributes['langfuse.observation.output']).toBe(
      JSON.stringify({ result_count: 1, result_type: 'array' }),
    );
    const envelope = spans.map((span) => ({ name: span.name, attributes: span.attributes, events: span.events }));
    expect(JSON.stringify(envelope)).not.toContain('must never be exported');
    expect(JSON.stringify(envelope)).not.toContain('secret.example.test');

    await resetProfileProviderForTests();
  });

  test('classifies failures without exporting raw error bodies', async () => {
    const { exporter } = installMemoryProvider();

    await expect(profileStage('vector', { timeout_ms: 6000 }, async () => {
      throw new Error('authorization=super-secret raw provider body');
    })).rejects.toThrow('authorization=super-secret raw provider body');

    const span = exporter.getFinishedSpans()[0];
    expect(span?.attributes).toMatchObject({ outcome: 'error', error_class: 'error' });
    expect(JSON.stringify({
      name: span?.name,
      attributes: span?.attributes,
      events: span?.events,
      links: span?.links,
      status: span?.status,
    })).not.toContain('super-secret');
    expect(classifyProfileError(new Error('deadline exceeded'))).toBe('timeout');

    await resetProfileProviderForTests();
  });

  test('is a no-op when no provider is configured', async () => {
    trace.disable();
    expect(await profileOperation('search', {}, async () => 42)).toBe(42);
    expect(await profileStage('serialize', {}, async () => 'result')).toBe('result');
  });

  test('does not make an exporter failure part of the operation result', async () => {
    const exporter = {
      export(_spans: unknown, callback: (result: { code: number; error?: Error }) => void) {
        callback({ code: 1, error: new Error('exporter unavailable') });
      },
      shutdown: async () => undefined,
      forceFlush: async () => undefined,
    };
    const provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter as never)],
    });
    provider.register({ contextManager: new AsyncLocalStorageContextManager() });
    setProfileProviderForTests(provider);

    await expect(profileOperation('search', {}, async () => 'normal result')).resolves.toBe('normal result');

    await resetProfileProviderForTests();
  });

  test('uses the closed semantic stage vocabulary for hit, skip, and fallback paths', async () => {
    const { exporter } = installMemoryProvider();
    const stages = [
      'cache_embedding', 'cache_lookup', 'config_cache', 'config_embedding', 'config_mode',
      'expansion', 'keyword', 'query_embedding',
      'vector', 'relational', 'fusion', 'post_fusion', 'rerank', 'alias_hop',
      'return_policy', 'serialize', 'config_keyword_only', 'hot_memory',
    ];

    for (const stage of stages) {
      await profileStage(stage, {
        decision: stage === 'rerank' ? 'skip' : 'run',
        fallback: stage === 'vector' ? 'keyword' : undefined,
      }, async () => undefined);
    }

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(
      stages.map((stage) => `gbrain.search.${stage}`),
    );
    await resetProfileProviderForTests();
  });

  test('profiles actual dispatch serialization and the hot-memory hook', async () => {
    const { exporter } = installMemoryProvider();
    const engine = {
      async getStats() {
        return { pages: 1, chunks: 1 };
      },
    } as unknown as BrainEngine;

    const result = await dispatchToolCall(engine, 'get_stats', {}, {
      metaHook: async () => ({ injected: true }),
    });

    expect(result.content[0]?.text).toContain('"pages": 1');
    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual([
      'gbrain.search.serialize',
      'gbrain.search.hot_memory',
    ]);
    await resetProfileProviderForTests();
  });

  test('keeps normalized results and invocation counts identical when profiling is enabled', async () => {
    const runFixture = async () => {
      let providerCalls = 0;
      let databaseCalls = 0;
      const result = await profileOperation('search', {}, async () => {
        providerCalls += 1;
        databaseCalls += 1;
        return { items: [{ id: 'page-1', score: 0.9 }], limit: 1, order: ['page-1'] };
      });
      return { databaseCalls, providerCalls, result };
    };

    trace.disable();
    const disabled = await runFixture();
    installMemoryProvider();
    const enabled = await runFixture();

    expect(enabled).toEqual(disabled);
    await resetProfileProviderForTests();
  });

  test('keeps content, credentials, URLs, and raw bodies out of exported envelopes', async () => {
    const { exporter } = installMemoryProvider();
    await profileOperation('query', {
      query_text: 'private query',
      content: 'private page content',
      embedding: '[0.1,0.2]',
      payload: 'provider payload',
      credentials: 'secret',
      token: 'token',
      authorization: 'Bearer secret',
      database_url: 'postgres://secret',
      provider_url: 'https://provider.secret',
      request_body: 'raw request',
      response_body: 'raw response',
    }, async () => undefined);

    const envelope = exporter.getFinishedSpans().map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
    }));
    const serialized = JSON.stringify(envelope);
    for (const secret of ['private query', 'private page content', '[0.1,0.2]', 'provider payload', 'secret', 'postgres://secret', 'raw request']) {
      expect(serialized).not.toContain(secret);
    }
    await resetProfileProviderForTests();
  });
});
