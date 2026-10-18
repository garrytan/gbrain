import { describe, expect, test } from 'bun:test';
import { measureWithoutSteal, stealTicks } from './helpers/hypervisor-steal.ts';

const stat = (steal: number) => `cpu  4705 356 584 3699 23 23 0 ${steal} 0 0\ncpu0 1393 70 152 913 5 6 0 0 0 0\n`;

/** A steal counter that returns the given readings in order. */
const counter = (...readings: Array<number | null>) => () => readings.shift() ?? null;

describe('stealTicks', () => {
  test('reads field 8 of the aggregate cpu line', () => {
    expect(stealTicks(() => stat(17))).toBe(17);
  });

  test('is null without /proc/stat or with a line it does not know', () => {
    expect(stealTicks(() => { throw new Error('ENOENT'); })).toBeNull();
    expect(stealTicks(() => 'cpu  1 2 3\n')).toBeNull();
    expect(stealTicks(() => 'intr 1 2 3 4 5 6 7 8 9\n')).toBeNull();
  });
});

describe('measureWithoutSteal', () => {
  test('keeps the first reading when steal did not move', async () => {
    let calls = 0;
    const r = await measureWithoutSteal(async () => ++calls * 10, 5, counter(3, 3));
    expect(r).toEqual({ value: 10, steal: [0] });
  });

  test('measures again after a window steal crossed and keeps the clean one', async () => {
    let calls = 0;
    const r = await measureWithoutSteal(async () => (++calls === 1 ? 116 : 24), 5, counter(3, 9, 9, 9));
    expect(r).toEqual({ value: 24, steal: [6, 0] });
  });

  test('stops at the bound and keeps the last reading when steal never stops', async () => {
    let calls = 0;
    const r = await measureWithoutSteal(async () => ++calls, 3, counter(0, 1, 1, 2, 2, 3, 3, 4));
    expect(r).toEqual({ value: 3, steal: [1, 1, 1] });
  });

  test('a slowdown with no steal is the reading kept: one attempt, never re-measured away', async () => {
    let calls = 0;
    const r = await measureWithoutSteal(async () => { calls++; return 113; }, 5, counter(5, 5));
    expect(r).toEqual({ value: 113, steal: [0] });
    expect(calls).toBe(1);
  });

  test('without /proc/stat the first reading is kept', async () => {
    let calls = 0;
    const r = await measureWithoutSteal(async () => ++calls, 5, () => null);
    expect(r).toEqual({ value: 1, steal: [null] });
  });
});
