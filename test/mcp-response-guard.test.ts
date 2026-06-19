import { afterEach, describe, expect, test } from 'bun:test';
import { resolveConfig } from '../src/core/config.ts';
import { operations, operationsByName } from '../src/core/operations.ts';
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
const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

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
    expect(bytes).toBeLessThan(58_000);

    const dryRunMutation = tools.find(tool => tool.name === 'dry_run_memory_mutation');
    expect((dryRunMutation?.inputSchema.properties as any).operation.enum).toContain('put_page');
  });

  test('offline MCP tool catalog hides unsupported capability-gated operations', () => {
    const catalog = createMcpToolCatalogProvider(operations, {
      config: resolveConfig({
        engine: 'sqlite',
        database_path: '/tmp/mbrain-offline-test.db',
        offline: true,
      }),
    });
    const compactTools = catalog.getTools({ compact: true });
    const fullTools = catalog.getTools({ compact: false });
    const compactNames = compactTools.map(tool => tool.name);
    const fullNames = fullTools.map(tool => tool.name);

    expect(compactNames).not.toContain('file_list');
    expect(compactNames).not.toContain('file_upload');
    expect(compactNames).not.toContain('file_url');
    expect(fullNames).toEqual(compactNames);
    expect(compactNames).toContain('get_page');
    expect(compactTools.length).toBeLessThan(operations.length);
  });

  test('pglite MCP tool catalog hides unsupported file operations', () => {
    const catalog = createMcpToolCatalogProvider(operations, {
      config: resolveConfig({
        engine: 'pglite',
        database_path: '/tmp/mbrain-local.pglite',
      }),
    });
    const compactTools = catalog.getTools({ compact: true });
    const fullTools = catalog.getTools({ compact: false });
    const compactNames = compactTools.map(tool => tool.name);
    const fullNames = fullTools.map(tool => tool.name);

    expect(compactNames).not.toContain('file_list');
    expect(compactNames).not.toContain('file_upload');
    expect(compactNames).not.toContain('file_url');
    expect(fullNames).toEqual(compactNames);
    expect(compactNames).toContain('get_page');
    expect(compactTools.length).toBeLessThan(operations.length);
  });

  test('offline file operations remain guarded when called directly', async () => {
    await expect(operationsByName.file_list.handler({
      config: resolveConfig({
        engine: 'sqlite',
        database_path: '/tmp/mbrain-offline-test.db',
        offline: true,
      }),
      dryRun: false,
      engine: {} as any,
      logger: noopLogger,
    }, {})).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringMatching(/sqlite\/local mode/i),
    });
  });

  test('pglite file operations remain guarded when called directly', async () => {
    await expect(operationsByName.file_upload.handler({
      config: resolveConfig({
        engine: 'pglite',
        database_path: '/tmp/mbrain-local.pglite',
      }),
      dryRun: true,
      engine: {} as any,
      logger: noopLogger,
    }, { path: '/tmp/example.txt' })).rejects.toMatchObject({
      code: 'unsupported_capability',
      message: expect.stringMatching(/pglite\/local mode/i),
    });
  });

  test('MCP tool catalog honors parameter-level capability requirements', () => {
    const sampleOperations: Operation[] = [
      {
        name: 'sample_public',
        description: 'Visible operation',
        params: {},
        handler: async () => ({ ok: true }),
      },
      {
        name: 'sample_file',
        description: 'File-backed operation',
        params: {
          storage_path: {
            type: 'string',
            required: true,
            capabilityRequired: 'files',
          },
        },
        handler: async () => ({ ok: true }),
      },
    ];
    const catalog = createMcpToolCatalogProvider(sampleOperations, {
      config: resolveConfig({
        engine: 'sqlite',
        database_path: '/tmp/mbrain-offline-test.db',
        offline: true,
      }),
    });

    expect(catalog.getTools({ compact: true }).map(tool => tool.name)).toEqual(['sample_public']);
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
    expect(compactTools[0].description).toBeUndefined();
    expect(fullTools[0].description).toBe(sampleOperations[0].description);
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
      expected_content_hash: null,
      defer_derived: true,
    });

    expect(prepareMcpToolParams('put_page', {
      slug: 'concepts/write',
      expected_content_hash: 'a'.repeat(64),
      defer_derived: false,
    })).toEqual({
      slug: 'concepts/write',
      expected_content_hash: 'a'.repeat(64),
      defer_derived: false,
    });

    process.env.MBRAIN_MCP_DEFER_PUT_PAGE_DERIVED = 'false';
    expect(prepareMcpToolParams('put_page', { slug: 'concepts/write' })).toEqual({
      slug: 'concepts/write',
      expected_content_hash: null,
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

  test('adds runnable required_reads continuation metadata for truncated retrieve_context results', () => {
    const requiredRead = {
      kind: 'section',
      slug: 'systems/mbrain',
      selector_id: 'section:workspace:default:systems/mbrain#compiled-truth@chars:120:',
      section_id: 'systems/mbrain#compiled-truth',
      content_hash: 'hash-systems-mbrain',
      char_start: 120,
      line_start: 3,
      line_end: 9,
    };
    const orientationOnlyRead = {
      kind: 'compiled_truth',
      slug: 'concepts/orientation-only',
      selector_id: 'compiled_truth:workspace:default:concepts/orientation-only',
      content_hash: 'hash-orientation-only',
    };

    const text = formatMcpToolResult('retrieve_context', {
      request_id: 'req-oversized-retrieve',
      required_reads: [requiredRead],
      read_plan: {
        mode: 'bounded_evidence',
        max_depth: 1,
        max_selectors: 1,
        selected_selectors: [requiredRead.selector_id],
        selected_selector_snapshots: [{
          ...requiredRead,
          content_hash: 'hash-from-read-plan-snapshot',
        }],
        deferred_candidate_ids: [],
        gap_reasons: [],
        next_actions: ['Call read_context with read_plan.selected_selector_snapshots before making factual claims.'],
      },
      orientation: {
        derived_consulted: [],
        recommended_reads: [orientationOnlyRead],
        summary_lines: ['Orientation only.'],
      },
      candidates: [{
        candidate_id: 'candidate-large',
        summary: 'x'.repeat(8_000),
      }],
    }, { maxResultTextBytes: 2_400 });

    expect(byteLength(text)).toBeLessThanOrEqual(2_400);

    const parsed = JSON.parse(text);
    expect(parsed._mbrain_mcp_response.hint).toContain('continuations.required_reads.arguments');
    expect(parsed._mbrain_mcp_response.hint).toContain('tool_search');
    const continuation = parsed._mbrain_mcp_response.continuations.required_reads;
    expect(continuation.tool).toBe('read_context');
    expect(continuation.lazy_discovery).toEqual({
      tool: 'tool_search',
      query: 'mbrain read_context',
      when: 'read_context is not callable in the current tool list',
    });
    expect(continuation.arguments).toEqual({
      selectors: [{
        ...requiredRead,
        content_hash: 'hash-from-read-plan-snapshot',
      }],
      token_budget: 900,
    });
    expect(JSON.stringify(continuation.arguments.selectors)).not.toContain('orientation-only');
  });

  test('adds runnable continuation selector metadata for truncated read_context results', () => {
    const continuationSelector = {
      kind: 'compiled_truth',
      slug: 'concepts/large-context',
      selector_id: 'compiled_truth:workspace:default:concepts/large-context@chars:2400:',
      content_hash: 'hash-large-context',
      char_start: 2_400,
    };
    const unreadRequired = {
      kind: 'timeline_range',
      slug: 'concepts/deferred-context',
      selector_id: 'timeline_range:workspace:default:concepts/deferred-context@chars:800:',
      content_hash: 'hash-deferred-context',
      char_start: 800,
      line_start: 30,
      line_end: 44,
    };

    const text = formatMcpToolResult('read_context', {
      answer_ready: {
        ready: false,
        answer_ground: [],
        unsupported_reasons: ['continuation_required'],
        citation_policy: 'cite canonical reads',
      },
      canonical_reads: [{
        selector: {
          kind: 'compiled_truth',
          slug: 'concepts/large-context',
          content_hash: 'hash-large-context',
        },
        authority: 'canonical',
        title: 'Large Context',
        text: 'Canonical evidence. '.repeat(800),
        source_refs: [],
        token_estimate: 5_000,
        has_more: true,
        continuation_selector: continuationSelector,
      }],
      evidence_claims: [],
      conflicts: [],
      warnings: [],
      unread_required: [unreadRequired],
      continuations: [continuationSelector],
    }, { maxResultTextBytes: 2_800 });

    expect(byteLength(text)).toBeLessThanOrEqual(2_800);

    const parsed = JSON.parse(text);
    expect(parsed._mbrain_mcp_response.hint).toContain('_mbrain_mcp_response.continuations');
    const metadataContinuations = parsed._mbrain_mcp_response.continuations;
    expect(metadataContinuations.continuation_selectors).toEqual({
      tool: 'read_context',
      arguments: {
        selectors: [continuationSelector],
        token_budget: 900,
      },
    });
    expect(metadataContinuations.unread_required).toEqual({
      tool: 'read_context',
      arguments: {
        selectors: [unreadRequired],
        token_budget: 900,
      },
    });
  });

  test('keeps tiny continuation fallback budgets bounded without throwing', () => {
    const text = formatMcpToolResult('retrieve_context', {
      request_id: 'req-tiny-budget',
      required_reads: Array.from({ length: 20 }, (_, index) => ({
        kind: 'compiled_truth',
        slug: `concepts/tiny-budget-${index}`,
        selector_id: `compiled_truth:workspace:default:concepts/tiny-budget-${index}@chars:${index * 100}:`,
        content_hash: `hash-tiny-budget-${index}`,
        char_start: index * 100,
      })),
      read_plan: {
        mode: 'bounded_evidence',
        max_depth: 1,
        max_selectors: 20,
        selected_selectors: [],
        deferred_candidate_ids: [],
        gap_reasons: [],
        next_actions: [],
      },
      candidates: [{
        candidate_id: 'large-candidate',
        summary: 'oversized '.repeat(2_000),
      }],
    }, { maxResultTextBytes: 64 });

    expect(byteLength(text)).toBeLessThanOrEqual(512);
    const parsed = JSON.parse(text);
    expect(parsed._mbrain_mcp_response.truncated).toBe(true);
    expect(parsed._mbrain_mcp_response.tool).toBe('retrieve_context');
    expect(parsed._mbrain_mcp_response.original_response_bytes).toBeGreaterThan(512);
    expect(parsed._mbrain_mcp_response.hint).toContain('continuations.required_reads.arguments');
    expect(parsed._mbrain_mcp_response.continuations_omitted).toBe(true);
    expect(parsed._mbrain_mcp_response.continuations).toBeUndefined();
  });
});
