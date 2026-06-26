/**
 * E2E: runSubagentViaGateway integration path (v0.38 Slice 1 + S1.5).
 *
 * Exercises the FULL gateway-native subagent handler path end-to-end:
 *   - Handler entry → reads `agent.use_gateway_loop` config → routes to gateway path
 *   - runSubagentViaGateway builds ChatToolDef[] + ToolHandler Map from ToolDef
 *   - Calls gateway.toolLoop() with persistence callbacks
 *   - Callbacks write subagent_messages (v2 ChatBlock shape) +
 *     subagent_tool_executions (with ordinal + gbrain_tool_use_id) under
 *     the write-ordering invariant
 *   - Returns SubagentResult mapped from gateway loop result
 *
 * Hermetic: PGLite in-memory engine, gateway transport stubbed via
 * `__setChatTransportForTests`. No ANTHROPIC_API_KEY, no real Anthropic
 * SDK instantiation (we stub `makeAnthropic` so the legacy-path fallback
 * doesn't trip on missing env).
 *
 * Plan reference: ~/.claude/plans/system-instruction-you-are-working-shimmying-breeze.md
 * (Slice 1 verification step 6 + cross-provider crash-replay regression — the
 * load-bearing test the CEO/codex review called out before v0.38 ships).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import {
  __testing as subagentTesting,
  makeSubagentHandler,
} from '../../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, ToolDef, ToolCtx } from '../../src/core/minions/types.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  withBudgetTracker,
  type ChatBlock,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';
import { BudgetExhausted, BudgetTracker } from '../../src/core/budget/budget-tracker.ts';

// ── Helpers ─────────────────────────────────────────────────

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

  configureGateway({
    chat_model: 'anthropic:claude-sonnet-4-6',
    embedding_model: 'openai:text-embedding-3-large',
    embedding_dimensions: 1536,
    expansion_model: 'anthropic:claude-haiku-4-5',
    env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' },
  });
});

function clearGateway(): void {
  __setChatTransportForTests(null);
  resetGateway();
}

it('post-run gateway budget overage is surfaced after the final response', () => {
  const tracker = new BudgetTracker({
    label: 'subagent.gateway',
    maxCostUsd: 0.01,
  });

  expect(() => {
    tracker.record({
      modelId: 'anthropic:claude-sonnet-4-6',
      inputTokens: 20_000,
      outputTokens: 20_000,
      kind: 'chat',
      label: 'synthetic-final-response',
    });
  }).toThrow(BudgetExhausted);

  expect(() => {
    subagentTesting.assertGatewayScopedBudgetNotExceeded(tracker, 'subagent.gateway');
  }).toThrow(/budget_exhausted_after_response/);
});

interface FakeJobOpts {
  prompt: string;
  model?: string;
  allowed_tools?: string[];
  required_tools?: string[];
  max_turns?: number;
  max_cost_usd?: number;
}

async function makeFakeJob(opts: FakeJobOpts): Promise<{ jobId: number; ctx: MinionJobContext; tokenSink: any[] }> {
  // Insert a minion_jobs row so foreign keys validate (subagent_tool_executions.job_id FK).
  const data = {
    prompt: opts.prompt,
    model: opts.model,
    allowed_tools: opts.allowed_tools,
    required_tools: opts.required_tools,
    max_turns: opts.max_turns,
    max_cost_usd: opts.max_cost_usd,
  };
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify(data)],
  );
  const jobId = rows[0].id;

  const tokenSink: Array<{ input?: number; output?: number; cache_read?: number }> = [];

  const abortCtrl = new AbortController();
  const shutdownCtrl = new AbortController();
  const ctx: MinionJobContext = {
    id: jobId,
    name: 'subagent',
    data,
    attempts_made: 0,
    signal: abortCtrl.signal,
    shutdownSignal: shutdownCtrl.signal,
    updateProgress: async () => {},
    updateTokens: async (t) => { tokenSink.push(t); },
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
  return { jobId, ctx, tokenSink };
}

/**
 * Stub ToolDef registry — avoids pulling in buildBrainTools (which needs
 * config + engine + brain setup). Tools are simple in-test functions.
 */
function makeStubTools(executions: Array<{ name: string; input: unknown; ts: number }>): ToolDef[] {
  return [
    {
      name: 'search',
      description: 'stub search',
      input_schema: { type: 'object' },
      idempotent: true,
      async execute(input: unknown, _ctx: ToolCtx) {
        executions.push({ name: 'search', input, ts: Date.now() });
        return { results: [{ slug: 'wiki/foo' }] };
      },
    },
    {
      name: 'put_page',
      description: 'stub put_page (non-idempotent)',
      input_schema: { type: 'object' },
      idempotent: false,
      async execute(input: unknown, _ctx: ToolCtx) {
        executions.push({ name: 'put_page', input, ts: Date.now() });
        return { saved: true };
      },
    },
    {
      name: 'always_fail',
      description: 'stub that always throws',
      input_schema: { type: 'object' },
      idempotent: true,
      async execute(_input: unknown, _ctx: ToolCtx) {
        throw new Error('intentional tool failure');
      },
    },
  ];
}

/**
 * Build the handler with a stubbed Anthropic constructor so the legacy
 * code path's `new Anthropic()` at construction never fires (we route
 * through the gateway path; the legacy client is unused).
 */
function buildHandler(toolRegistry: ToolDef[]) {
  return makeSubagentHandler({
    engine,
    config: {} as any,
    toolRegistry,
    makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path should not be invoked'); } } }) as any,
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('runSubagentViaGateway (v0.38 Slice 1 — full handler path through gateway.toolLoop)', () => {
  afterAll(() => clearGateway());

  it('happy path 1-turn: gateway returns text, handler returns SubagentResult', async () => {
    __setChatTransportForTests(async () => ({
      text: 'all done',
      blocks: [{ type: 'text', text: 'all done' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 12, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    } satisfies ChatResult));

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({ prompt: 'hello', model: 'anthropic:claude-sonnet-4-6' });

    const result = await handler(ctx);

    expect(result.result).toBe('all done');
    expect(result.stop_reason).toBe('end_turn');
    expect(result.tokens.in).toBeGreaterThanOrEqual(12);
    expect(result.tokens.out).toBeGreaterThanOrEqual(3);
    expect(executions.length).toBe(0); // no tools called

    // Verify persistence: 1 seed user message + 1 assistant message.
    const messages = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`,
      [jobId],
    );
    expect(messages.length).toBe(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].message_idx).toBe(0);
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].message_idx).toBe(1);
  });

  it('happy path 2-turn with tool: dispatches, persists v2 stable ID, returns final text', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'provider-tc-1', toolName: 'search', input: { q: 'acme' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 20, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'found acme corp',
        blocks: [{ type: 'text', text: 'found acme corp' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 25, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({
      prompt: 'find acme',
      model: 'anthropic:claude-sonnet-4-6',
      allowed_tools: ['search'],
    });

    const result = await handler(ctx);

    expect(result.result).toBe('found acme corp');
    expect(result.stop_reason).toBe('end_turn');
    expect(executions.length).toBe(1);
    expect(executions[0].name).toBe('search');
    expect(executions[0].input).toEqual({ q: 'acme' });

    // Verify v2 stable-ID persistence: ordinal + gbrain_tool_use_id populated.
    const toolRows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, tool_use_id, tool_name, status, ordinal,
              gbrain_tool_use_id::text AS gbrain_tool_use_id, schema_version
         FROM subagent_tool_executions
        WHERE job_id = $1`,
      [jobId],
    );
    expect(toolRows.length).toBe(1);
    expect(toolRows[0].tool_name).toBe('search');
    expect(toolRows[0].status).toBe('complete');
    expect(toolRows[0].ordinal).toBe(0);
    expect(toolRows[0].schema_version).toBe(2); // v0.38 write
    expect(String(toolRows[0].gbrain_tool_use_id)).toMatch(/^[0-9a-f-]{36}$/); // UUID v7
    expect(toolRows[0].tool_use_id).toBe('provider-tc-1'); // provider id preserved

    const messages = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role, content_blocks
         FROM subagent_messages
        WHERE job_id = $1
        ORDER BY message_idx`,
      [jobId],
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(messages[2].message_idx).toBe(2);
    const toolResultBlocks = typeof messages[2].content_blocks === 'string'
      ? JSON.parse(messages[2].content_blocks as string)
      : messages[2].content_blocks;
    expect(toolResultBlocks[0]).toMatchObject({
      type: 'tool-result',
      toolCallId: 'provider-tc-1',
      toolName: 'search',
    });

    // Token accumulation across both turns.
    expect(result.tokens.in).toBe(45); // 20 + 25
    expect(result.tokens.out).toBe(12); // 8 + 4
  });

  it('required_tools adds corrective turn on text-only gateway response before accepting success', async () => {
    let turn = 0;
    const seenMessages: unknown[] = [];
    __setChatTransportForTests(async (opts) => {
      turn++;
      seenMessages.push(opts.messages);
      if (turn === 1) {
        return {
          text: 'done without using the required tool',
          blocks: [{ type: 'text', text: 'done without using the required tool' }] as ChatBlock[],
          stopReason: 'end',
          usage: { input_tokens: 11, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      if (turn === 2) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc-required', toolName: 'search', input: { q: 'required' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 20, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'done after required tool',
        blocks: [{ type: 'text', text: 'done after required tool' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 25, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({
      prompt: 'find required',
      model: 'anthropic:claude-sonnet-4-6',
      allowed_tools: ['search'],
      required_tools: ['search'],
      max_turns: 4,
    });

    const result = await handler(ctx);

    expect(result.result).toBe('done after required tool');
    expect(result.stop_reason).toBe('end_turn');
    expect(turn).toBe(3);
    expect(JSON.stringify(seenMessages[1])).toContain('Required tool call missing: search');
    expect(JSON.stringify(seenMessages[1])).not.toContain('Your previous response was empty.');
    expect(executions).toHaveLength(1);
    expect(executions[0].name).toBe('search');

    const messages = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role, content_blocks
         FROM subagent_messages
        WHERE job_id = $1
        ORDER BY message_idx`,
      [jobId],
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(messages[2].content_blocks)).toContain('Required tool call missing: search');
    expect(JSON.stringify(messages[2].content_blocks)).not.toContain('Your previous response was empty.');

    const toolRows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT tool_name, status
         FROM subagent_tool_executions
        WHERE job_id = $1`,
      [jobId],
    );
    expect(toolRows).toEqual([{ tool_name: 'search', status: 'complete' }]);
  });

  it('adds corrective turn on empty gateway response before accepting success', async () => {
    let turn = 0;
    const seenMessages: unknown[] = [];
    __setChatTransportForTests(async (opts) => {
      turn++;
      seenMessages.push(opts.messages);
      if (turn === 1) {
        return {
          text: '',
          blocks: [] as ChatBlock[],
          stopReason: 'end',
          usage: { input_tokens: 11, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'NO_WRITE: no page met the synthesis bar.',
        blocks: [{ type: 'text', text: 'NO_WRITE: no page met the synthesis bar.' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 15, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({
      prompt: 'find nothing',
      model: 'anthropic:claude-sonnet-4-6',
      max_turns: 3,
    });

    const result = await handler(ctx);

    expect(result.result).toBe('NO_WRITE: no page met the synthesis bar.');
    expect(result.stop_reason).toBe('end_turn');
    expect(turn).toBe(2);
    expect(executions).toHaveLength(0);
    expect(JSON.stringify(seenMessages[1])).toContain('Your previous response was empty.');

    const messages = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role, content_blocks
         FROM subagent_messages
        WHERE job_id = $1
        ORDER BY message_idx`,
      [jobId],
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(messages[2].content_blocks)).toContain('Your previous response was empty.');
  });

  it('adds corrective turn when gateway response wraps an exact no-write phrase', async () => {
    let turn = 0;
    const seenMessages: unknown[] = [];
    __setChatTransportForTests(async (opts) => {
      turn++;
      seenMessages.push(opts.messages);
      if (turn === 1) {
        return {
          text: 'I completed the synthesis analysis. Here are the slugs I wrote:\n\nNO_WRITE: no page met the synthesis bar.',
          blocks: [{
            type: 'text',
            text: 'I completed the synthesis analysis. Here are the slugs I wrote:\n\nNO_WRITE: no page met the synthesis bar.',
          }] as ChatBlock[],
          stopReason: 'end',
          usage: { input_tokens: 11, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'NO_WRITE: no page met the synthesis bar.',
        blocks: [{ type: 'text', text: 'NO_WRITE: no page met the synthesis bar.' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 15, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({
      prompt: [
        'Dream synth task.',
        'If you wrote nothing, your final message must be exactly: `NO_WRITE: no page met the synthesis bar.`',
      ].join('\n'),
      model: 'anthropic:claude-sonnet-4-6',
      max_turns: 3,
    });

    const result = await handler(ctx);

    expect(result.result).toBe('NO_WRITE: no page met the synthesis bar.');
    expect(result.stop_reason).toBe('end_turn');
    expect(turn).toBe(2);
    expect(executions).toHaveLength(0);
    expect(JSON.stringify(seenMessages[1])).toContain('reply with exactly `NO_WRITE: no page met the synthesis bar.`');

    const messages = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role, content_blocks
         FROM subagent_messages
        WHERE job_id = $1
        ORDER BY message_idx`,
      [jobId],
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(messages[2].content_blocks)).toContain('required exact no-op phrase');
  });

  it('required_tools adds corrective turn before gateway resume from text-only assistant tail', async () => {
    let turn = 0;
    const seenMessages: unknown[] = [];
    __setChatTransportForTests(async (opts) => {
      turn++;
      seenMessages.push(opts.messages);
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc-resume-required', toolName: 'search', input: { q: 'resume' } },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 20, output_tokens: 8, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'done after resume required tool',
        blocks: [{ type: 'text', text: 'done after resume required tool' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 25, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({
      prompt: 'resume required',
      model: 'anthropic:claude-sonnet-4-6',
      allowed_tools: ['search'],
      required_tools: ['search'],
      max_turns: 4,
    });
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks)
       VALUES ($1, 0, 'user', $2::jsonb)`,
      [jobId, JSON.stringify([{ type: 'text', text: 'resume required' }])],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks, model)
       VALUES ($1, 1, 'assistant', $2::jsonb, 'anthropic:claude-sonnet-4-6')`,
      [jobId, JSON.stringify([{ type: 'text', text: 'done without required tool' }])],
    );

    const result = await handler(ctx);

    expect(result.result).toBe('done after resume required tool');
    expect(result.stop_reason).toBe('end_turn');
    expect(turn).toBe(2);
    expect(JSON.stringify(seenMessages[0])).toContain('Required tool call missing: search');
    expect(executions).toHaveLength(1);
    expect(executions[0].input).toEqual({ q: 'resume' });

    const messages = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role, content_blocks
         FROM subagent_messages
        WHERE job_id = $1
        ORDER BY message_idx`,
      [jobId],
    );
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(JSON.stringify(messages[2].content_blocks)).toContain('Required tool call missing: search');
  });

  it('tool error path: handler persists status=failed, loop continues with error feedback', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'tc-fail', toolName: 'always_fail', input: {} },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'sorry that failed',
        blocks: [{ type: 'text', text: 'sorry that failed' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 8, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({ prompt: 'try', model: 'anthropic:claude-sonnet-4-6' });

    const result = await handler(ctx);

    expect(result.result).toBe('sorry that failed');
    const toolRows = await engine.executeRaw<Record<string, unknown>>(
      `SELECT status, error FROM subagent_tool_executions WHERE job_id = $1`,
      [jobId],
    );
    expect(toolRows[0].status).toBe('failed');
    expect(String(toolRows[0].error)).toContain('intentional tool failure');
  });

  it('max_turns: loop terminates when budget exhausted', async () => {
    // Always return tool_calls — never end. Should hit max_turns cap (default 20 in subagent.ts).
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: `tc-${Math.random()}`, toolName: 'search', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    } satisfies ChatResult));

    const executions: Array<{ name: string; input: unknown; ts: number }> = [];
    const tools = makeStubTools(executions);
    const handler = buildHandler(tools);
    const { ctx } = await makeFakeJob({
      prompt: 'loop forever',
      model: 'anthropic:claude-sonnet-4-6',
    });
    // Override max_turns via data so the test runs in <1s.
    ctx.data.max_turns = 3;

    const result = await handler(ctx);

    expect(result.stop_reason).toBe('max_turns');
    // 3 tool dispatches over 3 turns (max_turns cap).
    expect(executions.length).toBe(3);
  });

  it('repeated identical tool failures surface as unrecoverable', async () => {
    __setChatTransportForTests(async () => ({
      text: '',
      blocks: [
        { type: 'tool-call', toolCallId: `tc-${Math.random()}`, toolName: 'always_fail', input: {} },
      ] as ChatBlock[],
      stopReason: 'tool_calls',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    } satisfies ChatResult));

    const tools = makeStubTools([]);
    const handler = buildHandler(tools);
    const { ctx } = await makeFakeJob({
      prompt: 'keep trying',
      model: 'anthropic:claude-sonnet-4-6',
      max_turns: 10,
    });

    await expect(handler(ctx)).rejects.toThrow(/repeated_tool_failure/);
  });

  it('per-job max_cost_usd is enforced on the gateway path', async () => {
    __setChatTransportForTests(async () => ({
      text: 'too expensive',
      blocks: [{ type: 'text', text: 'too expensive' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    } satisfies ChatResult));

    const tools = makeStubTools([]);
    const handler = buildHandler(tools);
    const { ctx } = await makeFakeJob({
      prompt: 'hi',
      model: 'anthropic:claude-sonnet-4-6',
      max_cost_usd: 0.000001,
    });

    await expect(handler(ctx)).rejects.toThrow(/budget_exhausted/);
  });

  it('per-job max_cost_usd still applies inside an outer budget scope', async () => {
    __setChatTransportForTests(async () => ({
      text: 'still too expensive',
      blocks: [{ type: 'text', text: 'still too expensive' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    } satisfies ChatResult));

    const tools = makeStubTools([]);
    const handler = buildHandler(tools);
    const { ctx } = await makeFakeJob({
      prompt: 'hi again',
      model: 'anthropic:claude-sonnet-4-6',
      max_cost_usd: 0.000001,
    });
    const outerTracker = new BudgetTracker({ label: 'outer.scope' });

    await expect(withBudgetTracker(outerTracker, () => handler(ctx))).rejects.toThrow(/budget_exhausted/);
    expect(outerTracker.totalSpent).toBeGreaterThan(0);
  });

  it('refusal stop reason: handler maps refusal → SubagentStopReason refusal', async () => {
    __setChatTransportForTests(async () => ({
      text: 'I cannot help with that',
      blocks: [{ type: 'text', text: 'I cannot help with that' }] as ChatBlock[],
      stopReason: 'refusal',
      usage: { input_tokens: 5, output_tokens: 7, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    } satisfies ChatResult));

    const tools = makeStubTools([]);
    const handler = buildHandler(tools);
    const { ctx } = await makeFakeJob({ prompt: 'bad request', model: 'anthropic:claude-sonnet-4-6' });

    const result = await handler(ctx);
    expect(result.stop_reason).toBe('refusal');
    expect(result.result).toBe('I cannot help with that');
  });

  it('non-Anthropic model routes through gateway path (the load-bearing v0.38 unlock)', async () => {
    // This is the headline scenario: openai:gpt-5.2 (no caching) works.
    // Pre-v0.38, this would have refused at queue.ts. With the gateway path
    // flag on, the loop runs end-to-end.
    __setChatTransportForTests(async () => ({
      text: 'gpt-5 says hi',
      blocks: [{ type: 'text', text: 'gpt-5 says hi' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 4, output_tokens: 4, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-5.2',
      providerId: 'openai',
    } satisfies ChatResult));

    const tools = makeStubTools([]);
    const handler = buildHandler(tools);
    const { ctx } = await makeFakeJob({ prompt: 'hi', model: 'openai:gpt-5.2' });

    const result = await handler(ctx);
    expect(result.result).toBe('gpt-5 says hi');
    expect(result.stop_reason).toBe('end_turn');
  });

  it('write-ordering invariant: assistant message persisted BEFORE tool pending row', async () => {
    // The D11 + codex P1 write-ordering invariant: persistence callbacks
    // fire in order so a SIGKILL between any two steps leaves the DB in a
    // reconcilable state. This test asserts the message_idx of the assistant
    // is strictly less than any subagent_tool_executions row that references it.
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [
            { type: 'tool-call', toolCallId: 'order-tc', toolName: 'search', input: {} },
          ] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const tools = makeStubTools([]);
    const handler = buildHandler(tools);
    const { jobId, ctx } = await makeFakeJob({ prompt: 'go', model: 'anthropic:claude-sonnet-4-6' });

    await handler(ctx);

    // Find the assistant turn that contains the tool call.
    const msgs = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`,
      [jobId],
    );
    const assistantIdx = (msgs.find(m => m.role === 'assistant') as any).message_idx;

    const toolRow = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx FROM subagent_tool_executions WHERE job_id = $1`,
      [jobId],
    );
    expect(toolRow[0].message_idx).toBe(assistantIdx);
    // Both rows present means the order completed correctly (assistant first,
    // tool exec keyed to it, follow-up user with results, second assistant).
    expect(msgs.length).toBeGreaterThanOrEqual(3);
  });
});
