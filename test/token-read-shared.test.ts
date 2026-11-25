/**
 * GST-2898 (company brains A to D): a member key that writes to one source and reads every shared source, now and
 * later (`--read-shared on`).
 * 1. Protects: a switched key reads its write source plus `default` and every federated source, including one
 *    federated after it was minted, and writes only to its write source (a write naming a shared source refuses
 *    permission_denied and names the one writable source). It never reads a guest source or, unless bound to the
 *    owner, another member's own source; page labels (readable_by) and private pages still apply; a deny-all grant
 *    stays deny-all with the switch on; an older build's grant write turns the switch off.
 * 2. Owner pin: every existing grant shape (no list, explicit list, none, drift, clients) resolves to the same sources
 *    with the switch off as before this change, and the migration rewrites no row; since GST-3747 a no-list key bound to
 *    a member other than the owner also drops other members' personal sources.
 * 3. Fails when: a switched key loses a shared source, reads a guest or another member's source, widens a deny-all
 *    grant, or an unswitched key's read set changes.
 * 4. Real seams: tokens and clients minted by the token and grant services, verified by the serve --http verifier
 *    (GBrainOAuthProvider), dispatched through MCP dispatch with remote=true on a repo-less brain, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { engineOfSqlQuery, sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { accessCheck } from '../src/commands/access.ts';
import { authSourcesFromGrant, grantFromClient, grantFromTokenRow } from '../src/core/grants/model.ts';
import { rescopeLegacyToken, parseRescopeTokenArgs } from '../src/core/grants/legacy-token.ts';
import { readsChangeLines } from '../src/commands/auth-read-shared.ts';
import { readClientGrant, rescopeClientGrant } from '../src/core/grants/service.ts';
import { mutateClientLifecycle } from '../src/core/grants/lifecycle.ts';
import { credentialReadSources } from '../src/core/grants/shared-exposure.ts';
import { clientReadShared, expandReadShared, sourceReadsFor, tokenReadSources } from '../src/core/grants/read-shared.ts';
import { accessPolicyNotices } from '../src/core/access/policy-notice.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const OWNER = 'owner-example';
const PRIVATE_ALICE = 'private-alice-example';
const PRIVATE_BOB = 'private-bob-example';
const page = (title: string, canary: string, fm: string[] = []) =>
  ['---', 'type: note', 'title: ' + title, ...fm, '---', '# ' + title, '', 'Harbor ledger notes ' + canary + '.'].join('\n');
const CANARY = { handbook: 'rsharedhandbook', roadmap: 'rsharedroadmap', guest: 'rsharedguest', bob: 'rsharedbob', labelled: 'rsharedlabelled', private: 'rsharedprivate', later: 'rsharedlater', own: 'rsharedown' };

for (const kind of testBackends()) {
  describe('read-shared switch (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, { token: string; id: string }> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;

    async function call(auth: AuthInfo, op: string, params: Record<string, unknown>) {
      const sourceId = auth.sourceId ?? 'default';
      const localFederatedSourceIds = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'],
        ...(localFederatedSourceIds ? { localFederatedSourceIds } : {}) });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json };
    }
    /** Which canaries `who` reads through get_page (naming the source) and an unqualified keyword search. */
    async function seen(who: string): Promise<string[]> {
      const auth = await verify(who);
      const out: string[] = [];
      for (const [key, slug, source] of [['handbook', 'wiki/team-handbook', 'company'], ['roadmap', 'wiki/roadmap', 'team'], ['guest', 'notes/guest-note', 'guests'],
        ['bob', 'notes/bob-own', PRIVATE_BOB], ['labelled', 'wiki/leadership', 'company'], ['private', 'wiki/private-plan', 'company']] as const) {
        const got = await call(auth, 'get_page', { slug, source_id: source });
        const search = await call(auth, 'search', { query: CANARY[key], match: 'keyword', fields: 'full', limit: 20 });
        if (got.text.includes(CANARY[key] + '.') || search.text.includes(CANARY[key])) out.push(key);
      }
      return out.sort();
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('company', 'company', '{"federated": true}'::jsonb), ('team', 'team', '{"federated": true}'::jsonb),
        ($1, $1, '{"federated": false}'::jsonb), ($2, $2, '{"federated": true}'::jsonb), ('guests', 'guests', '{"federated": true}'::jsonb),
        ('later', 'later', '{}'::jsonb) ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`, [PRIVATE_ALICE, PRIVATE_BOB]);
      for (const id of [OWNER, 'alice-example', 'bob-example', 'carol-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await engine.executeRaw('INSERT INTO access_member_sources (member_id, source_id) VALUES ($1, $2)', ['bob-example', PRIVATE_BOB]);
      await importFromContent(engine, 'wiki/team-handbook', page('Team handbook', CANARY.handbook), { sourceId: 'company' });
      await importFromContent(engine, 'wiki/leadership', page('Leadership', CANARY.labelled, ['readable_by: [alice-example, bob-example]']), { sourceId: 'company' });
      await importFromContent(engine, 'wiki/private-plan', page('Private plan', CANARY.private, ['visibility: private']), { sourceId: 'company' });
      await importFromContent(engine, 'wiki/roadmap', page('Roadmap', CANARY.roadmap), { sourceId: 'team' });
      await importFromContent(engine, 'notes/guest-note', page('Guest note', CANARY.guest), { sourceId: 'guests' });
      // The note lands first: a guest source admits only its listed writers once it is one.
      await engine.executeRaw(`UPDATE sources SET config = '{"federated": true, "guest": true}'::jsonb WHERE id = 'guests'`);
      await engine.executeRaw("INSERT INTO guest_sources (source_id) VALUES ('guests') ON CONFLICT DO NOTHING");
      await importFromContent(engine, 'notes/bob-own', page('Bob own', CANARY.bob), { sourceId: PRIVATE_BOB });
      await importFromContent(engine, 'notes/later-page', page('Later', CANARY.later), { sourceId: 'later' });
      await importFromContent(engine, 'notes/alice-own', page('Alice own', CANARY.own), { sourceId: PRIVATE_ALICE });
      const mint = async (name: string, member: string | null, sourceGrant?: string[], readShared = false) => {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], ...(sourceGrant ? { sourceGrant } : {}), ...(readShared ? { readShared } : {}) });
        tokens[name] = minted;
        if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
        else await readsUnscopedOnPurpose(engine, minted.id);
      };
      await mint('alice', 'alice-example', [PRIVATE_ALICE], true);
      await mint('alice-off', 'alice-example', [PRIVATE_ALICE]);
      await mint('carol', 'carol-example', [PRIVATE_ALICE], true);
      await mint('owner', OWNER, [PRIVATE_ALICE], true);
      await mint('unbound', null, ['default'], true);
      await mint('floor', 'carol-example');
      await mint('none', 'carol-example', []);
      await setOwner(engine, OWNER);
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('the migration rewrites no row: an existing key reads exactly what its grant listed, and the switch reads as off', async () => {
      const rows = await engine.executeRaw<Record<string, unknown>>("SELECT * FROM access_tokens WHERE name IN ('alice-off', 'floor', 'none')");
      for (const row of rows) {
        expect(row.read_shared_revision ?? null).toBeNull();
        const grant = grantFromTokenRow(row as never);
        expect(grant.readShared).toBe(false);
        const auth = await provider().verifyAccessToken(tokens[String(row.name)]!.token) as unknown as AuthInfo;
        const legacy = authSourcesFromGrant(grant);
        expect({ sourceId: auth.sourceId, allowedSources: auth.allowedSources, hasSourceGrant: auth.hasSourceGrant, readShared: (auth as AuthInfo).readShared })
          .toEqual({ sourceId: legacy.sourceId, allowedSources: legacy.allowedSources, hasSourceGrant: legacy.hasSourceGrant, readShared: undefined });
      }
      expect(await seen('alice-off')).toEqual([]);
      // The floor for a key with no list: default plus every federated source and a guest source; GST-3747: carol's key
      // reads no personal source bound to another member, so bob's own is out.
      expect(await seen('floor')).toEqual(['guest', 'handbook', 'roadmap']);
      expect(await seen('none')).toEqual([]);
    }, 240_000);

    test('a switched member key reads company and team, never a guest source or another member\'s own source, and labels still apply', async () => {
      const auth = await verify('alice');
      expect(auth.readShared).toBe(true);
      expect(auth.sourceId).toBe(PRIVATE_ALICE);
      expect(auth.allowedSources).toEqual([PRIVATE_ALICE, 'default', 'company', 'team']);
      expect(await seen('alice')).toEqual(['handbook', 'labelled', 'roadmap']);
      expect(await seen('carol')).toEqual(['handbook', 'roadmap']);
      expect((await call(auth, 'get_page', { slug: 'notes/alice-own' })).text).toContain(CANARY.own + '.');
    }, 240_000);

    test('the owner\'s switched key reads another member\'s federated own source and the private page; a key bound to no member is not excluded either', async () => {
      // readable_by [alice, bob] still keeps the labelled page from the owner (access.owner_reads_restricted is off).
      expect(await seen('owner')).toEqual(['bob', 'handbook', 'private', 'roadmap']);
      expect((await verify('unbound')).allowedSources).toEqual(['default', 'company', PRIVATE_BOB, 'team']);
    }, 240_000);

    test('private pages stay explicit: --private-pages granted-sources with the switch opens no private page in a shared source', async () => {
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['alice', '--private-pages', 'granted-sources']));
      const auth = await verify('alice');
      expect(auth.privatePages?.sources).toEqual([PRIVATE_ALICE]);
      expect(await seen('alice')).not.toContain('private');
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['alice', '--private-pages', 'none']));
    }, 240_000);

    test('a source federated later is read on the next call, with no re-grant', async () => {
      const before = await verify('alice');
      expect(before.allowedSources).not.toContain('later');
      await engine.executeRaw(`UPDATE sources SET config = '{"federated": true}'::jsonb WHERE id = 'later'`);
      const after = await verify('alice');
      expect(after.allowedSources).toContain('later');
      const got = await call(after, 'get_page', { slug: 'notes/later-page', source_id: 'later' });
      expect(got.text).toContain(CANARY.later + '.');
      expect((await verify('alice-off')).allowedSources).toEqual([PRIVATE_ALICE]);
      await engine.executeRaw(`UPDATE sources SET config = '{}'::jsonb WHERE id = 'later'`);
    }, 240_000);

    test('writes stay in the write source: naming a shared source refuses and names the one writable source', async () => {
      const auth = await verify('alice');
      const put = await call(auth, 'put_page', { slug: 'notes/alice-note-' + randomUUID().slice(0, 8), content: page('Alice note', 'rsharedwrite'), source_id: 'company', request_id: randomUUID() });
      expect(put.isError).toBe(true);
      expect(put.text).toContain('permission_denied');
      expect(put.text).toContain('This connection reads company but writes only to ' + PRIVATE_ALICE);
      expect(put.json.writable_source_ids ?? (put.json.error as Record<string, unknown> | undefined)?.writable_source_ids).toEqual([PRIVATE_ALICE]);
      const slug = 'notes/alice-note-' + randomUUID().slice(0, 8);
      const ok = await call(auth, 'put_page', { slug, content: page('Alice note', 'rsharedwrite2'), request_id: randomUUID() });
      expect(ok.isError).toBe(false);
      const [row] = await engine.executeRaw<{ source_id: string }>('SELECT source_id FROM pages WHERE slug = $1 AND deleted_at IS NULL', [slug]);
      expect(row?.source_id).toBe(PRIVATE_ALICE);
      const remember = await call(auth, 'remember', { fact: 'Acme-example renewed', entity: 'companies/acme-example', source_id: 'company', provenance: 'test' });
      expect(remember.isError).toBe(true);
      expect(remember.text).toContain('This connection reads company but writes only to ' + PRIVATE_ALICE);
    }, 240_000);

    test('deny-all stays deny-all: none and drifted grants read nothing with the switch on', async () => {
      await engine.executeRaw("UPDATE access_tokens SET read_shared_revision = grant_revision WHERE name = 'none'");
      expect((await verify('none')).allowedSources).toEqual([]);
      await mint2('drift', [PRIVATE_ALICE]);
      await engine.executeRaw(`UPDATE access_tokens SET permissions = jsonb_set(permissions, '{source_id}', '"company"'::jsonb) WHERE name = 'drift'`);
      expect((await verify('drift')).allowedSources).toEqual([]);
      expect(await credentialReadSources(engine, grantFromTokenRow((await engine.executeRaw<Record<string, unknown>>("SELECT * FROM access_tokens WHERE name = 'drift'"))[0] as never), 'carol-example')).toEqual([]);
    }, 240_000);

    async function mint2(name: string, sourceGrant: string[]) {
      tokens[name] = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant, readShared: true });
      await bindCredential(engine, { kind: 'token', id: tokens[name]!.id }, { member: 'carol-example' });
    }

    test('an older build\'s grant write (revision bumped, column untouched) turns the switch off: the key reads its stored list only', async () => {
      await mint2('old-build', [PRIVATE_ALICE]);
      expect((await verify('old-build')).allowedSources).toContain('company');
      await engine.executeRaw("UPDATE access_tokens SET grant_revision = grant_revision + 1 WHERE name = 'old-build'");
      const auth = await verify('old-build');
      expect(auth.allowedSources).toEqual([PRIVATE_ALICE]);
      expect(auth.readShared).toBeUndefined();
    }, 240_000);

    test('rescope: --read-shared on keeps it across later grant edits; narrowing an unscoped key lists what it stops reading; none refuses the switch', async () => {
      await mint2('rescope-me', [PRIVATE_ALICE]);
      const narrowed = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['floor', '--sources', PRIVATE_ALICE]));
      expect(narrowed.reads.stops_reading).toEqual(expect.arrayContaining(['company', 'team', 'guests']));
      const hint = (r: typeof narrowed, target: string) => readsChangeLines(r.reads, r.before.readShared === true, r.after.readShared === true, target).some(l => l.includes('Add --read-shared on'));
      expect(hint(narrowed, '--token floor')).toBe(true);
      const kept = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['rescope-me', '--takes-holders', 'world']));
      expect(kept.after.readShared).toBe(true);
      expect((await verify('rescope-me')).allowedSources).toContain('company');
      const off = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['rescope-me', '--read-shared', 'off']));
      expect(off.reads.stops_reading).toEqual(['default', 'company', 'team']);
      expect((await verify('rescope-me')).allowedSources).toEqual([PRIVATE_ALICE]);
      const on = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['rescope-me', '--read-shared', 'on']));
      expect(on.reads.shared_now).toEqual(['default', 'company', 'team']);
      const narrowing = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['rescope-me', '--sources', 'none'])).then(() => null, (e: Error & { reasons?: string[] }) => e);
      expect(narrowing?.reasons).toEqual(['read_shared_needs_source']);
      const narrowText = narrowing!.message;
      const [offRoute, revokeRoute, widenRoute] = ['gbrain auth rescope --token rescope-me --sources none --read-shared off', 'gbrain auth revoke "rescope-me"', '--sources <write-source>'].map(s => narrowText.indexOf(s));
      expect({ offRoute: offRoute >= 0, revokeRoute: revokeRoute > offRoute, widenLast: widenRoute > revokeRoute }).toEqual({ offRoute: true, revokeRoute: true, widenLast: true });
      const narrowed2 = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['rescope-me', '--sources', 'none', '--read-shared', 'off']));
      expect({ readShared: narrowed2.after.readShared === true, reads: (await verify('rescope-me')).allowedSources }).toEqual({ readShared: false, reads: [] });
      expect(narrowed2.reads.stops_reading.length).toBeGreaterThan(0);
      expect(hint(narrowed2, '--token rescope-me')).toBe(false);
      expect(() => parseRescopeTokenArgs(['rescope-me', '--read-shared', 'yes'])).toThrow('--read-shared must be on or off');
    }, 240_000);

    test('rescope never stores the switch on a key with no source list: on refuses, a reset to default clears it, and a later narrowing stays off', async () => {
      const unlisted = await mintLegacyToken(engine, { name: 'unlisted', scopes: ['read', 'write'], takesHolders: ['world'] });
      await bindCredential(engine, { kind: 'token', id: unlisted.id }, { member: 'carol-example' });
      await expect(rescopeLegacyToken(engine, parseRescopeTokenArgs(['unlisted', '--read-shared', 'on']))).rejects.toMatchObject({ reasons: ['read_shared_needs_source'] });
      await mint2('reset-me', [PRIVATE_ALICE]);
      const reset = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['reset-me', '--reset-default', 'sources']));
      expect(reset.after.readShared).not.toBe(true);
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['reset-me', '--sources', PRIVATE_ALICE]));
      expect((await verify('reset-me')).allowedSources).toEqual([PRIVATE_ALICE]);
    }, 240_000);

    test('OAuth clients: a switched client reads the shared set after its active-source filter; invalidating tokens keeps the switch', async () => {
      const registered = await provider().registerClientManual('client-alice-example', ['client_credentials'], 'read', [], PRIVATE_ALICE);
      await bindCredential(engine, { kind: 'client', id: registered.clientId }, { member: 'alice-example' });
      const token = async () => await provider().verifyAccessToken((await provider().exchangeClientCredentials(registered.clientId, registered.clientSecret!)).access_token) as unknown as AuthInfo;
      expect((await token()).allowedSources).toEqual([PRIVATE_ALICE]);
      const result = await rescopeClientGrant(engine, registered.clientId, { readShared: true }, { actor: 'test' });
      expect(result.after.readShared).toBe(true);
      const auth = await token();
      expect(auth.allowedSources).toEqual([PRIVATE_ALICE, 'default', 'company', 'team']);
      expect(auth.readShared).toBe(true);
      expect(auth.privatePages).toBeUndefined();
      const g = await readClientGrant(engine, registered.clientId);
      await mutateClientLifecycle(engine, registered.clientId, 'invalidate-tokens', { actor: 'test', dryRun: false, yes: true, expectedRevision: g.revision });
      expect((await readClientGrant(engine, registered.clientId)).readShared).toBe(true);
      expect(await credentialReadSources(engine, grantFromClient(await readClientGrant(engine, registered.clientId)), 'alice-example')).toEqual([PRIVATE_ALICE, 'default', 'company', 'team']);
      const clientNarrow = await rescopeClientGrant(engine, registered.clientId, { sourceId: null, sourcesNone: true, federatedRead: [] }, { actor: 'test' }).then(() => null, (e: Error & { reasons?: string[] }) => e);
      expect(clientNarrow?.reasons).toEqual(expect.arrayContaining(['read_shared_needs_source']));
      const clientText = clientNarrow!.message;
      const [cOff, cRevoke, cWiden] = [`gbrain auth rescope --client ${registered.clientId} --sources none --read-shared off`, `gbrain auth revoke-client "${registered.clientId}"`, '--sources <write-source>'].map(s => clientText.indexOf(s));
      expect({ off: cOff >= 0, revoke: cRevoke > cOff, widenLast: cWiden > cRevoke }).toEqual({ off: true, revoke: true, widenLast: true });
      const clientOff = await rescopeClientGrant(engine, registered.clientId, { sourceId: null, sourcesNone: true, federatedRead: [], readShared: false }, { actor: 'test' });
      expect({ none: clientOff.after.sourcesNone, readShared: clientOff.after.readShared === true }).toEqual({ none: true, readShared: false });
    }, 240_000);

    test('consumers see the resolved set: access check, whoami and the census resolver', async () => {
      const check = await accessCheck(engine, { token: 'alice' });
      expect({ read_shared: check.read_shared, reads_now: check.reads_now }).toEqual({ read_shared: true, reads_now: [PRIVATE_ALICE, 'default', 'company', 'team'] });
      const off = await accessCheck(engine, { token: 'alice-off' });
      expect({ read_shared: off.read_shared, reads_now: off.reads_now }).toEqual({ read_shared: false, reads_now: [PRIVATE_ALICE] });
      const who = await call(await verify('alice'), 'whoami', {});
      expect({ write: who.json.write_source, reads: who.json.read_sources, shared: who.json.read_shared }).toEqual({ write: PRIVATE_ALICE, reads: [PRIVATE_ALICE, 'default', 'company', 'team'], shared: true });
    }, 240_000);

    test('the legacy HTTP transport (startHttpTransport) gives a switched key the same read set and write source', async () => {
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
      try {
        const callAs = async (who: string, name: string, args: Record<string, unknown>) => (await fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'POST', headers: { authorization: `Bearer ${tokens[who]!.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
        })).text();
        expect(await callAs('alice', 'get_page', { slug: 'wiki/roadmap', source_id: 'team' })).toContain(CANARY.roadmap + '.');
        expect(await callAs('alice-off', 'get_page', { slug: 'wiki/roadmap', source_id: 'team' })).not.toContain(CANARY.roadmap + '.');
        expect(await callAs('alice', 'get_page', { slug: 'notes/guest-note', source_id: 'guests' })).not.toContain(CANARY.guest + '.');
        const who = await callAs('alice', 'whoami', {});
        expect(who).toContain('write_source');
        expect(who).toContain(PRIVATE_ALICE);
      } finally {
        server.stop(true);
      }
    }, 60_000);

    // GBRA-108 ruling (2026-11-17): GBRA-575's per-key --private-facts switch opens private facts only in sources listed
    // by id on the grant, never in a source reached through --read-shared.
    test('with --private-facts and --read-shared both on, private facts stay closed in every shared source the key reaches', async () => {
      const entity = 'companies/harbor-example';
      const world = '---\ntype: company\ntitle: Harbor Example\n---\n\n# Harbor Example\n\nHarbor company page.\n';
      const FACT = { own: 'rsharedfact own private', shared: 'rsharedfact shared private', world: 'rsharedfact shared world' };
      const fact = (sourceId: string, text: string, visibility: 'private' | 'world') => engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(
        'INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug) VALUES ($1, $2, $3, \'fact\', $4, \'mcp:extract_facts\', $2)', // gbrain-allow-direct-insert: database-only fact fixture
        [sourceId, entity, text, visibility]), TEST_WRITE_ATTRIBUTION));
      for (const sourceId of [PRIVATE_ALICE, 'company']) await importFromContent(engine, entity, world, { sourceId });
      await fact(PRIVATE_ALICE, FACT.own, 'private');
      await fact('company', FACT.shared, 'private');
      await fact('company', FACT.world, 'world');
      await mint2('both-switches', [PRIVATE_ALICE]);
      const rescoped = await rescopeLegacyToken(engine, parseRescopeTokenArgs(['both-switches', '--private-facts', 'granted-sources']));
      expect({ readShared: rescoped.after.readShared, privateFacts: rescoped.after.privateFacts }).toEqual({ readShared: true, privateFacts: 'granted_sources' });
      const auth = await verify('both-switches');
      expect(auth.allowedSources).toEqual([PRIVATE_ALICE, 'default', 'company', 'team']);
      expect(auth.privateFacts).toEqual({ mode: 'granted_sources', sources: [PRIVATE_ALICE] });
      const seenFacts = async (sourceId: string) => {
        __resetPrivateVisibilityCacheForTests();
        const text = (await call(auth, 'recall', { entity, source_id: sourceId })).text;
        return Object.entries(FACT).filter(([, f]) => text.includes(f)).map(([k]) => k);
      };
      expect(await seenFacts(PRIVATE_ALICE)).toEqual(['own']);
      expect(await seenFacts('company')).toEqual(['world']);
    }, 120_000);

    test('with no engine behind the bearer check, a source-granted token fails closed and a switched client reads its stored list, flagged', async () => {
      const plainTag = (async () => []) as unknown as Parameters<typeof sourceReadsFor>[1];
      expect(engineOfSqlQuery(plainTag)).toBeUndefined();
      expect(engineOfSqlQuery(sqlQueryForEngine(engine))).toBe(engine);
      const reads = sourceReadsFor(undefined, plainTag);
      for (const read of [reads.readSharedSourceRows(), reads.listSourceIds(), reads.filterUnarchivedSourceIds(['default'])]) {
        await expect(read).rejects.toThrow('it has none');
      }
      const scalar = { principal: { kind: 'legacy_token', id: 't' }, scopes: ['read'], sources: { kind: 'scalar', writeSource: PRIVATE_ALICE },
        allowedOperations: null, takesHolders: null, privatePages: 'none', privateFacts: 'none', readShared: true } as unknown as Parameters<typeof tokenReadSources>[1];
      await expect(tokenReadSources(reads, scalar, async () => null)).rejects.toThrow('it has none');
      const client = await clientReadShared(reads, { source_grant: 'scalar', read_shared_revision: 2, grant_revision: 2 }, [PRIVATE_ALICE], true, async () => null);
      expect(client).toEqual({ allowedSources: [PRIVATE_ALICE], flags: { readShared: true, readSharedUnresolved: true } });
    });

    test('a sources-table failure keeps the stored list and says so with read_shared_unresolved', async () => {
      const failing = { readSharedSourceRows: async () => { throw new Error('boom'); } };
      expect(await expandReadShared(failing, [PRIVATE_ALICE], 'alice-example')).toEqual({ sources: [PRIVATE_ALICE], unresolved: true });
      const notices = accessPolicyNotices('search', { remote: true, auth: { readSharedUnresolved: true } } as unknown as OperationContext);
      expect(notices.map(n => [n.code, n.kind])).toEqual([['read_shared_unresolved', 'degraded']]);
    });
  });
}
