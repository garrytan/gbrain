import { describe, expect, test } from 'bun:test';

describe('revert drill canary', () => {
  test('passes, so the drill times only the revert', () => {
    expect(['land', 'revert'].join(' then ')).toBe('land then revert');
  });
});
