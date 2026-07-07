import { describe, expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import { OperationError, operationsByName } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import { effectiveToolTier } from '../src/mcp/tool-tiers.ts';

describe('agent session activation operation', () => {
  test('plan_agent_session_activation is registered as a read operation', () => {
    const op = operationsByName.plan_agent_session_activation;
    expect(op).toBeDefined();
    expect(op.mutating).toBe(false);
    expect(op.cliHints?.name).toBe('agent-session-activate');
  });

  test('rejects invalid requested_scope with OperationError', async () => {
    const engine = new SQLiteEngine();
    const ctx: OperationContext = {
      engine,
      config: {} as OperationContext['config'],
      logger: console,
      dryRun: false,
    };

    await expect(operationsByName.plan_agent_session_activation.handler(ctx, {
      query: 'implementation planning',
      requested_scope: 'private',
    })).rejects.toBeInstanceOf(OperationError);
  });

  test('get_core_memory_blocks is registered as an admin-tier read operation', () => {
    const op = operationsByName.get_core_memory_blocks;
    expect(op).toBeDefined();
    expect(op.mutating).toBe(false);
    expect(effectiveToolTier(op)).toBe('admin');
    expect(op.cliHints?.name).toBe('core-memory-blocks');
  });

  test('get_core_memory_blocks compiles budgeted blocks and rejects an invalid now', async () => {
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: ':memory:' });
    await engine.initSchema();
    const ctx: OperationContext = {
      engine,
      config: {} as OperationContext['config'],
      logger: console,
      dryRun: false,
    };

    try {
      const result = await operationsByName.get_core_memory_blocks.handler(ctx, {
        budget_tokens: 500,
        now: '2026-06-05T00:00:00.000Z',
      }) as {
        authority: string;
        budget_tokens: number;
        total_token_estimate: number;
        generated_at: string;
        blocks: Array<{ name: string }>;
      };

      expect(result.authority).toBe('not_answer_evidence');
      expect(result.budget_tokens).toBe(500);
      expect(result.total_token_estimate).toBeLessThanOrEqual(500);
      expect(result.generated_at).toBe('2026-06-05T00:00:00.000Z');
      expect(result.blocks.map((block) => block.name)).toEqual([
        'owner-profile',
        'active-projects',
        'attention',
      ]);

      await expect(operationsByName.get_core_memory_blocks.handler(ctx, {
        now: 'not-a-timestamp',
      })).rejects.toBeInstanceOf(OperationError);
    } finally {
      await engine.disconnect();
    }
  });
});
