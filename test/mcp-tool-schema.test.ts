import { describe, expect, test } from 'bun:test';
import { operationToMcpTool } from '../src/mcp/tool-schema.ts';
import { operations, type Operation } from '../src/core/operations.ts';

function operation(overrides: Partial<Operation>): Operation {
  return {
    name: 'get_stats',
    description: 'Brain statistics',
    params: {},
    handler: async () => ({}),
    ...overrides,
  };
}

describe('MCP tool schema metadata', () => {
  test('adds ChatGPT Apps-compatible annotations for read-only operations', () => {
    const tool = operationToMcpTool(operation({
      name: 'get_stats',
      mutating: false,
    }));

    expect(tool.title).toBe('Get Stats');
    expect(tool.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  test('marks overwriting writes as destructive', () => {
    const tool = operationToMcpTool(operation({
      name: 'put_page',
      mutating: true,
    }));

    expect(tool.title).toBe('Put Page');
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  test('marks destructive operations separately from ordinary writes', () => {
    const tool = operationToMcpTool(operation({
      name: 'delete_page',
      mutating: true,
    }));

    expect(tool.title).toBe('Delete Page');
    expect(tool.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  test('does not mark read-only catalog operations as destructive', () => {
    const catalog = operations.map(op => operationToMcpTool(op));
    const contradictory = catalog
      .filter(tool => tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint === true)
      .map(tool => tool.name);

    expect(contradictory).toEqual([]);
    expect(catalog.find(tool => tool.name === 'get_memory_redaction_plan')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
  });

  test('compact schemas omit ChatGPT Apps metadata to preserve stdio frame budget', () => {
    const tool = operationToMcpTool(operation({
      name: 'get_stats',
      mutating: false,
    }), { compact: true });

    expect(tool.title).toBeUndefined();
    expect(tool.description).toBeUndefined();
    expect(tool.annotations).toBeUndefined();
  });
});
