/**
 * E2E regression: gateway-path subagent loop persists tool-result messages and
 * heals pre-fix histories on resume.
 *
 * Root cause this guards (gotcha #16): the gateway tool-loop persisted assistant
 * turns and per-tool execution rows but NEVER persisted the user-role message
 * carrying the tool results. On any resume (worker restart / re-claim) the
 * rebuilt conversation ended with an assistant turn whose tool-calls had no
 * matching tool-result message — AI SDK v6 then rejects the prompt with
 * "Tool results are missing for tool calls ..." (or "messages do not match the
 * ModelMessage[] schema" when it was the last message) and the job loops to
 * max_attempts. The legacy Anthropic-direct path always persisted this message;
 * the gateway path dropped it (`void userMessageIdx`).
 *
 * Two guarantees:
 *   1. Forward fix — a multi-turn tool flow persists contiguous message_idx
 *      (0,1,2,3,...) with the tool-result user message at every even index.
 *   2. Self-healing replay — a job corrupted by the OLD behavior (assistant
 *      tool-call turn with NO following tool-result message) resumes cleanly:
 *      the missing message is reconstructed from subagent_tool_executions, the
 *      tool is NOT re-executed, and the job completes.
 *
 * Hermetic: PGLite in-memory engine, gateway transport stubbed.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, ToolDef, ToolCtx } from '../../src/core/minions/types.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
  type ChatBlock,
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

async function makeFakeJob(prompt: string, model: string): Promise<{ jobId: number; ctx: MinionJobContext; executions: Array<{ name: string }> }> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify({ prompt, model })],
  );
  const jobId = rows[0].id;
  const executions: Array<{ name: string }> = [];
  const ctx: MinionJobContext = {
    id: jobId,
    name: 'subagent',
    data: { prompt, model },
    attempts_made: 0,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
  return { jobId, ctx, executions };
}

function searchTool(executions: Array<{ name: string }>): ToolDef[] {
  return [{
    name: 'search',
    description: 'stub search',
    input_schema: { type: 'object' },
    idempotent: true,
    async execute(_input: unknown, _ctx: ToolCtx) {
      executions.push({ name: 'search' });
      return { results: [{ slug: 'wiki/foo' }] };
    },
  }];
}

function buildHandler(toolRegistry: ToolDef[]) {
  return makeSubagentHandler({
    engine,
    config: {} as any,
    toolRegistry,
    makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path should not be invoked'); } } }) as any,
  });
}

describe('gateway subagent resume (gotcha #16 — tool-result message persistence)', () => {
  afterAll(() => clearGateway());

  it('forward fix: a 2-turn tool flow persists the tool-result user message (no message_idx gap)', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) {
        return {
          text: '',
          blocks: [{ type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', input: { q: 'acme' } }] as ChatBlock[],
          stopReason: 'tool_calls',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-sonnet-4-6',
          providerId: 'anthropic',
        } satisfies ChatResult;
      }
      return {
        text: 'done',
        blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 8, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string }> = [];
    const handler = buildHandler(searchTool(executions));
    const { jobId, ctx } = await makeFakeJob('find acme', 'anthropic:claude-sonnet-4-6');
    const result = await handler(ctx);

    expect(result.result).toBe('done');

    const msgs = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`,
      [jobId],
    );
    // Contiguous: user(0) → assistant w/ tool-call(1) → user w/ tool-result(2) → assistant(3).
    expect(msgs.map(m => [m.message_idx, m.role])).toEqual([
      [0, 'user'], [1, 'assistant'], [2, 'user'], [3, 'assistant'],
    ]);

    // The idx-2 user message must actually carry the tool-result block.
    const idx2 = await engine.executeRaw<{ content_blocks: unknown }>(
      `SELECT content_blocks FROM subagent_messages WHERE job_id = $1 AND message_idx = 2`,
      [jobId],
    );
    const blocks = typeof idx2[0].content_blocks === 'string'
      ? JSON.parse(idx2[0].content_blocks as string)
      : idx2[0].content_blocks;
    expect(Array.isArray(blocks)).toBe(true);
    expect((blocks as any[])[0].type).toBe('tool-result');
    expect((blocks as any[])[0].toolCallId).toBe('tc-1');
  });

  it('self-healing resume: a pre-fix corrupted job (missing tool-result message) completes without re-executing the tool', async () => {
    const { jobId, ctx } = await makeFakeJob('find acme', 'anthropic:claude-sonnet-4-6');

    // Seed a job in the BROKEN pre-fix shape: user(0), assistant-with-tool-call(1),
    // a completed tool execution at idx 1 — but NO tool-result user message at idx 2.
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks) VALUES
         ($1, 0, 'user', $2::jsonb),
         ($1, 1, 'assistant', $3::jsonb)`,
      [
        jobId,
        JSON.stringify([{ type: 'text', text: 'find acme' }]),
        JSON.stringify([
          { type: 'text', text: 'let me search' },
          { type: 'tool-call', toolCallId: 'tc-1', toolName: 'search', input: { q: 'acme' } },
        ]),
      ],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status, output, schema_version, ordinal, gbrain_tool_use_id, provider_id)
       VALUES ($1, 1, 'tc-1', 'search', $2::jsonb, 'complete', $3::jsonb, 2, 0, gen_random_uuid(), 'anthropic')`,
      [jobId, JSON.stringify({ q: 'acme' }), JSON.stringify({ results: [{ slug: 'wiki/foo' }] })],
    );

    // On resume the loop's FIRST chat() must receive a valid history (the healed
    // tool-result message), so it returns the final answer.
    __setChatTransportForTests(async () => ({
      text: 'recovered and done',
      blocks: [{ type: 'text', text: 'recovered and done' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 9, output_tokens: 3, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    } satisfies ChatResult));

    const executions: Array<{ name: string }> = [];
    const handler = buildHandler(searchTool(executions));
    ctx.attempts_made = 1; // a resume

    const result = await handler(ctx);

    // Completed (not stuck looping on "Tool results are missing").
    expect(result.result).toBe('recovered and done');
    expect(result.stop_reason).toBe('end_turn');
    // The tool's persisted output was reused — NOT re-executed.
    expect(executions.length).toBe(0);

    // The gap was healed in the DB: idx 2 is now a tool-result user message.
    const msgs = await engine.executeRaw<Record<string, unknown>>(
      `SELECT message_idx, role FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`,
      [jobId],
    );
    const idx2 = msgs.find(m => m.message_idx === 2);
    expect(idx2).toBeDefined();
    expect(idx2!.role).toBe('user');
    // And the resumed assistant turn was appended after the healed message.
    expect(msgs.some(m => m.message_idx === 3 && m.role === 'assistant')).toBe(true);
  });
});
