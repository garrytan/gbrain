/**
 * LIVE e2e — OpenRouter DeepSeek subagent abort/retry (TODOS.md OpenRouter follow-up).
 *
 * Skip-gated on OPENROUTER_API_KEY. First turn hits real OR DeepSeek V4 Flash, persists
 * the tool-call, completes the observation, then aborts before the follow-up
 * model turn. Resume must keep those persisted tool-call ids byte-identical
 * and must not re-dispatch the completed tool.
 *
 * The gateway loop swallows tool-execute errors (they become tool-result
 * isError blocks). Abort is therefore the job AbortSignal after the first
 * successful observation — not a throw from execute.
 *
 * Run (keep-keys required — unit preload strips OPENROUTER_API_KEY):
 *   GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 OPENROUTER_API_KEY=... \
 *     bun test test/e2e/openrouter-deepseek-subagent-replay.live.test.ts
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import type { MinionJobContext, ToolDef, ToolCtx } from '../../src/core/minions/types.ts';
import { configureGateway, resetGateway } from '../../src/core/ai/gateway.ts';

const MODEL = 'openrouter:deepseek/deepseek-v4-flash';
const API_KEY = process.env.OPENROUTER_API_KEY;
const skipAll = !API_KEY;
const SYSTEM =
  'You are a tool-using intern. You MUST call ping before you say anything else. Never answer in prose first.';

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
  // Flag OFF on purpose: OR DeepSeek must auto-route through the gateway.
  await engine.unsetConfig('agent.use_gateway_loop');
  if (skipAll) return;
  configureGateway({
    chat_model: MODEL,
    embedding_model: 'openrouter:openai/text-embedding-3-small',
    embedding_dimensions: 1024,
    expansion_model: MODEL,
    env: { OPENROUTER_API_KEY: API_KEY! },
  });
});

function makeCtx(
  jobId: number,
  prompt: string,
  signal: AbortSignal,
): MinionJobContext {
  return {
    id: jobId,
    name: 'subagent',
    data: { prompt, model: MODEL, max_turns: 4, system: SYSTEM },
    attempts_made: 0,
    signal,
    deadlineAtMs: null,
    shutdownSignal: new AbortController().signal,
    updateProgress: async () => {},
    updateTokens: async () => {},
    log: async () => {},
    isActive: async () => true,
    readInbox: async () => [],
  };
}

async function makeJob(prompt: string): Promise<{ jobId: number }> {
  const rows = await engine.executeRaw<{ id: number }>(
    `INSERT INTO minion_jobs (name, status, data, queue, priority, created_at)
     VALUES ('subagent', 'active', $1::jsonb, 'default', 0, now())
     RETURNING id`,
    [JSON.stringify({ prompt, model: MODEL, max_turns: 4, system: SYSTEM })],
  );
  return { jobId: rows[0]!.id };
}

describe('OpenRouter DeepSeek live — abort mid-loop and resume', () => {
  test('persisted tool-call ids stay byte-identical across resume', async () => {
    if (skipAll) {
      console.warn('[skip] OPENROUTER_API_KEY not set');
      return;
    }

    let pingCalls = 0;
    const firstAbort = new AbortController();
    const tools: ToolDef[] = [
      {
        name: 'ping',
        description: 'Mandatory ping. Call this tool once with {"who":"gbrain"} before answering.',
        input_schema: {
          type: 'object',
          properties: { who: { type: 'string' } },
          required: ['who'],
        },
        idempotent: true,
        async execute(_input: unknown, _ctx: ToolCtx) {
          pingCalls += 1;
          if (pingCalls === 1) {
            // Observation is complete; abort before the follow-up model turn.
            firstAbort.abort();
          }
          return { pong: true };
        },
      },
    ];

    const handler = makeSubagentHandler({
      engine,
      config: {} as never,
      toolRegistry: tools,
      makeAnthropic: () => ({
        messages: {
          create: async () => {
            throw new Error('legacy Anthropic SDK must not run for openrouter:*');
          },
        },
      }) as never,
    });

    const prompt = 'Call the ping tool exactly once with who=gbrain, then say done. Do not skip the tool.';
    const { jobId } = await makeJob(prompt);

    const first = await handler(makeCtx(jobId, prompt, firstAbort.signal));
    expect(pingCalls).toBe(1);
    expect(first.stop_reason).toBe('error');

    const firstRows = await engine.executeRaw<{ content_blocks: unknown }>(
      `SELECT content_blocks FROM subagent_messages
        WHERE job_id = $1 AND role = 'assistant'
        ORDER BY message_idx ASC LIMIT 1`,
      [jobId],
    );
    expect(firstRows.length).toBe(1);
    const firstBlocks = typeof firstRows[0]!.content_blocks === 'string'
      ? firstRows[0]!.content_blocks
      : JSON.stringify(firstRows[0]!.content_blocks);
    expect(firstBlocks).toMatch(/tool-call|tool_use/);

    const resume = await handler(makeCtx(jobId, prompt, new AbortController().signal));
    expect(resume.stop_reason).toBe('end_turn');
    // First observation already completed; resume must not re-execute it.
    expect(pingCalls).toBe(1);

    const secondRows = await engine.executeRaw<{ content_blocks: unknown }>(
      `SELECT content_blocks FROM subagent_messages
        WHERE job_id = $1 AND role = 'assistant'
        ORDER BY message_idx ASC LIMIT 1`,
      [jobId],
    );
    const secondBlocks = typeof secondRows[0]!.content_blocks === 'string'
      ? secondRows[0]!.content_blocks
      : JSON.stringify(secondRows[0]!.content_blocks);
    expect(secondBlocks).toBe(firstBlocks);
  }, 90_000);
});
