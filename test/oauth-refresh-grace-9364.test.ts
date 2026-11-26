/**
 * #9364: a refresh token's immediate predecessor, replayed by the same client inside a short grace window, gets
 * back the pair that already replaced it (a lost response, two tabs, parallel MCP clients). Any other replay (a
 * different client, after the window, an older ancestor) revokes the whole sign-in family.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { OAuthGrants, REFRESH_REUSE_GRACE_MS } from '../src/core/oauth-grants.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { hashToken } from '../src/core/utils.ts';
import { authorizeAsOwner, TEST_PKCE_CHALLENGE, TEST_PKCE_VERIFIER } from './helpers/oauth.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const CALLBACK = 'http://127.0.0.1:8989/oauth/callback';

for (const kind of testBackends()) {
  describe(`refresh reuse grace window (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let clock = Date.now();
    const transaction = <T>(fn: (sql: ReturnType<typeof sqlQueryForEngine>) => Promise<T>) => engine.transaction(tx => fn(sqlQueryForEngine(tx)));
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction });
    const grants = () => new OAuthGrants({ sql: sqlQueryForEngine(engine), transaction, tokenTtl: 3600, refreshTtl: 30 * 24 * 3600, now: () => clock });

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 60_000);
    afterAll(async () => { await close?.(); }, 30_000);

    async function signIn(name: string, clientId?: string) {
      const p = provider();
      const id = clientId ?? (await p.registerClientManual(name, ['authorization_code', 'refresh_token'], 'read', [CALLBACK], 'default', undefined, 'none')).clientId;
      const client = (await p.clientsStore.getClient(id))!;
      let redirect = '';
      await authorizeAsOwner(p, client, { codeChallenge: TEST_PKCE_CHALLENGE, redirectUri: CALLBACK, scopes: ['read'] }, { redirect: (u: string) => { redirect = u; } } as never);
      const tokens = await p.exchangeAuthorizationCode(client, new URL(redirect).searchParams.get('code')!, TEST_PKCE_VERIFIER, CALLBACK);
      return { clientId: id, tokens };
    }
    const live = async (token: string) => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM oauth_tokens WHERE token_hash = $1', [hashToken(token)]))[0]!.n === 1;
    const liveRefreshCount = async (clientId: string) => (await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM oauth_tokens WHERE client_id = $1 AND token_type = 'refresh'", [clientId]))[0]!.n;
    const refused = async (p: Promise<unknown>, token: string) => {
      const error = await p.then(() => null, e => e as Error);
      expect(error?.constructor.name).toBe('InvalidGrantError');
      expect(error!.message).not.toContain(token);
      return error!;
    };

    test('a lost response: the same client retrying the rotated token inside the window gets the same pair back', async () => {
      clock = Date.now();
      const { clientId, tokens } = await signIn('grace-retry');
      const first = await grants().refresh(clientId, tokens.refresh_token!);
      clock += REFRESH_REUSE_GRACE_MS - 5_000;
      const retry = await grants().refresh(clientId, tokens.refresh_token!);
      expect(retry.access_token).toBe(first.access_token);
      expect(retry.refresh_token).toBe(first.refresh_token);
      expect(retry.expires_in).toBeLessThanOrEqual(first.expires_in!);
      expect(await live(first.refresh_token!)).toBe(true);
      expect(await liveRefreshCount(clientId)).toBe(1);
      const next = await grants().refresh(clientId, first.refresh_token!);
      expect(next.refresh_token).not.toBe(first.refresh_token);
    });

    test('parallel refreshes of one token from the same client all receive the one replacement pair', async () => {
      clock = Date.now();
      const { clientId, tokens } = await signIn('grace-parallel');
      const results = await Promise.all(Array.from({ length: 6 }, () => grants().refresh(clientId, tokens.refresh_token!)));
      expect(new Set(results.map(r => r.refresh_token)).size).toBe(1);
      expect(new Set(results.map(r => r.access_token)).size).toBe(1);
      expect(await liveRefreshCount(clientId)).toBe(1);
    });

    test('a replay after the window revokes the whole family', async () => {
      clock = Date.now();
      const { clientId, tokens } = await signIn('grace-expired');
      const rotated = await grants().refresh(clientId, tokens.refresh_token!);
      clock += REFRESH_REUSE_GRACE_MS + 1_000;
      await refused(grants().refresh(clientId, tokens.refresh_token!), tokens.refresh_token!);
      expect(await live(rotated.refresh_token!)).toBe(false);
      expect(await live(rotated.access_token)).toBe(false);
      expect(await live(tokens.access_token)).toBe(false);
      await refused(grants().refresh(clientId, rotated.refresh_token!), rotated.refresh_token!);
    });

    test('a replay by a different client inside the window revokes the owner family', async () => {
      clock = Date.now();
      const owner = await signIn('grace-owner');
      const attacker = await signIn('grace-attacker');
      const rotated = await grants().refresh(owner.clientId, owner.tokens.refresh_token!);
      await refused(grants().refresh(attacker.clientId, owner.tokens.refresh_token!), owner.tokens.refresh_token!);
      expect(await live(rotated.refresh_token!)).toBe(false);
      expect(await live(rotated.access_token)).toBe(false);
      expect(await live(attacker.tokens.refresh_token!)).toBe(true);
    });

    test('a replay of an ancestor older than the immediate predecessor revokes the family, even inside the window', async () => {
      clock = Date.now();
      const { clientId, tokens } = await signIn('grace-ancestor');
      const second = await grants().refresh(clientId, tokens.refresh_token!);
      const third = await grants().refresh(clientId, second.refresh_token!);
      await refused(grants().refresh(clientId, tokens.refresh_token!), tokens.refresh_token!);
      expect(await live(third.refresh_token!)).toBe(false);
      expect(await live(third.access_token)).toBe(false);
    });

    test('revocation stays inside the family: another sign-in of the same client keeps working', async () => {
      clock = Date.now();
      const a = await signIn('grace-two-families');
      const b = await signIn('grace-two-families', a.clientId);
      await grants().refresh(a.clientId, a.tokens.refresh_token!);
      clock += REFRESH_REUSE_GRACE_MS + 1_000;
      await refused(grants().refresh(a.clientId, a.tokens.refresh_token!), a.tokens.refresh_token!);
      expect(await live(b.tokens.refresh_token!)).toBe(true);
      expect((await grants().refresh(a.clientId, b.tokens.refresh_token!)).refresh_token).toBeDefined();
    });

    test('the stored rotation never holds a usable token in clear, and is wiped after the window', async () => {
      clock = Date.now();
      const { clientId, tokens } = await signIn('grace-sealed');
      const rotated = await grants().refresh(clientId, tokens.refresh_token!);
      const [row] = await engine.executeRaw<{ sealed_pair: string | null }>('SELECT sealed_pair FROM oauth_refresh_rotations WHERE token_hash = $1', [hashToken(tokens.refresh_token!)]);
      expect(row!.sealed_pair).toBeTruthy();
      for (const secret of [rotated.refresh_token!, rotated.access_token, tokens.refresh_token!]) expect(row!.sealed_pair).not.toContain(secret);
      clock += REFRESH_REUSE_GRACE_MS + 1_000;
      const next = await grants().refresh(clientId, rotated.refresh_token!);
      const [after] = await engine.executeRaw<{ sealed_pair: string | null }>('SELECT sealed_pair FROM oauth_refresh_rotations WHERE token_hash = $1', [hashToken(tokens.refresh_token!)]);
      expect(after!.sealed_pair).toBeNull();
      expect(next.refresh_token).toBeDefined();
    });

    test('a refresh token minted before families existed starts one on its first refresh', async () => {
      clock = Date.now();
      const { clientId, tokens } = await signIn('grace-legacy');
      await engine.executeRaw('UPDATE oauth_tokens SET family_id = NULL WHERE client_id = $1', [clientId]);
      const rotated = await grants().refresh(clientId, tokens.refresh_token!);
      expect((await grants().refresh(clientId, tokens.refresh_token!)).refresh_token).toBe(rotated.refresh_token);
      clock += REFRESH_REUSE_GRACE_MS + 1_000;
      await refused(grants().refresh(clientId, tokens.refresh_token!), tokens.refresh_token!);
      expect(await live(rotated.refresh_token!)).toBe(false);
    });
  });
}
