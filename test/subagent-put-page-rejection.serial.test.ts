import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type Anthropic from '@anthropic-ai/sdk';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import { operations } from '../src/core/operations.ts';
import { MAX_FILE_SIZE } from '../src/core/import-file.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { makeSubagentHandler, type MessagesClient } from '../src/core/minions/handlers/subagent.ts';
import { finalizeWriteAccounting } from '../src/core/minions/handlers/subagent-persistence.ts';
import { __setChatTransportForTests, configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import type { MinionJobContext, SubagentResult } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
const config = { engine: 'pglite' as const };
const slug = 'wiki/personal/reflections/rejected-abc123';
const input = { slug, content: '---\ntype: note\ntitle: Example\n---\nA saved note.' };
const putPage = operations.find(op => op.name === 'put_page')!;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
}, 60_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_rate_leases');
  await engine.executeRaw('DELETE FROM minion_jobs');
  await engine.executeRaw('DELETE FROM pages');
});

afterEach(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.unsetConfig('agent.use_gateway_loop');
});

afterAll(async () => {
  await engine.disconnect();
});

async function makeContext(lane: 'anthropic' | 'gateway' | 'oneshot'): Promise<MinionJobContext> {
  const data = {
    prompt: 'Write a note.', require_writes: true,
    model: lane === 'gateway' ? 'openai:gpt-5.2' : 'anthropic:claude-sonnet-4-6',
    allowed_tools: ['put_page'], allowed_slug_prefixes: ['wiki/personal/reflections/*'],
    ...(lane === 'oneshot' ? { mode: 'oneshot', oneshot_slug_suffix: 'abc123' } : {}),
  };
  const job = await queue.add('subagent', data, {}, { allowProtectedSubmit: true });
  return {
    id: job.id, name: job.name, data, attempts_made: 0, deadlineAtMs: null,
    signal: new AbortController().signal, shutdownSignal: new AbortController().signal,
    async updateProgress() {}, async updateTokens() {}, async log() {},
    async isActive() { return true; }, async readInbox() { return []; },
  };
}

function chatResult(text: string, blocks: ChatResult['blocks']): ChatResult {
  return {
    model: 'openai:gpt-5.2', providerId: 'openai', text, blocks, stopReason: 'end',
    usage: { input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_creation_tokens: 0 },
  };
}

describe('put_page result normalization', () => {
  test('invalid YAML and oversized content reject without creating a page', async () => {
    const tool = buildBrainTools({ subagentId: 1, engine, config, deferEmbeds: true })
      .find(tool => tool.name === 'brain_put_page')!;
    for (const content of ['---\ntitle: [\n---\nbody', 'x'.repeat(MAX_FILE_SIZE + 1)]) {
      await expect(tool.execute({ slug: 'wiki/agents/1/rejected', content }, { engine, jobId: 1, remote: true }))
        .rejects.toThrow('page content was rejected before persistence');
      expect(await engine.getPage('wiki/agents/1/rejected', { sourceId: 'default' })).toBeNull();
    }
  });

  test('saving the same persisted page again remains a successful unchanged skip', async () => {
    const tool = buildBrainTools({ subagentId: 1, engine, config, deferEmbeds: true })
      .find(tool => tool.name === 'brain_put_page')!;
    const page = { ...input, slug: 'wiki/agents/1/saved' };
    expect(await tool.execute(page, { engine, jobId: 1, remote: true }))
      .toMatchObject({ status: 'created_or_updated' });
    expect(await tool.execute(page, { engine, jobId: 1, remote: true }))
      .toMatchObject({ status: 'skipped' });
    expect(await engine.getPage(page.slug, { sourceId: 'default' })).not.toBeNull();
  });

  test('scoped accounting reads JSON-string rejects without borrowing a prior invocation success', async () => {
    const ctx = await makeContext('oneshot');
    for (const [toolUseId, output] of [
      ['oneshot-aaaaaaaa-p0', { status: 'created_or_updated' }],
      ['oneshot-bbbbbbbb-p0', JSON.stringify({ status: 'skipped', error: 'Content rejected' })],
    ] as const) {
      await engine.executeRaw(
        `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output)
         VALUES ($1, 1, $2, 'brain_put_page', $3::text::jsonb, 'complete', $4::text::jsonb)`,
        [ctx.id, toolUseId, JSON.stringify(input), JSON.stringify(output)],
      );
    }
    const result: SubagentResult = {
      result: 'done', stop_reason: 'end_turn', turns_count: 1,
      tokens: { in: 10, out: 5, cache_read: 0, cache_create: 0 },
    };
    await expect(finalizeWriteAccounting(engine, ctx.id, result, {
      requireWrites: true, scopeToolUseIdPrefix: 'oneshot-bbbbbbbb-',
    })).rejects.toThrow('all 1 put_page write(s) failed');
    expect(await finalizeWriteAccounting(engine, ctx.id, result, {
      requireWrites: false, scopeToolUseIdPrefix: 'oneshot-bbbbbbbb-',
    })).toMatchObject({ pages_attempted: 1, pages_written: 0, pages_failed: 1 });
    expect(await finalizeWriteAccounting(engine, ctx.id, result, { requireWrites: true }))
      .toMatchObject({ pages_attempted: 2, pages_written: 1, pages_failed: 1 });
  });

  for (const output of [
    { slug, status: 'skipped', chunks: 0 },
    { slug, status: 'created_or_updated', embedding: { status: 'failed', error: 'Embedding unavailable' } },
  ]) {
    test(`successful persisted envelope is preserved: ${output.status}`, async () => {
      const mocked = spyOn(putPage, 'handler').mockResolvedValue(output);
      try {
        const tool = buildBrainTools({ subagentId: 1, engine, config }).find(tool => tool.name === 'brain_put_page')!;
        expect(await tool.execute(input, { engine, jobId: 1, remote: true })).toEqual(output);
      } finally {
        mocked.mockRestore();
      }
    });
  }
});

for (const lane of ['anthropic', 'gateway', 'oneshot'] as const) {
  for (const status of ['error', 'skipped'] as const) {
    test(`${lane} settles ${status} rejections as failed, including optional-write replay`, async () => {
      const mocked = spyOn(putPage, 'handler').mockResolvedValue({ slug, status, error: 'Import rejected', chunks: 0 });
      let calls = 0;
      const client: MessagesClient = {
        async create(params) {
          calls++;
          return {
            id: `message-${calls}`, type: 'message', role: 'assistant', model: params.model, stop_sequence: null,
            content: calls === 1
              ? [{ type: 'tool_use', id: 'put-1', name: 'brain_put_page', input }]
              : [{ type: 'text', text: 'done' }],
            stop_reason: calls === 1 ? 'tool_use' : 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          } as Anthropic.Message;
        },
      };
      try {
        configureGateway({ env: {} });
        await engine.setConfig('agent.use_gateway_loop', lane === 'gateway' ? 'true' : 'false');
        __setChatTransportForTests(async () => {
          calls++;
          return calls === 1
            ? { ...chatResult('', [{ type: 'tool-call', toolCallId: 'put-1', toolName: 'brain_put_page', input }]), stopReason: 'tool_calls' }
            : chatResult('done', [{ type: 'text', text: 'done' }]);
        });
        const handler = makeSubagentHandler({
          engine, config, client,
          _chat: async () => {
            calls++;
            const text = JSON.stringify({ pages: [{ slug, body: 'A note about [[people/alice-example]].' }], skipped: false });
            return chatResult(text, [{ type: 'text', text }]);
          },
        });
        const ctx = await makeContext(lane);
        await expect(handler(ctx)).rejects.toThrow('all 1 put_page write(s) failed');
        const rows = await engine.executeRaw<{ status: string; error: string }>(
          'SELECT status, error FROM subagent_tool_executions WHERE job_id = $1', [ctx.id],
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].status).toBe('failed');
        expect(rows[0].error).toContain('page content was rejected before persistence');
        expect(rows[0].error).not.toContain('Import rejected');
        expect(mocked).toHaveBeenCalledTimes(1);
        const callsBeforeReplay = calls;
        const optional = await handler({ ...ctx, data: { ...ctx.data, require_writes: false } });
        expect(optional.pages_attempted).toBe(1);
        expect(optional.pages_written).toBe(0);
        expect(optional.pages_failed).toBe(1);
        expect(calls).toBe(callsBeforeReplay);
      } finally {
        mocked.mockRestore();
      }
    });
  }

  test(`${lane} historical completed rejection cannot satisfy required writes`, async () => {
    const ctx = await makeContext(lane);
    await engine.setConfig('agent.use_gateway_loop', lane === 'gateway' ? 'true' : 'false');
    await engine.executeRaw(
      `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks, tokens_out)
       VALUES ($1, 0, 'user', $2::text::jsonb, NULL), ($1, 1, 'assistant', $3::text::jsonb, 5)`,
      [ctx.id, JSON.stringify([{ type: 'text', text: 'Write a note.' }]), JSON.stringify([{ type: 'text', text: 'done' }])],
    );
    await engine.executeRaw(
      `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output)
       VALUES ($1, 1, $2, 'brain_put_page', $3::text::jsonb, 'complete', $4::text::jsonb)`,
      [ctx.id, lane === 'oneshot' ? 'oneshot-abcd1234-p0' : 'put-1', JSON.stringify(input),
        JSON.stringify({ slug, status: 'skipped', error: 'Content rejected', chunks: 0 })],
    );
    let calls = 0;
    const handler = makeSubagentHandler({
      engine, config,
      client: { async create() { calls++; throw new Error('Unexpected replay model call'); } },
      _chat: async () => { calls++; throw new Error('Unexpected replay model call'); },
    });
    await expect(handler(ctx)).rejects.toThrow('all 1 put_page write(s) failed');
    const optional = await handler({ ...ctx, data: { ...ctx.data, require_writes: false } });
    expect(optional.pages_written).toBe(0);
    expect(optional.pages_failed).toBe(1);
    expect(calls).toBe(0);
  });
}
