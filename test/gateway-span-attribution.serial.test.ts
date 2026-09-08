/**
 * End-to-end span content: does the caller label + embed token count actually
 * reach an exported span?
 *
 * The sibling unit test (gateway-caller-attribution.test.ts) pins the helper
 * functions in isolation. That is not enough: `withSpan` returns a no-op
 * handle whenever tracing is disabled, which is the default everywhere except
 * production — so a helper can be perfectly correct while the wiring between
 * it and the span never runs. These tests install a real in-memory tracer and
 * assert on the finished span.
 *
 * Serial because it mutates two pieces of module-level state (the global
 * tracer and the gateway config) that would otherwise bleed across files.
 */
import { describe, test, expect, afterEach } from 'bun:test';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { __setTracerForTests } from '../src/core/tracing.ts';
import {
  configureGateway,
  resetGateway,
  embed,
  expand,
  __setEmbedTransportForTests,
  __setGenerateTextTransportForTests,
} from '../src/core/ai/gateway.ts';
import { withCallLabel } from '../src/core/call-label.ts';

const DIMS = 1280;

function installTracer(): InMemorySpanExporter {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  __setTracerForTests(provider.getTracer('test'));
  return exporter;
}

function configureZE() {
  configureGateway({
    embedding_model: 'zeroentropyai:zembed-1',
    embedding_dimensions: DIMS,
    env: { ZEROENTROPY_API_KEY: 'sk-fake' },
  });
}

/** Fake transport result; `tokens` omitted models a provider reporting no usage. */
function fakeEmbeddings(count: number, tokens?: number) {
  return {
    embeddings: Array.from({ length: count }, () => Array.from({ length: DIMS }, () => 0.1)),
    ...(tokens === undefined ? {} : { usage: { tokens } }),
  };
}

function embedSpan(exporter: InMemorySpanExporter): ReadableSpan {
  const span = exporter.getFinishedSpans().find(s => s.name === 'gateway.embed');
  if (!span) throw new Error(`no gateway.embed span; got: ${exporter.getFinishedSpans().map(s => s.name).join(', ')}`);
  return span;
}

/**
 * Groq is openai-compatible and does not declare `supports_structured_outputs`,
 * so expansion takes the generateText fallback — the one sub-path reachable
 * through an existing transport seam. The span write it exercises is shared by
 * every sub-path (it lives in `expand()`'s wrapper, not in the branches).
 */
function configureGroqExpansion() {
  configureGateway({
    expansion_model: 'groq:llama-3.1-8b-instant',
    env: { GROQ_API_KEY: 'sk-fake' },
  });
}

function expandSpan(exporter: InMemorySpanExporter): ReadableSpan {
  const span = exporter.getFinishedSpans().find(s => s.name === 'gateway.expand');
  if (!span) throw new Error(`no gateway.expand span; got: ${exporter.getFinishedSpans().map(s => s.name).join(', ')}`);
  return span;
}

afterEach(() => {
  __setEmbedTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  __setTracerForTests(null);
  resetGateway();
});

describe('caller attribution reaches the exported span', () => {
  test('a withCallLabel region stamps gbrain.caller on the embed span', async () => {
    const exporter = installTracer();
    configureZE();
    __setEmbedTransportForTests((async (args: any) => fakeEmbeddings(args.values.length)) as any);

    await withCallLabel('dream.synthesize', () => embed(['a page being indexed']));

    expect(embedSpan(exporter).attributes['gbrain.caller']).toBe('dream.synthesize');
  });

  test('no caller attribute outside any labeled region', async () => {
    const exporter = installTracer();
    configureZE();
    __setEmbedTransportForTests((async (args: any) => fakeEmbeddings(args.values.length)) as any);

    await embed(['unattributed write']);

    expect(embedSpan(exporter).attributes['gbrain.caller']).toBeUndefined();
  });
});

describe('embed token counts on the span', () => {
  test('provider-reported usage is recorded as measured', async () => {
    const exporter = installTracer();
    configureZE();
    __setEmbedTransportForTests((async (args: any) => fakeEmbeddings(args.values.length, 4242)) as any);

    await embed(['some text to embed']);

    const attrs = embedSpan(exporter).attributes;
    expect(attrs['embedding.token_count_source']).toBe('provider');
    expect(attrs['llm.token_count.prompt']).toBe(4242);
    expect(attrs['llm.token_count.total']).toBe(4242);
  });

  test('a provider reporting no usage is marked estimated, not silently measured', async () => {
    const exporter = installTracer();
    configureZE();
    __setEmbedTransportForTests((async (args: any) => fakeEmbeddings(args.values.length)) as any);

    await embed(['some text to embed']);

    const attrs = embedSpan(exporter).attributes;
    expect(attrs['embedding.token_count_source']).toBe('estimated');
    // Reporting a token count here would dress an estimate up as a measurement.
    expect(attrs['llm.token_count.prompt']).toBeUndefined();
  });

  test('usage sums across sub-batches rather than keeping only the last', async () => {
    const exporter = installTracer();
    configureZE();
    // ZE declares max_batch_tokens, so a large input pre-splits into several
    // transport calls; each reports its own usage.
    let calls = 0;
    __setEmbedTransportForTests((async (args: any) => {
      calls++;
      return fakeEmbeddings(args.values.length, 100);
    }) as any);

    const big = Array.from({ length: 40 }, () => 'x'.repeat(20_000));
    await embed(big);

    expect(calls).toBeGreaterThan(1);
    expect(embedSpan(exporter).attributes['llm.token_count.prompt']).toBe(100 * calls);
  });
});

describe('expand token counts on the span', () => {
  const REWRITES = JSON.stringify({ queries: ['rewrite one', 'rewrite two'] });

  test('provider-reported usage lands on the span', async () => {
    const exporter = installTracer();
    configureGroqExpansion();
    __setGenerateTextTransportForTests((async () => ({
      text: REWRITES,
      usage: { inputTokens: 120, outputTokens: 45, totalTokens: 165 },
    })) as any);

    const out = await expand('who invested in widget-co');

    expect(out.length).toBeGreaterThan(1);
    const attrs = expandSpan(exporter).attributes;
    expect(attrs['llm.token_count.prompt']).toBe(120);
    expect(attrs['llm.token_count.completion']).toBe(45);
    expect(attrs['llm.token_count.total']).toBe(165);
  });

  test('the resolved recipe:model replaces the config alias the span opened with', async () => {
    const exporter = installTracer();
    configureGroqExpansion();
    __setGenerateTextTransportForTests((async () => ({
      text: REWRITES,
      usage: { inputTokens: 10, outputTokens: 5 },
    })) as any);

    await expand('a query');

    // Cost lookup keys on the model id, so expand has to spell it the way chat
    // does or one model's spend splits across two group-by buckets.
    expect(expandSpan(exporter).attributes['llm.model_name']).toBe('groq:llama-3.1-8b-instant');
  });

  test('a provider reporting no usage stamps no token count (no measured zero)', async () => {
    const exporter = installTracer();
    configureGroqExpansion();
    __setGenerateTextTransportForTests((async () => ({ text: REWRITES })) as any);

    await expand('a query');

    const attrs = expandSpan(exporter).attributes;
    expect(attrs['llm.token_count.prompt']).toBeUndefined();
    expect(attrs['llm.token_count.total']).toBeUndefined();
    // The span still exists and still reports the model — absent usage is not a
    // reason to lose the call itself.
    expect(attrs['llm.model_name']).toBe('groq:llama-3.1-8b-instant');
  });

  test('expansion failure still exports a span, with the original query as the only variant', async () => {
    const exporter = installTracer();
    configureGroqExpansion();
    __setGenerateTextTransportForTests((async () => { throw new Error('provider down'); }) as any);

    // Expansion is best-effort: search must keep working, so no throw escapes.
    expect(await expand('a query')).toEqual(['a query']);

    const attrs = expandSpan(exporter).attributes;
    expect(attrs['expansion.variant_count']).toBe(1);
    expect(attrs['llm.token_count.prompt']).toBeUndefined();
  });

  test('caller attribution reaches the expand span too', async () => {
    const exporter = installTracer();
    configureGroqExpansion();
    __setGenerateTextTransportForTests((async () => ({
      text: REWRITES,
      usage: { inputTokens: 1, outputTokens: 1 },
    })) as any);

    await withCallLabel('query', () => expand('a query'));

    expect(expandSpan(exporter).attributes['gbrain.caller']).toBe('query');
  });
});
