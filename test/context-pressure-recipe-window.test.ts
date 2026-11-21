import { describe, expect, test } from 'bun:test';
import { resolveContextWindow } from '../src/core/context/pressure.ts';

describe('resolveContextWindow with recipe-declared windows', () => {
  test('a bare 1M Claude model id resolves to 1M without a [1m] marker', () => {
    expect(resolveContextWindow({ configured: null, model: 'claude-opus-5-5', maxSeen: 190_000 })).toBe(1_000_000);
  });
  test('an unknown model still defaults to 200k', () => {
    expect(resolveContextWindow({ configured: null, model: 'claude-haiku-4-5', maxSeen: 190_000 })).toBe(200_000);
  });
});
