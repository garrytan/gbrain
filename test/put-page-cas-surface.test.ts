import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { dispatchOperation, OperationError, operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { assertMcpPutPagePrecondition, handleToolCall, prepareMcpToolParams } from '../src/mcp/server.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

// Workstream A1/D1: public put_page requires observing the target (expected_content_hash field
// present) at the operation layer; admin_put_page is the CLI/admin repair escape; the ledger
// records whether the precondition was supplied.

const SLUG = 'concepts/cas-surface-check';
const CONTENT = [
  '---',
  'type: concept',
  'title: CAS Surface Check',
  '---',
  '',
  'CAS surface check. [Source: put_page CAS surface test, direct call, 2026-06-22 12:00 PM KST]',
].join('\n');

describe('put_page MCP precondition surface (D1)', () => {
  test('assertMcpPutPagePrecondition rejects a blind put_page (precondition field absent, no session)', () => {
    // The MCP SDK client drops a null-valued field, so a fresh create over the SDK arrives with
    // the field absent and no session — exactly the blind-create case that must route first.
    let thrown: unknown;
    try {
      assertMcpPutPagePrecondition('put_page', { slug: SLUG, content: CONTENT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationError);
    expect((thrown as OperationError).message).toContain('route_first');
    expect((thrown as OperationError).suggestion).toContain('route_memory_writeback');
  });

  test('assertMcpPutPagePrecondition allows observed writes only and ignores other tools', () => {
    // Explicit null (raw JSON-RPC callers keep it) asserts the page is absent — allowed.
    expect(() => assertMcpPutPagePrecondition('put_page', { slug: SLUG, content: CONTENT, expected_content_hash: null })).not.toThrow();
    // A real content hash (optimistic update) is allowed.
    expect(() => assertMcpPutPagePrecondition('put_page', { slug: SLUG, expected_content_hash: 'a'.repeat(64) })).not.toThrow();
    // memory_session_id is realm access context, not a route-first write grant.
    expect(() => assertMcpPutPagePrecondition('put_page', { slug: SLUG, content: CONTENT, memory_session_id: 'session:1' })).toThrow(/route_first/);
    // admin_put_page and every other tool are not gated by this check.
    expect(() => assertMcpPutPagePrecondition('admin_put_page', { slug: SLUG })).not.toThrow();
    expect(() => assertMcpPutPagePrecondition('get_page', { slug: SLUG })).not.toThrow();
  });

  test('admin_put_page is registered as a hidden, admin-tier operation escape', () => {
    const admin = operationsByName.admin_put_page;
    expect(admin).toBeDefined();
    expect(admin?.tier).toBe('admin');
    expect(admin?.cliHints?.hidden).toBe(true);
    expect(admin?.handler).not.toBe(operationsByName.put_page?.handler);
  });

  test('MCP parameter preparation never injects a null-CAS create precondition', () => {
    expect(prepareMcpToolParams('put_page', { slug: SLUG, content: CONTENT })).not.toHaveProperty('expected_content_hash');
    expect(prepareMcpToolParams('put_page', {
      slug: SLUG,
      content: CONTENT,
      memory_session_id: 'session:1',
    })).not.toHaveProperty('expected_content_hash');
  });
});

describe('put_page precondition ledger (D1)', () => {
  let engine: SQLiteEngine;
  let dir: string;
  let ctx: OperationContext;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mbrain-cas-surface-'));
    engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();
    ctx = { engine: engine as unknown as BrainEngine, config: {} as any, logger: console, dryRun: false };
  });

  afterEach(async () => {
    await engine.disconnect();
    rmSync(dir, { recursive: true, force: true });
  });

  const op = (name: string) => {
    const found = operations.find((o) => o.name === name);
    if (!found) throw new Error(`missing op: ${name}`);
    return found;
  };

  test('public put_page rejects direct operation calls without route-first precondition', async () => {
    await expect(op('put_page').handler(ctx, { slug: SLUG, content: CONTENT })).rejects.toMatchObject({
      name: 'OperationError',
      code: 'invalid_params',
      message: expect.stringContaining('route_first'),
    });
    expect(await engine.getPage(SLUG)).toBeNull();
  });

  test('public put_page rejects an undefined precondition property as still blind', async () => {
    await expect(op('put_page').handler(ctx, {
      slug: SLUG,
      content: CONTENT,
      expected_content_hash: undefined,
    })).rejects.toThrow(/route_first/);
    expect(await engine.getPage(SLUG)).toBeNull();
  });

  test('dispatch and legacy tool-call paths inherit the operation-layer guard', async () => {
    await expect(dispatchOperation(ctx, op('put_page'), { slug: SLUG, content: CONTENT }))
      .rejects.toThrow(/route_first/);
    await expect(handleToolCall(engine as unknown as BrainEngine, 'put_page', { slug: SLUG, content: CONTENT }))
      .rejects.toThrow(/route_first/);
  });

  test('public put_page dry-run still requires route-first precondition', async () => {
    await expect(op('put_page').handler({ ...ctx, dryRun: true }, { slug: SLUG, content: CONTENT }))
      .rejects.toThrow(/route_first/);
  });

  test('put_page with null on an absent slug succeeds and records precondition_supplied=true', async () => {
    await op('put_page').handler(ctx, { slug: SLUG, content: CONTENT, expected_content_hash: null });
    const events = await engine.listMemoryMutationEvents({ operation: 'put_page', target_id: SLUG });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].result).toBe('applied');
    expect((events[0].metadata as any).precondition_supplied).toBe(true);
  });

  test('admin_put_page without a precondition still writes and records precondition_supplied=false', async () => {
    await op('admin_put_page').handler(ctx, { slug: SLUG, content: CONTENT });
    const page = await engine.getPage(SLUG);
    expect(page?.slug).toBe(SLUG);
    const events = await engine.listMemoryMutationEvents({ operation: 'put_page', target_id: SLUG });
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect((events[0].metadata as any).precondition_supplied).toBe(false);
  });
});
