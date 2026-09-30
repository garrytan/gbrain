import { describe, expect, test } from 'bun:test';

describe('placeholder forms', () => {
  test('bare expect(true) with no matcher', () => {
    expect(true);
  });

  test('expect(true).toBe(true)', () => {
    expect(true).toBe(true);
  });

  test('expect(true).toBeTruthy()', () => {
    expect(true).toBeTruthy();
  });

  test('expect(1).toBe(1)', () => {
    expect(1).toBe(1);
  });
});
