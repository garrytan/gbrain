/**
 * E2E: gateway-path resume reconciles a dangling assistant tool-call turn.
 *
 * Regression for the crash-recovery parity gap between the gateway-native
 * subagent loop (runSubagentViaGateway → toolLoop, used for non-Anthropic
 * models like DeepSeek) and the legacy inline loop. The gateway path used to:
 *   1. never persist the synthesized tool-result user turn, and
 *   2. never reconcile a dangling assistant tool-call turn on resume.
 *
 * Net: a synthesize job that stalled (max_turns / max_stalled / 30-min
 * timeout) and got re-claimed reloaded `[user, assistant(tool_calls)]` with NO
 * tool-result message between the assistant and the next chat() call. The
 * provider rejected the dangling tool_calls with "Tool result is missing for
 * tool call X" → permanent dead-letter. Intermittent because only
 * stalled-then-resumed jobs hit it.
 *
 * Unlike subagent-crash-replay-multi-provider.test.ts (whose stub returns a
 * terminal turn regardless of input, so it never noticed the malformed
 * conversation), this test's stub ASSERTS the messages it receives are
 * well-formed — every assistant tool-call must be followed by a tool-result
 * covering its toolCallId — mirroring the real provider's rejection.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, ToolDef, ToolCtx, ContentBlock } from '../../src/core/minions/types.ts';
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

afterEach(() => {
  __setChatTransportForTests(null);
});

afterAll(() => {
  resetGateway();
});

// ── Helpers ─────────────────────────────────────────────────

/**
 * Assert the conversation the provider would see is well-formed: every
 * assistant turn carrying tool-call blocks is immediately followed by a turn
 * whose tool-result blocks cover ALL of its toolCallIds. Throws the same shape
 * of error a real openai-compatible provider (DeepSeek) raises on a dangling
 * tool-call — so the loop dead-letters here if the fix is missing.
 */
function assertWellFormed(messages: ChatMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const toolCallIds = m.content
      .filter((b): b is Extract<ChatBlock, { type: 'tool-call' }> => b.type === 'tool-call')
      .map(b => b.toolCallId);
    if (toolCallIds.length === 0) continue;
    const next = messages[i + 1];
    const resultIds = next && typeof next.content !== 'string'
      ? next.content
        .filter((b): b is Extract<ChatBlock, { type: 'tool-result' }> => b.type === 'tool-result')
        .map(b => b.toolCallId)
      : [];
    const missing = toolCallIds.filter(id => !resultIds.includes(id));
    if (missing.length > 0) {
      throw new Error(`Tool result is missing for tool call ${missing.join(', ')}`);
    }
  }
}

function makeStubTools(executions: Array<{ name: string; input: unknown }>): ToolDef[] {
  const mk = (name: string): ToolDef => ({
    name,
    description: `stub ${name}`,
    input_schema: { type: 'object' },
    idempotent: true,
    async execute(input: unknown, _ctx: ToolCtx) {
      executions.push({ name, input });
      return { reexecuted: name };
    },
  });
  return [mk('search'), mk('lookup')];
}

function buildHandler(toolRegistry: ToolDef[]) {
  return makeSubagentHandler({
    engine,
    config: {} as any,
    toolRegistry,
    makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path should not be invoked'); } } }) as any,
  });
}

function makeCrashedCtx(jobId: number, prompt: string, modelId: string): MinionJobContext {
  const abortCtrl = new AbortController();
  const shutdownCtrl = new AbortController();
  return {
    id: jobId,
    name: 'subagent',
    data: { prompt, model: modelId },
    attempts_made: 1, // crashed once
    signal: abortCtrl.signal,
    shutdownSignal: shutdownCtrl.signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  } as MinionJobContext;
}

/**
 * Seed a "crashed-mid-loop" state with TWO parallel tool calls:
 *   - user prompt at idx 0
 *   - assistant turn at idx 1 with two v2 tool-call blocks
 *   - two subagent_tool_executions rows status='complete' with distinct real
 *     outputs (the crashed worker finished both before SIGKILL)
 *   - NO tool-result message at idx 2 (the bug condition)
 */
async function seedParallelCrashedState(prompt: string): Promise<{ jobId: number }> {
  const jobRows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify({ prompt })],
  );
  const jobId = jobRows[0].id;

  await engine.executeRaw(
    `INSERT INTO subagent_messages
       (job_id, message_idx, role, content_blocks, model)
     VALUES ($1, 0, 'user', $2::jsonb, NULL)`,
    [jobId, JSON.stringify([{ type: 'text', text: prompt }])],
  );

  const assistantBlocks: ContentBlock[] = [
    { type: 'tool-call' as any, toolCallId: 'provider-tc-A', toolName: 'search', input: { q: 'alpha' } } as any,
    { type: 'tool-call' as any, toolCallId: 'provider-tc-B', toolName: 'lookup', input: { id: 'beta' } } as any,
  ];
  await engine.executeRaw(
    `INSERT INTO subagent_messages
       (job_id, message_idx, role, content_blocks, tokens_in, tokens_out,
        tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, 1, 'assistant', $2::jsonb, 12, 6, 0, 0, 'deepseek:deepseek-chat')`,
    [jobId, JSON.stringify(assistantBlocks)],
  );

  // Both tools completed pre-crash, with distinct real outputs.
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions
       (job_id, message_idx, tool_use_id, tool_name, input, status,
        schema_version, ordinal, gbrain_tool_use_id, output)
     VALUES ($1, 1, 'provider-tc-A', 'search', '{}'::jsonb, 'complete',
             2, 0, '01987654-3210-7000-8000-aaaaaaaaaaaa'::uuid, $2::jsonb),
            ($1, 1, 'provider-tc-B', 'lookup', '{}'::jsonb, 'complete',
             2, 1, '01987654-3210-7000-8000-bbbbbbbbbbbb'::uuid, $3::jsonb)`,
    [jobId, JSON.stringify({ results: ['alpha-result'] }), JSON.stringify({ value: 'beta-value' })],
  );

  return { jobId };
}

// ── Tests ───────────────────────────────────────────────────

describe('gateway-path resume reconciles a dangling assistant tool-call turn', () => {
  it('synthesizes the missing tool-result turn from stored outputs so the resumed chat() is well-formed', async () => {
    let stubCalls = 0;
    const terminalResponse: ChatResult = {
      text: 'synthesized final answer from both tool results',
      blocks: [{ type: 'text', text: 'synthesized final answer from both tool results' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 60, output_tokens: 12, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'deepseek:deepseek-chat',
      providerId: 'deepseek',
    };
    // Throws like a real provider if the conversation has a dangling tool-call.
    __setChatTransportForTests(async (opts) => {
      stubCalls++;
      assertWellFormed(opts.messages);
      return terminalResponse;
    });

    const executions: Array<{ name: string; input: unknown }> = [];
    const handler = buildHandler(makeStubTools(executions));

    const { jobId } = await seedParallelCrashedState('find alpha and beta');
    const ctx = makeCrashedCtx(jobId, 'find alpha and beta', 'deepseek:deepseek-chat');

    const result = await handler(ctx);

    // Completes via the terminal turn — no "missing tool result" dead-letter.
    expect(stubCalls).toBeGreaterThanOrEqual(1);
    expect(result.stop_reason).toBe('end_turn');
    expect(result.result).toBe(terminalResponse.text);

    // Prior tools were already complete — reconciler reuses stored outputs,
    // never re-executes.
    expect(executions.length).toBe(0);

    // The reconciled user turn is persisted at idx 2 and carries the REAL
    // stored outputs (not placeholders), covering both provider tool-call ids.
    const rows = await engine.executeRaw<{ content_blocks: unknown }>(
      `SELECT content_blocks FROM subagent_messages WHERE job_id = $1 AND message_idx = 2`,
      [jobId],
    );
    expect(rows.length).toBe(1);
    const blocks = (typeof rows[0].content_blocks === 'string'
      ? JSON.parse(rows[0].content_blocks as string)
      : rows[0].content_blocks) as ChatBlock[];
    const byId = new Map(
      blocks
        .filter((b): b is Extract<ChatBlock, { type: 'tool-result' }> => b.type === 'tool-result')
        .map(b => [b.toolCallId, b]),
    );
    expect(byId.get('provider-tc-A')?.output).toEqual({ results: ['alpha-result'] });
    expect(byId.get('provider-tc-B')?.output).toEqual({ value: 'beta-value' });
    expect(byId.get('provider-tc-A')?.isError).toBe(false);
    expect(byId.get('provider-tc-B')?.isError).toBe(false);
  });

  it('re-dispatches an idempotent tool with no prior execution row on resume', async () => {
    let stubCalls = 0;
    __setChatTransportForTests(async (opts) => {
      stubCalls++;
      assertWellFormed(opts.messages);
      return {
        text: 'done after re-dispatch',
        blocks: [{ type: 'text', text: 'done after re-dispatch' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 20, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'deepseek:deepseek-chat',
        providerId: 'deepseek',
      } satisfies ChatResult;
    });

    const executions: Array<{ name: string; input: unknown }> = [];
    const handler = buildHandler(makeStubTools(executions));

    // Crashed BEFORE the tool execution row was written: assistant tool-call
    // turn persisted, but no subagent_tool_executions row at all.
    const jobRows = await engine.executeRaw<{ id: number }>(
      `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
       VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
       RETURNING id`,
    );
    const jobId = jobRows[0].id;
    await engine.executeRaw(
      `INSERT INTO subagent_messages
         (job_id, message_idx, role, content_blocks, model)
       VALUES ($1, 0, 'user', '[{"type":"text","text":"go"}]'::jsonb, NULL),
              ($1, 1, 'assistant', $2::jsonb, 'deepseek:deepseek-chat')`,
      [jobId, JSON.stringify([{ type: 'tool-call', toolCallId: 'provider-tc-redispatch', toolName: 'search', input: { q: 'x' } }])],
    );

    const ctx = makeCrashedCtx(jobId, 'go', 'deepseek:deepseek-chat');
    const result = await handler(ctx);

    expect(stubCalls).toBeGreaterThanOrEqual(1);
    expect(result.stop_reason).toBe('end_turn');
    // No prior row → reconciler executes the (idempotent) tool exactly once.
    expect(executions).toEqual([{ name: 'search', input: { q: 'x' } }]);
    // The re-dispatched tool is now persisted complete.
    const toolRows = await engine.executeRaw<{ status: string }>(
      `SELECT status FROM subagent_tool_executions WHERE job_id = $1 AND tool_use_id = 'provider-tc-redispatch'`,
      [jobId],
    );
    expect(toolRows.length).toBe(1);
    expect(toolRows[0].status).toBe('complete');
  });
});
