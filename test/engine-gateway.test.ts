/**
 * GBRA-283 Wave B2: an engine opened from settings carries its own AI gateway (settings.ai). Its embed, chat and
 * rerank calls reach only its own providers and keys, a missing provider refuses engine_scope_missing with nothing
 * sent, the gateway follows engineKey (page transactions, proxies, a recovered degraded engine), two engines never
 * cross, and a key never shows up in an error, a log line, doctor output or the settings read back. Every provider
 * is a transport stub: nothing here opens a socket.
 */
import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  __clearQueryEmbedCacheForTests, __setEmbedTransportForTests, __setGenerateTextTransportForTests, __setRerankTransportForTests,
  chat, configureGateway, embedQuery, requireConfig, rerank, resetGateway,
} from '../src/core/ai/gateway.ts';
import { resolveAnthropicKey } from '../src/core/ai/anthropic-key.ts';
import { embeddedSettings, openEngine, withEngineScope, type EngineSettings } from '../src/core/engine-open.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { createDegradedEngine } from '../src/core/degraded-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';

const EMBEDDING = { model: 'openai:text-embedding-3-small', dimensions: 1536 };
const key = (label: string) => `sk-${label}-${randomBytes(12).toString('hex')}`;
const settingsFor = (over: Partial<EngineSettings> = {}): EngineSettings =>
  ({ embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() }, embedding: EMBEDDING, ...over });
const hostCtx = (engine: BrainEngine): OperationContext => ({
  engine, config: {}, logger: { info: () => {}, warn: () => {}, error: () => {} }, dryRun: false, remote: true,
} as unknown as OperationContext);
const failure = async (work: () => Promise<unknown>) => {
  try { await work(); return null; } catch (error) { return error as Error & { code?: string; suggestion?: string }; }
};

/** What each provider call carried: the URL it would post to and its bearer. */
type Sent = { kind: string; url: string; auth: string | null; model: string };
const sent: Sent[] = [];
async function sentBy(kind: string, model: any): Promise<void> {
  const headers = await model.config.headers();
  sent.push({ kind, model: model.modelId, url: model.config.url({ path: '/x', modelId: model.modelId }), auth: headers.authorization ?? headers.Authorization ?? null });
}
function installStubs(): void {
  __setEmbedTransportForTests((async ({ model, values }: any) => {
    await sentBy('embed', model);
    return { embeddings: values.map(() => Array.from({ length: EMBEDDING.dimensions }, (_, i) => (i % 7) + 1)), usage: { tokens: 1 } };
  }) as any);
  __setGenerateTextTransportForTests((async ({ model }: any) => {
    await sentBy('chat', model);
    return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  }) as any);
  __setRerankTransportForTests(async (url, init) => {
    sent.push({ kind: 'rerank', url, auth: new Headers(init.headers).get('authorization'), model: JSON.parse(String(init.body)).model });
    return new Response(JSON.stringify({ data: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 });
  });
}

afterEach(() => {
  sent.length = 0;
  __setEmbedTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
});

/** Process-wide keys and gateway that an embedded engine must never fall back to. */
const PROCESS_KEY = key('process');
const ambient = { OPENAI_API_KEY: PROCESS_KEY, ANTHROPIC_API_KEY: PROCESS_KEY, VOYAGE_API_KEY: PROCESS_KEY };
function configureProcessGateway(): void {
  configureGateway({ embedding_model: EMBEDDING.model, embedding_dimensions: EMBEDDING.dimensions, chat_model: 'openai:gpt-5.6', reranker_model: 'voyage:rerank-3-lite', env: { ...ambient } });
}

describe('engine_scope_missing', () => {
  test('an engine without settings.ai refuses embed, chat and rerank; no process key or process gateway is used and nothing is sent', async () => {
    installStubs();
    configureProcessGateway();
    await withEnv(ambient, async () => {
      const engine = await openEngine(settingsFor());
      try {
        for (const [touchpoint, call] of [
          ['embedding', () => embedQuery('a question')],
          ['chat', () => chat({ messages: [{ role: 'user', content: 'hello' }] })],
          ['reranker', () => rerank({ query: 'q', documents: ['d'] })],
        ] as const) {
          const error = await withEngineScope(engine, () => failure(call));
          expect(error?.code).toBe('engine_scope_missing');
          expect(error!.message).toContain(touchpoint);
          expect(error!.suggestion).toContain('nothing was sent');
          expect(`${error!.message} ${error!.suggestion}`).not.toContain(PROCESS_KEY);
        }
        expect(withEngineScope(engine, () => resolveAnthropicKey())).toBeUndefined();
        expect(sent).toEqual([]);
      } finally {
        await engine.disconnect();
      }
    });
  });

  test('a provider the settings do not name refuses while the named one answers', async () => {
    installStubs();
    const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('a') } }, models: { chat: 'anthropic:claude-sonnet-4-6' } } }));
    try {
      await withEngineScope(engine, () => embedQuery('reaches openai'));
      const error = await withEngineScope(engine, () => failure(() => chat({ messages: [{ role: 'user', content: 'hello' }] })));
      expect(error?.code).toBe('engine_scope_missing');
      expect(error!.message).toBe('This engine has no AI provider anthropic for chat.');
      expect(sent.map(s => s.kind)).toEqual(['embed']);
    } finally {
      await engine.disconnect();
    }
  });

  test('a disconnected engine drops its gateway: its next call refuses', async () => {
    installStubs();
    const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('a') } } } }));
    await engine.disconnect();
    const error = await withEngineScope(engine, () => failure(() => embedQuery('after close')));
    expect(error?.code).toBe('engine_scope_missing');
    expect(sent).toEqual([]);
  });
});

describe('two engines in one process', () => {
  test('each call reaches its own engine\'s provider, key, base URL and model; the same query is never served across engines', async () => {
    installStubs();
    configureProcessGateway();
    const keyA = key('a'), keyB = key('b');
    const a = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA, baseUrl: 'https://a.example/v1' }, voyage: { apiKey: keyA, baseUrl: 'https://rerank-a.example/v1' } }, models: { chat: 'openai:gpt-5.6-terra', reranker: 'voyage:rerank-3-lite' } } }));
    const b = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyB, baseUrl: 'https://b.example/v1' }, voyage: { apiKey: keyB, baseUrl: 'https://rerank-b.example/v1' } }, models: { chat: 'openai:gpt-5.6-luna', reranker: 'voyage:rerank-3' } } }));
    try {
      for (const engine of [a, b, a]) {
        await withEngineScope(engine, async () => {
          await embedQuery('the same question');
          await chat({ messages: [{ role: 'user', content: 'hello' }] });
          await rerank({ query: 'q', documents: ['d'] });
        });
      }
      const of = (auth: string) => sent.filter(s => s.auth === `Bearer ${auth}`);
      // Engine a's second embedQuery is its own cached vector; engine b's identical query still reaches b's provider.
      expect(sent).toHaveLength(8);
      expect(of(PROCESS_KEY)).toEqual([]);
      expect(of(keyA).map(s => [s.kind, s.url, s.model])).toEqual([
        ['embed', 'https://a.example/v1/x', 'text-embedding-3-small'], ['chat', 'https://a.example/v1/x', 'gpt-5.6-terra'], ['rerank', 'https://rerank-a.example/v1/rerank', 'rerank-3-lite'],
        ['chat', 'https://a.example/v1/x', 'gpt-5.6-terra'], ['rerank', 'https://rerank-a.example/v1/rerank', 'rerank-3-lite'],
      ]);
      expect(of(keyB).map(s => [s.kind, s.url, s.model])).toEqual([
        ['embed', 'https://b.example/v1/x', 'text-embedding-3-small'], ['chat', 'https://b.example/v1/x', 'gpt-5.6-luna'], ['rerank', 'https://rerank-b.example/v1/rerank', 'rerank-3'],
      ]);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  });

  test('an operation handler runs in its engine\'s scope: query embeds with that engine\'s key, no scope entered by the host', async () => {
    installStubs();
    configureProcessGateway();
    const keyA = key('a'), keyB = key('b');
    const a = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA } } } }));
    const b = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyB } } } }));
    try {
      await a.initSchema();
      await b.initSchema();
      await operationsByName.query.handler(hostCtx(a), { query: 'what does brain a know' });
      await operationsByName.query.handler(hostCtx(b), { query: 'what does brain b know' });
      const embeds = sent.filter(s => s.kind === 'embed').map(s => s.auth);
      expect(embeds).toEqual([`Bearer ${keyA}`, `Bearer ${keyB}`]);
    } finally {
      await a.disconnect();
      await b.disconnect();
    }
  }, 120_000);
});

describe('the gateway follows engineKey', () => {
  test('a page transaction, a forwarding proxy and a recovered degraded engine share their engine\'s gateway', async () => {
    installStubs();
    const keyA = key('a');
    const a = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA } } } }));
    try {
      await a.initSchema();
      const degraded = createDegradedEngine({ initialError: new Error('down'), reconnect: async () => a, minIntervalMs: 0 });
      await failure(() => (degraded as unknown as { getStats: () => Promise<unknown> }).getStats());
      await a.transaction(async tx => { await withEngineScope(tx, () => embedQuery('from a transaction')); });
      await withEngineScope(new Proxy(a, {}), () => embedQuery('from a proxy'));
      await withEngineScope(degraded, () => embedQuery('from a recovered degraded engine'));
      expect(sent.map(s => s.auth)).toEqual(Array(3).fill(`Bearer ${keyA}`));
    } finally {
      await a.disconnect();
    }
  }, 60_000);
});

describe('an engine that openEngine did not open', () => {
  test('keeps the process gateway byte for byte, in its own scope and with embedded engines open', async () => {
    installStubs();
    configureProcessGateway();
    const snapshot = async () => {
      sent.length = 0;
      __clearQueryEmbedCacheForTests();
      await embedQuery('the same question');
      await chat({ messages: [{ role: 'user', content: 'hello' }] });
      return JSON.stringify({ config: requireConfig(), sent, anthropic: resolveAnthropicKey() === PROCESS_KEY });
    };
    await withEnv(ambient, async () => {
      const outside = await snapshot();
      expect(outside).toContain(`Bearer ${PROCESS_KEY}`);
      const embedded = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('a') } }, models: { chat: 'openai:gpt-5.6' } } }));
      const cli = await createEngine({ engine: 'pglite' });
      try {
        expect(await withEngineScope(cli, snapshot)).toBe(outside);
        expect(await snapshot()).toBe(outside);
        expect(await withEngineScope(embedded, snapshot)).not.toBe(outside);
      } finally {
        await embedded.disconnect();
      }
    });
  });
});

describe('keys stay out of errors, logs, doctor output and read-back', () => {
  test('a canary key never appears anywhere the engine reports', async () => {
    const canary = key('canary');
    const printed: string[] = [];
    const spies = [spyOn(console, 'log'), spyOn(console, 'warn'), spyOn(console, 'error'), spyOn(console, 'info')];
    const stderr = spyOn(process.stderr, 'write');
    for (const spy of [...spies, stderr]) spy.mockImplementation(((...args: unknown[]) => { printed.push(args.map(String).join(' ')); return true; }) as never);
    try {
      const seen: string[] = [];
      const report = (error: unknown) => seen.push(JSON.stringify(error), String((error as Error)?.message), String((error as Error)?.stack), Bun.inspect(error));
      report(await failure(() => openEngine(settingsFor({ ai: { providers: { openai: { apiKey: canary, baseUrl: 'not a url' } } } }))));
      report(await failure(() => openEngine(settingsFor({ ai: { providers: { openai: { apiKey: canary, api_key: canary } as never } } }))));
      report(await failure(() => openEngine(settingsFor({ ai: { providers: { 'claude-cli': { apiKey: canary } } } }))));
      expect(seen.join('\n')).toContain('engine_settings_invalid');

      const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: canary } } } }));
      try {
        await engine.initSchema();
        __setEmbedTransportForTests((async () => { throw Object.assign(new Error(`401 Incorrect API key provided: ${canary}`), { statusCode: 401 }); }) as any);
        report(await withEngineScope(engine, () => failure(() => embedQuery('a question'))));
        report(await withEngineScope(engine, () => failure(() => chat({ messages: [{ role: 'user', content: 'hello' }], model: 'anthropic:claude-sonnet-4-6' }))));
        const { buildChecks } = await import('../src/commands/doctor.ts');
        const checks = await withEngineScope(engine, () => buildChecks(engine, ['--fast', '--json', '--scope=brain']));
        seen.push(JSON.stringify(checks));
        const held = embeddedSettings(engine)!;
        expect(held.ai?.providers.openai).toEqual({ hasApiKey: true });
        seen.push(JSON.stringify(held), Bun.inspect(engine));
      } finally {
        await engine.disconnect();
      }
      expect(seen.join('\n')).not.toContain(canary);
      expect(printed.join('\n')).not.toContain(canary);
      expect(seen.join('\n')).not.toContain(canary.slice(3, 20));
    } finally {
      for (const spy of [...spies, stderr]) spy.mockRestore();
    }
  }, 120_000);
});
