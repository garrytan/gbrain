import { afterEach, describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import type { Operation } from '../src/core/operations.ts';
import {
  createMcpToolCatalogProvider,
  formatMcpToolResult,
  mcpResultTextBudgetForFinalFrame,
  prepareMcpToolParams,
} from '../src/mcp/server.ts';

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf-8');
}

const originalDeferPutPageDerived = process.env.MBRAIN_MCP_DEFER_PUT_PAGE_DERIVED;

afterEach(() => {
  if (originalDeferPutPageDerived === undefined) {
    delete process.env.MBRAIN_MCP_DEFER_PUT_PAGE_DERIVED;
  } else {
    process.env.MBRAIN_MCP_DEFER_PUT_PAGE_DERIVED = originalDeferPutPageDerived;
  }
});

describe('MCP response guard', () => {
  test('compact MCP tool catalog stays below the stdio pipe pressure budget', () => {
    const catalog = createMcpToolCatalogProvider();
    const tools = catalog.getTools({ compact: true });
    const bytes = byteLength(JSON.stringify({ tools }));

    expect(tools.length).toBe(operations.length);
    expect(bytes).toBeLessThan(56_000);

    const dryRunMutation = tools.find(tool => tool.name === 'dry_run_memory_mutation');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).toContain('put_page');
  });

  test('cached MCP tool catalog returns stable compact and full arrays', () => {
    const sampleOperations: Operation[] = [{
      name: 'sample',
      description: 'A sample operation with a deliberately long description for compact schema coverage.',
      params: {
        slug: {
          type: 'string',
          required: true,
          description: 'Page slug',
        },
      },
      handler: async () => ({ ok: true }),
    }];
    const catalog = createMcpToolCatalogProvider(sampleOperations);

    const compactTools = catalog.getTools({ compact: true });
    const compactToolsAgain = catalog.getTools({ compact: true });
    const fullTools = catalog.getTools({ compact: false });
    const fullToolsAgain = catalog.getTools({ compact: false });

    expect(compactTools).toBe(compactToolsAgain);
    expect(fullTools).toBe(fullToolsAgain);
    expect(compactTools).not.toBe(fullTools);
    expect(compactTools[0].description.length).toBeLessThan(fullTools[0].description.length);
    expect((compactTools[0].inputSchema.properties as any).slug.description).toBeUndefined();
    expect((fullTools[0].inputSchema.properties as any).slug.description).toBe('Page slug');
  });

  test('mcpResultTextBudgetForFinalFrame reserves outer JSON-RPC frame space', () => {
    const maxFrameBytes = 24_000;
    const maxResultTextBytes = mcpResultTextBudgetForFinalFrame({ maxFrameBytes });

    expect(maxResultTextBytes).toBeLessThan(maxFrameBytes);
    expect(maxResultTextBytes).toBeGreaterThanOrEqual(512);

    const text = formatMcpToolResult('get_page', {
      slug: 'brain/quoted-page',
      title: 'Quoted Page',
      compiled_truth: `"quoted"\n`.repeat(maxFrameBytes),
      timeline: `"timeline"\n`.repeat(maxFrameBytes),
    }, { maxResultTextBytes });
    const frame = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text }] },
    })}\n`;

    expect(byteLength(frame)).toBeLessThanOrEqual(maxFrameBytes);
  });

  test('adds a bounded get_page window for MCP calls unless full content is requested', () => {
    expect(prepareMcpToolParams('get_page', { slug: 'concepts/x' })).toEqual({
      slug: 'concepts/x',
      content_char_limit: 6_000,
    });

    expect(prepareMcpToolParams('get_page', {
      slug: 'concepts/x',
      full_content: true,
    })).toEqual({
      slug: 'concepts/x',
      full_content: true,
    });
  });

  test('MCP put_page defers derived storage by default while allowing opt-out', () => {
    delete process.env.MBRAIN_MCP_DEFER_PUT_PAGE_DERIVED;
    expect(prepareMcpToolParams('put_page', { slug: 'concepts/write' })).toEqual({
      slug: 'concepts/write',
      defer_derived: true,
    });

    expect(prepareMcpToolParams('put_page', {
      slug: 'concepts/write',
      defer_derived: false,
    })).toEqual({
      slug: 'concepts/write',
      defer_derived: false,
    });

    process.env.MBRAIN_MCP_DEFER_PUT_PAGE_DERIVED = 'false';
    expect(prepareMcpToolParams('put_page', { slug: 'concepts/write' })).toEqual({
      slug: 'concepts/write',
    });
  });

  test('serializes small tool results as compact JSON', () => {
    const text = formatMcpToolResult('get_health', {
      ok: true,
      nested: { value: 1 },
    }, { maxResultTextBytes: 1_000 });

    expect(text).toBe('{"ok":true,"nested":{"value":1}}');
  });

  test('bounds large get_page payloads while preserving page identity', () => {
    const text = formatMcpToolResult('get_page', {
      slug: 'brain/large-page',
      title: 'Large Page',
      type: 'note',
      content_hash: 'hash-large-page',
      compiled_truth: 'A'.repeat(5_000),
      timeline: 'B'.repeat(5_000),
      content_window: {
        truncated: true,
        compiled_truth: {
          returned_chars: 5_000,
          continuation_selector: { kind: 'compiled_truth', slug: 'brain/large-page', char_start: 5_000 },
        },
      },
      tags: ['stress'],
    }, { maxResultTextBytes: 1_500 });

    expect(byteLength(text)).toBeLessThanOrEqual(1_500);

    const parsed = JSON.parse(text);
    expect(parsed.slug).toBe('brain/large-page');
    expect(parsed.title).toBe('Large Page');
    expect(parsed.tags).toEqual(['stress']);
    expect(parsed.compiled_truth.length).toBeLessThan(5_000);
    expect(parsed.timeline.length).toBeLessThan(5_000);
    expect(parsed.content_window).toBeUndefined();
    expect(parsed._mbrain_mcp_response.truncated).toBe(true);
    expect(parsed._mbrain_mcp_response.original_response_bytes).toBeGreaterThan(1_500);
    expect(parsed._mbrain_mcp_response.hint).toContain('read_context');
    expect(parsed._mbrain_mcp_response.continuations.compiled_truth.tool).toBe('read_context');
    expect(parsed._mbrain_mcp_response.continuations.compiled_truth.arguments.selectors[0].kind).toBe('compiled_truth');
    expect(parsed._mbrain_mcp_response.continuations.compiled_truth.arguments.selectors[0].content_hash).toBe('hash-large-page');
    expect(parsed._mbrain_mcp_response.continuations.timeline.tool).toBe('read_context');
    expect(parsed._mbrain_mcp_response.continuations.timeline.arguments.selectors[0].kind).toBe('timeline_range');
    expect(parsed._mbrain_mcp_response.continuations.timeline.arguments.selectors[0].content_hash).toBe('hash-large-page');
  });

  test('uses Unicode scalar offsets in fallback get_page continuations', () => {
    const text = formatMcpToolResult('get_page', {
      slug: 'brain/unicode-large-page',
      title: 'Unicode Large Page',
      type: 'note',
      content_hash: 'hash-unicode-large-page',
      compiled_truth: '🙂'.repeat(200),
      timeline: '🚀'.repeat(200),
    }, { maxResultTextBytes: 1_500 });

    const parsed = JSON.parse(text);
    const selector = parsed._mbrain_mcp_response.continuations.compiled_truth.arguments.selectors[0];
    const marker = '\n\n[truncated by mbrain MCP response guard]';
    expect(selector.char_start).toBe(Array.from(parsed.compiled_truth.replace(marker, '')).length);
    expect(selector.content_hash).toBe('hash-unicode-large-page');
  });

  test('fallback get_page continuations advance from existing window offsets', () => {
    const text = formatMcpToolResult('get_page', {
      slug: 'brain/windowed-large-page',
      title: 'Windowed Large Page',
      type: 'note',
      content_hash: 'hash-windowed-large-page',
      compiled_truth: '🙂'.repeat(200),
      timeline: '🚀'.repeat(200),
      content_window: {
        compiled_truth: {
          char_start: 40,
          returned_chars: 200,
          total_chars: 400,
        },
        timeline: {
          char_start: 80,
          returned_chars: 200,
          total_chars: 500,
        },
      },
    }, { maxResultTextBytes: 1_500 });

    const parsed = JSON.parse(text);
    const marker = '\n\n[truncated by mbrain MCP response guard]';
    const compiledReturned = Array.from(parsed.compiled_truth.replace(marker, '')).length;
    const timelineReturned = Array.from(parsed.timeline.replace(marker, '')).length;
    expect(parsed._mbrain_mcp_response.continuations.compiled_truth.arguments.selectors[0].char_start).toBe(40 + compiledReturned);
    expect(parsed._mbrain_mcp_response.continuations.compiled_truth.remaining_chars).toBe(400 - 40 - compiledReturned);
    expect(parsed._mbrain_mcp_response.continuations.timeline.arguments.selectors[0].char_start).toBe(80 + timelineReturned);
    expect(parsed._mbrain_mcp_response.continuations.timeline.remaining_chars).toBe(500 - 80 - timelineReturned);
  });

  test('falls back to a bounded envelope for generic oversized results', () => {
    const text = formatMcpToolResult('unknown_large_tool', {
      rows: Array.from({ length: 100 }, (_, index) => ({
        id: index,
        payload: 'x'.repeat(1_000),
      })),
    }, { maxResultTextBytes: 1_200 });

    expect(byteLength(text)).toBeLessThanOrEqual(1_200);

    const parsed = JSON.parse(text);
    expect(parsed._mbrain_mcp_response.truncated).toBe(true);
    expect(parsed._mbrain_mcp_response.tool).toBe('unknown_large_tool');
    expect(parsed._mbrain_mcp_response.hint).toContain('MBRAIN_MCP_MAX_RESULT_TEXT_BYTES');
    expect(parsed._mbrain_mcp_response.hint).toContain('MBRAIN_MCP_MAX_STDIO_FRAME_BYTES');
    expect(parsed.partial_json.length).toBeGreaterThan(0);
  });
});
