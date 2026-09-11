import { describe, expect, test } from 'bun:test';
import { operations, resolveRequestedScope, type OperationContext } from '../src/core/operations.ts';
import { BRAIN_TOOL_ALLOWLIST, buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';

function context(overrides: Partial<OperationContext> = {}): OperationContext {
  return { engine: {} as any, config: {} as any, logger: console as any, dryRun: false,
    remote: true, sourceId: 'source-a', ...overrides };
}

describe('operation authorization boundaries', () => {
  test('scalar and empty-array remote grants reject an explicit foreign source', () => {
    for (const remote of [true, undefined]) {
      for (const allowedSources of [undefined, []]) {
        const ctx = context({ remote, auth: { allowedSources } as any });
        expect(() => resolveRequestedScope(ctx, 'source-b')).toThrow(/granted sources/);
        expect(resolveRequestedScope(ctx, 'source-a')).toEqual({ sourceId: 'source-a' });
      }
    }
  });

  test('unqualified reads retain the scalar default and local explicit routing', () => {
    expect(resolveRequestedScope(context(), undefined)).toEqual({ sourceId: 'source-a' });
    expect(resolveRequestedScope(context({ remote: false }), 'source-b')).toEqual({ sourceId: 'source-b' });
  });

  test('forget_fact cannot expire a foreign or private fact', async () => {
    const op = operations.find(op => op.name === 'forget_fact')!;
    for (const [source_id, visibility] of [['source-b', 'world'], ['source-a', 'private']]) {
      let expired = false;
      const engine = {
        executeRaw: async () => [{ id: '7', source_id, visibility, expired_at: null,
          entity_slug: null, row_num: null, source_markdown_slug: null }],
        expireFact: async () => { expired = true; },
      };
      await expect(op.handler(context({ engine: engine as any }), { id: 7 })).rejects.toThrow(/not found/);
      expect(expired).toBe(false);
    }
  });

  test('delegated registry contains no attachments or local-only operations', () => {
    const tools = buildBrainTools({ engine: {} as any, config: {} as any, subagentId: 7 });
    expect(tools.some(tool => ['brain_file_list', 'brain_file_url'].includes(tool.name))).toBe(false);
    for (const op of operations.filter(op => BRAIN_TOOL_ALLOWLIST.has(op.name))) {
      expect(op.localOnly).not.toBe(true);
    }
  });
});
