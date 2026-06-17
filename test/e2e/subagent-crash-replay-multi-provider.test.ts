/**
 * E2E: SIGKILL crash-replay reconciliation across the provider matrix.
 *
 * This is the LOAD-BEARING test the v0.38 CEO + Codex reviews called out
 * as CRITICAL before ship. The contract:
 *
 *   A subagent job whose worker crashes mid-tool-dispatch MUST reconcile
 *   correctly on the next worker claim. Specifically:
 *     1. Tool executions marked status='complete' (or 'failed') in the DB
 *        before the crash MUST NOT be re-executed.
 *     2. The reconciliation key MUST work across provider response shapes
 *        — the gbrain-owned stable key (ordinal + gbrain_tool_use_id from
 *        migration v81) is the canonical key, not the provider tool_use_id.
 *     3. Legacy v1 rows (pre-v0.38, ordinal=NULL, gbrain_tool_use_id=NULL)
 *        get a synthesized stable key via the D5 read-time shim and replay
 *        the same way.
 *
 * We don't actually SIGKILL a subprocess (heavy, slow, flaky in CI). Instead
 * we SIMULATE the crashed state by pre-seeding subagent_messages +
 * subagent_tool_executions in the shape the DB would have post-crash, then
 * invoke the handler and assert it reconciles correctly without
 * re-executing the prior tools.
 *
 * Per-provider matrix: gateway.chat() abstracts providers through the
 * Vercel AI SDK, but each provider returns slightly different response
 * shapes (provider id, finishReason mapping, usage field names, content
 * block ordering). We stub the second-turn response with provider-specific
 * shapes to prove the reconciler handles all five without leaking
 * provider-specific assumptions.
 *
 * Plan reference: ~/.claude/plans/system-instruction-you-are-working-shimmying-breeze.md
 * (Risk register row "Stable-ID INSERT race across replays" + Slice 1
 * verification step 4 "SIGKILL worker mid-call").
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

/**
 * Provider matrix. Each entry is one provider whose response shape the
 * gateway path must reconcile across. The gateway.chat() normalizer
 * collapses these to ChatBlock[] before they hit our toolLoop, but the
 * test stubs the normalizer's output to verify the loop downstream
 * doesn't leak any provider-specific assumption.
 */
type ProviderShape = {
  providerId: string;
  modelId: string;
  // The second-turn (post-replay) response.
  finalResponse: ChatResult;
};

const PROVIDER_MATRIX: ProviderShape[] = [
  {
    providerId: 'anthropic',
    modelId: 'anthropic:claude-sonnet-4-6',
    finalResponse: {
      text: 'anthropic resumed: search result was helpful',
      blocks: [{ type: 'text', text: 'anthropic resumed: search result was helpful' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 50, output_tokens: 8, cache_read_tokens: 30, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    },
  },
  {
    providerId: 'openai',
    modelId: 'openai:gpt-5.2',
    finalResponse: {
      text: 'openai resumed: synthesized answer from prior tool result',
      blocks: [{ type: 'text', text: 'openai resumed: synthesized answer from prior tool result' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 45, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-5.2',
      providerId: 'openai',
    },
  },
  {
    providerId: 'google',
    modelId: 'google:gemini-1.5-pro',
    finalResponse: {
      text: 'gemini resumed: 1M-context replay went fine',
      blocks: [{ type: 'text', text: 'gemini resumed: 1M-context replay went fine' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 80, output_tokens: 6, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'google:gemini-1.5-pro',
      providerId: 'google',
    },
  },
  {
    providerId: 'openrouter',
    modelId: 'openrouter:anthropic/claude-sonnet-4-6',
    finalResponse: {
      text: 'openrouter resumed: proxied claude response',
      blocks: [{ type: 'text', text: 'openrouter resumed: proxied claude response' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 50, output_tokens: 7, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openrouter:anthropic/claude-sonnet-4-6',
      providerId: 'openrouter',
    },
  },
  {
    providerId: 'deepseek',
    modelId: 'deepseek:deepseek-chat',
    // Representative openai-compatible recipe with native chat + tools.
    // (LiteLLM proxy was the original 5th slot in the plan but its recipe
    // declares no chat touchpoint — it's embedding-only. Deepseek is the
    // matching openai-compatible chat provider with tool calling.)
    finalResponse: {
      text: 'deepseek resumed: openai-compatible chat works',
      blocks: [{ type: 'text', text: 'deepseek resumed: openai-compatible chat works' }] as ChatBlock[],
      stopReason: 'end',
      usage: { input_tokens: 40, output_tokens: 9, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'deepseek:deepseek-chat',
      providerId: 'deepseek',
    },
  },
];

/**
 * Stub tool registry that records every execution. Tests assert
 * `executions.length === 0` to prove replay short-circuit.
 */
function makeStubTools(executions: Array<{ name: string; input: unknown }>): ToolDef[] {
  return [
    {
      name: 'search',
      description: 'stub search',
      input_schema: { type: 'object' },
      idempotent: true,
      async execute(input: unknown, _ctx: ToolCtx) {
        executions.push({ name: 'search', input });
        return { results: [{ slug: 'wiki/foo' }] };
      },
    },
  ];
}

function buildHandler(toolRegistry: ToolDef[]) {
  return makeSubagentHandler({
    engine,
    config: {} as any,
    toolRegistry,
    makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path should not be invoked'); } } }) as any,
  });
}

/**
 * Seed a "crashed-mid-loop" state for jobId:
 *   - 1 user message at idx 0 (the seed prompt)
 *   - 1 assistant message at idx 1 containing a tool-call block
 *   - 1 subagent_tool_executions row with status='complete' + the result
 *     the crashed worker had ALREADY written before SIGKILL
 *
 * `shape` controls whether the rows are v1 (pre-v0.38: Anthropic content
 * blocks, ordinal=NULL, gbrain_tool_use_id=NULL) or v2 (post-v0.38:
 * ChatBlock content, ordinal+gbrain_tool_use_id populated).
 */
async function seedCrashedState(
  prompt: string,
  shape: 'v1' | 'v2',
): Promise<{ jobId: number; toolUseId: string; gbrainId: string | null }> {
  const jobRows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify({ prompt })],
  );
  const jobId = jobRows[0].id;

  // Seed user message at idx 0.
  await engine.executeRaw(
    `INSERT INTO subagent_messages
       (job_id, message_idx, role, content_blocks, tokens_in, tokens_out,
        tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, 0, 'user', $2::jsonb, NULL, NULL, NULL, NULL, NULL)`,
    [
      jobId,
      JSON.stringify(shape === 'v1'
        ? [{ type: 'text', text: prompt }]
        : [{ type: 'text', text: prompt }]),
    ],
  );

  // Seed assistant message at idx 1 with a tool-call block.
  const toolUseId = shape === 'v1' ? 'toolu_v1_crashed' : 'provider-tc-v2-crashed';
  const assistantBlocks: ContentBlock[] = shape === 'v1'
    ? [{ type: 'tool_use', id: toolUseId, name: 'search', input: { q: 'foo' } }]
    : [{ type: 'tool-call' as any, toolCallId: toolUseId, toolName: 'search', input: { q: 'foo' } } as any];

  await engine.executeRaw(
    `INSERT INTO subagent_messages
       (job_id, message_idx, role, content_blocks, tokens_in, tokens_out,
        tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, 1, 'assistant', $2::jsonb, 10, 5, 0, 0, 'anthropic:claude-sonnet-4-6')`,
    [jobId, JSON.stringify(assistantBlocks)],
  );

  // Seed the tool execution row. The crashed worker completed the tool
  // and persisted the result, but crashed before persisting the next
  // user message (the tool_result wrapper). Replay must see this as done.
  const priorOutput = JSON.stringify({ results: ['prior'] });
  let gbrainId: string | null = null;
  if (shape === 'v2') {
    gbrainId = '01987654-3210-7000-8000-aaaaaaaaaaaa';
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status,
          schema_version, ordinal, gbrain_tool_use_id, output)
       VALUES ($1, 1, $2, 'search', '{}'::jsonb, 'complete',
               2, 0, $3::uuid, $4::jsonb)`,
      [jobId, toolUseId, gbrainId, priorOutput],
    );
  } else {
    // v1 row: no ordinal, no gbrain_tool_use_id.
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions
         (job_id, message_idx, tool_use_id, tool_name, input, status,
          schema_version, output)
       VALUES ($1, 1, $2, 'search', '{}'::jsonb, 'complete',
               1, $3::jsonb)`,
      [jobId, toolUseId, priorOutput],
    );
  }

  return { jobId, toolUseId, gbrainId };
}

async function makeCrashedCtx(jobId: number, prompt: string, modelId: string): Promise<MinionJobContext> {
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
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('SIGKILL crash-replay reconciliation across provider matrix (v0.38 LOAD-BEARING)', () => {
  describe.each(PROVIDER_MATRIX)('provider $providerId', (provider) => {
    it('replay short-circuits the prior complete tool (v2 shape, gbrain_tool_use_id key)', async () => {
      // Stub the SECOND turn — replay should NOT call gateway.chat() for
      // turn 1 (the tool dispatch already happened pre-crash). It should
      // immediately re-feed the tool_result and ask the LLM for the final
      // text answer.
      __setChatTransportForTests(async () => provider.finalResponse);

      const executions: Array<{ name: string; input: unknown }> = [];
      const tools = makeStubTools(executions);
      const handler = buildHandler(tools);

      const { jobId } = await seedCrashedState('find foo', 'v2');
      const ctx = await makeCrashedCtx(jobId, 'find foo', provider.modelId);

      const result = await handler(ctx);

      // LOAD-BEARING: prior tool MUST NOT re-execute.
      expect(executions.length).toBe(0);

      // Final result comes from the stubbed second turn.
      expect(result.result).toBe(provider.finalResponse.text);
      expect(result.stop_reason).toBe('end_turn');

      // The prior complete tool row is still status='complete' (not overwritten).
      const toolRows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT status FROM subagent_tool_executions WHERE job_id = $1`,
        [jobId],
      );
      expect(toolRows.length).toBe(1);
      expect(toolRows[0].status).toBe('complete');
    });

    it('replay short-circuits the prior complete tool (v1 legacy shape, D5 synthesized key)', async () => {
      __setChatTransportForTests(async () => provider.finalResponse);

      const executions: Array<{ name: string; input: unknown }> = [];
      const tools = makeStubTools(executions);
      const handler = buildHandler(tools);

      const { jobId } = await seedCrashedState('find foo (v1)', 'v1');
      const ctx = await makeCrashedCtx(jobId, 'find foo (v1)', provider.modelId);

      const result = await handler(ctx);

      // LOAD-BEARING: v1 legacy rows reconcile via D5 synthesized stable
      // key — the prior tool MUST NOT re-execute even though it predates
      // the gbrain_tool_use_id column.
      expect(executions.length).toBe(0);

      expect(result.result).toBe(provider.finalResponse.text);
      expect(result.stop_reason).toBe('end_turn');
    });
  });

  describe('non-idempotent tool with pending status (unrecoverable error)', () => {
    it('throws unrecoverable when a non-idempotent tool is pending on resume', async () => {
      // Resume stub re-emits the SAME tool call the worker crashed on.
      // The gateway loop assigns the same (job_id, message_idx, ordinal)
      // key, the existing row (status=pending) is read back via RETURNING,
      // and the priorTools map lookup hits with status='pending'. Since the
      // tool is non-idempotent, the loop throws unrecoverable rather than
      // re-execute and risk a double side-effect.
      __setChatTransportForTests(async () => ({
        text: '',
        blocks: [
          { type: 'tool-call', toolCallId: 'tc-pending', toolName: 'put_page', input: { slug: 'foo' } },
        ] as ChatBlock[],
        stopReason: 'tool_calls',
        usage: { input_tokens: 5, output_tokens: 2, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult));

      const tools: ToolDef[] = [{
        name: 'put_page',
        description: 'non-idempotent stub',
        input_schema: { type: 'object' },
        idempotent: false,
        async execute() { throw new Error('should not be called on replay'); },
      }];
      const handler = buildHandler(tools);

      // Seed: crashed mid-loop with a pending non-idempotent tool exec.
      // The user prompt is at idx 0 (the seed write subagent.ts does).
      // The crashed worker started executing put_page at message_idx=2
      // (which is the NEW assistant turn the resume will generate),
      // ordinal=0. priorTools must surface this as status='pending'.
      const jobRows = await engine.executeRaw<{ id: number }>(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
         RETURNING id`,
      );
      const jobId = jobRows[0].id;
      const gbrainId = '01987654-3210-7000-8000-bbbbbbbbbbbb';

      // Just the user prompt — no prior assistant turn, so the resume
      // generates the first assistant turn fresh at message_idx=1, and
      // the tool dispatch at ordinal=0 will hit the pre-seeded pending row.
      await engine.executeRaw(
        `INSERT INTO subagent_messages
           (job_id, message_idx, role, content_blocks, model)
         VALUES ($1, 0, 'user', '[{"type":"text","text":"do it"}]'::jsonb, NULL)`,
        [jobId],
      );
      await engine.executeRaw(
        `INSERT INTO subagent_tool_executions
           (job_id, message_idx, tool_use_id, tool_name, input, status,
            schema_version, ordinal, gbrain_tool_use_id)
         VALUES ($1, 1, 'tc-pending', 'put_page', '{}'::jsonb, 'pending',
                 2, 0, $2::uuid)`,
        [jobId, gbrainId],
      );

      const ctx = await makeCrashedCtx(jobId, 'do it', 'anthropic:claude-sonnet-4-6');

      // The gateway-loop throws "non-idempotent ... pending on resume; cannot safely re-run".
      // The subagent.ts handler doesn't catch this — it bubbles. Asserting it bubbles
      // out as an Error is the contract; an UnrecoverableError variant would be a future
      // upgrade.
      await expect(handler(ctx)).rejects.toThrow(/non-idempotent.*pending/i);
    });
  });

  describe('failed tool on prior turn — replay surfaces the error to the LLM', () => {
    it('prior failed tool replays as is_error result, loop completes', async () => {
      const tools = makeStubTools([]);
      const handler = buildHandler(tools);

      const jobRows = await engine.executeRaw<{ id: number }>(
        `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
         VALUES ('subagent', 'active', '{}'::jsonb, 'default', 0, now())
         RETURNING id`,
      );
      const jobId = jobRows[0].id;
      const gbrainId = '01987654-3210-7000-8000-cccccccccccc';

      // User msg + assistant turn with tool_use + failed tool row.
      await engine.executeRaw(
        `INSERT INTO subagent_messages
           (job_id, message_idx, role, content_blocks, model)
         VALUES ($1, 0, 'user', '[{"type":"text","text":"try"}]'::jsonb, NULL),
                ($1, 1, 'assistant', $2::jsonb, 'anthropic:claude-sonnet-4-6')`,
        [
          jobId,
          JSON.stringify([{ type: 'tool-call', toolCallId: 'tc-failed', toolName: 'search', input: {} }]),
        ],
      );
      await engine.executeRaw(
        `INSERT INTO subagent_tool_executions
           (job_id, message_idx, tool_use_id, tool_name, input, status, error,
            schema_version, ordinal, gbrain_tool_use_id)
         VALUES ($1, 1, 'tc-failed', 'search', '{}'::jsonb, 'failed', 'rate limited',
                 2, 0, $2::uuid)`,
        [jobId, gbrainId],
      );

      // Second turn: LLM acknowledges the failure and ends.
      __setChatTransportForTests(async () => ({
        text: 'I see search failed (rate limited). Aborting.',
        blocks: [{ type: 'text', text: 'I see search failed (rate limited). Aborting.' }] as ChatBlock[],
        stopReason: 'end',
        usage: { input_tokens: 30, output_tokens: 11, cache_read_tokens: 0, cache_creation_tokens: 0 },
        model: 'anthropic:claude-sonnet-4-6',
        providerId: 'anthropic',
      } satisfies ChatResult));

      const ctx = await makeCrashedCtx(jobId, 'try', 'anthropic:claude-sonnet-4-6');
      const result = await handler(ctx);

      expect(result.result).toContain('search failed');
      expect(result.stop_reason).toBe('end_turn');
      // The prior failed row stays failed (not overwritten).
      const finalRows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT status, error FROM subagent_tool_executions WHERE job_id = $1`,
        [jobId],
      );
      expect(finalRows[0].status).toBe('failed');
      expect(finalRows[0].error).toBe('rate limited');
    });
  });

  describe('reconciliation key uniqueness — concurrent replays don\'t double-insert', () => {
    it('two simultaneous replay attempts both see the same prior tool outcome (idempotent reconciliation)', async () => {
      // Simulates: worker A crashed → worker B picks up the job → worker C
      // also tries to pick it up (lock-contention edge). Both must reconcile
      // to the SAME stable key and skip the prior tool execution.
      const { jobId } = await seedCrashedState('concurrent replay', 'v2');

      const transport = async () => PROVIDER_MATRIX[0].finalResponse;
      __setChatTransportForTests(transport);

      const executions: Array<{ name: string; input: unknown }> = [];
      const tools = makeStubTools(executions);

      // Run handler twice in parallel against the same job. Real workers
      // would use the queue's lock to serialize, but the reconciler MUST
      // be safe even under spurious double-invocation.
      const handler1 = buildHandler(tools);
      const handler2 = buildHandler(tools);
      const ctx1 = await makeCrashedCtx(jobId, 'concurrent replay', 'anthropic:claude-sonnet-4-6');
      const ctx2 = await makeCrashedCtx(jobId, 'concurrent replay', 'anthropic:claude-sonnet-4-6');

      const [result1, result2] = await Promise.all([handler1(ctx1), handler2(ctx2)]);

      // Neither path re-executed the prior tool.
      expect(executions.length).toBe(0);
      expect(result1.result).toBe(PROVIDER_MATRIX[0].finalResponse.text);
      expect(result2.result).toBe(PROVIDER_MATRIX[0].finalResponse.text);

      // Only one prior tool exec row exists (no duplicate inserts).
      const toolRows = await engine.executeRaw<Record<string, unknown>>(
        `SELECT COUNT(*)::int AS n FROM subagent_tool_executions WHERE job_id = $1`,
        [jobId],
      );
      expect(Number(toolRows[0].n)).toBe(1);
    });
  });
});
