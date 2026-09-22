import { describe, expect, test } from 'bun:test';
import { resolveSearchDateBounds } from '../src/core/search/hybrid.ts';

describe('public search date bounds preserve their comparison contract', () => {
  test('since includes the exact boundary without rounding microseconds', () => {
    expect(resolveSearchDateBounds({ since: '2030-06-15T10:00:00.123456+02:00' })).toMatchObject({
      afterDate: '2030-06-15T10:00:00.123456+02:00', afterDateInclusive: true,
    });
  });

  test('exact until includes the timestamp as written', () => {
    expect(resolveSearchDateBounds({ until: '2030-06-15T23:59:59.999999Z' })).toMatchObject({
      beforeDate: '2030-06-15T23:59:59.999999Z', beforeDateInclusive: true,
    });
  });

  test.each([
    ['2030-06-15', '2030-06-16T00:00:00.000Z'],
    ['2032-02-29', '2032-03-01T00:00:00.000Z'],
    ['2030-12-31', '2031-01-01T00:00:00.000Z'],
  ])('date-only until %s includes the entire day', (until, boundary) => {
    expect(resolveSearchDateBounds({ until })).toMatchObject({
      beforeDate: boundary, beforeDateInclusive: false,
    });
  });

  test('legacy after/before remain strict and public fields win', () => {
    const legacy = resolveSearchDateBounds({ afterDate: '2030-06-01', beforeDate: '2030-06-15' });
    expect(legacy.afterDateInclusive).not.toBe(true);
    expect(legacy.beforeDateInclusive).not.toBe(true);
    expect(legacy.beforeDate).toBe('2030-06-15T23:59:59.999Z');
    expect(resolveSearchDateBounds({ afterDate: '2030-01-01', since: '2030-06-15' })).toMatchObject({
      afterDate: '2030-06-15', afterDateInclusive: true,
    });
  });

  test('invalid calendar dates are rejected instead of shifting into the next month', () => {
    expect(() => resolveSearchDateBounds({ until: '2030-02-30' })).toThrow('Invalid until');
    expect(() => resolveSearchDateBounds({ since: '2030-02-29' })).toThrow('Invalid since');
    expect(() => resolveSearchDateBounds({ until: '0000-01-01' })).toThrow('Invalid until');
  });
});
