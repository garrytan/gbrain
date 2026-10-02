import { describe, expect, test } from 'bun:test';
import { canMarkRollingCacheBlock } from '../src/core/minions/handlers/subagent.ts';

describe('rolling cache block eligibility (#5326)', () => {
  test('rejects thinking and redacted_thinking blocks', () => {
    expect(canMarkRollingCacheBlock({ type: 'thinking', thinking: 'private' })).toBe(false);
    expect(canMarkRollingCacheBlock({ type: 'redacted_thinking', data: 'opaque' })).toBe(false);
  });

  test('allows ordinary content blocks only', () => {
    expect(canMarkRollingCacheBlock({ type: 'text', text: 'visible' })).toBe(true);
    expect(canMarkRollingCacheBlock({ type: 'tool_result', content: 'ok' })).toBe(true);
    expect(canMarkRollingCacheBlock(null)).toBe(false);
    expect(canMarkRollingCacheBlock('text')).toBe(false);
  });
});
