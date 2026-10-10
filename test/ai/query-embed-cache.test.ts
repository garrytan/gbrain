/**
 * Per-process query-embedding cache in gateway.embedQuery.
 *
 * A counting fake transport stands in for the provider ($0, no keys). Pins:
 *  - a repeat query makes 0 provider calls and returns an equal, independent copy;
 *  - inputs that resolve to the same provider request share an entry
 *    (default model/dims spelled out explicitly);
 *  - a different model, dimensions, query prefix or base URL misses;
 *  - TTL expiry and LRU eviction (512 entries) both force a provider call;
 *  - an aborted or failed embed is never cached;
 *  - a reconfigure while an embed is in flight keeps that vector out of the cache;
 *  - document-side embed() stays uncached.
 */

import { describe, test, expect, beforeEach, afterEach, setSystemTime } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  embed,
  embedQuery,
  __setEmbedTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { withAIInvocationGuard } from '../../src/core/ai/invocation-guard.ts';

const MODEL = 'openai:text-embedding-3-large';
let calls: string[] = [];
let failNext: Error | null = null;
let gate: Promise<void> | null = null;

function dimsOf(providerOptions: unknown): number {
  return (providerOptions as { openai?: { dimensions?: number } })?.openai?.dimensions ?? 1536;
}

function vectorFor(text: string, dims: number): number[] {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return Array.from({ length: dims }, (_, i) => ((h + i) % 97) / 97);
}

function configure(extra: Record<string, unknown> = {}): void {
  configureGateway({ embedding_model: MODEL, embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-fake' }, ...extra });
  __setEmbedTransportForTests((async (args: { values: string[]; providerOptions: unknown; abortSignal?: AbortSignal }) => {
    calls.push(...args.values);
    if (gate) await gate;
    if (args.abortSignal?.aborted) throw args.abortSignal.reason ?? new Error('aborted');
    if (failNext) { const e = failNext; failNext = null; throw e; }
    const dims = dimsOf(args.providerOptions);
    return { embeddings: args.values.map(v => vectorFor(v, dims)) };
  }) as never);
}

beforeEach(() => {
  calls = [];
  failNext = null;
  gate = null;
  configure();
});

afterEach(() => {
  setSystemTime();
  __setEmbedTransportForTests(null);
  resetGateway();
});

describe('query-embed cache — hits', () => {
  test('a repeat query makes 0 provider calls and returns an equal copy', async () => {
    const a = await embedQuery('widget roadmap');
    const b = await embedQuery('widget roadmap');
    expect(calls).toEqual(['widget roadmap']);
    expect(Array.from(b)).toEqual(Array.from(a));
    expect(b).not.toBe(a);
    a.fill(0);
    b.fill(0);
    const c = await embedQuery('widget roadmap');
    expect(Array.from(c)).toEqual(Array.from(new Float32Array(vectorFor('widget roadmap', 1536))));
    expect(calls).toHaveLength(1);
  });

  test('the configured model and dims spelled out explicitly share the entry', async () => {
    await embedQuery('widget roadmap');
    await embedQuery('widget roadmap', { embeddingModel: MODEL, dimensions: 1536 });
    await embedQuery('roadmap', { queryPrefix: 'widget ' });
    expect(calls).toEqual(['widget roadmap']);
  });
});

describe('query-embed cache — AI invocation guards', () => {
  test('a guarded caller is admitted by its guard, never served from the cache', async () => {
    await embedQuery('widget roadmap');
    const admitted: string[] = [];
    await withAIInvocationGuard(async call => {
      admitted.push(call.kind);
      return { settle: async () => {} };
    }, () => embedQuery('widget roadmap'));
    expect(admitted).toEqual(['embedding']);
    expect(calls).toEqual(['widget roadmap', 'widget roadmap']);
    const refusal = new Error('spend refused');
    await expect(withAIInvocationGuard(async () => { throw refusal; }, () => embedQuery('widget roadmap'))).rejects.toThrow();
    await embedQuery('widget roadmap');
    expect(calls).toHaveLength(2);
  });
});

describe('query-embed cache — misses', () => {
  test('a different model, dimensions or query prefix misses', async () => {
    await embedQuery('widget roadmap');
    await embedQuery('widget roadmap', { embeddingModel: 'openai:text-embedding-3-small', dimensions: 1536 });
    await embedQuery('widget roadmap', { dimensions: 1024 });
    await embedQuery('widget roadmap', { queryPrefix: 'query: ' });
    expect(calls).toEqual(['widget roadmap', 'widget roadmap', 'widget roadmap', 'query: widget roadmap']);
    const v = await embedQuery('widget roadmap', { dimensions: 1024 });
    expect(v.length).toBe(1024);
    expect(calls).toHaveLength(4);
  });

  test('the exact query string keys the entry: case and whitespace miss', async () => {
    await embedQuery('widget roadmap');
    await embedQuery('Widget roadmap');
    await embedQuery('widget roadmap ');
    expect(calls).toEqual(['widget roadmap', 'Widget roadmap', 'widget roadmap ']);
  });

  test('a different base URL misses (and any reconfigure starts empty)', async () => {
    await embedQuery('widget roadmap');
    configure({ base_urls: { openai: 'http://127.0.0.1:9/v1' } });
    await embedQuery('widget roadmap');
    configure();
    await embedQuery('widget roadmap');
    expect(calls).toHaveLength(3);
  });

  test('an entry expires after 10 minutes', async () => {
    const t0 = Date.now();
    setSystemTime(new Date(t0));
    await embedQuery('widget roadmap');
    setSystemTime(new Date(t0 + 10 * 60_000 - 1));
    await embedQuery('widget roadmap');
    expect(calls).toHaveLength(1);
    setSystemTime(new Date(t0 + 10 * 60_000 + 1));
    await embedQuery('widget roadmap');
    expect(calls).toHaveLength(2);
  });

  test('the least recently used entry is evicted past 512 entries', async () => {
    await embedQuery('q-0');
    await embedQuery('q-1');
    for (let i = 2; i < 512; i++) await embedQuery(`q-${i}`);
    await embedQuery('q-0');
    expect(calls).toHaveLength(512);
    await embedQuery('q-512');
    await embedQuery('q-0');
    expect(calls).toHaveLength(513);
    await embedQuery('q-1');
    expect(calls).toHaveLength(514);
    expect(calls.at(-1)).toBe('q-1');
  });

  test('document-side embed() is never cached', async () => {
    await embed(['widget roadmap']);
    await embed(['widget roadmap']);
    expect(calls).toHaveLength(2);
  });
});

describe('query-embed cache — failures are not cached', () => {
  test('an aborted embed is not cached and does not poison the next caller', async () => {
    const ctl = new AbortController();
    ctl.abort(new Error('caller gave up'));
    await expect(embedQuery('widget roadmap', { abortSignal: ctl.signal })).rejects.toThrow();
    const v = await embedQuery('widget roadmap');
    expect(Array.from(v)).toEqual(Array.from(new Float32Array(vectorFor('widget roadmap', 1536))));
    expect(calls).toHaveLength(2);
    await embedQuery('widget roadmap');
    expect(calls).toHaveLength(2);
  });

  test('a failed embed is not cached', async () => {
    failNext = new Error('provider 500');
    await expect(embedQuery('widget roadmap')).rejects.toThrow();
    await embedQuery('widget roadmap');
    await embedQuery('widget roadmap');
    expect(calls).toHaveLength(2);
  });

  test('a reconfigure during an in-flight embed keeps its vector out of the new cache', async () => {
    let release!: () => void;
    gate = new Promise<void>(r => { release = r; });
    const pending = embedQuery('widget roadmap');
    while (calls.length === 0) await new Promise(r => setTimeout(r, 1));
    configure();
    gate = null;
    release();
    await pending;
    await embedQuery('widget roadmap');
    expect(calls).toHaveLength(2);
  });
});
