import { expect, test } from 'bun:test';
import { capExtractFactsConcurrency, resolveExtractFactsConcurrency, runBoundedPool } from '../src/core/cycle/extract-facts-concurrency.ts';

for (const [value, expected] of [
  [undefined, 1], ['', 1], ['0', 1], ['1', 1], ['abc', 1], ['3', 3], ['99', 99], ['9007199254740992', 1],
  ['-2', 1], ['1.5', 1], ['3abc', 1], ['Infinity', 1], [' 6 ', 6],
] as const) {
  test(`concurrency ${JSON.stringify(value)} resolves to ${expected}`, () => {
    expect(resolveExtractFactsConcurrency({ GBRAIN_EXTRACT_FACTS_CONCURRENCY: value })).toBe(expected);
  });
}

test('caps only at the configured Postgres pool max, leaves unknown capacity and PGLite alone', () => {
  expect(capExtractFactsConcurrency(16, { kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 4 }) })).toBe(4);
  expect(capExtractFactsConcurrency(6, { kind: 'postgres', getPoolDiagnostics: () => ({ poolMax: 1 }) })).toBe(1);
  expect(capExtractFactsConcurrency(16, { kind: 'postgres', getPoolDiagnostics: () => null })).toBe(16);
  expect(capExtractFactsConcurrency(16, { kind: 'postgres', getPoolDiagnostics: () => { throw Error('unavailable'); } })).toBe(16);
  expect(capExtractFactsConcurrency(16, { kind: 'postgres' })).toBe(16);
  expect(capExtractFactsConcurrency(16, { kind: 'pglite' })).toBe(16);
});

const latch = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};
const defaults = {
  onError: () => 'deferred', stopOn: (o: string) => o === 'stop', finished: (o: string) => o !== 'stop' && o !== 'cancelled',
};

test('pool runs at most N tasks, returns ordered outcomes and isolates a throwing task', async () => {
  let active = 0;
  let peak = 0;
  const errors: number[] = [];
  const pool = await runBoundedPool({
    ...defaults, items: Array.from({ length: 12 }, (_, i) => i), concurrency: 3, shouldStart: () => true,
    task: async i => {
      peak = Math.max(peak, ++active);
      try {
        await new Promise(resolve => setTimeout(resolve, 2));
        if (i === 4) throw Error('page rejected');
        return 'complete';
      } finally { active--; }
    },
    onError: (_error, i) => { errors.push(i); return 'deferred'; },
  });
  expect(peak).toBe(3);
  expect(active).toBe(0);
  expect(errors).toEqual([4]);
  expect(pool.outcomes).toEqual(Array.from({ length: 12 }, (_, i) => i === 4 ? 'deferred' : 'complete'));
  expect(pool.visited).toBe(12);
});

test('stop predicate admits nothing further and the pool awaits every in-flight task', async () => {
  const gates = [latch(), latch(), latch()];
  const started: number[] = [];
  let allow = true;
  let ended = false;
  const running = runBoundedPool({
    ...defaults, items: [0, 1, 2, 3, 4], concurrency: 3, shouldStart: () => allow,
    task: async i => { started.push(i); await gates[i].promise; return 'complete'; },
  }).then(pool => { ended = true; return pool; });
  expect(started).toEqual([0, 1, 2]);
  allow = false;
  gates[1].release();
  await Promise.resolve();
  await Promise.resolve();
  expect(ended).toBe(false);
  gates[0].release();
  gates[2].release();
  const pool = await running;
  expect(started).toEqual([0, 1, 2]);
  expect(pool.outcomes.slice(0, 3)).toEqual(['complete', 'complete', 'complete']);
  expect(pool.outcomes[3]).toBeUndefined();
  expect(pool.visited).toBe(3);
});

test('a stop outcome stops admission, awaits in-flight pages and keeps its cursor before the stopped page', async () => {
  const gate = latch();
  const started: number[] = [];
  const running = runBoundedPool({
    ...defaults, items: [0, 1, 2, 3, 4], concurrency: 3, shouldStart: () => true,
    task: async i => { started.push(i); if (i === 0) return 'stop'; await gate.promise; return 'complete'; },
  });
  await Promise.resolve();
  expect(started).toEqual([0, 1, 2]);
  gate.release();
  const pool = await running;
  expect(started).toEqual([0, 1, 2]);
  expect(pool.outcomes.slice(0, 3)).toEqual(['stop', 'complete', 'complete']);
  expect(pool.visited).toBe(0);
});

test('an initially stopped or empty pool starts nothing', async () => {
  const task = async () => { throw Error('must not start'); };
  const stopped = await runBoundedPool({ ...defaults, items: [1, 2], concurrency: 6, shouldStart: () => false, task });
  expect(stopped.visited).toBe(0);
  expect(stopped.outcomes.filter(o => o !== undefined)).toEqual([]);
  expect(await runBoundedPool({ ...defaults, items: [], concurrency: 6, shouldStart: () => true, task }))
    .toEqual({ outcomes: [], visited: 0 });
});
