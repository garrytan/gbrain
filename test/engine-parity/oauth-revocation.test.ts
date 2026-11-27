/**
 * BrainEngine parity: the revoke writes of `OAuthGrants.revokeToken` and `revokeClient` (engine-sql/oauth-revocation.ts):
 * `deleteOauthTokenByHash`, `softDeleteOauthClient`, `deleteOauthClientTokens`, `deleteOauthClientCodes`.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the same calls leave the same credential tables on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts). `revokeToken` deletes the one token of the named
 *    client, and nothing for another client's hash, an unknown hash, a client that is gone or revoked (refused as an
 *    invalid client), or a client secret that changed. `revokeClient` stamps the client `deleted_at` (the row stays,
 *    no longer live), deletes its tokens and no other client's, and is silent for a client that does not exist. Both run
 *    on the grant transaction's engine handle (`transaction(fn)` passes it as `tx`), and a transaction that fails after
 *    the soft delete leaves the client live.
 *  - Regression: a revoke that deletes a hash of another client (a revoked token that was never the caller's), leaves a
 *    refresh token or a code usable after its client was revoked, or is refused on one engine, differently per arm.
 *  - Why existing coverage misses it: test/oauth.test.ts and test/oauth-consent-security.test.ts run the grants on PGLite
 *    with raw SQL and read the tables back with raw SQL.
 *    `revokeClient` also deletes the client's authorization codes and no other client's, and first consent's
 *    `oauthClientHoldsAuthorization` sees a token or a code (expired ones count) and nothing after the revoke.
 *  - Seam: none. Real engines and the real `OAuthGrants`; the tables are read through typed members only.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { OAuthGrants } from '../../src/core/oauth-grants.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { hashToken } from '../../src/core/utils.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** The grants as the server builds them: the lock and the writes run on the transaction's engine handle. */
function grants(engine: BrainEngine): OAuthGrants {
  return new OAuthGrants({
    sql: sqlQueryForEngine(engine),
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx), tx)),
    tokenTtl: 60,
    refreshTtl: 300,
  });
}

/** What a caller sees of a refused call: the error class and its message; `null` when it was accepted. */
async function refusal(run: () => Promise<unknown>): Promise<{ name: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as { name?: string; message?: string; code?: unknown };
    if (e.code === 'engine_capability_missing') throw error;
    return { name: String(e.name), message: String(e.message) };
  }
}

async function client(engine: BrainEngine, id: string, secret?: string): Promise<void> {
  await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read', ...(secret ? { client_secret_hash: hashToken(secret) } : {}) });
}

async function token(engine: BrainEngine, raw: string, clientId: string, type: 'access' | 'refresh' = 'access'): Promise<void> {
  await engine.insertOauthToken({ token_hash: hashToken(raw), token_type: type, client_id: clientId, scopes: ['read'], expires_at: 4_000_000_000, resource: null, created_at: 1_800_000_000 });
}

/** Which of these tokens are still stored: a second insert of the same hash is 23505 only for a token that is there. */
async function stored(engine: BrainEngine, owner: string, raws: string[]): Promise<Record<string, boolean>> {
  const out: Record<string, boolean> = {};
  for (const raw of raws) {
    try {
      await token(engine, raw, owner);
      out[raw] = false;
    } catch (error) {
      if ((error as { code?: unknown }).code !== '23505') throw error;
      out[raw] = true;
    }
  }
  return out;
}

describe('engine parity: OAuth revoke writes', () => {
  parityTest('revokeToken deletes the named client\'s token and nothing else, and refuses a client that is gone or whose secret changed',
    { methods: ['insertOauthClient', 'insertOauthToken', 'readOauthClientForUpdate', 'deleteOauthTokenByHash', 'softDeleteOauthClient'] }, async engine => {
      await client(engine, 'c1', 'secret-1');
      await client(engine, 'c2');
      await token(engine, 'a1', 'c1');
      await token(engine, 'r1', 'c1', 'refresh');
      await token(engine, 'a2', 'c2');
      const secret = hashToken('secret-1');
      const g = grants(engine);
      const other = await refusal(() => g.revokeToken('c2', 'a1'));
      const afterOther = await stored(engine, 'c1', ['a1']);
      const unknown = await refusal(() => g.revokeToken('c1', 'never-issued', secret));
      const staleSecret = await refusal(() => g.revokeToken('c1', 'a1', hashToken('rotated')));
      const none = await refusal(() => g.revokeToken('nobody', 'a1'));
      const own = await refusal(() => g.revokeToken('c1', 'a1', secret));
      const afterOwn = { c1: await stored(engine, 'c1', ['a1', 'r1']), c2: await stored(engine, 'c2', ['a2']) };
      await engine.softDeleteOauthClient('c2');
      const revoked = await refusal(() => g.revokeToken('c2', 'a2'));
      return { other, afterOther, unknown, staleSecret, none, own, afterOwn, revoked };
    });

  parityTest('revokeClient soft-deletes the client, deletes its tokens and no other client\'s, and is silent for an unknown client',
    { methods: ['insertOauthClient', 'insertOauthToken', 'readOauthClient', 'oauthClientLive', 'readOauthClientForUpdate', 'softDeleteOauthClient', 'deleteOauthClientCodes', 'deleteOauthClientTokens'] }, async engine => {
      await client(engine, 'c1');
      await client(engine, 'c2');
      await token(engine, 'a1', 'c1');
      await token(engine, 'r1', 'c1', 'refresh');
      await token(engine, 'a2', 'c2');
      const g = grants(engine);
      const unknown = await refusal(() => g.revokeClient('nobody'));
      const first = await refusal(() => g.revokeClient('c1'));
      const row = await engine.readOauthClient('c1');
      const live = { c1: await engine.oauthClientLive('c1'), c2: await engine.oauthClientLive('c2') };
      const tokens = { c1: await stored(engine, 'c1', ['a1', 'r1']), c2: await stored(engine, 'c2', ['a2']) };
      const again = await refusal(() => g.revokeClient('c1'));
      const afterRevoke = await refusal(() => g.revokeToken('c1', 'a1'));
      return { unknown, first, kept: row?.client_id, stamped: row?.deleted_at instanceof Date, live, tokens, again, afterRevoke };
    });

  parityTest('revokeClient deletes the client\'s authorization codes and no other client\'s, and the client then holds no authorization',
    { methods: ['insertOauthClient', 'insertOauthToken', 'insertOauthCode', 'readOauthCodeForUpdate', 'oauthClientHoldsAuthorization', 'readOauthClientForUpdate', 'softDeleteOauthClient', 'deleteOauthClientCodes', 'deleteOauthClientTokens'] }, async engine => {
      await client(engine, 'c1');
      await client(engine, 'c2');
      await client(engine, 'c3');
      await client(engine, 'c4');
      const code = (name: string, clientId: string, expires: number) => engine.insertOauthCode({ code_hash: hashToken(name), client_id: clientId,
        scopes: ['read'], code_challenge: 'challenge', code_challenge_method: 'S256', redirect_uri: 'https://app.example/cb', state: null, resource: null, expires_at: expires });
      await code('k1', 'c1', 4_000_000_000);
      await code('k1-old', 'c1', 1_000);
      await code('k2', 'c2', 4_000_000_000);
      await token(engine, 'a3', 'c3');
      const holds = async () => ({ c1: await engine.oauthClientHoldsAuthorization('c1'), c2: await engine.oauthClientHoldsAuthorization('c2'),
        c3: await engine.oauthClientHoldsAuthorization('c3'), c4: await engine.oauthClientHoldsAuthorization('c4') });
      const before = await holds();
      const revoked = await refusal(() => grants(engine).revokeClient('c1'));
      const codes = {
        k1: (await engine.readOauthCodeForUpdate(hashToken('k1'), 'c1')) !== null,
        k1Old: (await engine.readOauthCodeForUpdate(hashToken('k1-old'), 'c1')) !== null,
        k2: (await engine.readOauthCodeForUpdate(hashToken('k2'), 'c2')) !== null,
      };
      const after = await holds();
      return { before, revoked, codes, after };
    });

  parityTest('the revoke members run in the caller\'s transaction: a failure after the soft delete leaves the client live and its tokens kept',
    { methods: ['insertOauthClient', 'insertOauthToken', 'oauthClientLive', 'softDeleteOauthClient', 'deleteOauthClientCodes', 'deleteOauthClientTokens', 'deleteOauthTokenByHash'] }, async engine => {
      await client(engine, 'c1');
      await token(engine, 'a1', 'c1');
      await token(engine, 'a2', 'c1');
      const failure = await refusal(() => engine.transaction(async tx => {
        await tx.softDeleteOauthClient('c1');
        await tx.deleteOauthClientCodes('c1');
        await tx.deleteOauthClientTokens('c1');
        throw new Error('stop');
      }));
      const afterFailure = { live: await engine.oauthClientLive('c1'), tokens: await stored(engine, 'c1', ['a1', 'a2']) };
      await engine.transaction(async tx => {
        await tx.deleteOauthTokenByHash(hashToken('a1'), 'c1');
      });
      const afterCommit = await stored(engine, 'c1', ['a1', 'a2']);
      return { failure, afterFailure, afterCommit };
    });
});
