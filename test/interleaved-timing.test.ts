import { describe, expect, test } from 'bun:test';
import { interleavedMedians } from './helpers/interleaved-timing.ts';

// A synthetic clock: the slow shape costs 20ms and the fast one 1ms (the
// entity-resolve-perf fixture's usual medians), and every call that starts
// inside one stall window runs 5x slower. Master CI saw exactly this once:
// old_median=24.60ms new_median=5.34ms speedup=4.61x against a usual ~1ms.
function stalledClock(stallStart: number, stallLength: number) {
  let now = 0;
  const call = (cost: number) => async () => {
    const stalled = now >= stallStart && now < stallStart + stallLength;
    const elapsed = stalled ? cost * 5 : cost;
    now += elapsed;
    return elapsed;
  };
  return { slow: call(20), fast: call(1) };
}

describe('interleavedMedians', () => {
  test('a stall long enough to cover every fast sample timed as a block cannot move the ratio, wherever it lands', async () => {
    const runs = 5;
    const window = runs * 1 * 5;
    for (let stallStart = 0; stallStart <= runs * 21 * 5; stallStart += 0.5) {
      const clock = stalledClock(stallStart, window);
      const { first, second } = await interleavedMedians(runs, clock.slow, clock.fast);
      expect(first / second).toBeGreaterThanOrEqual(15);
    }
  });

  test('medians of an unstalled run are the per-call costs', async () => {
    const clock = stalledClock(Number.POSITIVE_INFINITY, 0);
    expect(await interleavedMedians(5, clock.slow, clock.fast)).toEqual({ first: 20, second: 1 });
  });
});
