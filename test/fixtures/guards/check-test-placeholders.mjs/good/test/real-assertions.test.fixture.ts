import { describe, expect, test } from 'bun:test';

const SCRIPT = `
  test('inside a template literal', () => {
    expect(true).toBe(true);
    expect(1).toBe(1);
  });
`;

describe('not placeholders', () => {
  test('fail sentinel is allowed', () => {
    try {
      JSON.parse('{');
      expect(true).toBe(false);
    } catch (e) {
      expect(e).toBeInstanceOf(SyntaxError);
    }
  });

  test('strings and comments are ignored', () => {
    // expect(true).toBe(true)
    const text = "expect(true).toBeTruthy()";
    expect(text.length).toBeGreaterThan(0);
    expect(SCRIPT).toContain('expect(1).toBe(1)');
  });

  test('real values are not placeholders', () => {
    const ok = [1, 2].includes(1);
    expect(ok).toBe(true);
    expect(2 - 1).toBe(1);
  });
});
