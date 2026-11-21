/**
 * BrainEngine parity: the `access_tokens` members the legacy-token mint, the read-floor command and the requester-scope
 * gate use (engine-sql/access-tokens.ts): `insertAccessToken`, `findActiveAccessTokens`, `setAccessTokenMinTrust`,
 * `readLiveAccessTokenScope`, driven through `mintLegacyToken`, `setMinTrust` and `credentialScopeFor`
 * (src/core/token-mint.ts, src/core/trust/min-trust.ts, src/core/access/requester-scope.ts).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `setMinTrust` on a name or id that is not an OAuth client finds the one ACTIVE token it names, changes its
 *    floor and reports the floor before and after; a client of that name wins over a token; two active tokens of one name
 *    are refused `invalid_params` and neither changes; a revoked token, and a name nobody has, are `not_found`; a tier
 *    outside the six is refused 23514 (`access_tokens_min_trust_check`) with the floor unchanged. The mint inserts a token at
 *    grant revision 1 and returns its id; a repeated token hash is 23505 (`access_tokens_token_hash_key`) and a
 *    `source_grant` outside the list is 23514 (`access_tokens_source_grant_check`), each leaving no row.
 *    `credentialScopeFor` on an agent job's legacy token reads the live token's creation time and its opt-out (a minted
 *    token has none); a revoked token and an id no token has read as not opted out, creation unknown. The same answers
 *    on every engine arm.
 *  - Regression: a store that finds a revoked token, ignores the id-or-name pair, matches a name partly, lets two tokens
 *    share a hash, takes a tier it should refuse, or returns the ambiguity as a pick of the first row: a floor set on the
 *    wrong credential, which widens or narrows what an agent can read. A store whose scope read fails, which
 *    credentialScopeFor swallows: a token minted after the brain began to serve several people reads as created at an
 *    unknown time, so its unbound reads get the grace instead of the refusal.
 *  - Why existing coverage misses it: test/trust-*.test.ts and test/auth-mint*.test.ts run on PGLite with raw SQL.
 *  - Seam: none. Real engines, typed members only. Ids are generated per engine, so each is reported as the name of the
 *    row it belongs to.
 */
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { credentialScopeFor } from '../../src/core/access/requester-scope.ts';
import { setMinTrust } from '../../src/core/trust/min-trust.ts';
import { mintLegacyToken } from '../../src/core/token-mint.ts';
import { hashToken } from '../../src/core/utils.ts';
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

  parityTest('the requester-scope read of a legacy token reads a live token\'s creation time, and nothing for a revoked or missing one',
    { methods: ['insertAccessToken', 'readLiveAccessTokenScope'] }, async (engine) => {
      const before = Date.now() / 1000 - 5;
      const live = await mintLegacyToken(engine, { name: 'scoped', scopes: ['read'], takesHolders: ['world'] });
      const after = Date.now() / 1000 + 5;
      const revoked = await insert(engine, 'scoped-revoked', 'h-scoped-revoked', { revoked_at: new Date('2026-01-01T00:00:00Z') });
      const scope = async (id: string) => {
        const auth = await credentialScopeFor(engine, { clientName: 'agent', scopes: ['read'], principal: { kind: 'legacy_token', id } } as never) as
          { readsUnscoped: boolean; createdAt: number | null };
        const at = auth.createdAt;
        return { readsUnscoped: auth.readsUnscoped, createdAt: at === null ? null : at >= before && at <= after ? 'during the run' : at };
      };
      const row = await engine.readLiveAccessTokenScope(live.id);
      const member = {
        live: row === null ? null : { readsUnscoped: row.reads_unscoped, createdAtIsDate: row.created_at instanceof Date },
        revoked: await engine.readLiveAccessTokenScope(revoked.id),
      };
      return { member, live: await scope(live.id), revoked: await scope(revoked.id), missing: await scope('00000000-0000-4000-8000-000000000000') };
    });
});
