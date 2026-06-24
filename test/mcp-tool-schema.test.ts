import { describe, expect, test } from 'bun:test';
import { type Operation, operations } from '../src/core/operations.ts';
import { operationToMcpTool } from '../src/mcp/tool-schema.ts';

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

  test('canonical target proposal tools expose read/write annotations and required params', () => {
    const catalog = new Map(operations.map(op => [op.name, operationToMcpTool(op)]));

    expect(catalog.get('list_canonical_target_proposals')?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(catalog.get('approve_canonical_target_proposal')?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    });

    const createSchema = catalog.get('create_canonical_target_proposal')?.inputSchema as any;
    const approveSchema = catalog.get('approve_canonical_target_proposal')?.inputSchema as any;
    const bindSchema = catalog.get('bind_memory_candidate_target')?.inputSchema as any;

    expect(createSchema.required).toContain('candidate_id');
    expect(approveSchema.required).toEqual(expect.arrayContaining([
      'proposal_id',
      'session_id',
      'realm_id',
      'actor',
      'source_refs',
    ]));
    expect(approveSchema.properties.create_missing_page_stub.type).toBe('boolean');
    expect(bindSchema.required).toEqual(expect.arrayContaining([
      'candidate_id',
      'proposal_id',
      'target_object_type',
      'target_object_id',
      'expected_current_target_object_type',
      'expected_current_target_object_id',
      'session_id',
      'realm_id',
      'actor',
      'source_refs',
    ]));
  });

  test('compact schemas always keep title and safety annotations but omit description', () => {
    const readOnly = operationToMcpTool(operation({
      name: 'get_stats',
      mutating: false,
    }), { compact: true });

    expect(readOnly.title).toBe('Get Stats');
    expect(readOnly.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    });
    expect(readOnly.description).toBeUndefined();

    const destructive = operationToMcpTool(operation({
      name: 'delete_page',
      mutating: true,
    }), { compact: true });

    expect(destructive.title).toBe('Delete Page');
    expect(destructive.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    });
  });

  test('compact catalog keeps title + annotations on every tool and a discoverable get_skillpack', () => {
    const catalog = new Map(operations.map(op => [op.name, operationToMcpTool(op, { compact: true })]));
    for (const tool of catalog.values()) {
      expect(typeof tool.title).toBe('string');
      expect(tool.annotations).toBeDefined();
    }
    // get_skillpack (the runtime self-orientation entrypoint) carries a compact description.
    expect(catalog.get('get_skillpack')?.description).toContain('get_skillpack');
  });

  test('compact schemas keep the retrieval-intent enum on the governed routing ops', () => {
    const catalog = new Map(operations.map(op => [op.name, operationToMcpTool(op, { compact: true })]));
    const expectedIntents = [
      'task_resume',
      'broad_synthesis',
      'precision_lookup',
      'mixed_scope_bridge',
      'personal_profile_lookup',
      'personal_episode_lookup',
    ];
    for (const name of ['evaluate_scope_gate', 'select_retrieval_route']) {
      const schema = catalog.get(name)?.inputSchema as any;
      expect(schema.properties.intent.enum).toEqual(expectedIntents);
    }
  });

  test('compact schemas preserve required params for validation-aware clients', () => {
    const tool = operationToMcpTool(operation({
      params: {
        slug: { type: 'string', required: true },
        content: { type: 'string' },
      },
    }), { compact: true });

    expect(tool.inputSchema.required).toEqual(['slug']);
  });

  test('compact schemas preserve only explicitly opted-in descriptions', () => {
    const tool = operationToMcpTool(operation({
      description: 'Full tool description.',
      discovery: {
        compactDescription: true,
        description: 'Compact tool description.',
      },
      params: {
        compact_hint: {
          type: 'string',
          description: 'Compact parameter description.',
          compactDescription: true,
        },
        verbose_hint: {
          type: 'string',
          description: 'Full parameter description.',
        },
      },
    }), { compact: true });

    expect(tool.description).toBe('Compact tool description.');
    expect((tool.inputSchema.properties as any).compact_hint.description).toBe('Compact parameter description.');
    expect((tool.inputSchema.properties as any).verbose_hint.description).toBeUndefined();
  });

  test('compact schemas omit bare object array item hints while preserving scalar item hints', () => {
    const tool = operationToMcpTool(operation({
      params: {
        object_items: {
          type: 'array',
          items: { type: 'object' },
        },
        string_items: {
          type: 'array',
          items: { type: 'string' },
        },
      },
    }), { compact: true });

    expect((tool.inputSchema.properties as any).object_items.items).toBeUndefined();
    expect((tool.inputSchema.properties as any).string_items.items).toEqual({ type: 'string' });
  });

  test('compact schemas can omit oversized enum hints while full schemas keep them', () => {
    const op = operation({
      params: {
        audit_filter: {
          type: 'string',
          enum: ['one', 'two'],
          compactEnum: false,
        },
      },
    });

    const fullTool = operationToMcpTool(op);
    const compactTool = operationToMcpTool(op, { compact: true });

    expect((fullTool.inputSchema.properties as any).audit_filter.enum).toEqual(['one', 'two']);
    expect((compactTool.inputSchema.properties as any).audit_filter.enum).toBeUndefined();
  });
});
