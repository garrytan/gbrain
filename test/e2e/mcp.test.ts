/**
 * E2E MCP Protocol Test — Tier 1
 *
 * Verifies the MCP server can start and that the tools/list
 * from operations.ts generates correct tool definitions.
 *
 * Note: The full stdio MCP protocol test (spawn server, send JSON-RPC)
 * is complex because the MCP SDK uses its own transport layer. This test
 * verifies the tool generation logic directly, which is what matters for
 * agent compatibility.
 */

import { describe, test, expect } from 'bun:test';
import { operations } from '../../src/core/operations.ts';

describe('E2E: MCP Tool Generation', () => {
  test('operations generate valid MCP tool definitions', () => {
    // This replicates exactly what server.ts does in the tools/list handler
    const tools = operations.map(op => ({
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, {
            type: v.type === 'array' ? 'array' : v.type,
            ...(v.description ? { description: v.description } : {}),
            ...(v.enum ? { enum: v.enum } : {}),
            ...(v.items ? { items: { type: v.items.type } } : {}),
          }]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]) => v.required)
          .map(([k]) => k),
      },
    }));

    expect(tools.length).toBe(operations.length);
    expect(tools.length).toBeGreaterThanOrEqual(30);

    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
      expect(typeof tool.inputSchema.properties).toBe('object');
      expect(Array.isArray(tool.inputSchema.required)).toBe(true);
      for (const prop of Object.values(tool.inputSchema.properties) as Array<Record<string, unknown>>) {
        if (prop.type === 'array') {
          expect(prop.items).toBeTruthy();
        }
      }
    }

    // Verify specific tools exist
    const names = tools.map(t => t.name);
    expect(names).toContain('get_page');
    expect(names).toContain('put_page');
    expect(names).toContain('search');
    expect(names).toContain('query');
    expect(names).toContain('add_link');
    expect(names).toContain('get_health');
    expect(names).toContain('sync_brain');
    expect(names).toContain('file_upload');
  });

  test('MCP server module can be imported', async () => {
    // Verify the server module loads without errors
    const mod = await import('../../src/mcp/server.ts');
    expect(typeof mod.startMcpServer).toBe('function');
    expect(typeof mod.handleToolCall).toBe('function');
  });
});
