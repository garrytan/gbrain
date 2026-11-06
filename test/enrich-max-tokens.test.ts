import { describe, test, expect } from 'bun:test';
import * as enrich from '../src/commands/enrich.ts';

// Namespace import so an unfixed module fails via expect(), not an import error.
const maxTokens = (model: string): number | undefined =>
  (enrich as unknown as { enrichMaxTokens?: (m: string) => number }).enrichMaxTokens?.(model);

describe('enrichMaxTokens', () => {
  test('reasoning claude-cli model gets thinking headroom, not 2048', () => {
    const n = maxTokens('claude-cli:claude-haiku-5-5');
    expect(typeof n).toBe('number');
    expect(n as number).toBeGreaterThan(2048);
  });
  test('non-reasoning model keeps 2048', () => {
    expect(maxTokens('openai:gpt-4o')).toBe(2048);
  });
});
