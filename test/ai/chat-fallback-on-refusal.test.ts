/**
 * `chat_fallback_on_refusal` and the first-hop notice (fix wave lane B3).
 *
 * Protects: with `chat_fallback_on_refusal=false`, a refused request (a
 * structural refusal stop reason or a provider content block thrown as an
 * error) is never sent to the next `chat_fallback_chain` entry, while an
 * outage still falls back; the key reaches chat() through the real loader on
 * every plane with env > config.json > DB precedence; the first hop of a
 * process queues exactly one `chat_fallback_hop` safety notice naming the
 * failed and the next model.
 * Fails when: the key is dropped at any hop (config.ts, the DB merge key list,
 * buildGatewayConfig, configureGateway, chatWithFallback), the precedence is
 * wrong, or the hop notice fires zero or more than one time per process.
 * Seams: the generateText transport (no network); a real PGLite brain for the
 * DB plane; a throwaway GBRAIN_HOME for the file plane.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chat, configureGateway, resetGateway, __setGenerateTextTransportForTests, type ChatResult } from '../../src/core/ai/gateway.ts';
import { chatWithFallback } from '../../src/core/ai/chat-fallback.ts';
import { takeChatFallbackHopNotices, __resetChatFallbackHopNoticeForTests } from '../../src/core/ai/fallback-hop-queue.ts';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { loadConfig, loadConfigWithEngine } from '../../src/core/config.ts';
import { _resetDbPlaneMergeMemoForTests } from '../../src/core/config-db-merge.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { withEnv } from '../helpers/with-env.ts';

const PRIMARY = 'claude-cli:claude-sonnet-4-6';
const FALLBACK = 'openai:gpt-5.6-luna';

type Outcome = 'ok' | 'refusal' | 'blocked' | 'outage';

/** A provider content block the way the AI SDK surfaces one: a 200 body whose prompt was blocked. */
function contentBlock(): Error {
  return Object.assign(new Error('No output generated: the prompt was blocked'), {
    responseBody: JSON.stringify({ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' } }),
    statusCode: 200,
  });
}

let attempts: string[] = [];
function installTransport(outcomes: Record<string, Outcome>): void {
  __setGenerateTextTransportForTests((async (args: any) => {
    const modelId: string = args.model.modelId;
    attempts.push(modelId);
    const outcome = outcomes[modelId] ?? 'ok';
    if (outcome === 'blocked') throw contentBlock();
    if (outcome === 'outage') throw Object.assign(new Error(`${modelId} upstream 503`), { status: 503 });
    return {
      content: [{ type: 'text', text: `answer from ${modelId}` }],
      finishReason: 'stop',
      usage: { inputTokens: 3, outputTokens: 2 },
      ...(outcome === 'refusal' ? { providerMetadata: { anthropic: { stopReason: 'refusal' } } } : {}),
    };
  }) as any);
}

const ask = () => chat({ model: PRIMARY, messages: [{ role: 'user', content: 'hello' }] });

let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  resetGateway();
  attempts = [];
  __resetChatFallbackHopNoticeForTests();
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  __setGenerateTextTransportForTests(null);
  warn.mockRestore();
  resetGateway();
});

describe('chatWithFallback onRefusal', () => {
  const result = (model: string, stopReason: ChatResult['stopReason']): ChatResult =>
    ({ text: `from ${model}`, blocks: [], stopReason, usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model, providerId: model.split(':')[0]! });

  test('false returns a structural refusal instead of sending it on', async () => {
    const seen: string[] = [];
    const out = await chatWithFallback({ messages: [] }, PRIMARY, [FALLBACK], async (o) => { seen.push(o.model!); return result(o.model!, 'refusal'); }, { onRefusal: false });
    expect(seen).toEqual([PRIMARY]);
    expect(out.stopReason).toBe('refusal');
    expect(out.fallbackFrom).toBeUndefined();
  });

  test('false throws a provider content block instead of sending it on', async () => {
    const seen: string[] = [];
    await expect(chatWithFallback({ messages: [] }, PRIMARY, [FALLBACK], async (o) => { seen.push(o.model!); throw contentBlock(); }, { onRefusal: false }))
      .rejects.toThrow('blocked');
    expect(seen).toEqual([PRIMARY]);
  });

  test('false still falls back on an outage', async () => {
    const seen: string[] = [];
    const out = await chatWithFallback({ messages: [] }, PRIMARY, [FALLBACK], async (o) => {
      seen.push(o.model!);
      if (o.model === PRIMARY) throw Object.assign(new Error('upstream 503'), { status: 503 });
      return result(o.model!, 'end');
    }, { onRefusal: false });
    expect(seen).toEqual([PRIMARY, FALLBACK]);
    expect(out.model).toBe(FALLBACK);
  });

  test('the default (true) keeps falling back on refusals', async () => {
    const seen: string[] = [];
    await chatWithFallback({ messages: [] }, PRIMARY, [FALLBACK], async (o) => { seen.push(o.model!); return result(o.model!, o.model === PRIMARY ? 'refusal' : 'end'); });
    expect(seen).toEqual([PRIMARY, FALLBACK]);
  });
});

describe('chat_fallback_on_refusal through the real loader', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  function home(fileOnRefusal?: boolean): string {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-on-refusal-'));
    mkdirSync(join(dir, '.gbrain'), { recursive: true });
    writeFileSync(join(dir, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite', database_path: join(dir, 'brain.pglite'), chat_model: PRIMARY, chat_fallback_chain: [FALLBACK],
      ...(fileOnRefusal !== undefined ? { chat_fallback_on_refusal: fileOnRefusal } : {}),
    }));
    return dir;
  }

  interface PlaneCase { name: string; env?: string; file?: boolean; db?: string; fallsBack: boolean }
  const cases: PlaneCase[] = [
    { name: 'unset (default true)', fallsBack: true },
    { name: 'DB false', db: 'false', fallsBack: false },
    { name: 'config.json false', file: false, fallsBack: false },
    { name: 'GBRAIN_CHAT_FALLBACK_ON_REFUSAL=false', env: 'false', fallsBack: false },
    { name: 'env true over config.json false', env: 'true', file: false, fallsBack: true },
    { name: 'env off over DB true', env: 'off', db: 'true', fallsBack: false },
    { name: 'config.json true over DB false', file: true, db: 'false', fallsBack: true },
  ];

  for (const outcome of ['refusal', 'blocked'] as const) {
    test.each(cases)(`${outcome}: $name`, async ({ env, file, db, fallsBack }) => {
      if (db === undefined) await engine.unsetConfig('chat_fallback_on_refusal');
      else await engine.setConfig('chat_fallback_on_refusal', db);
      _resetDbPlaneMergeMemoForTests();
      await withEnv({
        GBRAIN_HOME: home(file), GBRAIN_CHAT_FALLBACK_ON_REFUSAL: env, GBRAIN_CHAT_FALLBACK_CHAIN: undefined,
        GBRAIN_CHAT_MODEL: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, OPENAI_API_KEY: 'fake-openai',
      }, async () => {
        const merged = await loadConfigWithEngine(engine, loadConfig());
        configureGateway(buildGatewayConfig(merged!));
        installTransport({ 'claude-sonnet-4-6': outcome });
        if (fallsBack) {
          const out = await ask();
          expect(out.model).toBe(FALLBACK);
          expect(attempts).toEqual(['claude-sonnet-4-6', 'gpt-5.6-luna']);
        } else {
          if (outcome === 'refusal') expect((await ask()).stopReason).toBe('refusal');
          else await expect(ask()).rejects.toThrow();
          expect(attempts).toEqual(['claude-sonnet-4-6']);
        }
      });
    });
  }
});

describe('first-hop notice', () => {
  test('the first hop of a process queues one chat_fallback_hop notice naming both models', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: { OPENAI_API_KEY: 'fake-openai' } });
    installTransport({ 'claude-sonnet-4-6': 'outage' });
    await ask();
    await ask();
    const queued = takeChatFallbackHopNotices();
    expect(queued).toHaveLength(1);
    expect(queued[0]!.code).toBe('chat_fallback_hop');
    expect(queued[0]!.kind).toBe('safety');
    expect(queued[0]!.why).toContain(PRIMARY);
    expect(queued[0]!.why).toContain(FALLBACK);
    expect(queued[0]!.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'chat_fallback_chain', '--json']);
    await ask();
    expect(takeChatFallbackHopNotices()).toEqual([]);
    expect(attempts).toEqual(['claude-sonnet-4-6', 'gpt-5.6-luna', 'claude-sonnet-4-6', 'gpt-5.6-luna', 'claude-sonnet-4-6', 'gpt-5.6-luna']);
  });

  test('a refusal hop says refused content went to the next provider', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: { OPENAI_API_KEY: 'fake-openai' } });
    installTransport({ 'claude-sonnet-4-6': 'refusal' });
    await ask();
    const [notice] = takeChatFallbackHopNotices();
    expect(notice!.why).toContain('refused it');
    expect(notice!.why).toContain('chat_fallback_on_refusal false');
  });

  test('no hop, no notice', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: { OPENAI_API_KEY: 'fake-openai' } });
    installTransport({});
    await ask();
    expect(takeChatFallbackHopNotices()).toEqual([]);
  });
});
