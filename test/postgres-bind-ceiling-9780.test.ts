/**
 * #9780: Postgres carries at most 65,533 bind parameters per statement (the
 * driver refuses 65,534 with MAX_PARAMETERS_EXCEEDED). The dialect capability
 * every batched writer reads must say so, so a very large code page's edge
 * insert and a large body's segment-text staging split into statements the
 * driver accepts.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { POSTGRES_CAPABILITIES } from '../src/core/engine-sql/dialect-postgres.ts';
import { addCodeEdges } from '../src/core/engine-sql/code-edges.ts';
import { stageSegmentTexts } from '../src/core/engine-sql/page-body.ts';
import { renderFragment } from '../src/core/engine-sql/fragment.ts';
import type { SqlExecutor } from '../src/core/engine-sql/executor.ts';

const DRIVER_LIMIT = 65_534;

function countingPostgresExecutor(): { exec: SqlExecutor; binds: number[] } {
  const binds: number[] = [];
  const record = (params: readonly unknown[]) => {
    if (params.length >= DRIVER_LIMIT) throw Object.assign(new Error('Max number of parameters (65534) exceeded'), { code: 'MAX_PARAMETERS_EXCEEDED' });
    binds.push(params.length);
  };
  const exec = {
    dialect: 'postgres',
    capabilities: POSTGRES_CAPABILITIES,
    unsafe: async (_sql: string, params: readonly unknown[]) => { record(params); return { rows: [], affectedRows: 0 }; },
    run: async (fragment: Parameters<typeof renderFragment>[0]) => { record(renderFragment(fragment).params); return { rows: [], affectedRows: 0 }; },
  } as unknown as SqlExecutor;
  return { exec, binds };
}

describe('Postgres bind ceiling (#9780)', () => {
  test('the Postgres capability is a finite bound under the driver limit', () => {
    expect(POSTGRES_CAPABILITIES.maxBindParamsPerStatement).toBeLessThan(DRIVER_LIMIT);
  });

  test('code edge inserts for a very large code page split under the limit', async () => {
    const { exec, binds } = countingPostgresExecutor();
    const edges = Array.from({ length: 12_000 }, (_, i) => ({
      from_chunk_id: 1, to_chunk_id: i % 2 === 0 ? i + 2 : null, from_symbol_qualified: 'a',
      to_symbol_qualified: `b${i}`, edge_type: 'calls', source_id: 'default',
    }));
    await addCodeEdges(exec, [...edges, ...edges.map((e, i) => ({ ...e, to_symbol_qualified: `c${i}` }))]);
    expect(binds.reduce((a, b) => a + b, 0)).toBe(12_000 * 7 + 12_000 * 6);
    expect(Math.max(...binds)).toBeLessThan(DRIVER_LIMIT);
  });

  test('segment text staging splits under the limit', async () => {
    const { exec, binds } = countingPostgresExecutor();
    const texts = Array.from({ length: 14_000 }, (_, i) => {
      const body = new TextEncoder().encode(`line ${i}\n`);
      return { sha256: new Uint8Array(createHash('sha256').update(body).digest()), body, lineCount: 1 };
    });
    await stageSegmentTexts(exec, 'default', texts);
    expect(binds.reduce((a, b) => a + b, 0)).toBe(14_000 * 5);
    expect(Math.max(...binds)).toBeLessThan(DRIVER_LIMIT);
  });
});
