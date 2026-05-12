import { afterEach, describe, expect, test } from 'bun:test';
import { operations } from '../src/core/operations.ts';
import { formatMcpToolResult, prepareMcpToolParams } from '../src/mcp/server.ts';
import { operationToMcpTool } from '../src/mcp/tool-schema.ts';

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
    const tools = operations.map(operation => operationToMcpTool(operation, { compact: true }));
    const bytes = byteLength(JSON.stringify({ tools }));

    expect(tools.length).toBe(operations.length);
    expect(bytes).toBeLessThan(56_000);

    const dryRunMutation = tools.find(tool => tool.name === 'dry_run_memory_mutation');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).toContain('put_page');
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
    expect(parsed._mbrain_mcp_response.continuations.timeline.tool).toBe('read_context');
    expect(parsed._mbrain_mcp_response.continuations.timeline.arguments.selectors[0].kind).toBe('timeline_range');
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
    expect(parsed.partial_json.length).toBeGreaterThan(0);
  });
});
