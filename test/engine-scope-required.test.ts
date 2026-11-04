/**
 * GBRA-283 B3a: in a process that holds engines opened from settings, an AI call decides by scope presence alone. In an
 * embedded engine's scope it uses that engine's providers; in a local scope (withLocalScope, entered by the CLI, gbrain
 * serve and the jobs worker, or a non-embedded engine's scope) it uses the process gateway; with no scope at all it
 * refuses engine_scope_required, whatever process gateway the host configured. Every provider is a transport stub.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  __setEmbedTransportForTests, __setGenerateObjectTransportForTests, __setGenerateTextTransportForTests, __setRerankTransportForTests, __unconfigureGatewayForTests,
  chat, configureGateway, configureGatewayIfUninitialized, embed, embedQuery, expand, requireConfig, rerank, resetGateway,
} from '../src/core/ai/gateway.ts';
import { anthropicClientOptions, resolveAnthropicKey } from '../src/core/ai/anthropic-key.ts';
import { openEngine, withEngineScope, withLocalScope, type EngineSettings } from '../src/core/engine-open.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { spawnSync } from 'node:child_process';
import { applyReranker } from '../src/core/search/rerank.ts';
import type { SearchResult } from '../src/core/types.ts';

const EMBEDDING = { model: 'openai:text-embedding-3-small', dimensions: 1536 };
const key = (label: string) => `sk-${label}-${randomBytes(12).toString('hex')}`;
const settingsFor = (apiKey: string): EngineSettings => ({
  embedded_core: true, engine: 'pglite', database: {}, host: { id: randomUUID() }, embedding: EMBEDDING,
  ai: { providers: { openai: { apiKey }, voyage: { apiKey } }, models: { chat: 'openai:gpt-5.6', expansion: 'openai:gpt-5.6' } },
});
const failure = async (work: () => unknown) => {
  try { await work(); return null; } catch (error) { return error as Error & { code?: string; suggestion?: string }; }
};

type Sent = { kind: string; auth: string | null };
const sent: Sent[] = [];
async function sentBy(kind: string, model: any): Promise<void> {
  const headers = await model.config.headers();
  sent.push({ kind, auth: headers.authorization ?? headers.Authorization ?? headers['x-api-key'] ?? null });
}
function installStubs(): void {
  __setEmbedTransportForTests((async ({ model, values }: any) => {
    await sentBy('embed', model);
    return { embeddings: values.map(() => Array.from({ length: EMBEDDING.dimensions }, (_, i) => (i % 7) + 1)), usage: { tokens: 1 } };
  }) as any);
  __setGenerateTextTransportForTests((async ({ model }: any) => {
    await sentBy('chat', model);
    return { content: [{ type: 'text', text: 'ok' }], text: '{"queries":[]}', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
  }) as any);
  __setGenerateObjectTransportForTests((async ({ model }: any) => {
    await sentBy('expand', model);
    return { object: { queries: ['alternative'] }, usage: { inputTokens: 1, outputTokens: 1 } };
  }) as any);
  __setRerankTransportForTests(async (_url, init) => {
    sent.push({ kind: 'rerank', auth: new Headers(init.headers).get('authorization') });
    return new Response(JSON.stringify({ data: [{ index: 0, relevance_score: 0.9 }] }), { status: 200 });
  });
}

afterEach(() => {
  sent.length = 0;
  __setEmbedTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  __setGenerateObjectTransportForTests(null);
  __setRerankTransportForTests(null);
  resetGateway();
});

/** Keys an embedded engine or an unscoped call must never use: the environment canary and the process gateway's key. */
const CANARY = key('canary');
const PROCESS_KEY = key('process');
const canaryEnv = { OPENAI_API_KEY: CANARY, ANTHROPIC_API_KEY: CANARY, VOYAGE_API_KEY: CANARY };
function configureConflictingProcessGateway(): void {
  configureGateway({ embedding_model: EMBEDDING.model, embedding_dimensions: EMBEDDING.dimensions, chat_model: 'openai:gpt-5.6', expansion_model: 'openai:gpt-5.6',
    reranker_model: 'voyage:rerank-3-lite', env: { OPENAI_API_KEY: PROCESS_KEY, ANTHROPIC_API_KEY: PROCESS_KEY, VOYAGE_API_KEY: PROCESS_KEY } });
}
/** Every AI touchpoint once: embed, query embed, chat, expansion, rerank. */
const everyCall = (label: string) => [
  () => embed([`document ${label}`]),
  () => embedQuery(`query ${label}`),
  () => chat({ messages: [{ role: 'user', content: `hello ${label}` }] }),
  () => expand(`expand ${label}`),
  () => rerank({ query: `rerank ${label}`, documents: ['one'], model: 'voyage:rerank-3-lite' }),
];
const codes = async (calls: Array<() => unknown>) => Promise.all(calls.map(async call => (await failure(call))?.code ?? 'ok'));
const REQUIRED = Array(5).fill('engine_scope_required');
const detached = <T>(schedule: (run: () => void) => void, work: () => Promise<T>): Promise<T> =>
  new Promise((resolve, reject) => schedule(() => { work().then(resolve, reject); }));

describe('a mixed process: a local CLI engine and two embedded engines', () => {
  test('unscoped, detached and post-close calls refuse engine_scope_required; scoped calls use their own keys; no call carries the canary', async () => {
    installStubs();
    configureConflictingProcessGateway();
    await withEnv(canaryEnv, async () => {
      const cli = await createEngine({ engine: 'pglite' });
      const keyA = key('a');
      const keyB = key('b');
      const a = await openEngine(settingsFor(keyA));
      const b = await openEngine(settingsFor(keyB));
      let aOpen = true;
      try {
        const direct = await codes(everyCall('direct'));
        expect(direct).toEqual(REQUIRED);
        const error = await failure(() => chat({ messages: [{ role: 'user', content: 'hello' }] }));
        expect(`${error!.message} ${error!.suggestion}`).toContain('withEngineScope');
        expect(resolveAnthropicKey()).toBeUndefined();
        expect((await failure(() => anthropicClientOptions()))?.code).toBe('engine_scope_required');

        expect(await detached(run => setTimeout(run, 5), () => codes(everyCall('timer')))).toEqual(REQUIRED);
        expect(await detached(queueMicrotask, () => codes(everyCall('microtask')))).toEqual(REQUIRED);
        expect(await detached(run => setImmediate(run), () => codes(everyCall('immediate')))).toEqual(REQUIRED);
        expect(sent).toEqual([]);

        expect(await withEngineScope(a, () => detached(run => setTimeout(run, 5), () => codes(everyCall('a timer'))))).toEqual(Array(5).fill('ok'));
        expect(await withEngineScope(b, () => codes(everyCall('b')))).toEqual(Array(5).fill('ok'));
        const scopedAuth = sent.splice(0).map(s => s.auth);
        expect(new Set(scopedAuth)).toEqual(new Set([`Bearer ${keyA}`, `Bearer ${keyB}`]));

        expect(await withLocalScope(() => codes(everyCall('local')))).toEqual(Array(5).fill('ok'));
        expect(await withEngineScope(cli, () => codes(everyCall('cli engine')))).toEqual(Array(5).fill('ok'));
        expect(new Set(sent.splice(0).map(s => s.auth))).toEqual(new Set([`Bearer ${PROCESS_KEY}`]));
        expect(withLocalScope(() => resolveAnthropicKey())).toBe(process.env.ANTHROPIC_API_KEY);

        const afterClose = withEngineScope(a, () => detached(run => setTimeout(run, 200), () => codes(everyCall('a after close'))));
        const unscopedAfterClose = detached(run => setTimeout(run, 200), () => codes(everyCall('unscoped after close')));
        await a.disconnect();
        aOpen = false;
        const closedExpansionUnavailable = ['engine_scope_missing', 'engine_scope_missing', 'engine_scope_missing', 'ok', 'engine_scope_missing'];
        expect(await afterClose).toEqual(closedExpansionUnavailable);
        expect(await unscopedAfterClose).toEqual(REQUIRED);
        expect(sent).toEqual([]);
      } finally {
        await Promise.all([aOpen ? a.disconnect() : null, b.disconnect(), cli.disconnect()]);
      }
    });
    expect(sent.some(s => s.auth?.includes(CANARY))).toBe(false);
  }, 120_000);

  test('configureGatewayIfUninitialized is a no-op unscoped while an embedded engine is open, and configures in a local scope', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-scope-required-'));
    mkdirSync(join(home, '.gbrain'));
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'brain.pglite'), openai_api_key: CANARY }));
    __unconfigureGatewayForTests();
    await withEnv({ ...canaryEnv, GBRAIN_HOME: home }, async () => {
      const engine = await openEngine(settingsFor(key('a')));
      try {
        configureGatewayIfUninitialized();
        expect((await failure(() => withLocalScope(() => requireConfig())))?.message).toContain('not configured');
        withLocalScope(() => configureGatewayIfUninitialized());
        expect(withLocalScope(() => requireConfig()).env?.OPENAI_API_KEY).toBe(CANARY);
        expect((await failure(() => requireConfig()))?.code).toBe('engine_scope_required');
      } finally {
        await engine.disconnect();
      }
    });
  }, 60_000);
});

describe('rerank in a process holding an embedded engine', () => {
  test('an unscoped rerank skips as no_key: nothing was sent, so no provider failure is reported', async () => {
    installStubs();
    configureConflictingProcessGateway();
    const engine = await openEngine(settingsFor(key('a')));
    const seen: string[] = [];
    try {
      const results = [{ slug: 'notes/one', chunk_text: 'one', score: 1 }, { slug: 'notes/two', chunk_text: 'two', score: 0.5 }] as unknown as SearchResult[];
      const out = await applyReranker('rerank query', results, {
        enabled: true, topNIn: 2, topNOut: null, timeoutMs: 1000, model: 'voyage:rerank-3-lite',
        onSkip: reason => { seen.push(`skip:${reason}`); }, onFailure: reason => { seen.push(`failure:${reason}`); },
      });
      expect(out).toBe(results);
      expect(seen).toEqual(['skip:no_key']);
      expect(sent).toEqual([]);
    } finally {
      await engine.disconnect();
    }
  }, 60_000);
});

describe('a process that has not opened an embedded engine yet', () => {
  test('a call that entered a local engine scope before the first embedded engine opened keeps that scope after it opens', () => {
    const src = (path: string) => JSON.stringify(join(import.meta.dir, '..', 'src', path));
    const script = `
      const { __setGenerateTextTransportForTests, chat, configureGateway } = await import(${src('core/ai/gateway.ts')});
      const { openEngine, withEngineScope } = await import(${src('core/engine-open.ts')});
      __setGenerateTextTransportForTests(async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }));
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, chat_model: 'openai:gpt-5.6', env: { OPENAI_API_KEY: 'sk-process-local' } });
      let release; const gate = new Promise(resolve => { release = resolve; });
      const localEngine = { name: 'local-engine' };
      const local = withEngineScope(localEngine, async () => {
        await gate;
        try { await chat({ messages: [{ role: 'user', content: 'hello' }] }); return 'ok'; } catch (error) { return error?.code ?? String(error); }
      });
      const engine = await openEngine({ embedded_core: true, engine: 'pglite', database: {}, host: { id: crypto.randomUUID() } });
      release();
      const outcome = await local;
      await engine.disconnect();
      console.log('OUTCOME=' + outcome);
    `;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf-8', timeout: 60_000 });
    expect(run.stdout).toContain('OUTCOME=ok');
  }, 90_000);
});

describe('a process with no open embedded engine', () => {
  test('an unscoped call uses the process gateway as before, and does again once every embedded engine closed', async () => {
    installStubs();
    configureConflictingProcessGateway();
    expect(await codes(everyCall('before'))).toEqual(Array(5).fill('ok'));
    const engine: BrainEngine = await openEngine(settingsFor(key('a')));
    expect(await codes(everyCall('while open'))).toEqual(REQUIRED);
    await engine.disconnect();
    sent.length = 0;
    expect(await codes(everyCall('after'))).toEqual(Array(5).fill('ok'));
    expect(new Set(sent.map(s => s.auth))).toEqual(new Set([`Bearer ${PROCESS_KEY}`]));
  }, 60_000);
});
