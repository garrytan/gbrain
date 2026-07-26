import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const emptySearchEngine = {
  kind: 'postgres',
  searchKeyword: async () => [],
  listPages: async () => [],
  getPage: async () => null,
  // Prefer keyword-only MCP search so this mock does not need a full hybrid engine.
  getConfig: async (key: string) => (key === 'search.mcp_keyword_only' ? 'true' : null),
} as any;

function parseFirstText(result: Awaited<ReturnType<typeof dispatchToolCall>>): any {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('MCP retrieval guidance and input diagnostics', () => {
  test('accepts the same source selector for local and shared calls', async () => {
    const local = await dispatchToolCall(
      emptySearchEngine,
      'search',
      { query: 'Liu Cixin', source: 'duwu' },
      { remote: false, sourceId: 'default' },
    );
    const shared = await dispatchToolCall(
      emptySearchEngine,
      'search',
      { query: 'Liu Cixin', source: 'duwu' },
      { remote: true, sourceId: 'duwu' },
    );

    expect(local.isError).toBeUndefined();
    expect(shared.isError).toBeUndefined();
  });

  test('list_pages accepts the same source selector in shared mode', async () => {
    const result = await dispatchToolCall(
      emptySearchEngine,
      'list_pages',
      { source: 'duwu' },
      { remote: true, sourceId: 'duwu' },
    );

    expect(result.isError).toBeUndefined();
    expect(parseFirstText(result)).toEqual([]);
  });

  test('rejects a shared source selector outside the credential scope', async () => {
    const result = await dispatchToolCall(
      emptySearchEngine,
      'search',
      { query: 'Liu Cixin', source: 'private' },
      { remote: true, sourceId: 'duwu' },
    );

    expect(result.isError).toBe(true);
    const body = parseFirstText(result);
    expect(body.error).toBe('permission_denied');
    expect(body.message).toContain('outside this credential');
  });

  test('rejects Unicode replacement characters with an actionable UTF-8 error', async () => {
    const result = await dispatchToolCall(
      emptySearchEngine,
      'search',
      { query: '��¼7��' },
      { remote: true },
    );

    expect(result.isError).toBe(true);
    const body = parseFirstText(result);
    expect(body.error).toBe('invalid_encoding');
    expect(body.message).toContain('UTF-8');
    expect(body.message).toContain('arguments.query');
  });

  test('empty keyword search points the agent to query with the original wording', async () => {
    const question = '我家狗叫什么名字';
    const result = await dispatchToolCall(
      emptySearchEngine,
      'search',
      { query: question },
      { remote: true },
    );

    expect(result.isError).toBeUndefined();
    expect(parseFirstText(result)).toEqual([]);
    expect(result._meta?.pmbrain_guidance).toEqual({
      reason: 'keyword_no_match',
      next_tool: 'query',
      arguments: { query: question },
      instruction: 'Call query with the original user wording. Do not rewrite it into guessed keywords.',
    });
  });

  test('retrieval guidance merges with existing hot-memory metadata', async () => {
    const result = await dispatchToolCall(
      emptySearchEngine,
      'search',
      { query: '我家狗叫什么名字' },
      {
        remote: true,
        metaHook: async () => ({ brain_hot_memory: { facts: [] } }),
      },
    );

    expect(result._meta?.pmbrain_guidance).toBeDefined();
    expect(result._meta?.brain_hot_memory).toEqual({ facts: [] });
  });

  test('get_page failure tells the agent to reuse an exact returned slug', async () => {
    const result = await dispatchToolCall(
      emptySearchEngine,
      'get_page',
      { slug: '狗 靓靓' },
      { remote: true },
    );

    expect(result.isError).toBe(true);
    const body = parseFirstText(result);
    expect(body.error).toBe('page_not_found');
    expect(body.suggestion).toContain('Copy the exact `slug`');
    expect(body.suggestion).toContain('Do not invent');
  });
});
