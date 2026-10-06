/**
 * #5490: gateway.chat() consults `chat_fallback_chain`.
 *
 * Drives the real chat() path (provider resolution, error normalization,
 * invocation policy) through the generateText transport seam, so every
 * attempt is observed by the model the gateway actually instantiated. The
 * primary is a claude-cli model failing the way a Claude subscription limit
 * does: a ClaudeCliProcessError carrying apiErrorStatus 429.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import {
  configureGateway,
  resetGateway,
  chat,
  toolLoop,
  withBudgetTracker,
  __setGenerateTextTransportForTests,
} from '../../src/core/ai/gateway.ts';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildGatewayConfig } from '../../src/core/ai/build-gateway-config.ts';
import { loadConfig } from '../../src/core/config.ts';
import { BudgetExhausted, BudgetTracker } from '../../src/core/budget/budget-tracker.ts';
import { withEnv } from '../helpers/with-env.ts';
import { AITransientError } from '../../src/core/ai/errors.ts';
import { ClaudeCliProcessError } from '../../src/core/ai/providers/claude-cli-language-model.ts';
import { isAIInvocationPolicyError, withAIInvocationPreflight } from '../../src/core/ai/invocation-guard.ts';
import { defaultJudge } from '../../src/core/cycle/grade-takes.ts';
import { judgeContradiction } from '../../src/core/eval-contradictions/judge.ts';
import type { Take } from '../../src/core/engine.ts';
import { probeModel } from '../../src/commands/models.ts';
import { defaultDriftJudge } from '../../src/core/cycle/drift.ts';
import { makeJudgeClient } from '../../src/core/cycle/synthesize.ts';
import { runJudge } from '../../src/eval/shared/judge-runner.ts';
import { defaultEdgeJudge } from '../../src/core/cycle/edge-contradictions.ts';

const PRIMARY = 'claude-cli:claude-sonnet-4-6';
const FALLBACK = 'openai:gpt-5.6-luna';
const SECOND_FALLBACK = 'deepseek:deepseek-v4-flash';
const ENV = { OPENAI_API_KEY: 'fake-openai', DEEPSEEK_API_KEY: 'fake-deepseek' };

type Outcome = 'ok' | 'limit' | 'refusal' | 'filtered' | 'outage';

/** Synthetic subscription-limit failure in the claude-cli envelope shape, raw CLI output after the first line. */
function subscriptionLimit(): ClaudeCliProcessError {
  return new ClaudeCliProcessError(
    "claude-cli API error 429: You've hit your session limit · resets 3:00am (UTC)\n--- raw ---\n{\"is_error\":true,\"result\":\"synthetic raw blob\"}",
    { apiErrorStatus: 429, exitCode: 1 },
  );
}

let attempts: string[] = [];

/** Install a transport that answers per model id and records the attempt order. */
function installTransport(outcomes: Record<string, Outcome>): void {
  __setGenerateTextTransportForTests((async (args: any) => {
    const modelId: string = args.model.modelId;
    attempts.push(modelId);
    const outcome = outcomes[modelId] ?? 'ok';
    if (outcome === 'limit') throw subscriptionLimit();
    if (outcome === 'outage') throw Object.assign(new Error(`${modelId} upstream 503`), { status: 503 });
    return {
      content: [{ type: 'text', text: `answer from ${modelId}` }],
      finishReason: outcome === 'filtered' ? 'content-filter' : 'stop',
      usage: { inputTokens: 3, outputTokens: 2 },
      ...(outcome === 'refusal' ? { providerMetadata: { anthropic: { stopReason: 'refusal' } } } : {}),
    };
  }) as any);
}

const ask = (extra: Record<string, unknown> = {}) =>
  chat({ model: PRIMARY, messages: [{ role: 'user', content: 'hello' }], ...extra });

let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetGateway();
  attempts = [];
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  __setGenerateTextTransportForTests(null);
  warn.mockRestore();
  resetGateway();
});

interface HopCase {
  name: string;
  chain: string[];
  outcomes: Record<string, Outcome>;
  expectAttempts: string[];
  expectModel: string;
}

describe('chat() with chat_fallback_chain (#5490)', () => {
  test.each<HopCase>([
    {
      name: 'claude-cli subscription limit falls through to the API model',
      chain: [FALLBACK],
      outcomes: { 'claude-sonnet-4-6': 'limit' },
      expectAttempts: ['claude-sonnet-4-6', 'gpt-5.6-luna'],
      expectModel: FALLBACK,
    },
    {
      name: 'a healthy primary never touches the chain',
      chain: [FALLBACK],
      outcomes: {},
      expectAttempts: ['claude-sonnet-4-6'],
      expectModel: PRIMARY,
    },
    {
      name: 'the chain is walked in order past a failing entry',
      chain: [FALLBACK, SECOND_FALLBACK],
      outcomes: { 'claude-sonnet-4-6': 'limit', 'gpt-5.6-luna': 'outage' },
      expectAttempts: ['claude-sonnet-4-6', 'gpt-5.6-luna', 'deepseek-v4-flash'],
      expectModel: SECOND_FALLBACK,
    },
    {
      name: 'chain entries repeating the primary or each other run once',
      chain: [PRIMARY, FALLBACK, FALLBACK],
      outcomes: { 'claude-sonnet-4-6': 'limit' },
      expectAttempts: ['claude-sonnet-4-6', 'gpt-5.6-luna'],
      expectModel: FALLBACK,
    },
    {
      name: 'a structural refusal falls through to the next model',
      chain: [FALLBACK],
      outcomes: { 'claude-sonnet-4-6': 'refusal' },
      expectAttempts: ['claude-sonnet-4-6', 'gpt-5.6-luna'],
      expectModel: FALLBACK,
    },
    {
      name: 'a content filter falls through to the next model',
      chain: [FALLBACK],
      outcomes: { 'claude-sonnet-4-6': 'filtered' },
      expectAttempts: ['claude-sonnet-4-6', 'gpt-5.6-luna'],
      expectModel: FALLBACK,
    },
  ])('$name', async ({ chain, outcomes, expectAttempts, expectModel }) => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: chain, env: ENV });
    installTransport(outcomes);

    const result = await ask();

    expect(attempts).toEqual(expectAttempts);
    expect(result.model).toBe(expectModel);
    expect(result.text).toBe(`answer from ${expectAttempts.at(-1)}`);
    expect(result.fallbackFrom).toBe(expectModel === PRIMARY ? undefined : PRIMARY);
  });

  test('each hop is reported on stderr with the failed model and the next one', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'limit' });

    await ask();

    const lines = warn.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(PRIMARY);
    expect(lines[0]).toContain('session limit');
    expect(lines[0]).toContain(FALLBACK);
    expect(lines[0]).not.toContain('--- raw ---');
  });

  test("when every model fails, the call's own model's error surfaces and the last failure is logged", async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'limit', 'gpt-5.6-luna': 'outage' });

    const err = await ask().catch(e => e);

    expect(attempts).toEqual(['claude-sonnet-4-6', 'gpt-5.6-luna']);
    expect(err).toBeInstanceOf(AITransientError);
    expect(err.apiErrorStatus).toBe(429);
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain('gpt-5.6-luna upstream 503');
  });

  test('a refusal earlier in the chain is returned instead of a later failure', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'refusal', 'gpt-5.6-luna': 'outage' });

    const result = await ask();

    expect(attempts).toEqual(['claude-sonnet-4-6', 'gpt-5.6-luna']);
    expect(result.model).toBe(PRIMARY);
    expect(result.stopReason).toBe('refusal');
  });

  test('allowFallback: false pins the call to its own model', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'limit' });

    const err = await ask({ allowFallback: false }).catch(e => e);

    expect(attempts).toEqual(['claude-sonnet-4-6']);
    expect(err).toBeInstanceOf(AITransientError);
    expect(err.apiErrorStatus).toBe(429);
  });

  test('a gbrain policy refusal is never retried on another model', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({});
    const denied: string[] = [];

    const err = await withAIInvocationPreflight(async call => {
      denied.push(call.model);
      throw new Error('budget cap reached');
    }, () => ask()).catch(e => e);

    expect(isAIInvocationPolicyError(err)).toBe(true);
    expect(denied).toHaveLength(1);
    expect(attempts).toEqual([]);
  });

  test("the caller's own abort stops the chain", async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    const controller = new AbortController();
    __setGenerateTextTransportForTests((async (args: any) => {
      attempts.push(args.model.modelId);
      controller.abort();
      throw subscriptionLimit();
    }) as any);

    const err = await ask({ abortSignal: controller.signal }).catch(e => e);

    expect(attempts).toEqual(['claude-sonnet-4-6']);
    expect(err).toBeInstanceOf(AITransientError);
  });

  test.each([
    { name: 'unset', chain: undefined },
    { name: 'empty', chain: [] as string[] },
  ])('with the chain $name the primary error surfaces unchanged', async ({ chain }) => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: chain, env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'limit' });

    const err = await ask().catch(e => e);

    expect(attempts).toEqual(['claude-sonnet-4-6']);
    expect(err.apiErrorStatus).toBe(429);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('toolLoop() and judge flows with chat_fallback_chain (#5490)', () => {
  const loop = (extra: Record<string, unknown> = {}) => toolLoop({
    model: PRIMARY,
    initialMessages: [{ role: 'user', content: 'hello' }],
    tools: [],
    toolHandlers: new Map(),
    ...extra,
  });

  test('toolLoop turns fall back like any other chat call', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'limit' });

    const result = await loop();

    expect(attempts).toEqual(['claude-sonnet-4-6', 'gpt-5.6-luna']);
    expect(result.finalText).toBe('answer from gpt-5.6-luna');
  });

  const take = { claim: 'a synthetic claim', kind: 'fact', holder: 'alice-example', since_date: null, weight: 0.5 } as unknown as Take;

  const driftCandidate = { takeId: 1, pageId: 1, pageSlug: 'notes/a-example', rowNum: 1, claim: 'a synthetic claim', weight: 0.5, recentEvidenceCount: 1 };

  test.each([
    { name: 'toolLoop({ allowFallback: false }) (skillopt rollouts)', run: () => loop({ allowFallback: false }) },
    { name: 'grade_takes judge', run: () => defaultJudge({ take, evidence: 'synthetic evidence', modelHint: PRIMARY }) },
    { name: 'drift judge', run: () => defaultDriftJudge({ candidate: driftCandidate, evidence: 'synthetic evidence', modelHint: PRIMARY }) },
    { name: 'models doctor probe', run: () => probeModel(PRIMARY, 'chat') },
    {
      name: 'LongMemEval judge',
      run: () => runJudge({ client: chat, model: PRIMARY, prompt: 'synthetic', maxTokens: 16, temperature: 0, parse: () => 'yes' as never, retries: 0 }),
    },
    {
      name: 'edge_contradictions judge (apply mode is certified per model)',
      run: () => defaultEdgeJudge({ subject: { slug: 'people/alice-example', title: 'Alice Example' }, relationships: [], modelHint: PRIMARY }),
    },
    {
      name: 'contradiction eval judge',
      run: () => judgeContradiction({
        query: 'synthetic query',
        a: { slug: 'notes/a-example', text: 'statement one' },
        b: { slug: 'notes/b-example', text: 'statement two' },
        model: PRIMARY,
      }),
    },
  ])('$name keeps its own model at the subscription limit', async ({ run }) => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'limit' });

    await run().catch(() => undefined);

    expect(attempts).toEqual(['claude-sonnet-4-6']);
  });

  test('the synthesize triage client marks a verdict a chain model gave', async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    installTransport({ 'claude-sonnet-4-6': 'limit' });

    const msg = await makeJudgeClient(PRIMARY)!.create({ model: PRIMARY, max_tokens: 16, messages: [{ role: 'user', content: 'hello' }] });

    expect((msg as unknown as { answered_by?: string }).answered_by).toBe(FALLBACK);
  });
});

describe('chain sources and budget refusals (#5490)', () => {
  /** A throwaway GBRAIN_HOME whose config.json names the claude-cli primary and, optionally, a chain. */
  function homeWith(fileChain?: unknown): string {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-chat-fallback-'));
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'pglite',
      database_path: join(home, 'brain.pglite'),
      chat_model: PRIMARY,
      ...(fileChain !== undefined ? { chat_fallback_chain: fileChain } : {}),
    }));
    return home;
  }

  test.each([
    { name: 'GBRAIN_CHAT_FALLBACK_CHAIN', fileChain: undefined, envChain: FALLBACK },
    { name: 'a config.json array', fileChain: [FALLBACK], envChain: undefined },
    { name: 'a hand-written config.json string', fileChain: ` ${FALLBACK} `, envChain: undefined },
  ])('a chain from $name reaches chat() through loadConfig and buildGatewayConfig', async ({ fileChain, envChain }) => {
    await withEnv({
      GBRAIN_HOME: homeWith(fileChain),
      GBRAIN_CHAT_FALLBACK_CHAIN: envChain,
      GBRAIN_CHAT_MODEL: undefined,
      DATABASE_URL: undefined,
      GBRAIN_DATABASE_URL: undefined,
      OPENAI_API_KEY: 'fake-openai',
    }, async () => {
      configureGateway(buildGatewayConfig(loadConfig()!));
      installTransport({ 'claude-sonnet-4-6': 'limit' });

      const result = await ask();

      expect(attempts).toEqual(['claude-sonnet-4-6', 'gpt-5.6-luna']);
      expect(result.model).toBe(FALLBACK);
    });
  });

  test('a BudgetTracker refusal stops the chain instead of trying a cheaper model', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['openai:gpt-4o-mini'],
      env: { ...ENV, ANTHROPIC_API_KEY: 'fake-anthropic' },
    });
    installTransport({});
    const tracker = new BudgetTracker({ label: 'chat-fallback-budget', maxCostUsd: 0.005, auditPath: '/dev/null' });

    const err = await withBudgetTracker(tracker, () => chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 4096,
    })).catch(e => e);

    expect(err).toBeInstanceOf(BudgetExhausted);
    expect(attempts).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('fallback safety audit (fix wave 9 lane B, #6012)', () => {
  const OPENAI_PRIMARY = 'openai:gpt-5.6-luna';
  const DEEPSEEK_FALLBACK = 'deepseek:deepseek-v4-flash';

  /** An AI SDK APICallError-shaped 400 whose body is the provider's content-policy refusal. */
  const contentPolicy400 = (body: unknown) => Object.assign(new Error('Bad Request'), {
    statusCode: 400,
    responseBody: JSON.stringify(body),
  });

  test.each([
    {
      name: 'OpenAI invalid_prompt (usage-policy flag)',
      body: { error: { message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy.', type: 'invalid_request_error', param: null, code: 'invalid_prompt' } },
    },
    {
      name: 'Azure OpenAI content_filter',
      body: { error: { message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy.", param: 'prompt', code: 'content_filter', status: 400, innererror: { code: 'ResponsibleAIPolicyViolation' } } },
    },
    {
      name: 'DeepSeek Content Exists Risk',
      body: { error: { message: 'Content Exists Risk', type: 'invalid_request_error', param: null, code: 'invalid_request_error' } },
    },
  ])('with chat_fallback_on_refusal false, a $name 400 is not sent to the next model', async ({ body }) => {
    configureGateway({ chat_model: OPENAI_PRIMARY, chat_fallback_chain: [DEEPSEEK_FALLBACK], chat_fallback_on_refusal: false, env: ENV });
    __setGenerateTextTransportForTests((async (args: any) => {
      attempts.push(args.model.modelId);
      throw contentPolicy400(body);
    }) as any);

    const err = await chat({ model: OPENAI_PRIMARY, messages: [{ role: 'user', content: 'hello' }] }).catch(e => e);

    expect(attempts).toEqual(['gpt-5.6-luna']);
    expect(err).toBeInstanceOf(Error);
  });

  test('an ordinary 400 (context length) still falls back', async () => {
    configureGateway({ chat_model: OPENAI_PRIMARY, chat_fallback_chain: [DEEPSEEK_FALLBACK], chat_fallback_on_refusal: false, env: ENV });
    __setGenerateTextTransportForTests((async (args: any) => {
      attempts.push(args.model.modelId);
      if (args.model.modelId === 'gpt-5.6-luna') {
        throw contentPolicy400({ error: { message: 'This model maximum context length is 128000 tokens.', type: 'invalid_request_error', code: 'context_length_exceeded' } });
      }
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } };
    }) as any);

    const result = await chat({ model: OPENAI_PRIMARY, messages: [{ role: 'user', content: 'hello' }] });

    expect(attempts).toEqual(['gpt-5.6-luna', 'deepseek-v4-flash']);
    expect(result.model).toBe(DEEPSEEK_FALLBACK);
  });

  test("a cancel that lands while the primary refuses stops the walk and returns the refusal", async () => {
    configureGateway({ chat_model: PRIMARY, chat_fallback_chain: [FALLBACK], env: ENV });
    const controller = new AbortController();
    __setGenerateTextTransportForTests((async (args: any) => {
      attempts.push(args.model.modelId);
      controller.abort();
      return {
        content: [{ type: 'text', text: '' }],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1 },
        providerMetadata: { anthropic: { stopReason: 'refusal' } },
      };
    }) as any);

    const result = await ask({ abortSignal: controller.signal });

    expect(attempts).toEqual(['claude-sonnet-4-6']);
    expect(result.model).toBe(PRIMARY);
    expect(result.stopReason).toBe('refusal');
  });

  test('an unpriced chain entry under an explicit cap is refused with no_pricing guidance, never called', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['deepseek:deepseek-unpriced-example'],
      env: { ...ENV, ANTHROPIC_API_KEY: 'fake-anthropic' },
    });
    installTransport({ 'claude-sonnet-4-6': 'outage' });
    const tracker = new BudgetTracker({ label: 'chat-fallback-unpriced', maxCostUsd: 5, auditPath: '/dev/null' });

    const err = await withBudgetTracker(tracker, () => chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 256,
    })).catch(e => e);

    expect(attempts).toEqual(['claude-sonnet-4-6']);
    expect(err).toBeInstanceOf(BudgetExhausted);
    expect(err.reason).toBe('no_pricing');
    expect(err.modelId).toBe('deepseek:deepseek-unpriced-example');
    expect(String(err.message)).toContain('gbrain pricing set');
  });

  test('an unpriced chain entry under a default cap warns and runs', async () => {
    configureGateway({
      chat_model: 'anthropic:claude-sonnet-4-6',
      chat_fallback_chain: ['deepseek:deepseek-unpriced-example'],
      env: { ...ENV, ANTHROPIC_API_KEY: 'fake-anthropic' },
    });
    installTransport({ 'claude-sonnet-4-6': 'outage' });
    const tracker = new BudgetTracker({ label: 'chat-fallback-default-cap', maxCostUsd: 5, capSource: 'default', auditPath: '/dev/null' });

    const result = await withBudgetTracker(tracker, () => chat({
      model: 'anthropic:claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 256,
    }));

    expect(attempts).toEqual(['claude-sonnet-4-6', 'deepseek-unpriced-example']);
    expect(result.model).toBe('deepseek:deepseek-unpriced-example');
  });
});
