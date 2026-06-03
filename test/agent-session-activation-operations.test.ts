import { describe, expect, test } from 'bun:test';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName, OperationError } from '../src/core/operations.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

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
});
