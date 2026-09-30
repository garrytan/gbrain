import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const home = mkdtempSync(join(tmpdir(), 'gbrain-budget-thin-'));
mkdirSync(join(home, '.gbrain'));
writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite' }));
process.env.GBRAIN_HOME = home;
delete process.env.GBRAIN_SOURCE;
const calls: Array<Record<string, unknown>> = [];
const response = { facts: [], results: [], total: 0, budget_tokens: 0, budget_used: 0, dropped_count: 0,
  budget_packing: { policy: 'query_first', applied: true, reason: 'budget_below_one' } };
const realConfig = await import('../src/core/config.ts');
mock.module('../src/core/config.ts', () => ({ ...realConfig, isThinClient: () => true }));
const realMcp = await import('../src/core/mcp-client.ts');
mock.module('../src/core/mcp-client.ts', () => ({ ...realMcp,
  callRemoteTool: async (_config: unknown, name: string, params: Record<string, unknown>) => {
    expect(name).toBe('recall');
    calls.push(params);
    return { content: [{ type: 'text', text: JSON.stringify(response) }] };
  },
}));
const { runRecall } = await import('../src/commands/recall.ts');

beforeEach(() => { calls.length = 0; });
afterAll(() => { rmSync(home, { recursive: true, force: true }); });

test('opt-in thin recall forwards fractional budgets and all fact filters without touching a local engine', async () => {
  let output = '';
  const write = process.stdout.write;
  process.stdout.write = ((chunk: string) => { output += chunk; return true; }) as typeof write;
  try {
    await runRecall({} as never, ['topics/example', '--query', 'zebra telescope', '--budget-tokens', '0.5',
      '--budget-policy', 'query_first', '--session-id', 'session-example', '--since', '2026-09-01',
      '--grep', 'needle', '--supersessions', '--include-expired', '--pending', '--source', 'example', '--json']);
  } finally { process.stdout.write = write; }
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatchObject({ entity: 'topics/example', query: 'zebra telescope', budget_tokens: 0.5,
    budget_policy: 'query_first', session_id: 'session-example', since: '2026-09-01T00:00:00.000Z', grep: 'needle',
    supersessions: true, include_expired: true, include_pending: true, source_id: 'example', limit: 50 });
  expect(JSON.parse(output)).toEqual(response);
});
