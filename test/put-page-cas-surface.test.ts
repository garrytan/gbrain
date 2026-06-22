import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { BrainEngine } from '../src/core/engine.ts';
import { OperationError, operations, operationsByName, type OperationContext } from '../src/core/operations.ts';
import { assertMcpPutPagePrecondition } from '../src/mcp/server.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

// Workstream D1: the MCP put_page surface requires observing the target (expected_content_hash
// field present); admin_put_page is the CLI/admin repair escape; the ledger records whether the
// precondition was supplied.

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
  test('assertMcpPutPagePrecondition rejects put_page when expected_content_hash is omitted', () => {
    let thrown: unknown;
    try {
      assertMcpPutPagePrecondition('put_page', { slug: SLUG, content: CONTENT });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationError);
    expect((thrown as OperationError).message).toContain('route_first');
    expect((thrown as OperationError).message).toContain('route_memory_writeback');
  });

  test('assertMcpPutPagePrecondition accepts a present field (null or hash) and ignores other tools', () => {
    expect(() => assertMcpPutPagePrecondition('put_page', { slug: SLUG, expected_content_hash: null })).not.toThrow();
    expect(() => assertMcpPutPagePrecondition('put_page', { slug: SLUG, expected_content_hash: 'a'.repeat(64) })).not.toThrow();
    // admin_put_page and every other tool are not gated by this check.
    expect(() => assertMcpPutPagePrecondition('admin_put_page', { slug: SLUG })).not.toThrow();
    expect(() => assertMcpPutPagePrecondition('get_page', { slug: SLUG })).not.toThrow();
  });

  test('admin_put_page is registered as a hidden, admin-tier op sharing the put_page handler', () => {
    const admin = operationsByName.admin_put_page;
    expect(admin).toBeDefined();
    expect(admin?.tier).toBe('admin');
    expect(admin?.cliHints?.hidden).toBe(true);
    expect(admin?.handler).toBe(operationsByName.put_page?.handler);
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
