import { describe, test, expect } from 'bun:test';
import { addCodeEdges } from '../src/core/engine-sql/code-edges.ts';
import type { SqlExecutor } from '../src/core/engine-sql/executor.ts';

describe('addCodeEdges bind ceiling', () => {
  test('a Postgres executor with unlimited capability never gets a statement past 65,534 binds', async () => {
    const counts: number[] = [];
    const exec = {
      dialect: 'postgres',
      capabilities: { maxBindParamsPerStatement: Number.POSITIVE_INFINITY, transactionAdvisoryLocks: true, probesEmbeddingCast: true },
      unsafe: async (_text: string, params: readonly unknown[]) => { counts.push(params.length); return { rows: [], affectedRows: 0 }; },
    } as unknown as SqlExecutor;
    const edges = Array.from({ length: 20_000 }, (_, i) => ({
      from_chunk_id: 1, to_chunk_id: i % 2 === 0 ? i + 2 : null, from_symbol_qualified: 'a', to_symbol_qualified: `b${i}`,
      edge_type: 'calls', edge_metadata: {}, source_id: 'default',
    })) as never;
    await addCodeEdges(exec, edges);
    expect(counts.length).toBeGreaterThan(2);
    expect(Math.max(...counts)).toBeLessThanOrEqual(65_534);
  });
});
