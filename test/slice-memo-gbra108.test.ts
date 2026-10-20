/**
 * GBRA-108: the legacy sweep's preparations share one reads view per slice (`sliceReads`), and the owner checks and the
 * content-sanity config lift each run once per view (src/core/persistence/slice-memo.ts).
 *
 * Protects:
 * - a slice view answers a check once for every preparation of the slice; another view (the next slice) runs it again;
 * - an engine that is not a slice view (a publication, a transaction) runs every check every time;
 * - a failed check is not shared: the next preparation of the slice runs it again.
 */
import { describe, expect, test } from 'bun:test';
import { registerSliceView, sliceMemo } from '../src/core/persistence/slice-memo.ts';

describe('GBRA-108 slice memo', () => {
  test('a slice view answers each check once; the next slice and a plain engine read again', async () => {
    let reads = 0;
    const read = async () => ++reads;
    const first = registerSliceView({}), second = registerSliceView({}), plain = {};
    expect(await Promise.all([sliceMemo(first, 'k', read), sliceMemo(first, 'k', read), sliceMemo(first, 'k', read)])).toEqual([1, 1, 1]);
    expect(await sliceMemo(first, 'other', read)).toBe(2);
    expect(await sliceMemo(second, 'k', read)).toBe(3);
    expect([await sliceMemo(plain, 'k', read), await sliceMemo(plain, 'k', read)]).toEqual([4, 5]);
  });

  test('a failed check is not shared with the next preparation of the slice', async () => {
    const view = registerSliceView({});
    let calls = 0;
    const read = async () => { calls++; if (calls === 1) throw new Error('transient'); return calls; };
    await expect(sliceMemo(view, 'k', read)).rejects.toThrow('transient');
    expect(await sliceMemo(view, 'k', read)).toBe(2);
    expect(await sliceMemo(view, 'k', read)).toBe(2);
  });
});
