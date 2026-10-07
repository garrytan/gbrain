/**
 * #5474 at the runner level: a gateway-loop child whose brain write is still
 * pending after the tool's own wait must finish its attempt once the write
 * commits, on both the worker and the dream inline drain, instead of being
 * retried to death.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { LATEST_VERSION } from '../../src/core/migrate.ts';
import { MinionQueue } from '../../src/core/minions/queue.ts';
import { MinionWorker } from '../../src/core/minions/worker.ts';
import { runSubagentsInline } from '../../src/core/cycle/inline-drain.ts';
import { makeSubagentHandler } from '../../src/core/minions/handlers/subagent.ts';
import type { ToolDef } from '../../src/core/minions/types.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;
let providerTurns = 0;

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
  await engine.setConfig('version', String(LATEST_VERSION));
  await engine.setConfig('agent.use_gateway_loop', 'true');
  configureGateway({ chat_model: 'anthropic:claude-sonnet-4-6', embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    expansion_model: 'anthropic:claude-haiku-4-5', env: { ANTHROPIC_API_KEY: 'stub', OPENAI_API_KEY: 'stub' } } as never);
  providerTurns = 0;
  __setChatTransportForTests(async () => {
    providerTurns++;
    const first = providerTurns === 1;
    return { text: first ? '' : 'saved', stopReason: first ? 'tool_calls' : 'end',
      blocks: first ? [{ type: 'tool-call', toolCallId: 'write-1', toolName: 'brain_put_page', input: { slug: 'notes/runner-example', content: 'x' } }]
        : [{ type: 'text', text: 'saved' }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'openai:gpt-4o', providerId: 'openai' } satisfies ChatResult;
  });
});

/** put_page whose write reports `running` for the first `slowFor` dispatches; dispatch slowFor+1 commits. */
function slowCommit(slowFor: number) {
  const requestIds: unknown[] = [];
  const tool: ToolDef = { name: 'brain_put_page', description: 'example put_page', input_schema: { type: 'object' }, idempotent: true,
    async execute(input) {
      const request_id = (input as Record<string, unknown>).request_id; requestIds.push(request_id);
      return requestIds.length > slowFor ? { request_id, state: 'committed', retry_after_ms: null } : { request_id, state: 'running', retry_after_ms: 10 };
    } };
  return { tool, requestIds };
}

const gatewayHandler = (tool: ToolDef) => makeSubagentHandler({ engine, config: {} as never, toolRegistry: [tool],
  makeAnthropic: () => ({ messages: { create: async () => { throw new Error('legacy path must not run'); } } }) as never });

const finished = (status: string) => ['completed', 'failed', 'dead', 'cancelled'].includes(status);

async function viaWorker(tool: ToolDef): Promise<number> {
  const queue = new MinionQueue(engine);
  const job = await queue.add('subagent', { prompt: 'save the example', model: 'openai:gpt-4o' }, {}, { allowProtectedSubmit: true });
  const worker = new MinionWorker(engine, { pollInterval: 20 });
  worker.register('subagent', gatewayHandler(tool));
  const loop = worker.start();
  const until = Date.now() + 15_000;
  while (Date.now() < until && !finished((await queue.getJob(job.id))!.status)) await new Promise(resolve => setTimeout(resolve, 20));
  worker.stop();
  await loop;
  return job.id;
}

async function viaInlineDrain(tool: ToolDef): Promise<number> {
  const queue = new MinionQueue(engine);
  const queueName = `example-inline-${Date.now()}`;
  const job = await queue.add('subagent', { prompt: 'save the example', model: 'openai:gpt-4o' }, { queue: queueName }, { allowProtectedSubmit: true });
  await runSubagentsInline(engine, queue, queueName, undefined, gatewayHandler(tool));
  return job.id;
}

describe('a slow-committing subagent write does not cost the child its attempts (#5474)', () => {
  for (const [runner, run] of [['worker', viaWorker], ['dream inline drain', viaInlineDrain]] as const) {
    test(`${runner}: the child completes once its write commits`, async () => {
      const { tool, requestIds } = slowCommit(6);
      const jobId = await run(tool);
      const job = (await new MinionQueue(engine).getJob(jobId))!;
      expect(job.status).toBe('completed');
      expect({ failedAttempts: job.attempts_made, error: job.error_text ?? null }).toEqual({ failedAttempts: 0, error: null });
      expect(requestIds).toHaveLength(7);
      expect(new Set(requestIds).size).toBe(1);
      expect(providerTurns).toBe(2);
      const rows = await engine.executeRaw<{ status: string }>('SELECT status FROM subagent_tool_executions WHERE job_id=$1', [jobId]);
      expect(rows.map(row => row.status)).toEqual(['complete']);
    }, 30_000);
  }
});
