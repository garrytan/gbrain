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
  __clearQueryEmbedCacheForTests, __setEmbedTransportForTests, __unconfigureGatewayForTests, __setGenerateTextTransportForTests, __setRerankTransportForTests,
  chat, configureGateway, diagnoseEmbedding, embedQuery, isAvailable, requireConfig, rerank, resetGateway,
} from '../src/core/ai/gateway.ts';
import Anthropic from '@anthropic-ai/sdk';
import { anthropicClientOptions, resolveAnthropicKey } from '../src/core/ai/anthropic-key.ts';
import { embeddedEngineInScope } from '../src/core/engine-scope.ts';
import { PersistenceConsumer } from '../src/core/persistence/consumer.ts';
import { FactsQueue } from '../src/core/facts/queue.ts';
import { makeSubagentHandler } from '../src/core/minions/handlers/subagent.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { applyReranker } from '../src/core/search/rerank.ts';
import { resolveSearchMode } from '../src/core/search/mode.ts';
import { DEFAULT_RERANKER_MODEL } from '../src/core/ai/defaults.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import { startPersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { embeddedSettings, openEngine, withEngineScope, withLocalScope, type EngineSettings } from '../src/core/engine-open.ts';
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
  const url = model.config.url ? model.config.url({ path: '/x', modelId: model.modelId }) : `${model.config.baseURL}/x`;
  sent.push({ kind, model: model.modelId, url, auth: headers.authorization ?? headers.Authorization ?? headers['x-api-key'] ?? null });
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

describe('settings.ai validation', () => {
  test('each malformed ai setting refuses engine_settings_invalid, names the setting and never echoes the key', async () => {
    const canary = key('canary');
    for (const [ai, setting] of [
      [null, 'ai'],
      [{ models: {} }, 'ai'],
      [{ providers: { 'not-a-provider': { apiKey: canary } } }, 'ai.providers.not-a-provider'],
      [{ providers: { openai: canary } }, 'ai.providers.openai'],
      [{ providers: { openai: { apiKey: canary, key: canary } } }, 'ai.providers.openai.key'],
      [{ providers: { openai: { apiKey: '' } } }, 'ai.providers.openai.apiKey'],
      [{ providers: { openai: {} } }, 'ai.providers.openai.apiKey'],
      [{ providers: { openai: { apiKey: canary, baseUrl: 'ftp://proxy.example' } } }, 'ai.providers.openai.baseUrl'],
      [{ providers: { openai: { apiKey: canary } }, models: { embedding: 'openai:text-embedding-3-small' } }, 'ai.models.embedding'],
      [{ providers: { openai: { apiKey: canary } }, models: { chat: 'gpt-5.6' } }, 'ai.models.chat'],
      [{ providers: { dashscope: { apiKey: canary }, 'dashscope-rerank': { apiKey: key('other') } } }, 'ai.providers'],
    ] as const) {
      const error = await failure(() => openEngine(settingsFor({ ai: ai as never })));
      expect([error?.code, error?.message]).toEqual(['engine_settings_invalid', `The ${setting} setting is invalid.`]);
      expect(JSON.stringify(error) + error!.message + error!.suggestion).not.toContain(canary);
    }
  });
});

describe('process base URLs never reach an engine', () => {
  const PROXY = 'https://process-proxy.invalid';
  const processRoutes = { ...ambient, OPENAI_BASE_URL: `${PROXY}/v1`, ANTHROPIC_BASE_URL: PROXY };

  test('an engine that names a provider without baseUrl calls that provider\'s default endpoint', async () => {
    installStubs();
    await withEnv(processRoutes, async () => {
      const keyA = key('a');
      const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA }, anthropic: { apiKey: keyA } }, models: { chat: 'anthropic:claude-sonnet-4-6' } } }));
      try {
        await withEngineScope(engine, () => embedQuery('a question'));
        await withEngineScope(engine, () => chat({ messages: [{ role: 'user', content: 'hello' }] }));
        expect(sent.map(s => [s.kind, s.url.slice(0, s.url.lastIndexOf('/'))])).toEqual([['embed', 'https://api.openai.com/v1'], ['chat', 'https://api.anthropic.com/v1']]);
        expect(sent.map(s => s.auth)).toEqual([`Bearer ${keyA}`, keyA]);
      } finally {
        await engine.disconnect();
      }
    });
  });

  test('a directly built Anthropic client takes only the engine\'s key and endpoint, and refuses without its provider', async () => {
    await withEnv(processRoutes, async () => {
      const keyA = key('a');
      const named = await openEngine(settingsFor({ ai: { providers: { anthropic: { apiKey: keyA } } } }));
      const proxied = await openEngine(settingsFor({ ai: { providers: { anthropic: { apiKey: keyA, baseUrl: 'https://engine-proxy.example/v1' } } } }));
      const without = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA } } } }));
      try {
        const client = withEngineScope(named, () => new Anthropic(anthropicClientOptions()));
        expect([client.apiKey, client.baseURL]).toEqual([keyA, 'https://api.anthropic.com']);
        expect(withEngineScope(proxied, () => new Anthropic(anthropicClientOptions())).baseURL).toBe('https://engine-proxy.example');
        const error = await withEngineScope(without, () => failure(async () => anthropicClientOptions()));
        expect(error?.code).toBe('engine_scope_missing');
        expect(withLocalScope(() => anthropicClientOptions())).toEqual({ apiKey: PROCESS_KEY });
      } finally {
        await Promise.all([named.disconnect(), proxied.disconnect(), without.disconnect()]);
      }
    });
  });
});

describe('keys stay scrubbed past disconnect and in shared slots', () => {
  test('two providers that read one key slot open when given the same key', async () => {
    const shared = key('shared');
    const engine = await openEngine(settingsFor({ ai: { providers: { dashscope: { apiKey: shared }, 'dashscope-rerank': { apiKey: shared } } } }));
    await engine.disconnect();
  });

  test.each([1, 2])('a call still in flight when its engine disconnects (%i times) scrubs that engine\'s key from its error', async (disconnects) => {
    const keyA = key('a');
    const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA } } } }));
    await engine.initSchema();
    let reject!: (error: unknown) => void;
    let started!: () => void;
    const begun = new Promise<void>(resolve => { started = resolve; });
    __setEmbedTransportForTests((() => { started(); return new Promise((_, fail) => { reject = fail; }); }) as any);
    const pending = withEngineScope(engine, () => failure(() => embedQuery('a question')));
    await begun;
    for (let i = 0; i < disconnects; i++) await engine.disconnect().catch(() => {});
    reject(Object.assign(new Error(`401 Incorrect API key provided: ${keyA}`), { statusCode: 401 }));
    const error = await pending;
    expect(error).not.toBeNull();
    expect(`${error!.message} ${JSON.stringify(error)} ${error!.stack}`).not.toContain(keyA);
  });
});

describe('availability follows the engine\'s providers', () => {
  test('a keyless provider the engine does not name reads as unavailable', async () => {
    const engine = await openEngine(settingsFor({ embedding: { model: 'ollama:nomic-embed-text', dimensions: 768 }, ai: { providers: { openai: { apiKey: key('a') } } } }));
    try {
      expect(withEngineScope(engine, () => [diagnoseEmbedding().ok, isAvailable('embedding'), isAvailable('chat', 'ollama:llama3')])).toEqual([false, false, false]);
      expect(withEngineScope(engine, () => isAvailable('chat', 'openai:gpt-5.6'))).toBe(true);
    } finally {
      await engine.disconnect();
    }
  });
});

describe('chat usage and unscoped calls', () => {
  const usageRows = async (engine: BrainEngine) => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM chat_usage_log'))[0]!.n);
  const settled = () => Bun.sleep(200);

  test('chat usage lands in the in-scope engine\'s database, and a local-scope call never books to an embedded engine', async () => {
    installStubs();
    configureProcessGateway();
    const cli = await createEngine({ engine: 'pglite' });
    await cli.connect({ engine: 'pglite' } as never);
    await cli.initSchema();
    const a = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('a') } }, models: { chat: 'openai:gpt-5.6' } } }));
    const b = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('b') } }, models: { chat: 'openai:gpt-5.6' } } }));
    try {
      await a.initSchema();
      await b.initSchema();
      await withEngineScope(a, () => chat({ messages: [{ role: 'user', content: 'hello from a' }] }));
      await settled();
      expect([await usageRows(a), await usageRows(b), await usageRows(cli)]).toEqual([1, 0, 0]);
      await withLocalScope(() => chat({ messages: [{ role: 'user', content: 'hello from the host' }] }));
      await settled();
      expect([await usageRows(a), await usageRows(b), await usageRows(cli)]).toEqual([1, 0, 1]);
    } finally {
      await Promise.all([a.disconnect(), b.disconnect(), cli.disconnect()]);
    }
  }, 120_000);

  test('a process holding an embedded engine refuses an unscoped AI call engine_scope_required, also with a process gateway; a local scope uses it', async () => {
    __unconfigureGatewayForTests();
    installStubs();
    await withEnv(ambient, async () => {
      const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('a') } } } }));
      try {
        const error = await failure(() => chat({ messages: [{ role: 'user', content: 'hello' }] }));
        expect(error?.code).toBe('engine_scope_required');
        expect(`${error!.message} ${error!.suggestion}`).toContain('withEngineScope');
        expect(resolveAnthropicKey()).toBeUndefined();
        expect((await failure(async () => anthropicClientOptions()))?.code).toBe('engine_scope_required');
        configureProcessGateway();
        expect((await failure(() => chat({ messages: [{ role: 'user', content: 'hello' }] })))?.code).toBe('engine_scope_required');
        expect(resolveAnthropicKey()).toBeUndefined();
        expect(await withLocalScope(() => failure(() => chat({ messages: [{ role: 'user', content: 'hello' }] })))).toBeNull();
        expect(withLocalScope(resolveAnthropicKey)).toBe(PROCESS_KEY);
      } finally {
        await engine.disconnect();
      }
      expect(resolveAnthropicKey()).toBe(PROCESS_KEY);
    });
  });
});

describe('facts queue', () => {
  test('a queued facts job runs in the scope it was enqueued from, whichever engine started the pump', async () => {
    installStubs();
    configureProcessGateway();
    const keyA = key('a'), keyB = key('b');
    const a = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA } }, models: { chat: 'openai:gpt-5.6' } } }));
    const b = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyB } }, models: { chat: 'openai:gpt-5.6' } } }));
    const keyOf = (engine: BrainEngine) => (engine === a ? keyA : keyB);
    try {
      for (const [first, second] of [[a, b], [b, a]]) {
        sent.length = 0;
        const queue = new FactsQueue();
        const job = async () => { await chat({ messages: [{ role: 'user', content: 'extract facts' }] }); };
        withEngineScope(first!, () => queue.enqueue(job, 'shared-session'));
        withEngineScope(second!, () => queue.enqueue(job, 'shared-session'));
        withLocalScope(() => queue.enqueue(job, 'shared-session'));
        expect((await queue.drainPending({ timeout: 30_000 })).unfinished).toBe(0);
        expect(sent.filter(s => s.kind === 'chat').map(s => s.auth)).toEqual([`Bearer ${keyOf(first!)}`, `Bearer ${keyOf(second!)}`, `Bearer ${PROCESS_KEY}`]);
      }
    } finally {
      await Promise.all([a.disconnect(), b.disconnect()]);
    }
  }, 120_000);
});

describe('search reranking on an engine', () => {
  test('search uses the engine\'s settings.ai.models.reranker unless the brain or the call names one', async () => {
    const engine = await openEngine(settingsFor({ ai: { providers: { voyage: { apiKey: key('v') } }, models: { reranker: 'voyage:rerank-2.5' } } }));
    try {
      expect(withEngineScope(engine, () => resolveSearchMode({ mode: 'balanced' }).reranker_model)).toBe('voyage:rerank-2.5');
      expect(withEngineScope(engine, () => resolveSearchMode({ mode: 'balanced', overrides: { reranker_model: 'voyage:rerank-3' } }).reranker_model)).toBe('voyage:rerank-3');
      expect(withEngineScope(engine, () => resolveSearchMode({ mode: 'balanced', perCall: { reranker_model: 'voyage:rerank-3-lite' } }).reranker_model)).toBe('voyage:rerank-3-lite');
      expect(resolveSearchMode({ mode: 'balanced' }).reranker_model).toBe(DEFAULT_RERANKER_MODEL);
    } finally {
      await engine.disconnect();
    }
  });

  test('a reranker provider the engine was not given is a quiet no_key skip, not a provider failure', async () => {
    installStubs();
    const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('a') } } } }));
    try {
      const results = [{ slug: 'a', chunk_text: 'alpha' }, { slug: 'b', chunk_text: 'beta' }] as never[];
      const seen: string[] = [];
      const out = await withEngineScope(engine, () => applyReranker('q', results, {
        enabled: true, topNIn: 2, topNOut: 2, model: DEFAULT_RERANKER_MODEL, timeoutMs: 1000,
        onSkip: (reason: string) => seen.push(`skip:${reason}`), onFailure: (reason: string) => seen.push(`failure:${reason}`),
      } as never));
      expect(out).toBe(results);
      expect(seen).toEqual(['skip:no_key']);
      expect(sent).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  });
});

describe('the subagent handler\'s Anthropic client', () => {
  const PROXY = 'https://process-proxy.invalid';
  async function runJob(engine: BrainEngine) {
    const handler = makeSubagentHandler({ engine, toolRegistry: [] });
    const job = await new MinionQueue(engine).add('subagent', { prompt: 'hello' }, {}, { allowProtectedSubmit: true });
    const ctx = {
      id: job.id, name: job.name, data: { prompt: 'hello' }, attempts_made: 0, signal: new AbortController().signal, deadlineAtMs: null,
      shutdownSignal: new AbortController().signal, async updateProgress() {}, async updateTokens() {}, async log() {}, async isActive() { return true; }, async readInbox() { return []; },
    } as unknown as MinionJobContext;
    return handler(ctx);
  }

  test('a provider error that echoes the engine\'s key leaves the handler scrubbed', async () => {
    const keyA = key('a');
    const fetchSpy = spyOn(Anthropic.prototype as unknown as { fetchWithTimeout: () => Promise<Response> }, 'fetchWithTimeout').mockImplementation((async () =>
      new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key ${keyA}` } }), { status: 401, headers: { 'content-type': 'application/json' } })) as never);
    const engine = await openEngine(settingsFor({ ai: { providers: { anthropic: { apiKey: keyA } } } }));
    try {
      await engine.initSchema();
      const error = await failure(() => runJob(engine));
      expect(error).not.toBeNull();
      expect(`${error!.message} ${error!.stack} ${JSON.stringify(error)}`).not.toContain(keyA);
    } finally {
      fetchSpy.mockRestore();
      await engine.disconnect();
    }
  }, 120_000);

  test('is built for the handler\'s engine, whatever scope built the handler, and only when a job calls it', async () => {
    const calls: { url: string; key: string | null }[] = [];
    const fetchSpy = spyOn(Anthropic.prototype as unknown as { fetchWithTimeout: (url: string, init: RequestInit) => Promise<Response> }, 'fetchWithTimeout').mockImplementation((async (url: string, init: RequestInit) => {
      calls.push({ url, key: new Headers(init.headers as HeadersInit).get('x-api-key') });
      return new Response(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-4-6', stop_reason: 'end_turn', stop_sequence: null,
        content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as never);
    try {
      await withEnv({ ...ambient, ANTHROPIC_BASE_URL: PROXY }, async () => {
        const keyA = key('a');
        const named = await openEngine(settingsFor({ ai: { providers: { anthropic: { apiKey: keyA } } } }));
        const without = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: keyA } } } }));
        try {
          await named.initSchema();
          await without.initSchema();
          expect((await runJob(named)).result).toBe('ok');
          expect(calls).toEqual([{ url: 'https://api.anthropic.com/v1/messages', key: keyA }]);
          expect((await failure(() => withEngineScope(named, () => runJob(without))))?.code).toBe('engine_scope_missing');
          expect(calls).toHaveLength(1);
        } finally {
          await Promise.all([named.disconnect(), without.disconnect()]);
        }
      });
    } finally {
      fetchSpy.mockRestore();
    }
  }, 120_000);
});

describe('the persistence consumer stays in its engine\'s scope', () => {
  test('a wake from outside every scope still ticks for the consumer\'s engine', async () => {
    const engine = await openEngine(settingsFor({ ai: { providers: { openai: { apiKey: key('a') } } } }));
    const scopes: unknown[] = [];
    const tick = PersistenceConsumer.prototype.tick;
    const spy = spyOn(PersistenceConsumer.prototype, 'tick').mockImplementation(function (this: PersistenceConsumer, afterProgress?: boolean) {
      scopes.push(embeddedEngineInScope());
      return tick.call(this, afterProgress);
    });
    try {
      await engine.initSchema();
      const consumer = withEngineScope(engine, () => startPersistenceConsumer(engine, {} as never)) as PersistenceConsumer;
      const idle = async () => { while (scopes.length === 0 || (consumer as unknown as { tickPromise?: unknown }).tickPromise) await Bun.sleep(10); };
      await idle();
      const before = scopes.length;
      consumer.wake();
      while (scopes.length === before) await Bun.sleep(10);
      await idle();
      expect(scopes.slice(before).map(scope => scope === engine)).toEqual(Array(scopes.length - before).fill(true));
    } finally {
      spy.mockRestore();
      await stopPersistenceConsumer(engine);
      await engine.disconnect();
    }
  }, 60_000);
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
        expect(await withLocalScope(snapshot)).toBe(outside);
        expect((await failure(snapshot))?.code).toBe('engine_scope_required');
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
