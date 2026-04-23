/**
 * Subagent handler tests with a mocked Anthropic Messages client.
 *
 * Strategy: every test scripts a sequence of Messages API responses, hands
 * them to a FakeMessagesClient, and inspects (a) the SubagentResult the
 * handler returns and (b) the persisted rows in subagent_messages +
 * subagent_tool_executions. Replay tests simulate a crash by constructing
 * a fresh handler bound to the same job row with partial state already
 * written.
 *
 * PGLite in-memory so the schema, ON CONFLICT, and two-phase persistence
 * all exercise real SQL.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  makeSubagentHandler,
  RateLeaseUnavailableError,
  type MessagesClient,
} from '../src/core/minions/handlers/subagent.ts';
import type { ToolDef, MinionJobContext } from '../src/core/minions/types.ts';
import type Anthropic from '@anthropic-ai/sdk';

let engine: PGLiteEngine;
let queue: MinionQueue;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
});

// ── FakeMessagesClient ──────────────────────────────────────

type FakeResponse = Partial<Anthropic.Message> & { content: Anthropic.Message['content'] };

class FakeMessagesClient implements MessagesClient {
  public calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  constructor(private responses: FakeResponse[]) {}
  async create(
    params: Anthropic.MessageCreateParamsNonStreaming,
  ): Promise<Anthropic.Message> {
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

// Build a synthetic MinionJobContext around a real minion_jobs row. The
// handler only reads data/id/signal/shutdownSignal/updateTokens — we stub
// the rest. `subagent` is a protected job name (Lane 4H) so tests submit
// under the trusted-submit flag.
async function makeCtx(input: unknown): Promise<MinionJobContext> {
  const job = await queue.add(
    'subagent',
    input as Record<string, unknown>,
    {},
    { allowProtectedSubmit: true },
  );
  const ac = new AbortController();
  const shutdown = new AbortController();
  return {
    id: job.id,
    name: job.name,
    data: (input as Record<string, unknown>) ?? {},
    attempts_made: 0,
    signal: ac.signal,
    shutdownSignal: shutdown.signal,
    async updateProgress() {},
    async updateTokens() {},
    async log() {},
    async isActive() { return true; },
    async readInbox() { return []; },
  };
}

// ── Tiny tool registry for tests ────────────────────────────

function makeEchoTool(name = 'echo', idempotent = true): ToolDef {
  return {
    name,
    description: 'echo input',
    input_schema: { type: 'object', properties: { value: { type: 'string' } }, required: [] },
    idempotent,
    async execute(input) { return { echoed: input }; },
  };
}

function makeThrowingTool(name = 'broken'): ToolDef {
  return {
    name,
    description: 'always throws',
    input_schema: { type: 'object', properties: {}, required: [] },
    idempotent: true,
    async execute() { throw new Error('tool broken'); },
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('subagent handler happy path', () => {
  test('no-tool end_turn: returns text response + persists user + assistant rows', async () => {
    const client = new FakeMessagesClient([
      { content: [{ type: 'text', text: 'hello world' }] as any, stop_reason: 'end_turn' },
    ]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const ctx = await makeCtx({ prompt: 'hi' });

    const result = await handler(ctx);

    expect(result.result).toBe('hello world');
    expect(result.turns_count).toBe(1);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.tokens.in).toBe(10);
    expect(result.tokens.out).toBe(5);

    const msgs = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM subagent_messages WHERE job_id = $1`,
      [ctx.id],
    );
    expect(parseInt(msgs[0]!.count, 10)).toBe(2); // user seed + assistant
  });

  test('single tool_use turn: tool executes, two-phase row goes complete', async () => {
    const tool = makeEchoTool();
    const client = new FakeMessagesClient([
      {
        content: [
          { type: 'tool_use', id: 'tu_1', name: 'echo', input: { value: 'v1' } } as any,
        ],
        stop_reason: 'tool_use' as any,
      },
      {
        content: [{ type: 'text', text: 'done' }] as any,
        stop_reason: 'end_turn',
      },
    ]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [tool] });
    const ctx = await makeCtx({ prompt: 'go' });

    const result = await handler(ctx);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.result).toBe('done');
    expect(client.calls.length).toBe(2);

    // tool_executions row complete with echoed output
    const rows = await engine.executeRaw<{ status: string; output: unknown }>(
      `SELECT status, output FROM subagent_tool_executions WHERE job_id = $1`,
      [ctx.id],
    );
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('complete');
    const out = typeof rows[0]!.output === 'string' ? JSON.parse(rows[0]!.output as string) : rows[0]!.output;
    expect(out).toEqual({ echoed: { value: 'v1' } });
  });

  test('tool throws: row goes failed, model sees error, loop continues', async () => {
    const tool = makeThrowingTool();
    const client = new FakeMessagesClient([
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'broken', input: {} } as any],
        stop_reason: 'tool_use' as any,
      },
      {
        content: [{ type: 'text', text: 'recovered' }] as any,
        stop_reason: 'end_turn',
      },
    ]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [tool] });
    const ctx = await makeCtx({ prompt: 'try' });

    const result = await handler(ctx);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.result).toBe('recovered');

    const rows = await engine.executeRaw<{ status: string; error: string | null }>(
      `SELECT status, error FROM subagent_tool_executions WHERE job_id = $1`,
      [ctx.id],
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toContain('tool broken');
  });

  test('unknown tool name fails execution but loop continues', async () => {
    const client = new FakeMessagesClient([
      {
        content: [{ type: 'tool_use', id: 'tu_nope', name: 'no_such_tool', input: {} } as any],
        stop_reason: 'tool_use' as any,
      },
      { content: [{ type: 'text', text: 'ok' }] as any, stop_reason: 'end_turn' },
    ]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const ctx = await makeCtx({ prompt: 'x' });

    const result = await handler(ctx);
    expect(result.stop_reason).toBe('end_turn');

    const rows = await engine.executeRaw<{ status: string; error: string | null }>(
      `SELECT status, error FROM subagent_tool_executions WHERE job_id = $1`,
      [ctx.id],
    );
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.error).toContain('not in the registry');
  });

  test('max_turns exceeded returns stop_reason=max_turns', async () => {
    // Model keeps calling tool_use forever; we cap at 2 turns.
    const echoing: FakeResponse[] = Array.from({ length: 5 }).map((_, i) => ({
      content: [{ type: 'tool_use', id: `tu_${i}`, name: 'echo', input: {} } as any],
      stop_reason: 'tool_use' as any,
    }));
    const client = new FakeMessagesClient(echoing);
    const tool = makeEchoTool();
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [tool] });
    const ctx = await makeCtx({ prompt: 'loop', max_turns: 2 });

    const result = await handler(ctx);
    expect(result.stop_reason).toBe('max_turns');
    expect(result.turns_count).toBe(2);
  });
});

describe('subagent handler replay (crash recovery)', () => {
  test('resumes from persisted messages when prior rows exist', async () => {
    // Seed an in-progress conversation by running the first client, then
    // running a second handler on the SAME job with responses starting at
    // turn 2. No duplicate user-seed row (ON CONFLICT DO NOTHING).
    const tool = makeEchoTool();
    const client1 = new FakeMessagesClient([
      {
        content: [{ type: 'tool_use', id: 'tu_1', name: 'echo', input: { v: 1 } } as any],
        stop_reason: 'tool_use' as any,
      },
    ]);
    const handler1 = makeSubagentHandler({ engine, client: client1, toolRegistry: [tool] });
    const ctx = await makeCtx({ prompt: 'start' });

    // Run handler1 until it WOULD make a second LLM call — force that
    // second call to error so we persist only the first assistant message.
    try {
      const client1b = new FakeMessagesClient([
        {
          content: [{ type: 'tool_use', id: 'tu_1', name: 'echo', input: { v: 1 } } as any],
          stop_reason: 'tool_use' as any,
        },
      ]);
      const interrupted = makeSubagentHandler({ engine, client: client1b, toolRegistry: [tool] });
      await interrupted(ctx);
    } catch {
      // Out-of-scripted-responses — simulates worker kill before turn 2.
    }

    // Confirm partial state: 1 user + 1 assistant + 1 synthesized user
    // (tool_result) + 1 tool_exec complete.
    const preRows = await engine.executeRaw<{ c: string }>(
      `SELECT count(*)::text AS c FROM subagent_messages WHERE job_id = $1`,
      [ctx.id],
    );
    const preCount = parseInt(preRows[0]!.c, 10);
    expect(preCount).toBeGreaterThanOrEqual(1);

    // Resume with a fresh handler + client that supplies ONE more response.
    const client2 = new FakeMessagesClient([
      { content: [{ type: 'text', text: 'resumed ok' }] as any, stop_reason: 'end_turn' },
    ]);
    const handler2 = makeSubagentHandler({ engine, client: client2, toolRegistry: [tool] });
    const result = await handler2(ctx);

    expect(result.result).toBe('resumed ok');
    expect(result.stop_reason).toBe('end_turn');
    // Second client should see the prior conversation in the messages
    // array — at minimum the user seed + prior assistant + tool_result.
    expect(client2.calls[0]!.messages.length).toBeGreaterThan(1);
  });

  test('prior completed tool exec is replayed without re-invoking execute', async () => {
    // Prior state: a completed tool row. We assert the tool's execute is
    // NOT called on resume. Use a tool that throws if invoked — passing
    // means we used the replay path.
    const throwingTool = makeThrowingTool('pre_done');
    const ctx = await makeCtx({ prompt: 'start' });

    // Seed prior state manually: user, assistant with tool_use, tool_exec complete.
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks)
       VALUES ($1, 0, 'user', $2::jsonb)`,
      [ctx.id, JSON.stringify([{ type: 'text', text: 'start' }])],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks, model)
       VALUES ($1, 1, 'assistant', $2::jsonb, 'claude-sonnet-4-6')`,
      [
        ctx.id,
        JSON.stringify([
          { type: 'tool_use', id: 'tu_seeded', name: 'pre_done', input: {} },
        ]),
      ],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output)
       VALUES ($1, 1, 'tu_seeded', 'pre_done', '{}'::jsonb, 'complete', $2::jsonb)`,
      [ctx.id, JSON.stringify({ replayed: true })],
    );

    // Handler MUST NOT call the throwing execute and MUST end the loop on
    // the next LLM response.
    const client = new FakeMessagesClient([
      { content: [{ type: 'text', text: 'finished after replay' }] as any, stop_reason: 'end_turn' },
    ]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [throwingTool] });
    const result = await handler(ctx);

    expect(result.stop_reason).toBe('end_turn');
    expect(result.result).toBe('finished after replay');
    // Only one LLM call made on this resume (we had 2 persisted messages +
    // the tool result synthesis happened when resuming, then model spoke).
    expect(client.calls.length).toBe(1);
  });

  test('pending non-idempotent tool exec rejects on resume', async () => {
    const nonIdempotent = { ...makeEchoTool('do_once'), idempotent: false };
    const ctx = await makeCtx({ prompt: 'start' });
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks)
       VALUES ($1, 0, 'user', $2::jsonb)`,
      [ctx.id, JSON.stringify([{ type: 'text', text: 'start' }])],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks)
       VALUES ($1, 1, 'assistant', $2::jsonb)`,
      [
        ctx.id,
        JSON.stringify([{ type: 'tool_use', id: 'tu_x', name: 'do_once', input: {} }]),
      ],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status)
       VALUES ($1, 1, 'tu_x', 'do_once', '{}'::jsonb, 'pending')`,
      [ctx.id],
    );

    const client = new FakeMessagesClient([]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [nonIdempotent] });
    await expect(handler(ctx)).rejects.toThrow(/non-idempotent/);
  });
});

describe('subagent handler lease behavior', () => {
  test('acquires + releases a lease around the LLM call', async () => {
    const client = new FakeMessagesClient([
      { content: [{ type: 'text', text: 'ok' }] as any, stop_reason: 'end_turn' },
    ]);
    const handler = makeSubagentHandler({
      engine, client, toolRegistry: [], maxConcurrent: 1, rateLeaseKey: 'k1',
    });
    const ctx = await makeCtx({ prompt: 'hi' });
    await handler(ctx);
    // No leases should remain after completion.
    const rows = await engine.executeRaw<{ c: string }>(
      `SELECT count(*)::text AS c FROM subagent_rate_leases`,
    );
    expect(parseInt(rows[0]!.c, 10)).toBe(0);
  });

  test('throws RateLeaseUnavailableError when cap full', async () => {
    // Preload the cap with a stale-looking-but-live lease owned by a
    // different job.
    const owner = await queue.add('holder', {});
    await engine.executeRaw(
      `INSERT INTO subagent_rate_leases (key, owner_job_id, expires_at)
       VALUES ('k_cap', $1, now() + interval '1 minute')`,
      [owner.id],
    );
    const client = new FakeMessagesClient([]);
    const handler = makeSubagentHandler({
      engine, client, toolRegistry: [], maxConcurrent: 1, rateLeaseKey: 'k_cap',
    });
    const ctx = await makeCtx({ prompt: 'blocked' });
    await expect(handler(ctx)).rejects.toBeInstanceOf(RateLeaseUnavailableError);
  });
});

describe('subagent handler input validation', () => {
  test('missing prompt throws', async () => {
    const client = new FakeMessagesClient([]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [] });
    const ctx = await makeCtx({});
    await expect(handler(ctx)).rejects.toThrow(/prompt/);
  });

  test('allowed_tools unknown name rejected at dispatch', async () => {
    const tool = makeEchoTool('real');
    const client = new FakeMessagesClient([]);
    const handler = makeSubagentHandler({ engine, client, toolRegistry: [tool] });
    const ctx = await makeCtx({ prompt: 'x', allowed_tools: ['real', 'ghost_tool'] });
    await expect(handler(ctx)).rejects.toThrow(/unknown tool/);
  });
});

describe('makeSubagentHandler default client construction', () => {
  test('factory default wires sdk.messages through to the handler', async () => {
    // Regression guard for the v0.16.0 shipped bug: makeSubagentHandler
    // was casting `new Anthropic()` (top-level SDK class) to MessagesClient,
    // but `.create()` lives at sdk.messages.create. Every subagent job in
    // production died with "client.create is not a function" on first LLM
    // call. This test exercises the default-client path (no `deps.client`
    // injected) via the makeAnthropic dep-injection seam, so the exact
    // default-branch construction is covered without a real API call.
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const fakeSdk = {
      messages: {
        async create(
          params: Anthropic.MessageCreateParamsNonStreaming,
        ): Promise<Anthropic.Message> {
          calls.push(params);
          return {
            id: 'msg_regression',
            type: 'message',
            role: 'assistant',
            model: params.model,
            stop_reason: 'end_turn',
            stop_sequence: null,
            content: [{ type: 'text', text: 'ok' }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          } as unknown as Anthropic.Message;
        },
      },
    } as unknown as Anthropic;

    // Crucial: do NOT pass `client`. Only `makeAnthropic`. This forces the
    // factory to hit the default-client branch (`deps.client ?? makeAnthropic().messages`).
    const handler = makeSubagentHandler({
      engine,
      makeAnthropic: () => fakeSdk,
      toolRegistry: [],
    });
    const ctx = await makeCtx({ prompt: 'hello' });
    const result = await handler(ctx);

    expect(calls.length).toBe(1);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.result).toBe('ok');
  });
});
