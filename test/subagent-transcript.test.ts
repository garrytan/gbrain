/**
 * transcript renderer tests. Uses PGLite in-memory to round-trip messages +
 * tool executions through the actual schema so the loader path is exercised.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';
import {
  loadTranscriptRows,
  renderTranscript,
} from '../src/core/minions/transcript.ts';
import type { ContentBlock } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
let queue: MinionQueue;
let jobId: number;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  queue = new MinionQueue(engine);
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM subagent_messages');
  await engine.executeRaw('DELETE FROM subagent_tool_executions');
  await engine.executeRaw('DELETE FROM minion_jobs');
  const j = await queue.add(
    'subagent',
    { prompt: 'hi' },
    {},
    { allowProtectedSubmit: true },
  );
  jobId = j.id;
});

async function insertMessage(
  idx: number,
  role: 'user' | 'assistant',
  blocks: ContentBlock[],
  tokens: { in?: number; out?: number; cache_read?: number; cache_create?: number } = {},
  model = 'claude-sonnet-4-6',
) {
  await engine.executeRaw(
    `INSERT INTO subagent_messages (job_id, message_idx, role, content_blocks, tokens_in, tokens_out, tokens_cache_read, tokens_cache_create, model)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
    [jobId, idx, role, JSON.stringify(blocks), tokens.in ?? null, tokens.out ?? null, tokens.cache_read ?? null, tokens.cache_create ?? null, model],
  );
}

async function insertTool(
  idx: number,
  toolUseId: string,
  toolName: string,
  input: unknown,
  status: 'pending' | 'complete' | 'failed',
  output: unknown = null,
  error: string | null = null,
) {
  await engine.executeRaw(
    `INSERT INTO subagent_tool_executions (job_id, message_idx, tool_use_id, tool_name, input, status, output, error)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb, $8)`,
    [jobId, idx, toolUseId, toolName, JSON.stringify(input), status, output == null ? null : JSON.stringify(output), error],
  );
}

describe('loadTranscriptRows', () => {
  test('empty job returns empty arrays', async () => {
    const { messages, tools } = await loadTranscriptRows(engine, jobId);
    expect(messages).toEqual([]);
    expect(tools).toEqual([]);
  });

  test('returns messages in message_idx order', async () => {
    await insertMessage(1, 'assistant', [{ type: 'text', text: 'second' }]);
    await insertMessage(0, 'user', [{ type: 'text', text: 'first' }]);
    const { messages } = await loadTranscriptRows(engine, jobId);
    expect(messages.map(m => m.message_idx)).toEqual([0, 1]);
  });

  test('parses content_blocks from JSONB', async () => {
    const block: ContentBlock = { type: 'tool_use', id: 'tu_1', name: 'brain_search', input: { q: 'x' } };
    await insertMessage(0, 'assistant', [block]);
    const { messages } = await loadTranscriptRows(engine, jobId);
    expect(messages[0]!.content_blocks[0]!.type).toBe('tool_use');
  });
});

describe('renderTranscript', () => {
  test('empty messages produce a "no messages" placeholder', () => {
    const md = renderTranscript([], []);
    expect(md).toContain('# Subagent transcript');
    expect(md).toContain('_(no messages)_');
  });

  test('renders text content under role headers', async () => {
    await insertMessage(0, 'user', [{ type: 'text', text: 'hello' }]);
    await insertMessage(1, 'assistant', [{ type: 'text', text: 'hi back' }], { in: 5, out: 3 });
    const { messages, tools } = await loadTranscriptRows(engine, jobId);
    const md = renderTranscript(messages, tools);
    expect(md).toContain('## Message 0 — user');
    expect(md).toContain('hello');
    expect(md).toContain('## Message 1 — assistant');
    expect(md).toContain('hi back');
    expect(md).toContain('tokens:');
    expect(md).toContain('in=5');
  });

  test('renders tool_use with matching execution row', async () => {
    await insertMessage(0, 'assistant', [
      { type: 'tool_use', id: 'tu_42', name: 'brain_get_page', input: { slug: 'foo' } },
    ]);
    await insertTool(0, 'tu_42', 'brain_get_page', { slug: 'foo' }, 'complete', { title: 'Foo' });
    const { messages, tools } = await loadTranscriptRows(engine, jobId);
    const md = renderTranscript(messages, tools);
    expect(md).toContain('**tool_use** `brain_get_page`');
    expect(md).toContain('status: **complete**');
    expect(md).toContain('"title": "Foo"');
  });

  test('renders tool_use with failed execution row shows error', async () => {
    await insertMessage(0, 'assistant', [
      { type: 'tool_use', id: 'tu_43', name: 'brain_put_page', input: { slug: 'bad' } },
    ]);
    await insertTool(0, 'tu_43', 'brain_put_page', { slug: 'bad' }, 'failed', null, 'permission_denied');
    const { messages, tools } = await loadTranscriptRows(engine, jobId);
    const md = renderTranscript(messages, tools);
    expect(md).toContain('status: **failed**');
    expect(md).toContain('permission_denied');
  });

  test('pending tool execution is shown as pending', async () => {
    await insertMessage(0, 'assistant', [
      { type: 'tool_use', id: 'tu_44', name: 'brain_search', input: { q: 'x' } },
    ]);
    await insertTool(0, 'tu_44', 'brain_search', { q: 'x' }, 'pending');
    const { messages, tools } = await loadTranscriptRows(engine, jobId);
    const md = renderTranscript(messages, tools);
    expect(md).toContain('pending (no resolution recorded yet)');
  });

  test('truncates huge tool outputs per maxOutputBytes', async () => {
    await insertMessage(0, 'assistant', [
      { type: 'tool_use', id: 'tu_big', name: 'brain_search', input: {} },
    ]);
    const huge = 'x'.repeat(8000);
    await insertTool(0, 'tu_big', 'brain_search', {}, 'complete', { body: huge });
    const { messages, tools } = await loadTranscriptRows(engine, jobId);
    const md = renderTranscript(messages, tools, { maxOutputBytes: 1024 });
    expect(md).toContain('[truncated at 1024 bytes]');
    expect(md.length).toBeLessThan(huge.length);
  });

  test('unknown block types fall through to a JSON dump', async () => {
    await insertMessage(0, 'assistant', [{ type: 'some_future_block_type', extra: 42 } as any]);
    const { messages, tools } = await loadTranscriptRows(engine, jobId);
    const md = renderTranscript(messages, tools);
    expect(md).toContain('**some_future_block_type**');
    expect(md).toContain('"extra": 42');
  });
});
