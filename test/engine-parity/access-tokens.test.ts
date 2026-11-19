/**
 * BrainEngine parity: the `access_tokens` members the legacy-token mint and the read-floor command use
 * (engine-sql/access-tokens.ts): `insertAccessToken`, `findActiveAccessTokens`, `setAccessTokenMinTrust`, driven through
 * `mintLegacyToken` and `setMinTrust` (src/core/token-mint.ts, src/core/trust/min-trust.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `setMinTrust` on a name or id that is not an OAuth client finds the one ACTIVE token it names, changes its
 *    floor and reports the floor before and after; a client of that name wins over a token; two active tokens of one name
 *    are refused `invalid_params` and neither changes; a revoked token, and a name nobody has, are `not_found`; a tier
 *    outside the six is refused 23514 (`access_tokens_min_trust_check`) with the floor unchanged. The mint inserts a token at
 *    grant revision 1 and returns its id; a repeated token hash is 23505 (`access_tokens_token_hash_key`) and a
 *    `source_grant` outside the list is 23514 (`access_tokens_source_grant_check`), each leaving no row. The same answers
 *    on every engine arm. The bearer check `serve --http` runs (oauth-provider.ts verifyAccessToken with an engine)
 *    authenticates an active token with its scopes, source grant and read floor, and refuses a revoked or unknown token.
 *  - Regression: a store that finds a revoked token, ignores the id-or-name pair, matches a name partly, lets two tokens
 *    share a hash, takes a tier it should refuse, or returns the ambiguity as a pick of the first row: a floor set on the
 *    wrong credential, which widens or narrows what an agent can read.
 *  - Why existing coverage misses it: test/trust-*.test.ts and test/auth-mint*.test.ts run on PGLite with raw SQL.
 *  - Seam: none. Real engines, typed members only. Ids are generated per engine, so each is reported as the name of the
 *    row it belongs to.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { setMinTrust } from '../../src/core/trust/min-trust.ts';
import { mintLegacyToken, readActiveTokenPermissions, readActiveTokenPrivatePages, revokeLegacyTokenById } from '../../src/core/token-mint.ts';
import { hashToken } from '../../src/core/utils.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

/** What a caller sees of a refused call: the SQLSTATE or op code, the constraint, and the message; `null` when accepted. */
async function refusal(run: () => Promise<unknown>, names: Map<string, string> = new Map()): Promise<{ code: unknown; constraint: unknown; message: string } | null> {
  try {
    await run();
    return null;
  } catch (error) {
    const e = error as { code?: unknown; constraint?: unknown; constraint_name?: unknown; message?: unknown };
    if (e.code === 'engine_capability_missing') throw error;
    let message = String(e.message);
    for (const [id, name] of names) message = message.split(id).join(`<id:${name}>`);
    return { code: e.code, constraint: e.constraint_name ?? e.constraint, message };
  }
}

const GRANT = { source_grant: 'default', source_id: null, federated_read: null, allowed_operations: null, takes_holders: null };
const insert = (engine: BrainEngine, name: string, hash: string, extra: Record<string, unknown> = {}) =>
  engine.insertAccessToken({ name, token_hash: hashToken(hash), scopes: ['read'], permissions: {}, ...GRANT, ...extra });

describe('engine parity: access_tokens members', () => {
  parityTest('setMinTrust on a token target finds the one active token by id or name, refuses an ambiguous name, a revoked token and a bad tier',
    { methods: ['insertOauthClient', 'insertAccessToken', 'findActiveAccessTokens', 'setAccessTokenMinTrust', 'patchOauthClient'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'shared-name', client_name: 'a client' });
      const solo = await insert(engine, 'solo', 'h-solo');
      const floored = await insert(engine, 'floored', 'h-floored', { min_trust: 'tool_observed' });
      await insert(engine, 'twin', 'h-twin-1');
      await insert(engine, 'twin', 'h-twin-2');
      await insert(engine, 'shared-name', 'h-shared');
      await insert(engine, 'retired', 'h-retired', { revoked_at: new Date('2026-01-02T03:04:05Z') });
      const names = new Map([[solo.id, 'solo'], [floored.id, 'floored']]);
      const shown = (c: { id: string; name: string; kind: string; before: unknown; after: unknown }) => ({ ...c, id: names.get(c.id) ?? c.id });

      const out: Record<string, unknown> = {};
      out.byName = shown(await setMinTrust(engine, 'solo', 'agent_written'));
      out.byId = shown(await setMinTrust(engine, floored.id, 'unknown'));
      out.cleared = shown(await setMinTrust(engine, 'solo', null));
      out.client = (await setMinTrust(engine, 'shared-name', 'tool_observed')).kind;
      out.ambiguous = await refusal(() => setMinTrust(engine, 'twin', 'unknown'), names);
      out.revoked = await refusal(() => setMinTrust(engine, 'retired', 'unknown'), names);
      out.nobody = await refusal(() => setMinTrust(engine, 'nobody', 'unknown'), names);
      out.badTier = await refusal(() => setMinTrust(engine, 'solo', 'bogus' as never), names);
      out.found = {
        solo: (await engine.findActiveAccessTokens('solo')).map(r => ({ ...r, id: names.get(r.id) ?? 'id' })),
        floored: (await engine.findActiveAccessTokens(floored.id)).map(r => ({ ...r, id: names.get(r.id) ?? 'id' })),
        twin: (await engine.findActiveAccessTokens('twin')).length,
        retired: (await engine.findActiveAccessTokens('retired')).length,
        partial: (await engine.findActiveAccessTokens('sol')).length,
      };
      // The member itself: it sets a floor, clears it, and an id no token has changes nothing and does not throw.
      await engine.setAccessTokenMinTrust(solo.id, 'operator_curated');
      const setTo = (await engine.findActiveAccessTokens(solo.id))[0]?.min_trust;
      await engine.setAccessTokenMinTrust(solo.id, null);
      const clearedTo = (await engine.findActiveAccessTokens(solo.id))[0]?.min_trust;
      await engine.setAccessTokenMinTrust('00000000-0000-4000-8000-000000000000', 'unknown');
      out.direct = { setTo, clearedTo };
      return out;
    });

  parityTest('the mint inserts a token and returns its id; a repeated hash and a bad source grant are refused and leave no row',
    { methods: ['insertAccessToken', 'findActiveAccessTokens', 'setAccessTokenMinTrust'] }, async (engine) => {
      const minted = await mintLegacyToken(engine, { name: 'harness', scopes: ['read', 'write'], takesHolders: ['world'] });
      const second = await mintLegacyToken(engine, { name: 'harness', scopes: ['read'], takesHolders: ['world'] });
      const floor = await setMinTrust(engine, minted.id, 'operator_curated');
      const names = new Map([[minted.id, 'harness-1'], [second.id, 'harness-2']]);
      const dupe = await refusal(() => insert(engine, 'dupe', 'h-dupe'), names);
      const repeated = await refusal(() => insert(engine, 'dupe-again', 'h-dupe'), names);
      const badGrant = await refusal(() => insert(engine, 'bad-grant', 'h-bad-grant', { source_grant: 'everything' }), names);
      const badTier = await refusal(() => insert(engine, 'bad-tier', 'h-bad-tier', { min_trust: 'bogus' }), names);
      const ambiguousMint = await refusal(() => setMinTrust(engine, 'harness', 'unknown'), names);
      return {
        scopes: [minted.scopes, second.scopes], distinctIds: minted.id !== second.id, name: minted.name,
        floor: { kind: floor.kind, name: floor.name, before: floor.before, after: floor.after },
        dupe, repeated, badGrant, badTier, ambiguousMint,
        left: { again: (await engine.findActiveAccessTokens('dupe-again')).length, grant: (await engine.findActiveAccessTokens('bad-grant')).length,
          tier: (await engine.findActiveAccessTokens('bad-tier')).length, harness: (await engine.findActiveAccessTokens('harness')).length },
      };
    });

  parityTest('mint: a minted token reads back its private-pages grant and its permissions while active, and an id no token has reads none',
    { methods: ['insertAccessToken', 'readActiveAccessTokenGrant'] }, async (engine) => {
      const minted = await mintLegacyToken(engine, { name: 'minted', scopes: ['read', 'write'], takesHolders: ['world'] });
      const nobody = '00000000-0000-4000-8000-0000000000e1';
      return {
        privatePages: await readActiveTokenPrivatePages(engine, minted.id),
        permissions: await readActiveTokenPermissions(engine, minted.id),
        upperCase: (await readActiveTokenPermissions(engine, minted.id.toUpperCase())) !== undefined,
        nobody: { privatePages: await readActiveTokenPrivatePages(engine, nobody), permissions: await readActiveTokenPermissions(engine, nobody) },
        notAnId: { privatePages: await readActiveTokenPrivatePages(engine, 'minted'), permissions: await readActiveTokenPermissions(engine, 'minted') },
        member: await engine.readActiveAccessTokenGrant(nobody, 'permissions'),
      };
    });

  parityTest('list: every token newest first, revoked ones included, with its grant columns and never its hash',
    { methods: ['insertAccessToken', 'listAccessTokens', 'revokeAccessToken'] }, async (engine) => {
      const empty = await engine.listAccessTokens();
      const names = new Map<string, string>();
      for (const name of ['first', 'second', 'third']) {
        const row = await insert(engine, name, `h-list-${name}`, { scopes: name === 'second' ? ['read', 'write'] : ['read'] });
        names.set(row.id, name);
        await Bun.sleep(5);
      }
      const second = [...names].find(([, n]) => n === 'second')![0];
      await engine.revokeAccessToken(second);
      const rows = await engine.listAccessTokens();
      return {
        empty,
        rows: rows.map(r => ({
          name: r.name, id: names.get(r.id) ?? 'unknown', scopes: r.scopes, created: r.created_at instanceof Date, lastUsed: r.last_used_at,
          revoked: r.revoked_at instanceof Date, member: r.member_id, privatePages: r.private_pages ?? 'none',
          hash: Object.keys(r).filter(k => k.includes('hash')),
        })),
      };
    });

  parityTest('revoke: by name stamps every active token of that name once, by id returns its name once, and a revoked token reads as gone',
    { methods: ['insertAccessToken', 'revokeAccessTokensNamed', 'revokeAccessToken', 'readActiveAccessTokenGrant', 'accessTokenLive', 'findActiveAccessTokens', 'forgetWakeCredential'] }, async (engine) => {
      const a = await insert(engine, 'twin', 'h-rv-1');
      const b = await insert(engine, 'twin', 'h-rv-2');
      const solo = await insert(engine, 'solo', 'h-rv-3');
      const keep = await insert(engine, 'keep', 'h-rv-4');
      const names = new Map([[a.id, 'twin-a'], [b.id, 'twin-b'], [solo.id, 'solo'], [keep.id, 'keep']]);
      const live = async () => Object.fromEntries(await Promise.all([...names].map(async ([id, n]) => [n, await engine.accessTokenLive(id)] as const)));
      const before = await live();
      const byName = (await engine.revokeAccessTokensNamed('twin')).map(id => names.get(id)).sort();
      const byNameAgain = await engine.revokeAccessTokensNamed('twin');
      const byId = await revokeLegacyTokenById(engine, solo.id.toUpperCase());
      const byIdAgain = await revokeLegacyTokenById(engine, solo.id);
      const member = await engine.revokeAccessToken('00000000-0000-4000-8000-0000000000e2');
      return {
        before, byName, byNameAgain, byId, byIdAgain, member, after: await live(),
        grants: { solo: await engine.readActiveAccessTokenGrant(solo.id, 'permissions'), keep: (await engine.readActiveAccessTokenGrant(keep.id, 'permissions')) !== null },
        active: { twin: (await engine.findActiveAccessTokens('twin')).length, solo: (await engine.findActiveAccessTokens('solo')).length, keep: (await engine.findActiveAccessTokens('keep')).length },
      };
    });

  parityTest('bearer check: serve --http authenticates an active token by its hash with its grant, and refuses a revoked or unknown token',
    { methods: ['insertAccessToken', 'readOauthAccessTokenRows', 'readActiveAccessTokenByHash', 'touchAccessTokenLastUsed', 'revokeAccessToken'] }, async (engine) => {
      // The provider serve --http builds (serve-http.ts): `sql` for the rest of OAuth, the engine for the bearer check.
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
      const reader = await insert(engine, 'reader', 'tok-reader');
      const writer = await insert(engine, 'writer', 'tok-writer', { scopes: ['read', 'write'], min_trust: 'tool_observed', source_grant: 'federated', source_id: 'default', federated_read: ['default'] });
      const gone = await insert(engine, 'gone', 'tok-gone');
      const names = new Map([[reader.id, 'reader'], [writer.id, 'writer'], [gone.id, 'gone']]);
      const verify = async (token: string) => {
        try {
          const auth = await provider.verifyAccessToken(token) as unknown as Record<string, unknown>;
          const { expiresAt, createdAt, principal, ...rest } = auth;
          const p = principal as { kind: string; id: string };
          return { ...rest, principal: { kind: p.kind, id: names.get(p.id) ?? p.id }, expiresInAYear: Number(expiresAt) > Date.now() / 1000 + 364 * 24 * 3600, hasCreatedAt: createdAt != null };
        } catch (error) {
          if ((error as { code?: unknown }).code === 'engine_capability_missing') throw error;
          return { refused: (error as Error).constructor.name, message: (error as Error).message };
        }
      };
      const out: Record<string, unknown> = {};
      out.reader = await verify('tok-reader');
      out.writer = await verify('tok-writer');
      out.beforeRevoke = await verify('tok-gone');
      await revokeLegacyTokenById(engine, gone.id);
      out.revoked = await verify('tok-gone');
      out.unknown = await verify('tok-nobody');
      out.hashNotToken = await verify(hashToken('tok-reader'));
      // Not vacuous: the active tokens authenticate and the revoked and unknown ones are refused on every arm.
      for (const k of ['reader', 'writer', 'beforeRevoke']) if ('refused' in (out[k] as object)) throw new Error(`${k} refused: ${JSON.stringify(out[k])}`);
      for (const k of ['revoked', 'unknown', 'hashNotToken']) if (!('refused' in (out[k] as object))) throw new Error(`${k} authenticated`);
      return out;
    });
});
