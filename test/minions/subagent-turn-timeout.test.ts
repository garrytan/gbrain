/**
 * #4921: a subagent turn is bounded by the per-turn cap
 * (`ai.chat.per_turn_timeout_ms`, default 30 min) and the job's own deadline,
 * not by the gateway's 300 s default chat backstop, which killed long
 * thinking-model turns inside a 30-min job. Calls outside a job keep 300 s.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import { runSubagentOneshot, type OneshotArgs } from '../../src/core/minions/handlers/subagent-oneshot.ts';
import {
  DEFAULT_CHAT_PER_TURN_TIMEOUT_MS,
  resolveChatPerTurnTimeoutMs,
} from '../../src/core/minions/handler-timeouts.ts';
import { KNOWN_CONFIG_KEYS } from '../../src/core/config.ts';
import type { MinionJobContext, SubagentHandlerData } from '../../src/core/minions/types.ts';
import {
  __setChatTransportForTests,
  __setGenerateTextTransportForTests,
  chat,
  configureGateway,
  resetGateway,
  toolLoop,
  type ChatOpts,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', '85');
  await engine.setConfig('agent.use_gateway_loop', 'true');
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', env: { ANTHROPIC_API_KEY: 'stub' } });
});

afterEach(() => {
  __setChatTransportForTests(null);
  __setGenerateTextTransportForTests(null);
  resetGateway();
});

const DONE: ChatResult = {
  text: 'done',
  blocks: [{ type: 'text', text: 'done' }],
  stopReason: 'end',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
  model: 'anthropic:claude-sonnet-4-6',
  providerId: 'anthropic',
};

function captureChatOpts(): ChatOpts[] {
  const seen: ChatOpts[] = [];
  __setChatTransportForTests(async (opts) => {
    seen.push(opts);
    return DONE;
  });
  return seen;
}

async function makeCtx(data: SubagentHandlerData, deadlineAtMs: number | null): Promise<MinionJobContext> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (submission_authority, name, status, data, queue, priority, created_at)
     VALUES ('{"version":1,"kind":"application"}'::jsonb, 'subagent', 'active', $1::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify(data)],
  );
  return {
    id: rows[0].id,
    name: 'subagent',
    data: data as unknown as Record<string, unknown>,
    attempts_made: 0,
    signal: new AbortController().signal,
    deadlineAtMs,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

function buildHandler() {
  return makeSubagentHandler({
    engine,
    config: {} as any,
    toolRegistry: [],
    makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path should not be invoked'); } } }) as any,
  });
}

describe('subagent gateway loop turn timeout (#4921)', () => {
  test('every turn gets the 30-min per-turn cap instead of the 300 s backstop by default', async () => {
    const seen = captureChatOpts();
    const ctx = await makeCtx({ prompt: 'hello', model: 'anthropic:claude-sonnet-4-6' }, Date.now() + 30 * 60_000);

    await buildHandler()(ctx);

    expect(seen).toHaveLength(1);
    expect(seen[0]!.timeoutMs).toBe(DEFAULT_CHAT_PER_TURN_TIMEOUT_MS);
    expect(seen[0]!.timeoutMs).toBeGreaterThan(300_000);
  });

  test('ai.chat.per_turn_timeout_ms sets the cap', async () => {
    await engine.setConfig('ai.chat.per_turn_timeout_ms', '3600000');
    const seen = captureChatOpts();
    const ctx = await makeCtx({ prompt: 'hello', model: 'anthropic:claude-sonnet-4-6' }, null);

    await buildHandler()(ctx);

    expect(seen[0]!.timeoutMs).toBe(3_600_000);
  });
});

describe('oneshot sub-budget (#4921)', () => {
  async function oneshotTimeoutMs(deadlineAtMs: number | null, turnTimeoutMs?: number): Promise<number | undefined> {
    const data: SubagentHandlerData = { prompt: 'p', mode: 'oneshot', allowed_slug_prefixes: ['wiki/*'], oneshot_slug_suffix: 'abc123' };
    const ctx = await makeCtx(data, deadlineAtMs);
    let seen: number | undefined;
    const args: OneshotArgs = {
      engine,
      ctx,
      data,
      model: 'anthropic:claude-sonnet-4-6',
      maxOutputTokens: 8192,
      ...(turnTimeoutMs !== undefined ? { turnTimeoutMs } : {}),
      putPageTool: { name: 'brain_put_page', description: 'stub', input_schema: { type: 'object' }, idempotent: false, execute: async () => ({}) },
      leaseKey: 'anthropic:messages',
      maxConcurrent: 32,
      leaseTtlMs: 120_000,
      _chat: (async (opts: ChatOpts) => { seen = opts.timeoutMs; return { ...DONE, text: 'not json' }; }) as OneshotArgs['_chat'],
    };
    await runSubagentOneshot(args);
    return seen;
  }

  test('a long job gives the single call a quarter of the time left, up to the per-turn cap, past 300 s', async () => {
    expect(await oneshotTimeoutMs(Date.now() + 3 * 60 * 60_000, DEFAULT_CHAT_PER_TURN_TIMEOUT_MS)).toBe(DEFAULT_CHAT_PER_TURN_TIMEOUT_MS);
    const quarter = await oneshotTimeoutMs(Date.now() + 40 * 60_000, DEFAULT_CHAT_PER_TURN_TIMEOUT_MS);
    expect(quarter).toBeGreaterThan(300_000);
    expect(quarter).toBeLessThanOrEqual(10 * 60_000);
  });

  test('a job without a deadline keeps the 300 s oneshot budget', async () => {
    expect(await oneshotTimeoutMs(null, DEFAULT_CHAT_PER_TURN_TIMEOUT_MS)).toBe(300_000);
  });
});

describe('chat() timeoutMs (#4921)', () => {
  test('timeoutMs bounds a hung provider call', async () => {
    __setGenerateTextTransportForTests((async (args: any) => {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 2_000);
        args.abortSignal.addEventListener('abort', () => { clearTimeout(timer); reject(args.abortSignal.reason); });
      });
      return { content: [{ type: 'text', text: 'late' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    }) as any);

    const started = Date.now();
    const err = await chat({ messages: [{ role: 'user', content: 'x' }], timeoutMs: 50 }).catch(e => e);

    expect(err).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test('a tool loop outside a job sends no timeoutMs, so the 300 s backstop applies', async () => {
    const seen = captureChatOpts();

    await toolLoop({ initialMessages: [{ role: 'user', content: 'x' }], tools: [], toolHandlers: new Map() });

    expect(seen[0]!.timeoutMs).toBeUndefined();
  });
});

describe('ai.chat.per_turn_timeout_ms config key (#4921)', () => {
  test('is a known key', () => {
    expect(KNOWN_CONFIG_KEYS).toContain('ai.chat.per_turn_timeout_ms');
  });

  test.each([
    [null, DEFAULT_CHAT_PER_TURN_TIMEOUT_MS],
    ['', DEFAULT_CHAT_PER_TURN_TIMEOUT_MS],
    ['abc', DEFAULT_CHAT_PER_TURN_TIMEOUT_MS],
    ['0', DEFAULT_CHAT_PER_TURN_TIMEOUT_MS],
    ['-5', DEFAULT_CHAT_PER_TURN_TIMEOUT_MS],
    ['1.5', DEFAULT_CHAT_PER_TURN_TIMEOUT_MS],
    ['600000', 600_000],
  ])('resolves %p to %p', (raw, expected) => {
    expect(resolveChatPerTurnTimeoutMs(raw)).toBe(expected);
  });
});
