import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { LATEST_VERSION } from '../src/core/migrate.ts';
import { OperationError } from '../src/core/operations.ts';
import { assertMcpSurfaceSchemaReady, mapUnknownMcpToolError } from '../src/mcp/server.ts';

describe('MCP schema drift error mapping', () => {
  test('maps undefined-column and undefined-table database errors to schema_out_of_date', () => {
    for (const error of [
      Object.assign(new Error('column "completed_at" does not exist'), { code: '42703' }),
      Object.assign(new Error('relation "memory_jobs" does not exist'), { code: '42P01' }),
    ]) {
      const mapped = mapUnknownMcpToolError(error);

      expect(mapped).toBeInstanceOf(OperationError);
      const operationError = mapped as OperationError;
      expect(operationError.toJSON()).toMatchObject({
        error: 'schema_out_of_date',
        suggestion: 'Run mbrain init to apply pending schema migrations, then restart the MCP surface.',
      });
      expect(operationError.message).toContain(`required schema v${LATEST_VERSION}`);
      expect(operationError.message).not.toContain('completed_at');
      expect(operationError.message).not.toContain('memory_jobs');
    }
  });

  test('leaves unrelated exceptions unmapped', () => {
    const error = new Error('network unavailable');

    expect(mapUnknownMcpToolError(error)).toBe(error);
  });

  test('fails closed on stale non-stdio MCP surfaces while allowing get_health to report drift', async () => {
    const staleEngine = {
      getConfig: async () => String(LATEST_VERSION - 1),
    } as unknown as BrainEngine;

    await expect(assertMcpSurfaceSchemaReady(staleEngine, 'http_remote', 'retrieve_context'))
      .rejects.toThrow(OperationError);
    await expect(assertMcpSurfaceSchemaReady(staleEngine, 'http_remote', 'get_health'))
      .resolves.toBeUndefined();
    await expect(assertMcpSurfaceSchemaReady(staleEngine, 'stdio', 'retrieve_context'))
      .resolves.toBeUndefined();
  });
});
