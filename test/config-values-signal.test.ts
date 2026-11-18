/**
 * A keyed config read stops waiting when its abort signal fires (#6278). The typed read takes no signal, so before
 * this a config read that never came back held its caller past the caller's deadline.
 */
import { expect, test } from 'bun:test';
import { readConfigMap, readConfigRows } from '../src/core/config-values.ts';

const stalled = { getConfigValues: () => new Promise<Array<{ key: string; value: string }>>(() => {}) };

test('a stalled typed config read rejects with the signal reason when the signal fires', async () => {
  const abort = new AbortController();
  const reason = new Error('phase deadline');
  setTimeout(() => abort.abort(reason), 20);
  const outcome = await Promise.race([
    readConfigMap(stalled, ['a.key'], { signal: abort.signal }).then(() => 'resolved', (error: unknown) => error),
    new Promise(resolve => setTimeout(() => resolve('still waiting'), 1000)),
  ]);
  expect(outcome).toBe(reason);
});

test('a read whose signal already fired is not started', async () => {
  let calls = 0;
  const engine = { getConfigValues: async () => { calls += 1; return []; } };
  const abort = new AbortController();
  abort.abort(new Error('stopped'));
  await expect(readConfigRows(engine, ['a.key'], { signal: abort.signal })).rejects.toThrow('stopped');
  expect(calls).toBe(0);
});

test('a read that finishes before the signal fires returns its rows', async () => {
  const engine = { getConfigValues: async () => [{ key: 'a.key', value: '1' }] };
  const abort = new AbortController();
  expect(await readConfigMap(engine, ['a.key'], { signal: abort.signal })).toEqual(new Map([['a.key', '1']]));
  abort.abort();
});
