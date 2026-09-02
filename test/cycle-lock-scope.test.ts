/**
 * Cycle lock ids per lane (eng finding E1 of the brain-plane repair plan):
 * the Modal source lane runs `autopilot-cycle --source default` and holds
 * `gbrain-cycle:default`; the global lane (`autopilot-global-maintenance`,
 * no source) holds the legacy `gbrain-cycle`. The two ids are DIFFERENT, so
 * the locks never serialize the lanes against each other: the worker's
 * `--concurrency 1` is what keeps them back to back on one tick.
 */
import { describe, test, expect } from 'bun:test';
import { cycleLockIdFor } from '../src/core/cycle.ts';

describe('cycleLockIdFor', () => {
  test('--source default → the scoped id, not the legacy one', () => {
    expect(cycleLockIdFor('default')).toBe('gbrain-cycle:default');
  });
  test('unscoped (global lane, legacy autopilot) → gbrain-cycle', () => {
    expect(cycleLockIdFor(undefined)).toBe('gbrain-cycle');
  });
  test('another source → its own id', () => {
    expect(cycleLockIdFor('wiki')).toBe('gbrain-cycle:wiki');
  });
  test('the source and global lanes hold different locks', () => {
    expect(cycleLockIdFor('default')).not.toBe(cycleLockIdFor(undefined));
  });
  test('a malformed source id throws instead of minting a lock id', () => {
    expect(() => cycleLockIdFor('not a valid id!')).toThrow();
  });
});
