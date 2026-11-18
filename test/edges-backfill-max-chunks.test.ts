import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { runEdgesBackfill } from '../src/commands/edges-backfill.ts';

function emptyEngine() {
  let dbCalls = 0;
  const engine = {
    kind: 'pglite',
    executeRaw: async () => { dbCalls++; return []; },
    hasCodeEdgesSymbol: async () => { dbCalls++; return true; },
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      dbCalls++;
      return work({ executeRaw: async () => { dbCalls++; return []; } });
    },
  } as unknown as BrainEngine;
  return { engine, dbCalls: () => dbCalls };
}

for (const raw of ['abc', '12abc', '0', '-1', undefined]) {
  test(`edges-backfill rejects invalid --max-chunks ${raw ?? '(missing)'} before DB work`, async () => {
    const { engine, dbCalls } = emptyEngine();
    const args = ['--source', 'default', '--json', '--max-chunks', ...(raw === undefined ? [] : [raw])];
    await expect(runEdgesBackfill(engine, args)).rejects.toThrow('--max-chunks');
    expect(dbCalls()).toBe(0);
  });
}

test('edges-backfill accepts --max-chunks 5 and runs the resolver', async () => {
  const { engine, dbCalls } = emptyEngine();
  await runEdgesBackfill(engine, ['--source', 'default', '--max-chunks', '5']);
  expect(dbCalls()).toBeGreaterThan(0);
});

test('edges-backfill accepts a leading-zero --max-chunks 05 as 5', async () => {
  const { engine, dbCalls } = emptyEngine();
  await runEdgesBackfill(engine, ['--source', 'default', '--max-chunks', '05']);
  expect(dbCalls()).toBeGreaterThan(0);
});
