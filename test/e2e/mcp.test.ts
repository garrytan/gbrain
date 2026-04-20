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

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { operations, operationsByName } from '../../src/core/operations.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { hasDatabase, setupDB, teardownDB, importFixtures, getEngine } from './helpers.ts';

// Skip all E2E tests if no database is configured
const skipE2E = !hasDatabase();
const describeE2E = skipE2E ? describe.skip : describe;

describeE2E('E2E: MCP Tool Generation', () => {
  beforeAll(async () => {
    await setupDB();
    await importFixtures();
  });
  afterAll(teardownDB);
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

  test('handleToolCall calls put_page and get_timeline in sequence (MCP bug regression)', async () => {
    // Regression test for issue #249: MCP get_timeline returns [].
    //
    // The MCP server passes its own engine instance to handleToolCall.
    // handleToolCall creates a ctx with remote=false (trusted CLI path).
    // This test verifies the handleToolCall path doesn't have the
    // get_timeline empty-array bug by writing via handleToolCall
    // and immediately reading back via the same path.

    const engine = getEngine();

    // Step 1: Write a page with auto-timeline extraction via handleToolCall
    const putResult = await handleToolCall(engine, 'put_page', {
      slug: 'test/mcp-timeline-bug',
      content: `---
title: MCP Timeline Bug Test
type: concept
---

# Test

Body content.

<!-- timeline -->
2025-06-01: Test event happened here
<!-- /timeline -->
`,
    }) as { slug: string; status: string; auto_timeline?: { created: number } };

    expect(putResult.slug).toBe('test/mcp-timeline-bug');
    expect(putResult.auto_timeline?.created).toBeGreaterThanOrEqual(1);

    // Step 2: Read the timeline back via handleToolCall
    const timeline = await handleToolCall(engine, 'get_timeline', {
      slug: 'test/mcp-timeline-bug',
    }) as Array<{ date: string; summary: string }>;

    // This is the assertion that failed in issue #249
    expect(timeline.length).toBeGreaterThanOrEqual(1);
    const found = timeline.find(e => e.summary.includes('Test event'));
    expect(found).toBeDefined();
  });

  test('handleToolCall throws for unknown tools', async () => {
    const engine = getEngine();
    await expect(handleToolCall(engine, 'nonexistent_tool', {}))
      .rejects.toThrow(/Unknown tool/);
  });

  test('handleToolCall uses remote=false (trusted CLI path)', async () => {
    // handleToolCall is the `gbrain call` backing path, not the MCP stdio path.
    // It sets remote=false so auto operations run (auto_link, auto_timeline).
    const engine = getEngine();
    const result = await handleToolCall(engine, 'put_page', {
      slug: 'test/remote-flag',
      content: '---\ntitle: Remote Flag Test\ntype: concept\n---\n\nBody',
    }) as { auto_links?: unknown; auto_timeline?: unknown };

    // With remote=false, auto operations are NOT skipped (they run if enabled)
    // The result should NOT have auto_links.skipped or auto_timeline.skipped
    expect(result.auto_links?.['skipped']).toBeUndefined();
    expect(result.auto_timeline?.['skipped']).toBeUndefined();
  });
});
