/**
 * #6607 (Cat 41 consent-negative): OpenAI latest-model discovery
 * (`GET /v1/models`, unbilled) ran on every engine connect whenever
 * OPENAI_API_KEY was set, so `gbrain doctor` on an existing keyless brain that
 * never ran setup sent it with the user's key. Discovery now runs only before
 * an OpenAI-routed gateway call. A request counter stands in for the OpenAI
 * endpoint (OPENAI_BASE_URL): a keyless brain's doctor and search send
 * nothing, an OpenAI-routed chat sends one discovery request (once per
 * reconfigure) and the call itself runs on the freshly discovered tier, an
 * Anthropic-routed chat sends none.
 *
 * Serial: mutates process env, GBRAIN_HOME and gateway module state.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import {
  __setChatTransportForTests,
  chat,
  configureGateway,
  getChatModel,
  reconfigureGatewayWithEngine,
  resetGateway,
} from '../src/core/ai/gateway.ts';
import { _resetOpenAILatestForTests, latestOpenAITiers } from '../src/core/ai/openai-latest.ts';
import { openaiStaticTierFallback } from '../src/core/model-config.ts';

const requests: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let base: string;
const roots: string[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      requests.push(`${req.method} ${new URL(req.url).pathname}`);
      return Response.json({ data: [{ id: 'gpt-5.6' }, { id: 'gpt-5.6-luna' }] });
    },
  });
  base = `http://127.0.0.1:${server.port}/v1`;
});
afterAll(() => {
  server.stop(true);
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-lazy-discovery-'));
  roots.push(dir);
  return dir;
}

const NO_KEYS = { OPENAI_API_KEY: undefined, ANTHROPIC_API_KEY: undefined, VOYAGE_API_KEY: undefined, GEMINI_API_KEY: undefined,
  GOOGLE_GENERATIVE_AI_API_KEY: undefined, OPENAI_BASE_URL: undefined, GBRAIN_MODEL_DISCOVERY: undefined };

describe('an existing keyless brain with OPENAI_API_KEY in the environment (#6607)', () => {
  test('doctor and search send no model-discovery request', async () => {
    const home = tempHome();
    const init = await runCli(['init', '--pglite', '--no-embedding', '--json'], { home, env: NO_KEYS, timeoutMs: 120_000 });
    expect(init.exitCode).toBe(0);
    requests.length = 0;
    const keyed = { ...NO_KEYS, OPENAI_API_KEY: 'sk-test-discovery', OPENAI_BASE_URL: base };
    await runCli(['doctor', '--json'], { home, env: keyed, timeoutMs: 120_000 });
    await runCli(['search', 'anything'], { home, env: keyed, timeoutMs: 120_000 });
    expect(requests).toEqual([]);
  }, 300_000);
});

describe('OpenAI-routed calls still discover, at first use', () => {
  class StubEngine {
    readonly kind = 'pglite' as const;
    async getConfig() { return null; }
    async setConfig() {}
  }
  const reply = () => ({ text: 'ok', blocks: [], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: getChatModel(), providerId: 'test' }) as never;
  let home: string;
  beforeEach(() => {
    home = tempHome();
    requests.length = 0;
    resetGateway();
    _resetOpenAILatestForTests();
    __setChatTransportForTests(async () => reply());
  });
  afterEach(() => {
    __setChatTransportForTests(null);
    resetGateway();
    _resetOpenAILatestForTests();
  });

  test('connect sends nothing; the first OpenAI chat discovers once and runs on the discovered tier', async () => {
    await withEnv({ ...NO_KEYS, GBRAIN_HOME: home, OPENAI_API_KEY: 'sk-test-discovery' }, async () => {
      configureGateway({ env: { OPENAI_API_KEY: 'sk-test-discovery', OPENAI_BASE_URL: base } });
      await reconfigureGatewayWithEngine(new StubEngine() as never);
      expect(requests).toEqual([]);
      expect(getChatModel()).toBe(openaiStaticTierFallback().reasoning);
      let called = '';
      __setChatTransportForTests(async () => { called = getChatModel(); return reply(); });
      await chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(requests).toEqual(['GET /v1/models']);
      const discovered = latestOpenAITiers('reasoning');
      expect(typeof discovered).toBe('string');
      expect(discovered).not.toBe(openaiStaticTierFallback().reasoning);
      expect(called).toBe(discovered as string);
      await chat({ messages: [{ role: 'user', content: 'again' }] });
      expect(requests).toEqual(['GET /v1/models']);
    });
  });

  test('an Anthropic-routed chat sends no discovery request', async () => {
    await withEnv({ ...NO_KEYS, GBRAIN_HOME: home, OPENAI_API_KEY: 'sk-test-discovery' }, async () => {
      configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { OPENAI_API_KEY: 'sk-test-discovery', OPENAI_BASE_URL: base, ANTHROPIC_API_KEY: 'sk-ant-test' } });
      await chat({ messages: [{ role: 'user', content: 'hi' }] });
      expect(requests).toEqual([]);
    });
  });
});
