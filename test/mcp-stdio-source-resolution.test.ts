import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { resolveStdioSourceId } from '../src/mcp/server.ts';

function engineForDefault(sourceId: string): BrainEngine {
  return {
    executeRaw: async (sql: string, params?: unknown[]) => {
      if (sql.includes('id, local_path')) return [];
      if (sql.includes('id !=')) return [];
      if (sql.includes('WHERE id = $1') && params?.[0] === sourceId) {
        return [{ id: sourceId }];
      }
      return [];
    },
    getConfig: async (key: string) => key === 'sources.default' ? sourceId : null,
  } as unknown as BrainEngine;
}

describe('stdio MCP source resolution', () => {
  test('uses the canonical brain default instead of pinning the empty default source', async () => {
    const sourceId = await resolveStdioSourceId(
      engineForDefault('vault-a'),
      null,
      'C:\\tmp\\outside-vault',
    );
    expect(sourceId).toBe('vault-a');
  });

  test('honors an explicit source override', async () => {
    const sourceId = await resolveStdioSourceId(
      engineForDefault('vault-b'),
      'vault-b',
      'C:\\tmp\\outside-vault',
    );
    expect(sourceId).toBe('vault-b');
  });

  test('fails closed to the explicit source or seeded default when resolution is unavailable', async () => {
    const unavailable = {
      executeRaw: async () => { throw new Error('database unavailable'); },
      getConfig: async () => { throw new Error('database unavailable'); },
    } as unknown as BrainEngine;
    expect(await resolveStdioSourceId(unavailable, 'vault-c')).toBe('vault-c');
    expect(await resolveStdioSourceId(unavailable, null)).toBe('default');
  });
});
