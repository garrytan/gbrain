import { describe, test, expect, beforeEach } from 'bun:test';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { LastUsedAtCooldown, accessTokenLastUsedCooldown } from '../src/core/token-last-used.ts';

describe('access_tokens.last_used_at cooling', () => {
  beforeEach(() => {
    accessTokenLastUsedCooldown.clear();
  });

  test('LRU allows one write per key per minute', () => {
    const cooldown = new LastUsedAtCooldown(60_000, 10);

    expect(cooldown.shouldWrite('token-a', 1_000)).toBe(true);
    for (let i = 0; i < 10; i++) {
      expect(cooldown.shouldWrite('token-a', 1_000 + i)).toBe(false);
    }
    expect(cooldown.shouldWrite('token-a', 61_001)).toBe(true);
  });

  test('legacy token verification does not UPDATE last_used_at on every request', async () => {
    let updates = 0;
    const sql = (async (strings: TemplateStringsArray, ..._values: unknown[]) => {
      const query = strings.join('?');
      if (query.includes('FROM oauth_tokens')) return [];
      if (query.includes('FROM access_tokens') && query.includes('SELECT name')) return [{ name: 'legacy-agent', scopes: null }];
      if (query.includes('UPDATE access_tokens')) {
        updates++;
        return [];
      }
      throw new Error(`Unexpected SQL in test: ${query}`);
    }) as any;

    const provider = new GBrainOAuthProvider({ sql });
    for (let i = 0; i < 10; i++) {
      const authInfo = await provider.verifyAccessToken('legacy-token');
      expect(authInfo.clientId).toBe('legacy-agent');
    }

    expect(updates).toBe(1);
  });
});
