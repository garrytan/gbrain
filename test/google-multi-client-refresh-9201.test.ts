import { describe, it, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileVaultBackend, type CredentialEntry } from '../src/core/creds/vault.ts';
import { GoogleTokenProvider } from '../src/core/creds/providers/google.ts';
import { withEnv } from './helpers/with-env.ts';

function entry(account: string, clientId: string): CredentialEntry {
  return {
    id: `google:${account}`,
    provider: 'google',
    kind: 'oauth2',
    client_ref: 'byo',
    secret: { access_token: 'old', refresh_token: `rt-${clientId}`, expiry: '2020-01-01T00:00:00.000Z' },
    meta: { account, client_id: clientId, connected_at: '2026-01-01T00:00:00.000Z' },
  };
}

describe('refresh uses the client that minted each account token (#9201)', () => {
  it('keeps the earlier account refreshing after a different client is stored', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-9201-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const vault = new FileVaultBackend();
        const at = '2026-01-01T00:00:00.000Z';
        await vault.putClient({ provider: 'google', client_id: 'client-a', client_secret: 'sa', created_at: at });
        await vault.put(entry('a@example.com', 'client-a'));
        await vault.putClient({ provider: 'google', client_id: 'client-b', client_secret: 'sb', created_at: at });
        await vault.put(entry('b@example.org', 'client-b'));

        const seen: string[] = [];
        const fakeFetch = (async (_u: unknown, init: { body: unknown }) => {
          const p = new URLSearchParams(String(init.body));
          seen.push(p.get('client_id') ?? '');
          const ok = p.get('refresh_token') === `rt-${p.get('client_id')}`;
          return new Response(
            JSON.stringify(ok ? { access_token: 'new', expires_in: 3600 } : { error: 'unauthorized_client' }),
            { status: ok ? 200 : 401 },
          );
        }) as unknown as typeof fetch;

        const outcome = async (id: string) => {
          try {
            return await new GoogleTokenProvider(vault, id, fakeFetch).forceRefresh();
          } catch (e) {
            return `error:${String(e)}`;
          }
        };
        expect(await outcome('google:a@example.com')).toBe('new');
        expect(await outcome('google:b@example.org')).toBe('new');
        expect(seen).toEqual(['client-a', 'client-b']);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
