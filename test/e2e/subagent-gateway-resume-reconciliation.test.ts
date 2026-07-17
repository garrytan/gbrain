/**
 * E2E: gateway-loop resume reconciliation (fix-wave A).
 *
 * The gateway-native subagent loop persists each assistant turn but historically
 * never persisted the following tool-result user turn. A resumed job therefore
 * reloaded assistant tool-calls with no matching tool-result, and non-Anthropic
 * (openai-compat) providers reject that unbalanced history with
 * AI_MissingToolResultsError — dead-lettering the job. This wave:
 *   1. forward-persists the tool-result user turn (onToolResultTurn), and
 *   2. reconciles an already-corrupted transcript on resume by rebuilding the
 *      missing tool-result turns from settled subagent_tool_executions,
 *      re-dispatching idempotent-pending tools and throwing on non-idempotent.
 *
 * Hermetic: PGLite in-memory engine, gateway transport stubbed. Seeds use the
 * sanctioned `$N::text::jsonb` positional bind (NEVER JSON.stringify into a
 * bare `::jsonb`) so the seed is Postgres-safe too.
 *
 * Supersedes the resume/replay work in #1934 #2062 #2065 #2112 #2274 #2487
 * #2802 #2336 #2257 #2499.
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
  toModelMessages,
  type ChatBlock,
  type ChatMessage,
  type ChatResult,
} from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
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

async function makeJob(prompt: string, model: string): Promise<{ jobId: number; ctx: MinionJobContext }> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::text::jsonb, 'default', 0, now()) RETURNING id`,
    [JSON.stringify({ prompt, model })],
  );
  const jobId = rows[0].id;
  const ctx: MinionJobContext = {
    id: jobId, name: 'subagent', data: { prompt, model }, attempts_made: 1,
    signal: new AbortController().signal, shutdownSignal: new AbortController().signal,
    updateProgress: async () => {}, updateTokens: async () => {}, log: async () => {},
    isActive: async () => true, readInbox: async () => [],
  };
  return { jobId, ctx };
}

function makeTools(executions: string[]): ToolDef[] {
  return [
    { name: 'search', description: 's', input_schema: { type: 'object' }, idempotent: true,
      async execute(input: unknown, _c: ToolCtx) { executions.push('search'); return { results: ['fresh'] }; } },
    { name: 'put_page', description: 'p', input_schema: { type: 'object' }, idempotent: false,
      async execute(_input: unknown, _c: ToolCtx) { executions.push('put_page'); return { saved: true }; } },
  ];
}

function buildHandler(toolRegistry: ToolDef[]) {
  return makeSubagentHandler({
    engine, config: {} as any, toolRegistry,
    makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path unused'); } } }) as any,
  });
}

async function seedMessage(jobId: number, idx: number, role: string, blocks: ChatBlock[]): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks, schema_version)
     VALUES ($1, $2, $3, $4::text::jsonb, 2)`,
    [jobId, idx, role, JSON.stringify(blocks)],
  );
}

async function seedExec(jobId: number, msgIdx: number, toolUseId: string, name: string, status: string, output: unknown, ordinal: number, error?: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions
       (job_id, message_idx, tool_use_id, tool_name, input, status, output, error, schema_version, ordinal)
     VALUES ($1, $2, $3, $4, $5::text::jsonb, $6, $7::text::jsonb, $8, 2, $9)`,
    [jobId, msgIdx, toolUseId, name, JSON.stringify({}), status, output == null ? null : JSON.stringify(output), error ?? null, ordinal],
  );
}

/** Assert every assistant tool-call turn is answered by a following tool-result. */
function assertBalanced(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const calls = m.content.filter((b): b is Extract<ChatBlock, { type: 'tool-call' }> => b.type === 'tool-call');
    if (calls.length === 0) continue;
    const next = messages[i + 1];
    expect(next, `assistant tool-call turn at ${i} must be followed by a tool-result turn`).toBeDefined();
    const answered = new Set(
      (typeof next!.content === 'string' ? [] : next!.content)
        .filter((b): b is Extract<ChatBlock, { type: 'tool-result' }> => b.type === 'tool-result')
        .map(b => b.toolCallId),
    );
    for (const c of calls) expect(answered.has(c.toolCallId), `tool-call ${c.toolCallId} unanswered`).toBe(true);
  }
  // The real provider path: this must not throw the ModelMessage schema error.
  expect(() => toModelMessages(messages)).not.toThrow();
}

describe('gateway resume reconciliation', () => {
  it('forward-persists the tool-result user turn (idx 2) in a 2-turn flow', async () => {
    let turn = 0;
    __setChatTransportForTests(async () => {
      turn++;
      if (turn === 1) return {
        text: '', blocks: [{ type: 'tool-call', toolCallId: 'tc1', toolName: 'search', input: { q: 'x' } }] as ChatBlock[],
        stopReason: 'tool_calls', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      } satisfies ChatResult;
      return {
        text: 'done', blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
        stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6', providerId: 'anthropic',
      } satisfies ChatResult;
    });
    const { jobId, ctx } = await makeJob('go', 'anthropic:claude-sonnet-4-6');
    await buildHandler(makeTools([]))(ctx);

    const msgs = await engine.executeRaw<{ message_idx: number; role: string; content_blocks: unknown }>(
      `SELECT message_idx, role, content_blocks FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`, [jobId]);
    expect(msgs.map(m => [m.message_idx, m.role])).toEqual([[0, 'user'], [1, 'assistant'], [2, 'user'], [3, 'assistant']]);
    const toolResultTurn = typeof msgs[2].content_blocks === 'string' ? JSON.parse(msgs[2].content_blocks as string) : msgs[2].content_blocks;
    expect((toolResultTurn as any[])[0].type).toBe('tool-result');
    expect((toolResultTurn as any[])[0].toolCallId).toBe('tc1');
  });

  it('self-heals a pre-fix corrupted job from the stored output (no re-execute), transcript balanced', async () => {
    const { jobId, ctx } = await makeJob('resume me', 'openai:gpt-4o'); // non-Anthropic: strict pairing
    // Corrupted pre-fix state: seed user + assistant(tool-call), a complete
    // exec row, but NO tool-result user turn at idx 2.
    await seedMessage(jobId, 0, 'user', [{ type: 'text', text: 'resume me' }]);
    await seedMessage(jobId, 1, 'assistant', [{ type: 'tool-call', toolCallId: 'prov-tc-1', toolName: 'search', input: { q: 'x' } }]);
    await seedExec(jobId, 1, 'prov-tc-1', 'search', 'complete', { results: ['from-prior-run'] }, 0);

    let captured: ChatMessage[] = [];
    __setChatTransportForTests(async (opts) => {
      captured = opts.messages;
      return {
        text: 'recovered and done', blocks: [{ type: 'text', text: 'recovered and done' }] as ChatBlock[],
        stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-4o', providerId: 'openai',
      } satisfies ChatResult;
    });
    const executions: string[] = [];
    const result = await buildHandler(makeTools(executions))(ctx);

    expect(result.result).toBe('recovered and done');
    expect(executions.length).toBe(0); // stored output reused, tool NOT re-run
    assertBalanced(captured);
    // The healed tool-result carries the real stored output.
    const healed = (captured[2].content as ChatBlock[])[0] as Extract<ChatBlock, { type: 'tool-result' }>;
    expect(healed.output).toEqual({ results: ['from-prior-run'] });

    // Durably persisted so the next resume stays balanced.
    const msgs = await engine.executeRaw<{ message_idx: number; role: string }>(
      `SELECT message_idx, role FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`, [jobId]);
    expect(msgs.map(m => [m.message_idx, m.role])).toEqual([[0, 'user'], [1, 'assistant'], [2, 'user'], [3, 'assistant']]);
  });

  it('heals MULTIPLE consecutive dangling assistant turns (pre-fix multi-turn corruption)', async () => {
    const { jobId, ctx } = await makeJob('multi', 'openai:gpt-4o');
    // Pre-fix loop persisted assistants at 1 and 3 (gaps at 2 = skipped user idx).
    await seedMessage(jobId, 0, 'user', [{ type: 'text', text: 'multi' }]);
    await seedMessage(jobId, 1, 'assistant', [{ type: 'tool-call', toolCallId: 'tc-a', toolName: 'search', input: {} }]);
    await seedExec(jobId, 1, 'tc-a', 'search', 'complete', { results: ['a'] }, 0);
    await seedMessage(jobId, 3, 'assistant', [{ type: 'tool-call', toolCallId: 'tc-b', toolName: 'search', input: {} }]);
    await seedExec(jobId, 3, 'tc-b', 'search', 'complete', { results: ['b'] }, 0);

    let captured: ChatMessage[] = [];
    __setChatTransportForTests(async (opts) => {
      captured = opts.messages;
      return { text: 'ok', blocks: [{ type: 'text', text: 'ok' }] as ChatBlock[], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult;
    });
    const executions: string[] = [];
    await buildHandler(makeTools(executions))(ctx);

    expect(executions.length).toBe(0);
    assertBalanced(captured);
    // Both dangling turns healed and persisted (idx 2 and 4).
    const msgs = await engine.executeRaw<{ message_idx: number; role: string }>(
      `SELECT message_idx, role FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`, [jobId]);
    expect(msgs.map(m => m.message_idx)).toContain(2);
    expect(msgs.map(m => m.message_idx)).toContain(4);
  });

  it('re-dispatches an idempotent tool that was still pending on resume', async () => {
    const { jobId, ctx } = await makeJob('redispatch', 'openai:gpt-4o');
    await seedMessage(jobId, 0, 'user', [{ type: 'text', text: 'redispatch' }]);
    await seedMessage(jobId, 1, 'assistant', [{ type: 'tool-call', toolCallId: 'tc-pending', toolName: 'search', input: {} }]);
    await seedExec(jobId, 1, 'tc-pending', 'search', 'pending', null, 0);

    __setChatTransportForTests(async () => ({ text: 'ok', blocks: [{ type: 'text', text: 'ok' }] as ChatBlock[], stopReason: 'end',
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult));
    const executions: string[] = [];
    await buildHandler(makeTools(executions))(ctx);
    expect(executions).toEqual(['search']); // idempotent-pending re-executed once
  });

  it('throws on a non-idempotent tool still pending on resume', async () => {
    const { jobId, ctx } = await makeJob('unsafe', 'openai:gpt-4o');
    await seedMessage(jobId, 0, 'user', [{ type: 'text', text: 'unsafe' }]);
    await seedMessage(jobId, 1, 'assistant', [{ type: 'tool-call', toolCallId: 'tc-mut', toolName: 'put_page', input: {} }]);
    await seedExec(jobId, 1, 'tc-mut', 'put_page', 'pending', null, 0);

    __setChatTransportForTests(async () => ({ text: '', blocks: [] as ChatBlock[], stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult));
    await expect(buildHandler(makeTools([]))(ctx)).rejects.toThrow(/non-idempotent tool "put_page" pending on resume/i);
  });

  it('error-stubs a dangling tool-call whose tool is no longer registered', async () => {
    const { jobId, ctx } = await makeJob('gone tool', 'openai:gpt-4o');
    await seedMessage(jobId, 0, 'user', [{ type: 'text', text: 'gone tool' }]);
    await seedMessage(jobId, 1, 'assistant', [{ type: 'tool-call', toolCallId: 'tc-gone', toolName: 'removed_tool', input: {} }]);
    // No exec row and the tool isn't in the registry (only 'search'/'put_page').

    let captured: ChatMessage[] = [];
    __setChatTransportForTests(async (opts) => {
      captured = opts.messages;
      return { text: 'handled', blocks: [{ type: 'text', text: 'handled' }] as ChatBlock[], stopReason: 'end',
        usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult;
    });
    const result = await buildHandler(makeTools([]))(ctx);
    expect(result.result).toBe('handled');
    assertBalanced(captured);
    const stub = (captured[2].content as ChatBlock[])[0] as Extract<ChatBlock, { type: 'tool-result' }>;
    expect(stub.isError).toBe(true);
    expect(String(stub.output)).toContain('removed_tool');
    // Persisted as a failed exec so the next resume is stable.
    const rows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM subagent_tool_executions WHERE job_id = $1 AND tool_use_id = 'tc-gone'`, [jobId]);
    expect(rows[0].status).toBe('failed');
  });

  it('terminal resume: a completed transcript returns its text without calling the model', async () => {
    const { jobId, ctx } = await makeJob('already done', 'openai:gpt-4o');
    await seedMessage(jobId, 0, 'user', [{ type: 'text', text: 'already done' }]);
    await seedMessage(jobId, 1, 'assistant', [{ type: 'text', text: 'the final answer' }]);

    let chatCalls = 0;
    __setChatTransportForTests(async () => { chatCalls++; return { text: 'SHOULD NOT RUN', blocks: [] as ChatBlock[], stopReason: 'end',
      usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult; });
    const result = await buildHandler(makeTools([]))(ctx);
    expect(chatCalls).toBe(0);
    expect(result.result).toBe('the final answer');
    expect(result.stop_reason).toBe('end_turn');
  });
});
