import { describe, expect, test } from 'bun:test';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';

const emptySearchEngine = {
  kind: 'postgres',
  searchKeyword: async () => [],
  getPage: async () => null,
} as any;

function parseFirstText(result: Awaited<ReturnType<typeof dispatchToolCall>>): any {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

describe('MCP retrieval guidance and input diagnostics', () => {
  test('rejects unknown search parameters instead of silently ignoring source', async () => {
    const result = await dispatchToolCall(
      emptySearchEngine,
      'search',
      { query: '刘慈欣', source: 'duwu' },
      { remote: true },
    );

    expect(result.isError).toBe(true);
    const body = parseFirstText(result);
    expect(body.error).toBe('invalid_params');
    expect(body.message).toContain('Unknown parameter: source');
    expect(body.message).toContain('Allowed parameters: query, limit, offset');
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
