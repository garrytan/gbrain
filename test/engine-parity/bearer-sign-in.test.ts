/**
 * BrainEngine parity — sign-in with a legacy access token (oauth-provider.ts verifyAccessToken, the bearer check
 * `gbrain serve --http` runs): the token read by hash, the debounced last-use stamp, and the member binding a member
 * key carries (access/token-binding.ts tokenMemberBinding, members.ts verifiedMember).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a member key that `gbrain access serves several` minted signs in as its member with the same scopes and sources,
 *    its use is stamped, a revoked key and an unknown key are refused, and a key bound to a disabled member is refused
 *    with access_member_disabled.
 *  - Regression: on a Rust brain the bearer check read the token, its member and its sources with raw SQL, so every
 *    member key (and every other legacy token) was refused at sign-in (docs/designs/RUST_ENGINE.md row 32d-1).
 *  - Why existing coverage misses it: the oauth and access-binding suites run on the SQL engines only.
 *  - Seam: none. Keys come from labelSeveral with GBRAIN_HOME in a temp dir; the provider gets the engine it serves.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms, resetArm } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { LATEST_SCHEMA_VERSION } from '../../src/core/schema-migrations/latest.generated.ts';
import { labelSeveral } from '../../src/commands/access-serves.ts';
import { disableMember } from '../../src/core/access/members.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { startHttpTransport } from '../../src/mcp/http-transport.ts';
import { RateLimiter } from '../../src/mcp/rate-limit.ts';

const { parityTest, arms } = parityArms(testBackends());

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });

/** Labels alice and bob on a fresh brain and returns each member key as its file holds it. */
async function memberKeys(engine: BrainEngine): Promise<Record<string, string>> {
  await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
  const home = mkdtempSync(join(tmpdir(), 'gbrain-bearer-parity-'));
  homes.push(home);
  const receipt = await withEnv({ GBRAIN_HOME: home, GBRAIN_SETUP_ABORT_AFTER: undefined }, () =>
    labelSeveral(engine, ['alice-example', 'bob-example'], 'default', true, true));
  expect(receipt.completed).toContain('keys');
  return Object.fromEntries(receipt.keys.map(k => [k.member, readFileSync(k.path, 'utf8').trim()]));
}

/** The provider `gbrain serve --http` builds over this engine. */
const provider = (engine: BrainEngine) => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine } as never);

/** What a sign-in answers: the AuthInfo less the token and its far-future expiry, or the refusal message. */
async function signIn(engine: BrainEngine, token: string): Promise<unknown> {
  try {
    const info = await provider(engine).verifyAccessToken(token) as unknown as Record<string, unknown>;
    const { token: _t, expiresAt: _e, principal, member, createdAt: _c, ...rest } = info;
    return { ...rest, principalKind: (principal as { kind?: string } | undefined)?.kind ?? null, memberId: (member as { id?: string } | null)?.id ?? null };
  } catch (error) {
    return { refused: (error as Error).message };
  }
}

describe('engine parity: legacy-token sign-in', () => {
  parityTest('a member key signs in as its member; its use is stamped; a revoked, unknown or disabled-member key is refused', {
    methods: ['listAccessTokens', 'revokeAccessTokenById'],
  }, async (engine) => {
    const keys = await memberKeys(engine);
    const alice = await signIn(engine, keys['alice-example']!);
    // The stamp is fire-and-forget on every engine, so wait (bounded) for it to land.
    const stamped = async () => (await engine.listAccessTokens()).filter(r => r.last_used_at != null).map(r => r.name).sort();
    let used = await stamped();
    for (let i = 0; i < 50 && !used.length; i++) { await new Promise(r => setTimeout(r, 20)); used = await stamped(); }
    const unknown = await signIn(engine, 'gbrain_not_a_real_token');
    await disableMember(engine, 'bob-example');
    const disabled = await signIn(engine, keys['bob-example']!);
    const aliceId = (await engine.listAccessTokens()).find(r => r.name === 'member-alice-example')!.id as string;
    await engine.revokeAccessTokenById(aliceId);
    const revoked = await signIn(engine, keys['alice-example']!);
    expect(alice).toMatchObject({ clientName: 'member-alice-example', memberId: 'alice-example', principalKind: 'legacy_token' });
    expect(used).toEqual(['member-alice-example']);
    expect(unknown).toEqual({ refused: 'Invalid token' });
    expect(String((disabled as { refused?: string }).refused)).toContain('access_member_disabled');
    expect(revoked).toEqual({ refused: 'Invalid token' });
    return { alice, used, unknown, disabled, revoked };
  });
});

describe('engine parity: the bearer members', () => {
  // The three members the bearer checks call (engine-sql/access-credentials.ts), read on every arm directly: the live
  // token's whole row by hash for both callers, the debounced last-use stamp, and the OAuth token read, which finds no
  // row for a hash no OAuth token has (on Rust no OAuth token can exist yet, row 32d-2).
  parityTest('the bearer reads find the live token by hash, stamp it once a minute, and find no OAuth token', {
    methods: ['insertAccessToken', 'readActiveAccessTokenByHash', 'touchAccessTokenLastUsed', 'readOauthAccessTokenRows'],
  }, async (engine) => {
    await engine.setConfig('version', String(LATEST_SCHEMA_VERSION));
    const { id } = await engine.insertAccessToken({ name: 'laptop', token_hash: 'hash-laptop', scopes: ['read'], permissions: {}, source_grant: 'default',
      source_id: null, federated_read: null, allowed_operations: null, takes_holders: null });
    const shape = (row: Record<string, unknown> | null) => row && { name: row.name, id: row.id === id, used: row.last_used_at != null };
    const provider = shape(await engine.readActiveAccessTokenByHash('hash-laptop', 'provider'));
    const transport = shape(await engine.readActiveAccessTokenByHash('hash-laptop', 'transport'));
    const unknown = await engine.readActiveAccessTokenByHash('no-such-hash', 'provider');
    await engine.touchAccessTokenLastUsed(id, true);
    const stamped = shape(await engine.readActiveAccessTokenByHash('hash-laptop', 'provider'));
    const oauth = await engine.readOauthAccessTokenRows('no-such-hash', 0);
    expect({ provider, transport, unknown, stamped, oauth }).toEqual({
      provider: { name: 'laptop', id: true, used: false }, transport: { name: 'laptop', id: true, used: false },
      unknown: null, stamped: { name: 'laptop', id: true, used: true }, oauth: [],
    });
    return { provider, transport, unknown, stamped, oauth };
  });
});

describe('engine parity: legacy-token sign-in over the serve --http legacy transport', () => {
  // The transport's own bearer check (mcp/http-transport.ts validateToken) over a real socket: whoami as the member key.
  parityTest('the transport signs a member key in as its member and refuses an unknown key', {
    methods: ['listAccessTokens'],
  }, async (engine) => {
    const keys = await memberKeys(engine);
    const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
    } });
    try {
      const call = async (token: string) => {
        const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
        });
        const body = res.status === 200 ? await res.json() as { result?: { content?: Array<{ text?: string }> } } : null;
        const who = JSON.parse(body?.result?.content?.[0]?.text ?? 'null') as { token_name?: string; access?: { member?: string; bound_by?: string } } | null;
        return { status: res.status, token: who?.token_name ?? null, member: who?.access?.member ?? null, boundBy: who?.access?.bound_by ?? null };
      };
      const alice = await call(keys['alice-example']!);
      const unknown = await call('gbrain_not_a_real_token');
      expect(alice).toEqual({ status: 200, token: 'member-alice-example', member: 'alice-example', boundBy: 'credential' });
      expect(unknown.status).toBe(401);
      return { alice, unknown };
    } finally {
      await server.stop?.(true);
    }
  });
});

describe('the Rust arm signs in a member key', () => {
  // A parity case counts a typed refusal as a pass, so this reads the Rust arm's own engine: it is red while the bearer
  // check refuses every member key on Rust.
  test('a member key that serves several minted signs in on Rust', async () => {
    const rust = arms().find((arm) => arm.backend === 'rust');
    if (!rust) return;
    await resetArm(rust);
    const keys = await memberKeys(rust.engine);
    expect(await signIn(rust.engine, keys['alice-example']!)).toMatchObject({ memberId: 'alice-example', principalKind: 'legacy_token' });
  });
});
