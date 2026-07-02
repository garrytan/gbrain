/**
 * Regression: the gateway-native subagent loop must persist the tool-result
 * user turn and reconcile it on crash-replay, so a resumed conversation is
 * structurally balanced (every assistant tool-call is answered by a matching
 * tool-result before the next dispatch).
 *
 * The bug: `gateway.toolLoop` pushed the tool-result user turn to the in-memory
 * array but never persisted it (no `onToolResultTurn` callback), and the
 * gateway path had no replay reconciliation. After any interruption between the
 * assistant-turn persist and turn completion, replay rebuilt
 * `[user, assistant(tool-calls)]` with no tool-results, and the next real
 * `chat()` threw "Tool results are missing for tool calls ...". It poisoned
 * every retry → dead job. It only hit the non-Anthropic stack (the legacy
 * Anthropic path already persisted + reconciled tool-result turns).
 *
 * Why the existing crash-replay test missed it: that suite stubs the chat
 * transport, so the real AI SDK validator never runs and an unbalanced messages
 * array is never rejected. This test captures what the loop hands to `chat()`
 * on resume and asserts it is balanced — the property the validator enforces in
 * production.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, ToolDef, ToolCtx } from '../../src/core/minions/types.ts';
import {
  __setChatTransportForTests,
  configureGateway,
  resetGateway,
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
  await engine.disconnect();
  resetGateway();
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
    env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub', LITELLM_API_KEY: 'stub' },
  });
});

afterEach(() => {
  __setChatTransportForTests(null);
});

function makeStubTools(executions: Array<{ name: string; input: unknown }>): ToolDef[] {
  return [{
    name: 'search',
    description: 'stub search',
    input_schema: { type: 'object' },
    idempotent: true,
    async execute(input: unknown, _ctx: ToolCtx) {
      executions.push({ name: 'search', input });
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

function makeCtx(jobId: number, prompt: string, modelId: string): MinionJobContext {
  return {
    id: jobId,
    name: 'subagent',
    data: { prompt, model: modelId },
    attempts_made: 1,
    signal: new AbortController().signal,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  } as MinionJobContext;
}

/**
 * Seed the exact poisoned shape this bug produced: the assistant tool-call turn
 * persisted (idx 1) and the tool execution marked complete, but NO tool-result
 * user turn at idx 2 (the gateway path never wrote it).
 */
async function seedToolResultGapState(prompt: string, providerToolCallId: string) {
  const jobRows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now()) RETURNING id`,
    [JSON.stringify({ prompt })],
  );
  const jobId = jobRows[0].id;
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks, model)
     VALUES ($1, 0, 'user', $2::jsonb, NULL),
            ($1, 1, 'assistant', $3::jsonb, 'litellm:gpt-5.4-mini')`,
    [
      jobId,
      JSON.stringify([{ type: 'text', text: prompt }]),
      JSON.stringify([{ type: 'tool-call', toolCallId: providerToolCallId, toolName: 'search', input: { q: 'foo' } }]),
    ],
  );
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions
       (job_id, message_idx, tool_use_id, tool_name, input, status, schema_version, ordinal, gbrain_tool_use_id, output)
     VALUES ($1, 1, $2, 'search', '{}'::jsonb, 'complete', 2, 0, '01987654-3210-7000-8000-aaaaaaaaaaaa'::uuid, $3::jsonb)`,
    [jobId, providerToolCallId, JSON.stringify({ results: ['prior'] })],
  );
  return jobId;
}

describe('gateway subagent loop — tool-result turn persistence + replay reconciliation', () => {
  it('resume hands chat() a BALANCED conversation (every assistant tool-call answered)', async () => {
    const providerToolCallId = 'call_8Alll6DvrBKPDeD1hGofWJSD';
    const seenMessages: ChatMessage[][] = [];
    __setChatTransportForTests(async (opts): Promise<ChatResult> => {
      seenMessages.push(opts.messages as ChatMessage[]);
      return {
        text: 'final answer after replay',
        blocks: [{ type: 'text', text: 'final answer after replay' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 20, output_tokens: 6, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'litellm:gpt-5.4-mini',
        providerId: 'litellm',
      };
    });

    const executions: Array<{ name: string; input: unknown }> = [];
    const handler = buildHandler(makeStubTools(executions));
    const jobId = await seedToolResultGapState('surface patterns', providerToolCallId);

    const result = await handler(makeCtx(jobId, 'surface patterns', 'litellm:gpt-5.4-mini'));

    // The prior complete tool is NOT re-executed.
    expect(executions.length).toBe(0);
    expect(result.result).toBe('final answer after replay');

    // The conversation handed to chat() on resume must be balanced: the
    // assistant tool-call turn is followed by a user turn carrying a
    // tool-result for the same id. Pre-fix, seenMessages[0] ended with the
    // unanswered assistant tool-call and the real validator would have thrown.
    const firstDispatch = seenMessages[0];
    const asstIdx = firstDispatch.findIndex(
      m => m.role === 'assistant' && Array.isArray(m.content) && m.content.some(b => (b as ChatBlock).type === 'tool-call'),
    );
    expect(asstIdx).toBeGreaterThanOrEqual(0);
    const answered = new Set<string>();
    for (const m of firstDispatch.slice(asstIdx + 1)) {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if ((b as ChatBlock).type === 'tool-result') answered.add((b as Extract<ChatBlock, { type: 'tool-result' }>).toolCallId);
        }
      }
    }
    expect(answered.has(providerToolCallId)).toBe(true);
  });

  it('persists the reconciled tool-result user turn to subagent_messages (state is balanced on disk)', async () => {
    const providerToolCallId = 'call_uLo1qezAkyyFv8EwNL6ekaP8';
    __setChatTransportForTests(async (): Promise<ChatResult> => ({
      text: 'done',
      blocks: [{ type: 'text', text: 'done' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'litellm:gpt-5.4-mini',
      providerId: 'litellm',
    }));

    const handler = buildHandler(makeStubTools([]));
    const jobId = await seedToolResultGapState('surface patterns', providerToolCallId);
    await handler(makeCtx(jobId, 'surface patterns', 'litellm:gpt-5.4-mini'));

    const rows = await engine.executeRaw<{ message_idx: number; role: string; content_blocks: unknown }>(
      `SELECT message_idx, role, content_blocks FROM subagent_messages WHERE job_id = $1 ORDER BY message_idx`,
      [jobId],
    );
    // Find a user turn carrying a tool-result for the crashed call id.
    const hasReconciledTurn = rows.some(r => {
      if (r.role !== 'user') return false;
      const blocks = typeof r.content_blocks === 'string' ? JSON.parse(r.content_blocks) : r.content_blocks;
      return Array.isArray(blocks) && blocks.some((b: any) => b?.type === 'tool-result' && b?.toolCallId === providerToolCallId);
    });
    expect(hasReconciledTurn).toBe(true);
  });
});
