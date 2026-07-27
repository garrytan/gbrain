/**
 * Tests for the `advisor` MCP op gate (T7 / C3): remote callers need
 * mcp.publish_advisor; local callers bypass; the op is read-only (drops
 * workspace-dependent findings over MCP via runAdvisor's remote filter).
 */
import { describe, test, expect } from 'bun:test';
import { operationsByName, OperationError, type OperationContext } from '../src/core/operations.ts';

const advisor = operationsByName['advisor']!;

function ctx(over: Partial<OperationContext>, cfg: Record<string, string | null> = {}): OperationContext {
  return {
    engine: {
      getConfig: async (k: string) => cfg[k] ?? null,
      getStats: async () => { throw new Error('no'); },
      getHealth: async () => { throw new Error('no'); },
      executeRaw: async () => { throw new Error('no'); },
    } as unknown as OperationContext['engine'],
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as OperationContext['logger'],
    dryRun: false,
    remote: true,
    ...over,
  } as OperationContext;
}

describe('advisor op gate', () => {
  test('op exists, is read-scoped and not localOnly (exposed over MCP)', () => {
    expect(advisor).toBeDefined();
    expect(advisor.scope).toBe('read');
    expect(advisor.localOnly).not.toBe(true);
  });

  test('remote without mcp.publish_advisor → permission_denied', async () => {
    await expect(advisor.handler(ctx({ remote: true }), {})).rejects.toBeInstanceOf(OperationError);
  });

  test('remote WITH mcp.publish_advisor → returns a report', async () => {
    const report = (await advisor.handler(ctx({ remote: true }, { 'mcp.publish_advisor': 'true' }), {})) as {
      findings: unknown[];
    };
    expect(Array.isArray(report.findings)).toBe(true);
  });

  test('local caller bypasses the gate', async () => {
    const report = (await advisor.handler(ctx({ remote: false }), {})) as { findings: unknown[] };
    expect(Array.isArray(report.findings)).toBe(true);
  });
});
