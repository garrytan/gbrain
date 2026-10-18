import { describe, expect, test } from 'bun:test';
import { interleaveFusion } from '../../src/core/search/fusion-lists.ts';

const id = (x: { id: number }) => x.id;
const rows = (...ids: number[]) => ids.map(n => ({ id: n }));

describe('interleaveFusion', () => {
  test('takes each arm\'s #1, then each arm\'s #2, in arm order', () => {
    expect(interleaveFusion([rows(1, 2, 3), rows(10, 20, 30)], id).map(id)).toEqual([1, 10, 2, 20, 3, 30]);
  });

  test('de-duplicates by key, keeping the first occurrence', () => {
    const cos = [{ id: 1, arm: 'cos' }, { id: 2, arm: 'cos' }];
    const kw = [{ id: 2, arm: 'kw' }, { id: 1, arm: 'kw' }, { id: 3, arm: 'kw' }];
    expect(interleaveFusion([cos, kw], id)).toEqual([{ id: 1, arm: 'cos' }, { id: 2, arm: 'kw' }, { id: 3, arm: 'kw' }]);
  });

  test('empty arms cast no vote; no arms yields nothing', () => {
    expect(interleaveFusion([[], rows(4, 5)], id).map(id)).toEqual([4, 5]);
    expect(interleaveFusion([rows(4, 5), []], id).map(id)).toEqual([4, 5]);
    expect(interleaveFusion<{ id: number }>([], id)).toEqual([]);
    expect(interleaveFusion([[], []], id)).toEqual([]);
  });

  test('unequal lengths continue with the longer arm', () => {
    expect(interleaveFusion([rows(1), rows(10, 20, 30)], id).map(id)).toEqual([1, 10, 20, 30]);
  });

  test('limit truncates the fused order (k-bounded candidate set)', () => {
    expect(interleaveFusion([rows(1, 2, 3, 4, 5), rows(10, 20, 30, 40, 50)], id, 5).map(id)).toEqual([1, 10, 2, 20, 3]);
    expect(interleaveFusion([rows(1, 2), rows(1, 2)], id, 5).map(id)).toEqual([1, 2]);
    expect(interleaveFusion([rows(1, 2)], id, 0)).toEqual([]);
  });

  test('is deterministic and does not mutate its inputs', () => {
    const a = rows(3, 1, 2);
    const b = rows(2, 9);
    const first = interleaveFusion([a, b], id);
    expect(interleaveFusion([a, b], id)).toEqual(first);
    expect(a.map(id)).toEqual([3, 1, 2]);
    expect(b.map(id)).toEqual([2, 9]);
  });

  test('three arms rotate in arm order', () => {
    expect(interleaveFusion([rows(1, 2), rows(10), rows(100, 200)], id).map(id)).toEqual([1, 10, 100, 2, 200]);
  });
});
