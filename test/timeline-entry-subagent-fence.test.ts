/**
 * #2778 — add_timeline_entry subagent slug fence.
 *
 * add_timeline_entry joined the subagent brain-tool allowlist, so it must be
 * confined exactly like put_page: when ctx.viaSubagent=true the target slug
 * must match the trusted-workspace allow-list (when set) or the legacy
 * wiki/agents/<subagentId>/ namespace, fail-closed on a missing subagentId.
 * Non-subagent callers (CLI, plain MCP) are unchanged.
 *
 * Uses dryRun ctxs — the fence runs BEFORE the dry-run short-circuit, so no
 * engine is needed (same pattern as test/put-page-namespace.test.ts).
 */

import { describe, test, expect } from 'bun:test';
import { operations, OperationError } from '../src/core/operations.ts';
import type { OperationContext, Operation } from '../src/core/operations.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const add_timeline_entry = operations.find(o => o.name === 'add_timeline_entry') as Operation;
if (!add_timeline_entry) throw new Error('add_timeline_entry op missing');

const ENTRY = { date: '2026-07-01', summary: 'test entry' };

function makeCtx(overrides: Partial<OperationContext> = {}): OperationContext {
  const engine = {} as BrainEngine; // dry_run short-circuits before touching the engine
  return {
    engine,
    config: { engine: 'postgres' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: true,
    remote: true,
    sourceId: 'default',
    ...overrides,
  };
}

describe('add_timeline_entry subagent fence (#2778)', () => {
  describe('regression: non-subagent callers unchanged', () => {
    test('local CLI write (viaSubagent undefined) accepts arbitrary slug', async () => {
      const ctx = makeCtx({ remote: false });
      const result = await add_timeline_entry.handler(ctx, { slug: 'people/alice-example', ...ENTRY });
      expect(result).toMatchObject({ dry_run: true, action: 'add_timeline_entry', slug: 'people/alice-example' });
    });

    test('MCP write (remote=true, viaSubagent=undefined) accepts arbitrary slug', async () => {
      const ctx = makeCtx({ remote: true });
      const result = await add_timeline_entry.handler(ctx, { slug: 'companies/acme-example', ...ENTRY });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('viaSubagent=false is the same as unset', async () => {
      const ctx = makeCtx({ viaSubagent: false, subagentId: 42 });
      const result = await add_timeline_entry.handler(ctx, { slug: 'anything/goes', ...ENTRY });
      expect(result).toMatchObject({ dry_run: true });
    });
  });

  describe('legacy namespace confinement', () => {
    test('accepts wiki/agents/<subagentId>/ prefix', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      const result = await add_timeline_entry.handler(ctx, { slug: 'wiki/agents/42/notes', ...ENTRY });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('rejects a slug outside the namespace', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 42 });
      const p = add_timeline_entry.handler(ctx, { slug: 'people/alice-example', ...ENTRY });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/add_timeline_entry/);
    });

    test('rejects prefix-collision attempt (wiki/agents/12evil/* with subagentId=12)', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 12 });
      const p = add_timeline_entry.handler(ctx, { slug: 'wiki/agents/12evil/foo', ...ENTRY });
      await expect(p).rejects.toBeInstanceOf(OperationError);
    });

    test('FAIL-CLOSED: viaSubagent=true with undefined subagentId rejects any slug', async () => {
      const ctx = makeCtx({ viaSubagent: true });
      const p = add_timeline_entry.handler(ctx, { slug: 'wiki/agents/42/foo', ...ENTRY });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/subagentId/);
    });
  });

  describe('trusted-workspace allow-list', () => {
    const allow = ['wiki/personal/patterns/*', 'wiki/originals/*'];

    test('accepts a slug inside the allow-list', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 7, allowedSlugPrefixes: allow });
      const result = await add_timeline_entry.handler(ctx, { slug: 'wiki/personal/patterns/topic-x', ...ENTRY });
      expect(result).toMatchObject({ dry_run: true });
    });

    test('rejects a slug outside the allow-list (even inside the legacy namespace)', async () => {
      const ctx = makeCtx({ viaSubagent: true, subagentId: 7, allowedSlugPrefixes: allow });
      const p = add_timeline_entry.handler(ctx, { slug: 'wiki/agents/7/notes', ...ENTRY });
      await expect(p).rejects.toBeInstanceOf(OperationError);
      await expect(p).rejects.toThrow(/allow-list/);
    });
  });
});
