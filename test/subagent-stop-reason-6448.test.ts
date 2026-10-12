/**
 * #6448 items 2/3 — a subagent turn that produced no answer is reported as
 * `error` (or `refusal`), never as a clean `end_turn`, on the direct Messages
 * path, the gateway path and both replay paths; a thinking-only or blank
 * terminal tail is read from the stored transcript instead of being sent
 * back to the provider as an assistant prefill.
 *
 * Hermetic: PGLite in-memory, FakeMessagesClient for the direct path, the
 * gateway test transport for the gateway path. No provider call.
 *
 * Contributed by @javieraldape (#6478: diagnosis + the five fail-first
 * shapes); the direct-path refusal arm is this wave's.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { makeSubagentHandler, type MessagesClient } from '../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  toolLoop,
  type ChatBlock,
  type ChatResult,
} from '../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw(`DELETE FROM config WHERE key = 'agent.use_gateway_loop'`);
  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    expansion_model: 'anthropic:claude-haiku-4-5',
    env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
  });
});

type FakeResponse = Partial<Anthropic.Message> & { content: Anthropic.Message['content'] };

class FakeMessagesClient implements MessagesClient {
  public calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private responses: FakeResponse[]) {}
  async create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> {
    this.calls.push(params);
    if (this.responses.length === 0) throw new Error('FakeMessagesClient: out of scripted responses');
    const r = this.responses.shift()!;
    return {
      id: `msg_${this.calls.length}`,
      type: 'message',
      role: 'assistant',
      model: params.model,
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } as any,
      ...r,
    } as Anthropic.Message;
  }
}

async function makeCtx(input: Record<string, unknown>): Promise<MinionJobContext> {
  const job = await queue.add('subagent', input, {}, { allowProtectedSubmit: true });
  return {
    id: job.id, name: job.name, data: input, attempts_made: 0,
    signal: new AbortController().signal, deadlineAtMs: null, shutdownSignal: new AbortController().signal,
    async updateProgress() {}, async updateTokens() {}, async log() {},
    async isActive() { return true; }, async readInbox() { return []; },
  };
}

async function messageCount(jobId: number): Promise<number> {
  const rows = await engine.executeRaw<{ c: string }>(
    `SELECT count(*)::text AS c FROM subagent_messages WHERE job_id = $1`, [jobId],
  );
  return parseInt(rows[0]!.c, 10);
}

async function seed(jobId: number, idx: number, role: string, blocks: unknown[], tokensOut: number | null = null, schemaVersion = 1): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks, model, tokens_in, tokens_out, schema_version)
     VALUES ($1, $2, $3, $4::text::jsonb, 'claude-sonnet-4-6', 100, $5, $6)`,
    [jobId, idx, role, JSON.stringify(blocks), tokensOut, schemaVersion],
  );
}

const noUsage = { input_tokens: 5, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 };

describe('gateway.toolLoop empty-response stop reason (#6448)', () => {
  test('a zero-tool-call turn with no text stops `empty_response`, not `end`', async () => {
    __setChatTransportForTests(async () => ({
      text: '', blocks: [] as ChatBlock[], stopReason: 'end', usage: noUsage,
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    }));
    const result = await toolLoop({ initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    expect(result.stopReason).toBe('empty_response');
    expect(result.finalText).toBe('');
    expect(result.totalUsage.input_tokens).toBe(5);
  });

  test('whitespace-only text is an empty response too', async () => {
    __setChatTransportForTests(async () => ({
      text: ' \n\t', blocks: [{ type: 'text', text: ' \n\t' }] as ChatBlock[], stopReason: 'end', usage: noUsage,
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    }));
    const result = await toolLoop({ initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    expect(result.stopReason).toBe('empty_response');
  });

  test('an output-cap stop with no text stays `length` (truncation is never reported as empty)', async () => {
    __setChatTransportForTests(async () => ({
      text: '', blocks: [] as ChatBlock[], stopReason: 'length', usage: { ...noUsage, output_tokens: 8192 },
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    }));
    const result = await toolLoop({ initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    expect(result.stopReason).toBe('length');
  });

  test('a turn with real text still stops `end`', async () => {
    __setChatTransportForTests(async () => ({
      text: 'done', blocks: [{ type: 'text', text: 'done' }] as ChatBlock[], stopReason: 'end', usage: noUsage,
      model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
    }));
    const result = await toolLoop({ initialMessages: [{ role: 'user', content: 'hi' }], tools: [], toolHandlers: new Map() });
    expect(result.stopReason).toBe('end');
  });
});

describe('direct Messages path (#6448)', () => {
  test('a blockless end_turn reports stop_reason=error, keeps the persisted rows and the token accounting', async () => {
    const client = new FakeMessagesClient([{ content: [] as any, stop_reason: 'end_turn' }]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const ctx = await makeCtx({ prompt: 'hi' });
    const result = await handler(ctx);
    expect(result.stop_reason).toBe('error');
    expect(result.result).toBe('');
    expect(result.turns_count).toBe(1);
    expect(result.tokens.in).toBe(10);
    expect(result.tokens.out).toBe(5);
    expect(await messageCount(ctx.id)).toBe(2); // user seed + the empty assistant turn, kept for replay
  });

  test('a whitespace-only text block is an empty response', async () => {
    const client = new FakeMessagesClient([{ content: [{ type: 'text', text: '  \n' }] as any, stop_reason: 'end_turn' }]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const result = await handler(await makeCtx({ prompt: 'hi' }));
    expect(result.stop_reason).toBe('error');
  });

  test('a provider refusal reports stop_reason=refusal', async () => {
    const client = new FakeMessagesClient([{ content: [] as any, stop_reason: 'refusal' as any }]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const result = await handler(await makeCtx({ prompt: 'hi' }));
    expect(result.stop_reason).toBe('refusal');
    expect(result.result).toBe('');
  });

  test('an output-cap stop with no text is still max_tokens', async () => {
    const client = new FakeMessagesClient([{ content: [] as any, stop_reason: 'max_tokens' }]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const result = await handler(await makeCtx({ prompt: 'hi', max_tokens: 1024 }));
    expect(result.stop_reason).toBe('max_tokens');
  });

  test('replay of a thinking-only terminal tail returns error without a provider request', async () => {
    const ctx = await makeCtx({ prompt: 'start' });
    await seed(ctx.id, 0, 'user', [{ type: 'text', text: 'start' }]);
    await seed(ctx.id, 1, 'assistant', [{ type: 'thinking', thinking: 'reasoning only, no answer' }], 50);
    const client = new FakeMessagesClient([]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const result = await handler(ctx);
    expect(client.calls.length).toBe(0);
    expect(result.stop_reason).toBe('error');
    expect(result.result).toBe('');
    expect(result.tokens.out).toBe(50);
  });

  test('replay of an empty tail that hit the cap stays max_tokens', async () => {
    const ctx = await makeCtx({ prompt: 'start', max_tokens: 50 });
    await seed(ctx.id, 0, 'user', [{ type: 'text', text: 'start' }]);
    await seed(ctx.id, 1, 'assistant', [], 50);
    const client = new FakeMessagesClient([]);
    const result = await makeSubagentHandler({ engine, client, toolRegistry: [] })(ctx);
    expect(client.calls.length).toBe(0);
    expect(result.stop_reason).toBe('max_tokens');
  });
});

describe('gateway path (#6448)', () => {
  beforeEach(async () => {
    await engine.setConfig('agent.use_gateway_loop', 'true');
  });

  function gatewayHandler() {
    return makeSubagentHandler({
      engine, config: {} as any, toolRegistry: [],
      makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path unused'); } } }) as any,
    });
  }

  test('a live empty completion reports stop_reason=error and persists the turn', async () => {
    __setChatTransportForTests(async () => ({
      text: '', blocks: [] as ChatBlock[], stopReason: 'end', usage: noUsage,
      model: 'openai:gpt-4o', providerId: 'openai',
    } satisfies ChatResult));
    const ctx = await makeCtx({ prompt: 'hi', model: 'openai:gpt-4o' });
    const result = await gatewayHandler()(ctx);
    expect(result.stop_reason).toBe('error');
    expect(result.result).toBe('');
    expect(await messageCount(ctx.id)).toBe(2);
  });

  test('a legacy thinking-only assistant tail is terminal: no new provider request, stop_reason=error', async () => {
    const ctx = await makeCtx({ prompt: 'start', model: 'openai:gpt-4o' });
    await seed(ctx.id, 0, 'user', [{ type: 'text', text: 'start' }], null, 2);
    await seed(ctx.id, 1, 'assistant', [{ type: 'reasoning', text: 'thought about it' }], 40, 2);
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return { text: 'SHOULD NOT RUN', blocks: [] as ChatBlock[], stopReason: 'end', usage: noUsage, model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult;
    });
    const result = await gatewayHandler()(ctx);
    expect(calls).toBe(0);
    expect(result.stop_reason).toBe('error');
    expect(result.result).toBe('');
    expect(result.tokens.out).toBe(40);
  });

  test('an empty tail persisted at the output cap replays as max_tokens, still without a request', async () => {
    const ctx = await makeCtx({ prompt: 'start', model: 'openai:gpt-4o', max_tokens: 40 });
    await seed(ctx.id, 0, 'user', [{ type: 'text', text: 'start' }], null, 2);
    await seed(ctx.id, 1, 'assistant', [], 40, 2);
    let calls = 0;
    __setChatTransportForTests(async () => {
      calls++;
      return { text: 'SHOULD NOT RUN', blocks: [] as ChatBlock[], stopReason: 'end', usage: noUsage, model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult;
    });
    const result = await gatewayHandler()(ctx);
    expect(calls).toBe(0);
    expect(result.stop_reason).toBe('max_tokens');
  });

  test('a text-bearing terminal tail still replays as end_turn with its text', async () => {
    const ctx = await makeCtx({ prompt: 'start', model: 'openai:gpt-4o' });
    await seed(ctx.id, 0, 'user', [{ type: 'text', text: 'start' }], null, 2);
    await seed(ctx.id, 1, 'assistant', [{ type: 'text', text: 'the final answer' }], 7, 2);
    __setChatTransportForTests(async () => { throw new Error('must not be called'); });
    const result = await gatewayHandler()(ctx);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.result).toBe('the final answer');
  });
});
