import { describe, expect, test } from 'bun:test';

import { resolveSingleSourceSyncStrategy } from '../src/commands/sync.ts';

describe('single-source sync strategy', () => {
  test('inherits the registered code strategy when CLI does not override it', () => {
    expect(resolveSingleSourceSyncStrategy(undefined, { strategy: 'code' })).toBe('code');
  });

  test('keeps an explicit CLI strategy authoritative', () => {
    expect(resolveSingleSourceSyncStrategy('markdown', { strategy: 'code' })).toBe('markdown');
  });

  test('ignores invalid legacy configuration values', () => {
    expect(resolveSingleSourceSyncStrategy(undefined, { strategy: 'invalid' })).toBeUndefined();
  });
});
