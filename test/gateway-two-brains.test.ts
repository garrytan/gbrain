/**
 * Two brains in one process keep their own gateway: provider keys, base URLs,
 * models, chat-usage rows, search telemetry rows and query-embedding cache.
 *
 * Two PGLite engines are opened in one process and each is configured with
 * `configureGatewayForEngine` from values (`buildGatewayConfig` with an `env`
 * and no file config). The two brains embed through the same proxy URL and
 * model id with different keys, the case where a cached query vector of one
 * brain is a plausible answer for the other, and they chat through different
 * base URLs with different keys. A fake `fetch` answers every provider request
 * and records the URL and bearer it saw, so nothing leaves the process. Each
 * assertion runs inside the engine's scope, the way an operation handler does
 * (operation-load.ts); the search and query ops are driven through
 * `operationsByName`, so the scope the operation layer enters is what routes
 * their embeddings and telemetry.
 *
 * Outside any scope the process-wide configuration the test preload installs
 * is still what `requireConfig()` answers: the CLI, one engine per process,
 * is unchanged.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createEngine } from '../src/core/engine-factory.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEngineScope } from '../src/core/engine-scope.ts';
import { buildGatewayConfig } from '../src/core/ai/build-gateway-config.ts';
import { chat, configureGatewayForEngine, embedQuery, requireConfig, resetGateway } from '../src/core/ai/gateway.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { awaitPendingTelemetryFlush, _resetTelemetryWriterForTest } from '../src/core/search/telemetry.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { waitFor } from './helpers/wait-for.ts';

const DIMS = LEGACY_EMBEDDING_CONFIG.embedding_dimensions;
/** Both brains embed through one proxy under one model name; only their keys differ. */
const SHARED_EMBED_URL = 'http://embed-proxy.invalid/v1';
const SHARED_EMBED_MODEL = 'shared-embed';

interface Brain { name: string; embedKey: string; chatKey: string; chatUrl: string; fill: number; engine: BrainEngine }

const brainA: Brain = { name: 'a', embedKey: 'test-embed-key-brain-a', chatKey: 'test-chat-key-brain-a', chatUrl: 'http://brain-a.invalid/v1', fill: 0.1 } as Brain;
const brainB: Brain = { name: 'b', embedKey: 'test-embed-key-brain-b', chatKey: 'test-chat-key-brain-b', chatUrl: 'http://brain-b.invalid/v1', fill: 0.2 } as Brain;
const brains = [brainA, brainB];

/** Every provider request the fake fetch answered: which URL, with which bearer. */
const requests: Array<{ url: string; bearer: string | null; body: Record<string, unknown> }> = [];
const originalFetch = globalThis.fetch;

/** The brain a request belongs to: by the bearer on the shared embedding proxy, by the URL for chat. */
function brainFor(url: string, bearer: string | null): Brain {
  const brain = url.startsWith(SHARED_EMBED_URL)
    ? brains.find(b => bearer === `Bearer ${b.embedKey}`)
    : brains.find(b => url.startsWith(b.chatUrl));
  if (!brain) throw new Error(`request neither brain was configured for: ${url} with ${bearer}`);
  return brain;
}

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const bearer = new Headers(init?.headers ?? {}).get('authorization');
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
  requests.push({ url, bearer, body });
  const brain = brainFor(url, bearer);
  const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.endsWith('/embeddings')) {
    // The same text embeds to a different vector under each key, as two tenants of one proxy may get.
    return json({ object: 'list', model: body.model, data: [{ object: 'embedding', index: 0, embedding: new Array(DIMS).fill(brain.fill) }], usage: { prompt_tokens: 3, total_tokens: 3 } });
  }
  if (url.endsWith('/chat/completions')) {
    return json({ id: `chatcmpl-${brain.name}`, object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message: { role: 'assistant', content: `answer from brain ${brain.name}` }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  }
  throw new Error(`unexpected provider path: ${url}`);
}) as unknown as typeof fetch;

/** The gateway configuration for one brain, built from values alone: nothing read from the process or the home directory. */
function gatewayConfigFor(brain: Brain) {
  const config = {
    engine: 'pglite',
    embedding_model: `litellm:${SHARED_EMBED_MODEL}`,
    embedding_dimensions: DIMS,
    chat_model: `groq:brain-${brain.name}-chat`,
    provider_base_urls: { litellm: SHARED_EMBED_URL, groq: brain.chatUrl },
  } as unknown as GBrainConfig;
  return buildGatewayConfig(config, { env: { LITELLM_API_KEY: brain.embedKey, GROQ_API_KEY: brain.chatKey }, fileConfig: null });
}

const ctx = (engine: BrainEngine): OperationContext => ({
  engine, remote: false, sourceId: 'default', config: { engine: 'pglite' }, dryRun: false,
  logger: { info() {}, warn() {}, error() {} },
}) as unknown as OperationContext;

const inA = <T>(fn: () => T) => withEngineScope(brainA.engine, fn);
const inB = <T>(fn: () => T) => withEngineScope(brainB.engine, fn);

async function count(engine: BrainEngine, sql: string): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number | string }>(sql);
  return Number(row?.n ?? 0);
}

beforeAll(async () => {
  _resetTelemetryWriterForTest();
  for (const brain of brains) {
    brain.engine = await createEngine({ engine: 'pglite' });
    await brain.engine.connect({});
    await brain.engine.initSchema();
  }
  // Distinct content per brain, chunked for keyword search (no embedding: the fake provider is not installed yet).
  await importFromContent(brainA.engine, 'notes/alpha', '---\ntype: note\ntitle: Alpha note\n---\n\nBrain a keeps the word quokka in its only note.\n', { noEmbed: true });
  await importFromContent(brainB.engine, 'notes/beta', '---\ntype: note\ntitle: Beta note\n---\n\nBrain b keeps the word wombat in its only note.\n', { noEmbed: true });
  for (const brain of brains) configureGatewayForEngine(brain.engine, gatewayConfigFor(brain));
  globalThis.fetch = fakeFetch;
}, 120_000);

afterAll(async () => {
  globalThis.fetch = originalFetch;
  resetGateway();
  _resetTelemetryWriterForTest();
  await Promise.all(brains.map(b => b.engine?.disconnect()));
});

describe('two brains in one process', () => {
  test('each engine reads its own keys, base URLs and models; outside a scope the process config still answers', () => {
    const a = inA(() => requireConfig());
    const b = inB(() => requireConfig());
    expect(a.env.LITELLM_API_KEY).toBe(brainA.embedKey);
    expect(b.env.LITELLM_API_KEY).toBe(brainB.embedKey);
    expect(a.env.GROQ_API_KEY).toBe(brainA.chatKey);
    expect(b.env.GROQ_API_KEY).toBe(brainB.chatKey);
    expect(a.base_urls?.groq).toBe(brainA.chatUrl);
    expect(b.base_urls?.groq).toBe(brainB.chatUrl);
    expect(a.chat_model).toBe('groq:brain-a-chat');
    expect(b.chat_model).toBe('groq:brain-b-chat');
    // Built from values: the config carries only the env it was given.
    expect(Object.keys(a.env).sort()).toEqual(['GROQ_API_KEY', 'LITELLM_API_KEY']);

    const processConfig = requireConfig();
    expect(processConfig.embedding_model).toBe(LEGACY_EMBEDDING_CONFIG.embedding_model);
    expect(processConfig.env.LITELLM_API_KEY).toBeUndefined();
    expect(processConfig.env.GROQ_API_KEY).toBeUndefined();
  });

  test('a query embedding is requested with the brain\'s own key, and the cache never hands one brain the other\'s vector', async () => {
    requests.length = 0;
    const text = 'the same question asked of both brains';

    const fromA = await inA(() => embedQuery(text));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${SHARED_EMBED_URL}/embeddings`);
    expect(requests[0]!.bearer).toBe(`Bearer ${brainA.embedKey}`);
    expect(requests[0]!.body.model).toBe(SHARED_EMBED_MODEL);
    expect(fromA[0]).toBeCloseTo(brainA.fill, 6);

    // Same text, same proxy, same model id, same dims: brain b must still ask with its own key, not read a's cached vector.
    const fromB = await inB(() => embedQuery(text));
    expect(requests).toHaveLength(2);
    expect(requests[1]!.url).toBe(`${SHARED_EMBED_URL}/embeddings`);
    expect(requests[1]!.bearer).toBe(`Bearer ${brainB.embedKey}`);
    expect(fromB[0]).toBeCloseTo(brainB.fill, 6);

    // Brain a's second ask is a cache hit, and it is a's vector, not b's.
    const againA = await inA(() => embedQuery(text));
    expect(requests).toHaveLength(2);
    expect(againA[0]).toBeCloseTo(brainA.fill, 6);
  }, 60_000);

  test('a chat call goes to the brain\'s own base URL with its own key, and its usage row lands in that brain\'s ledger', async () => {
    requests.length = 0;
    const messages = [{ role: 'user' as const, content: 'hello' }];

    const resA = await inA(() => chat({ messages }));
    expect(resA.text).toBe('answer from brain a');
    expect(resA.model).toBe('groq:brain-a-chat');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${brainA.chatUrl}/chat/completions`);
    expect(requests[0]!.bearer).toBe(`Bearer ${brainA.chatKey}`);
    expect(requests[0]!.body.model).toBe('brain-a-chat');

    // The sink is fire-and-forget: wait for the row, then prove the other ledger stayed empty.
    await waitFor(async () => (await count(brainA.engine, 'SELECT count(*)::int AS n FROM chat_usage_log')) === 1, { timeoutMs: 10_000 });
    expect(await count(brainB.engine, 'SELECT count(*)::int AS n FROM chat_usage_log')).toBe(0);

    const resB = await inB(() => chat({ messages }));
    expect(resB.text).toBe('answer from brain b');
    expect(requests[1]!.url).toBe(`${brainB.chatUrl}/chat/completions`);
    expect(requests[1]!.bearer).toBe(`Bearer ${brainB.chatKey}`);
    await waitFor(async () => (await count(brainB.engine, 'SELECT count(*)::int AS n FROM chat_usage_log')) === 1, { timeoutMs: 10_000 });
    expect(await count(brainA.engine, 'SELECT count(*)::int AS n FROM chat_usage_log')).toBe(1);

    const [rowA] = await brainA.engine.executeRaw<{ model: string }>('SELECT model FROM chat_usage_log');
    const [rowB] = await brainB.engine.executeRaw<{ model: string }>('SELECT model FROM chat_usage_log');
    expect(rowA?.model).toBe('groq:brain-a-chat');
    expect(rowB?.model).toBe('groq:brain-b-chat');
  }, 60_000);

  test('the search and query operations find each brain\'s own content, embed with its key and write telemetry to that brain', async () => {
    const search = operationsByName.search!;
    const slugs = async (engine: BrainEngine, query: string) =>
      ((await search.handler(ctx(engine), { query, match: 'keyword' })) as Array<{ slug: string }>).map(r => r.slug);
    expect(await slugs(brainA.engine, 'quokka')).toEqual(['notes/alpha']);
    expect(await slugs(brainB.engine, 'wombat')).toEqual(['notes/beta']);
    expect(await slugs(brainA.engine, 'wombat')).toEqual([]);

    // The hybrid path is the one that embeds and records telemetry (the keyword page above does neither): two queries on a, one on b.
    const query = operationsByName.query!;
    const ask = (engine: BrainEngine, q: string) => query.handler(ctx(engine), { query: q, expand: false });
    requests.length = 0;
    await ask(brainA.engine, 'quokka');
    await ask(brainA.engine, 'wombat');
    const askedByA = requests.length;
    expect(askedByA).toBeGreaterThan(0);
    expect(requests.every(r => r.bearer === `Bearer ${brainA.embedKey}`)).toBe(true);
    await ask(brainB.engine, 'wombat');
    expect(requests.length).toBeGreaterThan(askedByA);
    expect(requests.slice(askedByA).every(r => r.bearer === `Bearer ${brainB.embedKey}`)).toBe(true);

    await awaitPendingTelemetryFlush(10_000, 'exit');
    // Each brain's table counts only its own searches.
    const searches = 'SELECT coalesce(sum(count), 0)::int AS n FROM search_telemetry WHERE mode NOT IN (\'empty_result\', \'rerank_gate\')';
    expect(await count(brainA.engine, searches)).toBe(2);
    expect(await count(brainB.engine, searches)).toBe(1);
  }, 60_000);
});
