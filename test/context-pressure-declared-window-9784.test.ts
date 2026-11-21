import { describe, expect, test } from 'bun:test';
import { resolveContextWindow } from '../src/core/context/pressure.ts';

describe('context window for a bare Claude model id (#9784)', () => {
  test('a model the Anthropic recipe declares at 1M resolves to 1M before the fill passes 200k', () => {
    expect(resolveContextWindow({ configured: null, model: 'claude-opus-5-5', maxSeen: 190_000 })).toBe(1_000_000);
    expect(resolveContextWindow({ configured: null, model: null, configuredModel: 'claude-sonnet-5-5', maxSeen: 0 })).toBe(1_000_000);
  });

  test('a model with no declared window keeps the 200k default', () => {
    expect(resolveContextWindow({ configured: null, model: 'claude-haiku-4-5', maxSeen: 190_000 })).toBe(200_000);
    expect(resolveContextWindow({ configured: null, model: 'some-other-model', maxSeen: 0 })).toBe(200_000);
  });

  test('a 4.x model the recipe lists at 1M keeps the 200k default until the fill passes it', () => {
    expect(resolveContextWindow({ configured: null, model: 'claude-opus-4-6', maxSeen: 150_000 })).toBe(200_000);
    expect(resolveContextWindow({ configured: null, model: 'anthropic:claude-opus-4-8', maxSeen: 0 })).toBe(200_000);
    expect(resolveContextWindow({ configured: null, model: 'claude-opus-4-6', maxSeen: 250_000 })).toBe(1_000_000);
  });

  test('the session model decides; a configured default is read only when the transcript names none', () => {
    expect(resolveContextWindow({ configured: null, model: 'claude-opus-4-6', configuredModel: 'claude-opus-5-5', maxSeen: 190_000 })).toBe(200_000);
    expect(resolveContextWindow({ configured: null, model: 'claude-haiku-4-5', configuredModel: 'claude-opus-5-5', maxSeen: 0 })).toBe(200_000);
  });

  test('explicit config still wins over the declared window', () => {
    expect(resolveContextWindow({ configured: 150_000, model: 'claude-opus-5-5', maxSeen: 0 })).toBe(150_000);
  });
});
