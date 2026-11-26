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
 *    `source_grant` outside the list is 23514 (`access_tokens_source_grant_check`), each leaving no row. The same answers
 *    on every engine arm. `credentialScopeFor` on an agent job's legacy token reads the live token's creation time and its
 *    opt-out (a minted token has none); a revoked token and an id no token has read as not opted out, creation unknown.
 *    The bearer check `serve --http` runs (oauth-provider.ts verifyAccessToken with an engine)
 *    authenticates an active token with its scopes, source grant and read floor, and refuses a revoked or unknown token.
 *    The OAuth rung of that check reads the `oauth_tokens` rows the store keeps: a valid OAuth token authenticates with the
 *    same AuthInfo (grant, sources, surface, floor), an expired one, a refresh token, a token of a deleted client and a
 *    token of a soft-deleted client are refused the same way, and a repeated hash (23505) or an unknown client (23503) is
 *    refused on insert. The bearer check stamps `last_used_at` (null before, set after, unchanged by a second check inside
 *    60 seconds), and the stamp leaves a row with no `source_grant` alone when it is the unified one. A token still on the
 *    legacy shape (no `source_grant`) authenticates with its permissions grant and its first check converts the row once,
 *    one more grant revision; a second conversion finds nothing.
 *    `credentialScopeFor` on an agent job's legacy token reads the live token's creation time and its stored
 *    `--reads-unscoped` opt-out (a minted token has none; an opted-out token reads unscoped, a cleared one does not); a
 *    revoked token and an id no token has read as not opted out, creation unknown. `defaultSourceMemberWriter` reads a
 *    bound token's stored member for its default-source page writes.
 *  - Regression: a store that finds a revoked token, ignores the id-or-name pair, matches a name partly, lets two tokens
 *    share a hash, takes a tier it should refuse, or returns the ambiguity as a pick of the first row: a floor set on the
 *    wrong credential, which widens or narrows what an agent can read. A store whose scope read fails, which
 *    credentialScopeFor swallows: a token minted after the brain began to serve several people reads as created at an
 *    unknown time, so its unbound reads get the grace instead of the refusal.
 *  - Why existing coverage misses it: test/trust-*.test.ts and test/auth-mint*.test.ts run on PGLite with raw SQL.
 *  - Seam: none. Real engines, typed members only. Ids are generated per engine, so each is reported as the name of the
 *    row it belongs to.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { credentialScopeFor } from '../../src/core/access/requester-scope.ts';
import { defaultSourceMemberWriter } from '../../src/core/persistence/page-visibility.ts';
import { setMinTrust } from '../../src/core/trust/min-trust.ts';
import { mintLegacyToken, readActiveTokenPermissions, readActiveTokenPrivatePages, revokeLegacyTokenById } from '../../src/core/token-mint.ts';
import { hashToken } from '../../src/core/utils.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { OAuthGrants } from '../../src/core/oauth-grants.ts';
import { createHash } from 'node:crypto';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { addMember, bindCredential } from '../../src/core/access/members.ts';
import { createSource, OWNER_ONLY_STOP, parityArms, stopOnOwnerOnlyRefusal } from './harness.ts';
import { migrateLegacyTokens, rescopeLegacyToken, type RescopeTokenArgs } from '../../src/core/grants/legacy-token.ts';
import type { Server } from 'node:http';
import express from 'express';
import { buildServeHttpApp } from '../../src/commands/serve-http.ts';
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

  // gbrain auth rescope locks the one active token it edits: by id (any case) or by exact name, revoked tokens left out.
  // Postgres returns the rows in no set order, so the case sorts them by when they were made; the hash is never compared.
  parityTest('lockActiveAccessTokens reads the active tokens with one id or one exact name, with the columns rescope reads',
    { methods: ['insertAccessToken', 'lockActiveAccessTokens', 'revokeAccessToken'] }, async (engine) => {
      const late = await insert(engine, 'twin', 'h-lk-late', { created_at: new Date('2026-02-02T00:00:00Z'), may_act_for: ['member:alice-example'] });
      const early = await insert(engine, 'twin', 'h-lk-early', { created_at: new Date('2026-01-01T00:00:00Z'), scopes: ['read', 'write'] });
      const solo = await insert(engine, 'solo', 'h-lk-solo', { created_at: new Date('2026-01-03T00:00:00Z'), min_trust: 'tool_observed' });
      const gone = await insert(engine, 'solo-old', 'h-lk-gone', { created_at: new Date('2026-01-04T00:00:00Z') });
      await engine.revokeAccessToken(gone.id);
      const names = new Map([[late.id, 'twin-late'], [early.id, 'twin-early'], [solo.id, 'solo'], [gone.id, 'solo-old']]);
      const KEYS = ['id', 'name', 'scopes', 'created_at', 'revoked_at', 'permissions', 'source_grant', 'source_id', 'federated_read',
        'allowed_operations', 'takes_holders', 'grant_revision', 'min_trust', 'member_id', 'may_act_for', 'attest_actor', 'reads_unscoped'];
      const shown = (rows: Record<string, unknown>[]) => [...rows]
        .sort((a, b) => (a.created_at as Date).getTime() - (b.created_at as Date).getTime())
        .map(r => ({
          ...Object.fromEntries(KEYS.map(k => [k, r[k] ?? null])),
          id: names.get(String(r.id)) ?? 'unknown',
          created_at: (r.created_at as Date).toISOString(),
          grant_revision: Number(r.grant_revision),
        }));
      const out = {
        twin: shown(await engine.lockActiveAccessTokens({ name: 'twin' })),
        solo: shown(await engine.lockActiveAccessTokens({ name: 'solo' })),
        partial: (await engine.lockActiveAccessTokens({ name: 'sol' })).length,
        otherCase: (await engine.lockActiveAccessTokens({ name: 'Solo' })).length,
        revokedByName: (await engine.lockActiveAccessTokens({ name: 'solo-old' })).length,
        byId: shown(await engine.lockActiveAccessTokens({ id: solo.id })),
        byUpperId: shown(await engine.lockActiveAccessTokens({ id: solo.id.toUpperCase() })).map(r => r.id),
        revokedById: (await engine.lockActiveAccessTokens({ id: gone.id })).length,
        unknownId: (await engine.lockActiveAccessTokens({ id: '00000000-0000-4000-8000-0000000000e1' })).length,
        inTransaction: (await engine.transaction(tx => tx.lockActiveAccessTokens({ name: 'twin' }))).length,
      };
      expect(out.twin.map(r => r.id)).toEqual(['twin-early', 'twin-late']);
      expect(out.solo.map(r => r.id)).toEqual(['solo']);
      expect([out.partial, out.otherCase, out.revokedByName, out.revokedById, out.unknownId, out.inTransaction]).toEqual([0, 0, 0, 0, 0, 2]);
      expect(out.byUpperId).toEqual(['solo']);
      return out;
    });

  // gbrain auth rescope writes a token's grant in one statement: the five grant columns, the scopes when the edit names
  // them, the permissions mirror and one more grant revision, by id in any case. A bad source grant writes nothing.
  parityTest('writeAccessTokenGrant writes the grant columns, the scopes when given, the permissions and one more revision; an unknown id writes nothing',
    { methods: ['insertAccessToken', 'writeAccessTokenGrant', 'lockActiveAccessTokens'] }, async (engine) => {
      const token = await insert(engine, 'grant', 'h-wg', { scopes: ['read', 'write'], permissions: { keep: 1 } });
      const other = await insert(engine, 'bystander', 'h-wg-other');
      const KEYS = ['scopes', 'permissions', 'source_grant', 'source_id', 'federated_read', 'allowed_operations', 'takes_holders', 'grant_revision'];
      const read = async (id: string) => {
        const [row] = await engine.lockActiveAccessTokens({ id });
        return { ...Object.fromEntries(KEYS.map(k => [k, row[k] ?? null])), grant_revision: Number(row.grant_revision) };
      };
      const federated = { source_grant: 'federated', source_id: 'default', federated_read: ['default', 'work'], allowed_operations: ['get_page', 'search'], takes_holders: ['world', 'brain'] };
      const out: Record<string, unknown> = {};
      out.first = await engine.writeAccessTokenGrant(token.id, { columns: federated, scopes: null, permissions: { keep: 1, source_id: ['default', 'work'] } });
      out.afterFirst = await read(token.id);
      out.second = await engine.writeAccessTokenGrant(token.id.toUpperCase(), {
        columns: { source_grant: 'none', source_id: null, federated_read: [], allowed_operations: [], takes_holders: null }, scopes: ['read'], permissions: {},
      });
      out.afterSecond = await read(token.id);
      out.unknown = await engine.writeAccessTokenGrant('00000000-0000-4000-8000-0000000000e1', { columns: federated, scopes: null, permissions: {} });
      out.badGrant = await refusal(() => engine.writeAccessTokenGrant(token.id, { columns: { ...federated, source_grant: 'everything' }, scopes: null, permissions: {} }));
      out.afterBad = await read(token.id);
      out.bystander = await read(other.id);
      out.inTransaction = await engine.transaction(tx => tx.writeAccessTokenGrant(other.id, { columns: { ...GRANT, source_grant: 'scalar', source_id: 'default' }, scopes: null, permissions: { source_id: 'default' } }));
      expect([out.first, out.second, out.unknown, out.inTransaction]).toEqual([2, 3, null, 2]);
      expect(out.afterBad).toEqual(out.afterSecond);
      return out;
    });

  // The private-pages and private-facts grants live in their own columns; every read of a token row shows what was set.
  parityTest('writeAccessTokenPrivateGrant sets private_pages or private_facts, every token read shows it, and a value outside the two is refused',
    { methods: ['insertAccessToken', 'writeAccessTokenPrivateGrant', 'listAccessTokens', 'readActiveAccessTokenGrant', 'readAccessTokenWriteGrant', 'lockActiveAccessTokens'] }, async (engine) => {
      const token = await insert(engine, 'private', 'h-pv');
      const reads = async () => {
        const listed = (await engine.listAccessTokens()).find(r => r.id === token.id)!;
        const [locked] = await engine.lockActiveAccessTokens({ id: token.id });
        const write = await engine.readAccessTokenWriteGrant(token.id);
        return {
          listed: [listed.private_pages, listed.private_facts], locked: [locked.private_pages, locked.private_facts],
          active: (await engine.readActiveAccessTokenGrant(token.id, 'private_pages'))?.value, write: [write?.private_pages, write?.private_facts],
          revision: Number(locked.grant_revision),
        };
      };
      const out: Record<string, unknown> = { fresh: await reads() };
      await engine.writeAccessTokenPrivateGrant(token.id, 'private_pages', 'granted_sources');
      out.pages = await reads();
      await engine.writeAccessTokenPrivateGrant(token.id.toUpperCase(), 'private_facts', 'granted_sources');
      out.facts = await reads();
      await engine.writeAccessTokenPrivateGrant(token.id, 'private_pages', 'none');
      out.pagesOff = await reads();
      out.badPages = await refusal(() => engine.writeAccessTokenPrivateGrant(token.id, 'private_pages', 'everything'));
      out.badFacts = await refusal(() => engine.writeAccessTokenPrivateGrant(token.id, 'private_facts', 'everything'));
      out.afterBad = await reads();
      await engine.writeAccessTokenPrivateGrant('00000000-0000-4000-8000-0000000000e1', 'private_pages', 'granted_sources');
      expect(out.afterBad).toEqual(out.pagesOff);
      return out;
    });

  // gbrain auth rescope --migrate-legacy locks every active token still on the legacy shape, oldest first.
  parityTest('lockLegacyAccessTokens reads the active tokens with no source grant, oldest first, with the columns the migration reads',
    { methods: ['insertAccessToken', 'lockLegacyAccessTokens', 'revokeAccessToken'] }, async (engine) => {
      const legacy = { source_grant: null, permissions: { source_id: 'default', takes_holders: ['world'] } };
      const late = await insert(engine, 'late', 'h-ll-late', { ...legacy, created_at: new Date('2026-02-02T00:00:00Z') });
      const early = await insert(engine, 'early', 'h-ll-early', { ...legacy, created_at: new Date('2026-01-01T00:00:00Z'), scopes: ['read', 'write'] });
      await insert(engine, 'unified', 'h-ll-unified', { created_at: new Date('2026-01-05T00:00:00Z') });
      const gone = await insert(engine, 'gone', 'h-ll-gone', { ...legacy, created_at: new Date('2026-01-03T00:00:00Z') });
      await engine.revokeAccessToken(gone.id);
      const names = new Map([[late.id, 'late'], [early.id, 'early']]);
      const KEYS = ['name', 'scopes', 'permissions', 'source_grant', 'source_id', 'federated_read', 'allowed_operations', 'takes_holders', 'grant_revision', 'private_pages', 'private_facts', 'revoked_at'];
      const rows = (await engine.lockLegacyAccessTokens()).map(r => ({
        ...Object.fromEntries(KEYS.map(k => [k, r[k] ?? null])), id: names.get(String(r.id)) ?? 'unknown',
        created_at: (r.created_at as Date).toISOString(), grant_revision: Number(r.grant_revision),
      }));
      const inTransaction = (await engine.transaction(tx => tx.lockLegacyAccessTokens())).length;
      expect(rows.map(r => r.id)).toEqual(['early', 'late']);
      expect(inTransaction).toBe(2);
      return { rows, inTransaction };
    });

  // The command end to end: rescopeLegacyToken (each grant axis, the private grants, the refusals) and the migration.
  parityTest('rescopeLegacyToken edits each grant axis and the private grants, refuses an unknown source, and migrateLegacyTokens converts the legacy tokens',
    { methods: ['insertAccessToken', 'lockActiveAccessTokens', 'filterUnarchivedSourceIds', 'writeAccessTokenGrant', 'writeAccessTokenPrivateGrant', 'lockLegacyAccessTokens', 'transaction'] },
    async (engine, backend) => {
      await createSource(engine, backend, 'work');
      const token = await insert(engine, 'edited', 'h-rs');
      const base = { target: { name: 'edited' }, reset: [], refreshOperations: false, allNew: false, dryRun: false, json: false } as RescopeTokenArgs;
      const run = async (args: Partial<RescopeTokenArgs>) => {
        try {
          const r = await rescopeLegacyToken(engine, { ...base, ...args });
          return { ...r, id: r.id === token.id ? 'edited' : 'other' };
        } catch (error) {
          const e = error as { code?: unknown; message?: unknown };
          if (e.code === 'engine_capability_missing') throw error;
          return { code: e.code, message: String(e.message) };
        }
      };
      const out: Record<string, unknown> = {};
      out.sources = await run({ sources: ['default', 'work'] });
      out.operations = await run({ operations: ['get_page', 'search'] });
      out.holders = await run({ takesHolders: ['world', 'brain'] });
      out.pages = await run({ privatePages: 'granted_sources' });
      out.facts = await run({ privateFacts: 'granted_sources', scopes: ['read', 'write'] });
      out.preview = await run({ privatePages: 'none', dryRun: true });
      out.reset = await run({ reset: ['sources', 'takes-holders', 'operations'] });
      out.unknownSource = await run({ sources: ['nosuch'] });
      out.stale = await run({ sources: ['default'], expectedRevision: 1 });
      out.show = await run({});
      const legacy = { source_grant: null, permissions: { source_id: ['default', 'work'], takes_holders: ['world'] } };
      await insert(engine, 'legacy-a', 'h-rs-a', { ...legacy, created_at: new Date('2026-01-01T00:00:00Z') });
      await insert(engine, 'legacy-b', 'h-rs-b', { ...legacy, permissions: { allowed_operations: ['get_page'] }, created_at: new Date('2026-01-02T00:00:00Z') });
      const shown = (r: Awaited<ReturnType<typeof migrateLegacyTokens>>) => ({ ...r,
        migrated: r.migrated.map(m => ({ ...m, id: 'id' })), skipped: r.skipped.map(m => ({ ...m, id: 'id', fix: m.fix.replace(/--id \S+/, '--id <id>') })) });
      out.migratePreview = shown(await migrateLegacyTokens(engine, { dryRun: true }));
      out.migrate = shown(await migrateLegacyTokens(engine, { dryRun: false }));
      out.migrateAgain = shown(await migrateLegacyTokens(engine, { dryRun: false }));
      const [a] = await engine.lockActiveAccessTokens({ name: 'legacy-a' });
      out.legacyA = { source_grant: a.source_grant, source_id: a.source_id, federated_read: a.federated_read, takes_holders: a.takes_holders, grant_revision: Number(a.grant_revision) };
      return out;
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
  parityTest('serve --http end to end: one MCP tool call with a valid access token returns the same result, and an unknown token gets 401',
    { methods: ['putPage', 'insertAccessToken', 'readActiveAccessTokenByHash'], timeout: 120_000,
      // While the Rust store is multi-user, the owner-only session gate refuses this non-owner key (L4 opens it); nothing is read.
      rustMultiuserStop: OWNER_ONLY_STOP() }, async (engine) => {
      await engine.putPage('notes/served-example', { type: 'note', title: 'Served example', compiled_truth: 'A page read over serve --http.', timeline: '' });
      await insert(engine, 'http-reader', 'tok-http-reader');
      const app = express();
      const server: Server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const address = server.address();
        if (!address || typeof address === 'string') throw new Error('expected a TCP address');
        const base = `http://127.0.0.1:${address.port}`;
        await buildServeHttpApp(app, engine, { port: address.port, tokenTtl: 3600, enableDcr: false, publicUrl: base });
        const call = async (token: string) => {
          const res = await fetch(`${base}/mcp`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: 'notes/served-example' } } }),
          });
          const text = await res.text();
          if (res.status !== 200) return { status: res.status, error: (() => { try { return JSON.parse(text).error; } catch { return text; } })() };
          const dataLine = text.split('\n').find(l => l.startsWith('data:'));
          const result = JSON.parse(dataLine ? dataLine.slice('data:'.length) : text).result as { isError?: boolean; content: Array<{ text: string }> };
          if (result.isError) return { status: res.status, isError: true, error: result.content[0]?.text };
          const page = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
          return { status: res.status, isError: result.isError ?? false, page: { slug: page.slug, type: page.type, title: page.title, compiled_truth: page.compiled_truth } };
        };
        const ok = await call('tok-http-reader');
        const unknown = await call('tok-http-nobody');
        stopOnOwnerOnlyRefusal((ok as { error?: unknown }).error, ['A page read over serve --http.']);
        // Not vacuous: the valid token reads the page and the unknown one is refused, on every arm.
        if (ok.status !== 200 || (ok as { page?: { slug?: unknown } }).page?.slug !== 'notes/served-example') throw new Error(`valid token: ${JSON.stringify(ok)}`);
        if (unknown.status !== 401) throw new Error(`unknown token: ${JSON.stringify(unknown)}`);
        return { ok, unknown };
      } finally {
        await new Promise<void>(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); });
      }
    });

  /** A bearer check as serve --http runs it, as what a caller sees: the AuthInfo (ids by name, times as a flag) or the refusal. */
  async function bearer(engine: BrainEngine, provider: GBrainOAuthProvider, token: string): Promise<Record<string, unknown>> {
    try {
      const auth = await provider.verifyAccessToken(token) as unknown as Record<string, unknown>;
      const { expiresAt, createdAt, ...rest } = auth;
      return { ...rest, expiresAtIsStored: typeof expiresAt === 'number', hasCreatedAt: createdAt != null };
    } catch (error) {
      if ((error as { code?: unknown }).code === 'engine_capability_missing') throw error;
      return { refused: (error as Error).constructor.name, message: (error as Error).message };
    }
  }

  parityTest('bearer check, OAuth rung: a valid OAuth token authenticates with its client grant, and an expired one, a refresh token, and a deleted or soft-deleted client\'s token are refused',
    { methods: ['insertOauthClient', 'insertOauthToken', 'readOauthAccessTokenRows', 'readActiveAccessTokenByHash', 'deleteOAuthClient', 'insertSource'] }, async (engine) => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
      await engine.insertSource({ id: 'wiki', name: 'wiki', local_path: null, config: {} });
      const now = Math.floor(Date.now() / 1000);
      const client = (id: string, extra: Record<string, unknown> = {}) => engine.insertOauthClient({
        client_id: id, client_name: `Client ${id}`, scope: 'read write', source_id: 'default', federated_read: ['default', 'wiki'], client_id_issued_at: 1_700_000_000,
        token_ttl: 600, bound_slug_prefixes: ['notes/'], surface: 'full', surface_set_by: 'operator', min_trust: 'tool_observed', ...extra,
      });
      await client('oc-valid');
      await client('oc-gone');
      await client('oc-soft', { deleted_at: new Date('2026-01-02T03:04:05Z') });
      await client('oc-wiki', { source_id: null, federated_read: [], scope: 'read' });
      const token = (hash: string, clientId: string, extra: Record<string, unknown> = {}) => engine.insertOauthToken({
        token_hash: hashToken(hash), token_type: 'access', client_id: clientId, scopes: ['read', 'write'], expires_at: now + 3600,
        resource: null, created_at: now, grant_type: 'client_credentials', ...extra,
      });
      await token('ot-valid', 'oc-valid');
      await token('ot-plain', 'oc-valid', { grant_type: undefined, scopes: ['read'], resource: 'https://brain.example/mcp' });
      await token('ot-narrow', 'oc-wiki', { scopes: ['read', 'admin'] });
      await token('ot-expired', 'oc-valid', { expires_at: now - 10 });
      await token('ot-refresh', 'oc-valid', { token_type: 'refresh' });
      await token('ot-gone', 'oc-gone');
      await token('ot-soft', 'oc-soft');

      const out: Record<string, unknown> = {};
      for (const name of ['valid', 'plain', 'narrow', 'expired', 'refresh']) out[name] = await bearer(engine, provider, `ot-${name}`);
      out.beforeDelete = await bearer(engine, provider, 'ot-gone');
      out.deleted = await engine.deleteOAuthClient('oc-gone');
      out.afterDelete = await bearer(engine, provider, 'ot-gone');
      out.soft = await bearer(engine, provider, 'ot-soft');
      out.hashNotToken = await bearer(engine, provider, hashToken('ot-valid'));
      out.reread = await bearer(engine, provider, 'ot-valid');
      // The rung rows the check reads: the same keys on every arm (a degraded rung drops columns), and none for a bad hash.
      const rungs: Record<string, unknown> = {};
      for (const rung of [0, 1, 2, 3, 4] as const) rungs[rung] = Object.keys((await engine.readOauthAccessTokenRows(hashToken('ot-valid'), rung))[0] ?? {}).sort();
      out.rungKeys = rungs;
      out.noRow = (await engine.readOauthAccessTokenRows(hashToken('ot-nobody'), 0)).length;
      // Not vacuous: the valid ones authenticate, the others are refused, on every arm.
      for (const k of ['valid', 'plain', 'narrow', 'beforeDelete', 'reread']) if ('refused' in (out[k] as object)) throw new Error(`${k} refused: ${JSON.stringify(out[k])}`);
      for (const k of ['expired', 'refresh', 'afterDelete', 'soft', 'hashNotToken']) if (!('refused' in (out[k] as object))) throw new Error(`${k} authenticated`);
      return out;
    });

  parityTest('bearer check, OAuth rung, in a session set to America/Los_Angeles: the client grant timestamps read as the same UTC text and the token authenticates the same',
    { methods: ['insertOauthClient', 'insertOauthToken', 'readOauthAccessTokenRows'] }, async (engine, backend, ctx) => {
      const now = Math.floor(Date.now() / 1000);
      await engine.insertOauthClient({
        client_id: 'oc-tz', client_name: 'Client oc-tz', scope: 'read write', source_id: 'default', federated_read: ['default'], client_id_issued_at: 1_700_000_000,
        token_ttl: 600, surface: 'full', surface_set_by: 'operator',
        // A summer and a winter instant (PDT and PST offsets), each with a fraction.
        created_at: new Date('2026-07-04T15:16:17.123Z'), reads_unscoped: new Date('2026-01-02T03:04:05.5Z'),
      });
      await engine.insertOauthToken({ token_hash: hashToken('ot-tz'), token_type: 'access', client_id: 'oc-tz', scopes: ['read'], expires_at: now + 3600,
        resource: null, created_at: now, grant_type: 'client_credentials' });
      // The session time zone a Postgres server or PGLite can carry; the Rust store has no session.
      let reader: BrainEngine = engine;
      let restore = async () => {};
      if (backend === 'pglite') {
        await engine.executeRaw(`SET TIME ZONE 'America/Los_Angeles'`);
        restore = async () => { await engine.executeRaw('RESET TIME ZONE'); };
      } else if (backend === 'postgres') {
        const [{ db }] = await engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
        const quoted = `"${db.replace(/"/g, '""')}"`;
        await engine.executeRaw(`ALTER DATABASE ${quoted} SET timezone TO 'America/Los_Angeles'`);
        const fresh = ctx.unconnectedEngine();
        await fresh.engine.connect(fresh.config);
        reader = fresh.engine;
        restore = async () => { await engine.executeRaw(`ALTER DATABASE ${quoted} RESET timezone`); };
      }
      try {
        // Not vacuous: the session really is on Pacific time where there is one.
        const zone = backend === 'rust' ? 'America/Los_Angeles'
          : (await reader.executeRaw<{ tz: string }>(`SELECT current_setting('TimeZone') AS tz`))[0]!.tz;
        const [row] = await reader.readOauthAccessTokenRows(hashToken('ot-tz'), 0);
        const grant = (row?.current_grant ?? {}) as Record<string, unknown>;
        const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(reader), engine: reader });
        return {
          zone,
          created_at: grant.created_at, reads_unscoped: grant.reads_unscoped, deleted_at: grant.deleted_at,
          auth: await bearer(reader, provider, 'ot-tz'),
        };
      } finally {
        await restore();
      }
    });

  parityTest('the expired-credential sweep serve --http runs at startup deletes the expired OAuth tokens of any type and keeps the live ones',
    { methods: ['insertOauthClient', 'insertOauthToken', 'deleteExpiredOauthCredentials', 'readOauthAccessTokenRows'] }, async (engine) => {
      const now = Math.floor(Date.now() / 1000);
      await engine.insertOauthClient({ client_id: 'oc-sweep', client_name: 'Client oc-sweep', scope: 'read', client_id_issued_at: 1_700_000_000 });
      const token = (name: string, extra: Record<string, unknown>) => engine.insertOauthToken({
        token_hash: hashToken(name), token_type: 'access', client_id: 'oc-sweep', scopes: ['read'], expires_at: now + 3600,
        resource: null, created_at: now, grant_type: 'client_credentials', ...extra,
      });
      await token('ot-sweep-live', {});
      await token('ot-sweep-old', { expires_at: now - 10 });
      await token('ot-sweep-old-refresh', { token_type: 'refresh', expires_at: now - 10 });
      const swept = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).sweepExpiredTokens();
      const kept = async (name: string) => (await engine.readOauthAccessTokenRows(hashToken(name), 0)).length;
      const out = { swept, live: await kept('ot-sweep-live'), again: await engine.deleteExpiredOauthCredentials(now) };
      // Not vacuous: two expired tokens go, the live one stays, and a second sweep finds nothing.
      if (out.swept !== 2 || out.live !== 1 || out.again !== 0) throw new Error(`sweep: ${JSON.stringify(out)}`);
      return out;
    });

  /** The grants serve --http builds: the client lock, the code and the tokens run as members on the engine's transaction. */
  const grantsFor = (engine: BrainEngine) => new OAuthGrants({ sql: sqlQueryForEngine(engine), engine,
    transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx), tx)), tokenTtl: 3600, refreshTtl: 86400 });
  const REDIRECT = 'https://client.example/callback';
  const VERIFIER = 'v'.repeat(43);
  const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
  const authorize = (grants: OAuthGrants, clientId: string) => grants.begin(clientId, { redirectUri: REDIRECT, codeChallenge: CHALLENGE, scopes: ['read'], state: 'st-1' } as never);
  const failure = async (run: () => Promise<unknown>) => { try { await run(); return null; } catch (e) { return `${(e as Error).constructor.name}: ${(e as Error).message}`; } };

  parityTest('an authorization code is issued, exchanged for tokens once, and a second exchange is refused (OAuthGrants over the engine transaction)',
    { methods: ['insertOauthClient', 'readOauthClient', 'readOauthClientForUpdate', 'insertOauthCode', 'readOauthCodeChallenge', 'readOauthCodeForUpdate', 'deleteOauthCode', 'issueOauthTokens', 'readOauthAccessTokenRows'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'oc-code', client_name: 'Client oc-code', scope: 'read', grant_types: ['authorization_code', 'refresh_token'],
        redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', client_id_issued_at: 1_700_000_000 });
      const grants = grantsFor(engine);
      const out: Record<string, unknown> = {};
      const consent = await authorize(grants, 'oc-code');
      const redirect = new URL(await grants.decide(consent, true));
      const code = redirect.searchParams.get('code')!;
      out.redirect = { origin: redirect.origin, path: redirect.pathname, state: redirect.searchParams.get('state'), codeShape: /^gbrain_code_[A-Za-z0-9_-]+$/.test(code) };
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
      const client = { client_id: 'oc-code' } as never;
      out.challenge = await provider.challengeForAuthorizationCode(client, code);
      out.otherClient = await failure(() => provider.challengeForAuthorizationCode({ client_id: 'nobody' } as never, code));
      out.wrongRedirect = await failure(() => grants.exchangeCode('oc-code', code, VERIFIER, 'https://client.example/other'));
      out.wrongVerifier = await failure(() => grants.exchangeCode('oc-code', code, 'w'.repeat(43), REDIRECT));
      const tokens = await grants.exchangeCode('oc-code', code, VERIFIER, REDIRECT);
      out.tokens = { type: tokens.token_type, expiresIn: tokens.expires_in, scope: tokens.scope, refresh: /^gbrain_rt_/.test(tokens.refresh_token ?? '') };
      const rows = await engine.readOauthAccessTokenRows(hashToken(tokens.access_token), 0);
      out.accessRow = rows.map(r => ({ client_id: r.client_id, scopes: r.scopes, token_type: r.token_type }));
      out.second = await failure(() => grants.exchangeCode('oc-code', code, VERIFIER, REDIRECT));
      out.afterExchange = await failure(() => provider.challengeForAuthorizationCode(client, code));
      out.refused = await failure(() => grants.exchangeCode('oc-code', 'gbrain_code_never-issued', VERIFIER, REDIRECT));
      // Not vacuous: the first exchange issued the pair and the repeat and the stranger were refused with the same error.
      if (rows.length !== 1 || !String(out.second).startsWith('InvalidGrantError') || !String(out.refused).startsWith('InvalidGrantError')) throw new Error(`code flow: ${JSON.stringify(out)}`);
      return out;
    });

  parityTest('the startup sweep deletes an expired authorization code with the expired tokens and keeps a live code; deleting a client deletes its codes',
    { methods: ['insertOauthClient', 'insertOauthCode', 'readOauthCodeChallenge', 'deleteExpiredOauthCredentials', 'deleteOAuthClient'] }, async (engine) => {
      const now = Math.floor(Date.now() / 1000);
      for (const id of ['oc-sw-a', 'oc-sw-b']) await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read', client_id_issued_at: 1_700_000_000 });
      const code = (name: string, client: string, expires: number) => engine.insertOauthCode({ code_hash: hashToken(name), client_id: client, scopes: ['read'],
        code_challenge: CHALLENGE, code_challenge_method: 'S256', redirect_uri: REDIRECT, state: null, resource: null, expires_at: expires });
      await code('code-live', 'oc-sw-a', now + 600);
      await code('code-old', 'oc-sw-a', now - 10);
      await code('code-b', 'oc-sw-b', now + 600);
      const read = async (name: string, client: string) => engine.readOauthCodeChallenge(hashToken(name), client, now);
      const out: Record<string, unknown> = {};
      out.before = { live: await read('code-live', 'oc-sw-a'), old: await read('code-old', 'oc-sw-a'), other: await read('code-live', 'oc-sw-b') };
      out.repeated = await refusal(() => code('code-live', 'oc-sw-a', now + 600));
      out.noClient = await refusal(() => code('code-nobody', 'nobody', now + 600));
      out.swept = await new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine }).sweepExpiredTokens();
      out.again = await engine.deleteExpiredOauthCredentials(now);
      await engine.deleteOAuthClient('oc-sw-a');
      out.afterDelete = { live: await read('code-live', 'oc-sw-a'), b: await read('code-b', 'oc-sw-b') };
      if (out.swept !== 1 || out.again !== 0) throw new Error(`sweep: ${JSON.stringify(out)}`);
      return out;
    });

  parityTest('the restore quarantine expires every OAuth token and code of every client and keeps the rows, so the next sweep removes them',
    { methods: ['insertOauthClient', 'insertOauthToken', 'insertOauthCode', 'readOauthCodeForUpdate', 'readOauthRefreshTokenForUpdate', 'readOauthCodeChallenge', 'expireAllOauthCredentials', 'deleteExpiredOauthCredentials'] }, async (engine) => {
      const now = Math.floor(Date.now() / 1000);
      for (const id of ['oc-qa', 'oc-qb']) await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read', client_id_issued_at: 1_700_000_000 });
      await engine.insertOauthCode({ code_hash: hashToken('qcode-a'), client_id: 'oc-qa', scopes: ['read'], code_challenge: CHALLENGE, code_challenge_method: 'S256',
        redirect_uri: REDIRECT, state: null, resource: null, expires_at: now + 600 });
      await engine.insertOauthCode({ code_hash: hashToken('qcode-b'), client_id: 'oc-qb', scopes: ['read'], code_challenge: CHALLENGE, code_challenge_method: 'S256',
        redirect_uri: REDIRECT, state: 'st', resource: null, expires_at: now + 600 });
      const token = (name: string, client: string, type: 'access' | 'refresh', expires: number | null) => engine.insertOauthToken({
        token_hash: hashToken(name), token_type: type, client_id: client, scopes: ['read'],
        // The column is nullable (a token that never expires); the insert type is narrower, and the quarantine must expire that one too.
        expires_at: expires as number, resource: null, created_at: now });
      await token('qtok-a', 'oc-qa', 'access', now + 3600);
      await token('qtok-r', 'oc-qb', 'refresh', now + 86_400);
      await token('qtok-never', 'oc-qa', 'access', null);
      const code = async (name: string, client: string) => (await engine.readOauthCodeForUpdate(hashToken(name), client))?.expires_at;
      const out: Record<string, unknown> = {};
      // Each arm reads its own clock, so a live expiry is compared as seconds from that arm's `now`, not as a time.
      const liveA = await code('qcode-a', 'oc-qa');
      out.before = { aFromNow: liveA == null ? liveA : Number(liveA) - now, live: await engine.readOauthCodeChallenge(hashToken('qcode-a'), 'oc-qa', now) };
      out.expired = await engine.expireAllOauthCredentials();
      out.after = {
        a: await code('qcode-a', 'oc-qa'), b: await code('qcode-b', 'oc-qb'),
        refresh: (await engine.readOauthRefreshTokenForUpdate(hashToken('qtok-r'), 'oc-qb'))?.expires_at,
        challenge: await engine.readOauthCodeChallenge(hashToken('qcode-a'), 'oc-qa', now),
      };
      out.swept = await engine.deleteExpiredOauthCredentials(now);
      out.again = await engine.expireAllOauthCredentials();
      // Not vacuous: each code and token is still there with expires_at 0, and one sweep then removes all five rows.
      if (out.swept !== 5 || (out.after as { a: unknown }).a !== 0 || (out.before as { aFromNow: unknown }).aFromNow !== 600) {
        throw new Error(`quarantine: ${JSON.stringify(out)}`);
      }
      return out;
    });

  parityTest('the grant members on one transaction: the client lock read, a code read and deleted by its own client only, a token pair written all or none',
    { methods: ['insertOauthClient', 'readOauthClientForUpdate', 'insertOauthCode', 'readOauthCodeForUpdate', 'deleteOauthCode', 'issueOauthTokens', 'readOauthAccessTokenRows', 'transaction'] }, async (engine) => {
      const now = Math.floor(Date.now() / 1000);
      for (const id of ['oc-tx', 'oc-tx-other']) await engine.insertOauthClient({ client_id: id, client_name: id, scope: 'read', client_id_issued_at: 1_700_000_000 });
      const token = (name: string, type: 'access' | 'refresh') => ({ token_hash: hashToken(name), token_type: type, client_id: 'oc-tx', scopes: ['read'], expires_at: now + 60, resource: null, created_at: now });
      const out: Record<string, unknown> = {};
      out.inside = await engine.transaction(async tx => {
        const locked = await tx.readOauthClientForUpdate('oc-tx');
        const none = await tx.readOauthClientForUpdate('nobody');
        await tx.insertOauthCode({ code_hash: hashToken('code-tx'), client_id: 'oc-tx', scopes: ['read', 'write'], code_challenge: CHALLENGE, code_challenge_method: 'S256',
          redirect_uri: REDIRECT, state: 'st', resource: 'https://r.example/', expires_at: now + 600 });
        const row = await tx.readOauthCodeForUpdate(hashToken('code-tx'), 'oc-tx');
        const stranger = await tx.readOauthCodeForUpdate(hashToken('code-tx'), 'oc-tx-other');
        await tx.deleteOauthCode(hashToken('code-tx'), 'oc-tx-other');
        const kept = await tx.readOauthCodeForUpdate(hashToken('code-tx'), 'oc-tx');
        await tx.deleteOauthCode(hashToken('code-tx'), 'oc-tx');
        const gone = await tx.readOauthCodeForUpdate(hashToken('code-tx'), 'oc-tx');
        await tx.issueOauthTokens([token('tx-access', 'access'), token('tx-refresh', 'refresh')]);
        return { client: locked?.client_id, none, row: row && { client_id: row.client_id, scopes: row.scopes, method: row.code_challenge_method, redirect: row.redirect_uri,
          state: row.state, resource: row.resource, expiresAt: row.expires_at - now, created: row.created_at instanceof Date }, stranger, kept: kept !== null, gone };
      });
      const rows = async (name: string) => (await engine.readOauthAccessTokenRows(hashToken(name), 0)).length;
      out.written = { access: await rows('tx-access'), refresh: await rows('tx-refresh') };
      out.repeated = await refusal(() => engine.transaction(tx => tx.issueOauthTokens([token('tx-new', 'access'), token('tx-access', 'refresh')])));
      out.noClient = await refusal(() => engine.transaction(tx => tx.issueOauthTokens([token('tx-new2', 'access'), { ...token('tx-new3', 'access'), client_id: 'nobody' }])));
      // All or none: the first row of each refused pair is not left behind.
      out.left = { new: await rows('tx-new'), new2: await rows('tx-new2') };
      if (out.written && (out.written as { access: number }).access !== 1) throw new Error(`issueOauthTokens wrote nothing: ${JSON.stringify(out)}`);
      return out;
    });

  parityTest('two grants for one client at the same time both finish and both tokens exist',
    { methods: ['insertOauthClient', 'readOauthClientForUpdate', 'issueOauthTokens', 'readOauthAccessTokenRows'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'oc-two', client_name: 'two', scope: 'read', grant_types: ['client_credentials'],
        client_secret_hash: hashToken('secret'), client_secret_expires_at: 0, client_id_issued_at: 1_700_000_000 });
      const grants = grantsFor(engine);
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error('two concurrent grants did not finish in 20s')), 20_000).unref());
      const [a, b] = await Promise.race([Promise.all([grants.clientCredentials('oc-two', 'secret'), grants.clientCredentials('oc-two', 'secret')]), timeout]);
      const rows = async (t: { access_token: string }) => (await engine.readOauthAccessTokenRows(hashToken(t.access_token), 0)).length;
      const out = { distinct: a.access_token !== b.access_token, a: await rows(a), b: await rows(b), scope: a.scope };
      if (!out.distinct || out.a !== 1 || out.b !== 1) throw new Error(`concurrent grants: ${JSON.stringify(out)}`);
      return out;
    });

  parityTest('insertOauthToken refuses a repeated token hash (23505) and a client with no row (23503) and leaves no row',
    { methods: ['insertOauthClient', 'insertOauthToken', 'readOauthAccessTokenRows'] }, async (engine) => {
      await engine.insertOauthClient({ client_id: 'oc-a', client_name: 'A', scope: 'read' });
      const now = Math.floor(Date.now() / 1000);
      const row = (hash: string, clientId: string) => ({ token_hash: hashToken(hash), token_type: 'access' as const, client_id: clientId, scopes: ['read'], expires_at: now + 60, resource: null, created_at: now, grant_type: 'client_credentials' as const });
      const out: Record<string, unknown> = {};
      out.first = await refusal(() => engine.insertOauthToken(row('t1', 'oc-a')));
      out.repeated = await refusal(() => engine.insertOauthToken(row('t1', 'oc-a')));
      out.noClient = await refusal(() => engine.insertOauthToken(row('t2', 'nobody')));
      out.repeatedNoClient = await refusal(() => engine.insertOauthToken(row('t1', 'nobody')));
      out.rows = { t1: (await engine.readOauthAccessTokenRows(hashToken('t1'), 0)).length, t2: (await engine.readOauthAccessTokenRows(hashToken('t2'), 0)).length };
      return out;
    });

  parityTest('bearer check on a legacy-shape token: serve --http authenticates it with its permissions grant and converts the row once, one more grant revision',
    { methods: ['insertAccessToken', 'readActiveAccessTokenByHash', 'convertLegacyAccessTokenGrant'] }, async (engine) => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
      const plain = await insert(engine, 'plain-old', 'tok-plain-old', { source_grant: null, permissions: { source_id: 'default' } });
      const wide = await insert(engine, 'wide-old', 'tok-wide-old', { source_grant: null, scopes: ['read', 'write'],
        permissions: { source_id: 'default', federated_read: ['default', 'wiki'], takes_holders: ['world', 'alice-example'] } });
      const names = new Map([[plain.id, 'plain'], [wide.id, 'wide']]);
      const row = async (token: string) => {
        const r = (await engine.readActiveAccessTokenByHash(hashToken(token), 'provider'))!;
        return { source_grant: r.source_grant, source_id: r.source_id, federated_read: r.federated_read, allowed_operations: r.allowed_operations,
          takes_holders: r.takes_holders, grant_revision: Number(r.grant_revision), lastUsed: r.last_used_at ? 'set' : 'null' };
      };
      const verify = async (token: string) => {
        const { expiresAt, createdAt, principal, ...rest } = await provider.verifyAccessToken(token) as unknown as Record<string, unknown>;
        const p = principal as { kind: string; id: string };
        return { ...rest, principal: { kind: p.kind, id: names.get(p.id) ?? p.id }, hasExpiry: expiresAt != null, hasCreatedAt: createdAt != null };
      };
      const out: Record<string, unknown> = {};
      out.before = { plain: await row('tok-plain-old'), wide: await row('tok-wide-old') };
      out.firstPlain = await verify('tok-plain-old');
      out.firstWide = await verify('tok-wide-old');
      out.converted = { plain: await row('tok-plain-old'), wide: await row('tok-wide-old') };
      out.secondPlain = await verify('tok-plain-old');
      out.again = { plain: await row('tok-plain-old'), wide: await row('tok-wide-old') };
      out.convertsOnce = await engine.convertLegacyAccessTokenGrant(plain.id,
        { source_grant: 'all', source_id: null, federated_read: null, allowed_operations: null, takes_holders: null });
      // Not vacuous: each row starts on the legacy shape and the first check converts it with one more revision.
      const before = out.before as Record<string, { source_grant: unknown; grant_revision: number }>;
      const converted = out.converted as Record<string, { source_grant: unknown; grant_revision: number }>;
      for (const k of ['plain', 'wide']) {
        if (before[k].source_grant !== null || converted[k].source_grant === null || converted[k].grant_revision !== before[k].grant_revision + 1) {
          throw new Error(`${k} not converted: ${JSON.stringify(out)}`);
        }
      }
      if (JSON.stringify(out.firstPlain) !== JSON.stringify(out.secondPlain)) throw new Error('the converted row authorizes differently');
      return out;
    });
  parityTest('a token bound to a member: the bearer check carries the live member and its groups, and refuses a token whose member is disabled or removed; a binding is read, written and cleared by id, revoked or not',
    { methods: ['insertAccessToken', 'insertAccessMember', 'setAccessMemberDisabled', 'tombstoneAccessMember', 'readCredentialBindingForUpdate', 'writeCredentialBinding',
      'writeCredentialReadsUnscoped', 'readAccessMembers', 'readLiveMember', 'readActiveAccessTokenByHash', 'revokeAccessToken', 'readScopeSourceConfigs'] }, async (engine, backend) => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
      await engine.insertAccessMember({ id: 'alice-example', displayName: null, email: null, kind: 'person', groups: ['team-a'], bindTokenId: null });
      await engine.insertAccessMember({ id: 'bob-example', displayName: null, email: null, kind: 'person', groups: [], bindTokenId: null });
      await createSource(engine, backend, 'scope-a');
      const alice = await insert(engine, 'alice-tok', 'tok-alice');
      const bob = await insert(engine, 'bob-tok', 'tok-bob');
      const plain = await insert(engine, 'plain-tok', 'tok-plain');
      const retired = await insert(engine, 'retired-tok', 'tok-retired');
      const names = new Map([[alice.id, 'alice-tok'], [bob.id, 'bob-tok'], [plain.id, 'plain-tok'], [retired.id, 'retired-tok']]);
      const verify = async (token: string) => {
        try {
          const { expiresAt, createdAt, principal, ...rest } = await provider.verifyAccessToken(token) as unknown as Record<string, unknown>;
          const p = principal as { kind: string; id: string };
          return { ...rest, principal: { kind: p.kind, id: names.get(p.id) ?? p.id } };
        } catch (error) {
          if ((error as { code?: unknown }).code === 'engine_capability_missing') throw error;
          return { refused: (error as Error).constructor.name, message: (error as Error).message };
        }
      };
      const binding = async (id: string, readsUnscoped = true) => {
        const row = await engine.transaction(tx => tx.readCredentialBindingForUpdate({ kind: 'token', id }, { readsUnscoped }));
        return row && { ...row, ...(readsUnscoped ? { reads_unscoped: row.reads_unscoped == null ? null : 'set' } : {}) };
      };
      const out: Record<string, unknown> = {};
      out.missing = { binding: await binding('00000000-0000-4000-8000-00000000dead'), live: await engine.readLiveMember('legacy_token', '00000000-0000-4000-8000-00000000dead') };
      out.before = { alice: await binding(alice.id), bearer: await verify('tok-alice') };
      out.bound = {
        alice: await bindCredential(engine, { kind: 'token', id: alice.id }, { member: 'alice-example', mayActFor: ['alice-example'], readsUnscoped: true }),
        bob: await bindCredential(engine, { kind: 'token', id: bob.id }, { member: 'bob-example' }),
        retired: await bindCredential(engine, { kind: 'token', id: retired.id }, { member: 'alice-example' }),
      };
      out.afterBind = { alice: await binding(alice.id), bob: await binding(bob.id, false), plain: await binding(plain.id) };
      out.bearerLive = { alice: await verify('tok-alice'), bob: await verify('tok-bob'), plain: await verify('tok-plain') };
      out.row = await (async () => {
        const r = (await engine.readActiveAccessTokenByHash(hashToken('tok-alice'), 'provider'))!;
        return { member_id: r.member_id, may_act_for: r.may_act_for, reads_unscoped: r.reads_unscoped ? 'set' : null };
      })();
      out.listed = (await engine.listAccessTokens()).map(t => [names.get(t.id), t.member_id]).sort();
      out.live = { alice: await engine.readLiveMember('legacy_token', alice.id), plain: await engine.readLiveMember('legacy_token', plain.id) };
      await engine.setAccessMemberDisabled('bob-example', true);
      out.bobDisabled = { bearer: await verify('tok-bob'), live: await engine.readLiveMember('legacy_token', bob.id), bobsTokenStillBound: (await binding(bob.id, false))?.member_id };
      await engine.setAccessMemberDisabled('bob-example', false);
      out.bobBack = await verify('tok-bob');
      await revokeLegacyTokenById(engine, retired.id);
      out.retired = { bearer: await verify('tok-retired'), live: await engine.readLiveMember('legacy_token', retired.id), binding: (await binding(retired.id, false))?.member_id };
      out.rebound = await bindCredential(engine, { kind: 'token', id: retired.id }, { member: null });
      await engine.tombstoneAccessMember('alice-example');
      out.aliceRemoved = { bearer: await verify('tok-alice'), live: await engine.readLiveMember('legacy_token', alice.id) };
      out.cleared = {
        alice: await bindCredential(engine, { kind: 'token', id: alice.id }, { member: null, mayActFor: null, readsUnscoped: false }),
        binding: await binding(alice.id), bearer: await verify('tok-alice'),
      };
      // The attest right: a token with no member lists the scope sources it may write, and the mark commits with the binding.
      out.attest = await bindCredential(engine, { kind: 'token', id: plain.id }, { attestActor: 'qm', attestOps: ['memory_write'], attestSources: ['scope-a'] });
      out.attested = { binding: await binding(plain.id), scope: (await engine.readScopeSourceConfigs(['scope-a']))[0]?.config, bearer: await verify('tok-plain') };
      // `gbrain access member add --bind-token` binds the token in the member's own write; an id no token has binds nothing.
      const carol = await insert(engine, 'carol-tok', 'tok-carol');
      names.set(carol.id, 'carol-tok');
      await addMember(engine, 'carol-example', { bindToken: 'carol-tok' });
      await engine.insertAccessMember({ id: 'dave-example', displayName: null, email: null, kind: 'person', groups: [], bindTokenId: '00000000-0000-4000-8000-00000000dead' });
      out.memberAdd = { carol: (await binding(carol.id, false))?.member_id, bearer: await verify('tok-carol'), dave: (await engine.readAccessMembers({ id: 'dave-example' })).length };
      // Not vacuous: the live member authenticates with its identity, and the disabled and removed members' tokens are refused.
      const live = out.bearerLive as Record<string, Record<string, unknown>>;
      if ('refused' in live.alice! || !live.alice!.member) throw new Error(`the bound token carries no member: ${JSON.stringify(live.alice)}`);
      if (!('refused' in (out.bobDisabled as { bearer: object }).bearer) || !('refused' in (out.aliceRemoved as { bearer: object }).bearer)) throw new Error('a token of a disabled or removed member authenticated');
      return out;
    });
  parityTest('bearer check stamps last_used_at: null before, set after, unchanged by a second check inside 60 seconds; the unified stamp leaves a row with no source_grant alone',
    { methods: ['insertAccessToken', 'listAccessTokens', 'readActiveAccessTokenByHash', 'touchAccessTokenLastUsed'] }, async (engine) => {
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), engine });
      const seen = await insert(engine, 'seen', 'tok-seen');
      const old = await insert(engine, 'old', 'tok-old', { source_grant: null });
      const lastUsed = async (id: string) => (await engine.listAccessTokens()).find(r => r.id === id)!.last_used_at;
      const state = (v: Date | null) => (v ? 'set' : 'null');
      const settle = async () => { for (let i = 0; i < 100 && !(await lastUsed(seen.id)); i++) await new Promise(r => setTimeout(r, 20)); };
      const out: Record<string, unknown> = {};
      out.before = state(await lastUsed(seen.id));
      out.beforeByHash = state((await engine.readActiveAccessTokenByHash(hashToken('tok-seen'), 'transport'))!.last_used_at as Date | null);
      await provider.verifyAccessToken('tok-seen');
      await settle();
      const first = await lastUsed(seen.id);
      out.afterFirst = state(first);
      await provider.verifyAccessToken('tok-seen');
      await new Promise(r => setTimeout(r, 150));
      const second = await lastUsed(seen.id);
      out.afterSecond = state(second);
      out.unchangedBySecond = first?.getTime() === second?.getTime();
      out.byHash = state((await engine.readActiveAccessTokenByHash(hashToken('tok-seen'), 'provider'))!.last_used_at as Date | null);
      out.byHashIsDate = (await engine.readActiveAccessTokenByHash(hashToken('tok-seen'), 'provider'))!.last_used_at instanceof Date;
      await engine.touchAccessTokenLastUsed(old.id, true);
      out.unifiedLeavesLegacyShape = state(await lastUsed(old.id));
      await engine.touchAccessTokenLastUsed(old.id, false);
      out.legacyStamps = state(await lastUsed(old.id));
      if (out.afterFirst !== 'set' || out.before !== 'null' || out.unchangedBySecond !== true) throw new Error(`last_used_at: ${JSON.stringify(out)}`);
      return out;
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

  // An agent job's legacy token that opted out with --reads-unscoped reads unscoped: the requester-scope gate lets its
  // unbound reads through. A store that answers the opt-out as not kept refuses that token's reads.
  parityTest('the requester-scope read of a legacy token that opted out with --reads-unscoped reads the stored opt-out, and a cleared one reads not opted out',
    { methods: ['insertAccessToken', 'writeCredentialReadsUnscoped', 'readLiveAccessTokenScope'] }, async (engine) => {
      const token = await mintLegacyToken(engine, { name: 'unscoped-agent', scopes: ['read'], takesHolders: ['world'] });
      const target = { kind: 'token' as const, id: token.id };
      const scope = async () => {
        const auth = await credentialScopeFor(engine, { clientName: 'agent', scopes: ['read'], principal: { kind: 'legacy_token', id: token.id } } as never) as
          { readsUnscoped: boolean; createdAt: number | null };
        const row = await engine.readLiveAccessTokenScope(token.id);
        return { readsUnscoped: auth.readsUnscoped, created: auth.createdAt !== null,
          stored: row === null ? 'no row' : row.reads_unscoped instanceof Date ? 'a time' : row.reads_unscoped };
      };
      const minted = await scope();
      await engine.writeCredentialReadsUnscoped(target, true);
      const optedOut = await scope();
      await engine.writeCredentialReadsUnscoped(target, false);
      const cleared = await scope();
      expect(minted).toEqual({ readsUnscoped: false, created: true, stored: null });
      expect(optedOut).toEqual({ readsUnscoped: true, created: true, stored: 'a time' });
      expect(cleared).toEqual(minted);
      return { minted, optedOut, cleared };
    });

  // A remote page write in the default source by a legacy token bound to a member is that member's page (GST-2059); an
  // unbound or missing token writes a shared page.
  parityTest('the default-source member read of a legacy token\'s write answers the stored member, and no member for an unbound or missing token',
    { methods: ['insertAccessToken', 'insertAccessMember', 'writeCredentialBinding', 'readCredentialMemberId'] }, async (engine) => {
      await engine.insertAccessMember({ id: 'alice-example', displayName: null, email: null, kind: 'person', groups: [], bindTokenId: null });
      const bound = await mintLegacyToken(engine, { name: 'bound-writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      const unbound = await mintLegacyToken(engine, { name: 'unbound-writer', scopes: ['read', 'write'], takesHolders: ['world'] });
      await bindCredential(engine, { kind: 'token', id: bound.id }, { member: 'alice-example' });
      const writer = (id: string) => defaultSourceMemberWriter(engine, { remote: true, principal: { kind: 'legacy_token', id }, sourceId: 'default' } as never);
      const out = { bound: await writer(bound.id), unbound: await writer(unbound.id), missing: await writer('00000000-0000-4000-8000-000000000000') };
      expect(out).toEqual({ bound: 'member:alice-example', unbound: null, missing: null });
      return out;
    });
});
