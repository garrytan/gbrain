/**
 * Whole-config-table reads re-send the table only when its hash moved.
 * Fails when: an unchanged hash re-sends rows or misreads them, a changed
 * hash serves cached rows, a caller's mutation leaks into the cache, engines
 * share one cache entry, or a result without the hash row is accepted.
 */
import { describe, expect, test } from 'bun:test';
import { readConfigTableCached, type ConfigTableRow } from '../src/core/config-table-cache.ts';

/** Mirrors the engine statement: the hash row always, the rows only when the caller's hash is stale. */
function fakeTable(initial: Record<string, string>) {
  let rows = { ...initial };
  let version = 0;
  const sent: number[] = [];
  return {
    sent,
    write(key: string, value: string) { rows = { ...rows, [key]: value }; version++; },
    run: async (known: string | null): Promise<ConfigTableRow[]> => {
      const hash = `h${version}`;
      const out: ConfigTableRow[] = [{ key: null, value: hash }];
      if (known !== hash) for (const [key, value] of Object.entries(rows)) out.push({ key, value });
      sent.push(out.length - 1);
      return out;
    },
  };
}

describe('readConfigTableCached', () => {
  test('an unchanged table sends no rows; a write is seen on the next read', async () => {
    const owner = {};
    const t = fakeTable({ a: '1', b: '2' });
    expect(await readConfigTableCached(owner, t.run)).toEqual({ a: '1', b: '2' });
    expect(await readConfigTableCached(owner, t.run)).toEqual({ a: '1', b: '2' });
    t.write('a', '9');
    expect(await readConfigTableCached(owner, t.run)).toEqual({ a: '9', b: '2' });
    expect(t.sent).toEqual([2, 0, 2]);
  });

  test('callers get copies, and each engine object has its own cache', async () => {
    const t = fakeTable({ a: '1' });
    const one = {}, two = {};
    const first = await readConfigTableCached(one, t.run);
    first.a = 'mutated';
    expect(await readConfigTableCached(one, t.run)).toEqual({ a: '1' });
    expect(await readConfigTableCached(two, t.run)).toEqual({ a: '1' });
    expect(t.sent).toEqual([1, 0, 1]);
  });

  test('a result without the hash row is refused, not cached as empty', async () => {
    await expect(readConfigTableCached({}, async () => [{ key: 'a', value: '1' }])).rejects.toThrow('no hash row');
  });
});
