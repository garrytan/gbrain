import { describe, expect, test } from 'bun:test';
import { applyResolveAuth } from '../../src/core/ai/gateway.ts';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';

describe('Ollama OpenCode Go session routing', () => {
  test('includes a stable session header in resolved request auth', () => {
    const recipe = getRecipe('ollama')!;
    const auth = applyResolveAuth(recipe, { env: {} } as any, 'chat');

    expect(auth.headers).toMatchObject({ 'x-opencode-session': 'gbrain' });
  });
});
