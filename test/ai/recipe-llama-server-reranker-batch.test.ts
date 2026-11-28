import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('llama-server-reranker setup hint batch sizes', () => {
  test('launch hint sets explicit logical and physical batch sizes', () => {
    const hint = getRecipe('llama-server-reranker')!.setup_hint ?? '';
    expect(hint).toMatch(/-b 2048/);
    expect(hint).toMatch(/-ub 2048/);
  });
});
