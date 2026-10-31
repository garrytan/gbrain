/**
 * GBRA-218 A1 identity: credential bindings at verification, in dispatch and
 * on a local stdio server, on a repo-less brain (in-memory PGLite; Postgres
 * too when DATABASE_URL is set).
 *
 * 1. Protects: a token or OAuth client bound to a disabled, removed or missing
 *    member is refused by the verifier (access_member_disabled) on both the
 *    OAuth provider and the legacy bearer transport; the verifier carries the
 *    live member on AuthInfo so dispatch needs no lookup; an unbound credential
 *    keeps an empty identity; a stdio server reads as config mcp.stdio_member
 *    and, unbound, sees no page that names readers; whoami and grant_diagnosis
 *    report member, groups and may_act_for.
 * 2. Fails when: a disabled member's credential still verifies (or verifies
 *    as unbound and keeps reading open pages), dispatch trusts a stale
 *    identity source, an unbound stdio server reads a restricted page, or a
 *    stdio server bound to a disabled member keeps reading.
 * 3. Existing coverage: test/member-read-access.test.ts checks reads with the
 *    principal lookup only.
 * 4. Real seams: GBrainOAuthProvider.verifyAccessToken, startHttpTransport's
 *    bearer verifier over a real socket, dispatchToolCall with transport stdio.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { memberIdentityFor, STDIO_MEMBER_KEY } from '../src/core/access/caller.ts';
import { addGroup, addMember, bindCredential, disableMember, enableMember, removeMember } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
const SRC = 'source-a';
const ALICE_SLUG = 'notes/alice-plan';
const CANARY = 'canarybindalice';

for (const kind of testBackends()) {
  describe(`access binding (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, { id: string; token: string }> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (token: string) => await provider().verifyAccessToken(token) as unknown as AuthInfo;
    const verifyError = async (token: string) => { try { await verify(token); return 'verified'; } catch (e) { return (e as Error).message; } };

    async function stdioGet(slug: string): Promise<string> {
      const out = await dispatchToolCall(engine, 'get_page', { slug }, { remote: true, transport: 'stdio', sourceId: SRC, takesHoldersAllowList: ['world'] });
      return out.content.map(c => c.text).join('\n');
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(DIMS).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await importFromContent(engine, ALICE_SLUG, `---\ntype: note\ntitle: Alice plan\nreadable_by: [alice-example]\n---\n# Alice plan\n\nPlanning notes ${CANARY}.`, { sourceId: SRC });
      await addMember(engine, 'alice-example', { groups: ['team-a'] });
      await addMember(engine, 'bob-example');
      for (const name of ['alice', 'bob', 'unbound', 'ghost']) {
        tokens[name] = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      }
      await bindCredential(engine, { kind: 'token', id: tokens.alice!.id }, { member: 'alice-example', mayActFor: ['member:bob-example'] });
      await bindCredential(engine, { kind: 'token', id: tokens.bob!.id }, { member: 'bob-example' });
      await engine.executeRaw("UPDATE access_tokens SET member_id = 'nobody-example' WHERE id = $1::uuid", [tokens.ghost!.id]);
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('the legacy-token verifier joins the live member and carries it on AuthInfo; an unbound token carries null', async () => {
      const alice = await verify(tokens.alice!.token);
      expect(alice.member).toEqual({ id: 'alice-example', groups: ['team-a'] });
      expect(alice.mayActFor).toEqual(['member:bob-example']);
      expect((await verify(tokens.unbound!.token)).member).toBeNull();
    });

    test('a token bound to a disabled, removed or missing member is refused at verification', async () => {
      expect(await verifyError(tokens.ghost!.token)).toContain('access_member_disabled');
      await disableMember(engine, 'bob-example');
      expect(await verifyError(tokens.bob!.token)).toContain('access_member_disabled');
      await enableMember(engine, 'bob-example');
      expect((await verify(tokens.bob!.token)).member).toEqual({ id: 'bob-example', groups: [] });
      await addMember(engine, 'frank-example');
      const frank = await mintLegacyToken(engine, { name: 'frank', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      await bindCredential(engine, { kind: 'token', id: frank.id }, { member: 'frank-example' });
      await removeMember(engine, 'frank-example');
      expect(await verifyError(frank.token)).toContain('access_member_disabled');
    });

    test('an OAuth client bound to a member verifies as that member and is refused once the member is disabled', async () => {
      const registered = await provider().registerClientManual('client-a-example', ['client_credentials'], 'read', [], SRC);
      await bindCredential(engine, { kind: 'client', id: registered.clientId }, { member: 'alice-example' });
      const issued = await provider().exchangeClientCredentials(registered.clientId, registered.clientSecret!);
      expect((await verify(issued.access_token)).member).toEqual({ id: 'alice-example', groups: ['team-a'] });
      await disableMember(engine, 'alice-example');
      try {
        expect(await verifyError(issued.access_token)).toContain('access_member_disabled');
      } finally {
        await enableMember(engine, 'alice-example');
      }
      await bindCredential(engine, { kind: 'client', id: registered.clientId }, { member: null });
      expect((await verify(issued.access_token)).member).toBeNull();
    });

    test('the legacy bearer transport refuses a token bound to a disabled member with access_member_disabled', async () => {
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
      try {
        const callAs = (token: string) => fetch(`http://127.0.0.1:${server.port}/mcp`, {
          method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: ALICE_SLUG } } }),
        });
        const ok = await callAs(tokens.alice!.token);
        expect(ok.status).toBe(200);
        expect(await ok.text()).toContain(CANARY);
        await disableMember(engine, 'alice-example');
        try {
          const refused = await callAs(tokens.alice!.token);
          expect(refused.status).toBe(401);
          expect(await refused.json()).toMatchObject({ error: 'invalid_token', code: 'access_member_disabled' });
        } finally {
          await enableMember(engine, 'alice-example');
        }
      } finally {
        server.stop(true);
      }
    }, 60_000);

    test('dispatch reads the identity the verifier joined without a query; only an AuthInfo no verifier built is looked up', async () => {
      const noQueries = { executeRaw: async () => { throw new Error('dispatch must not query when the verifier joined the member'); } } as unknown as BrainEngine;
      const joined = { token: '', clientId: 'x', scopes: ['read'], principal: { kind: 'legacy_token' as const, id: tokens.alice!.id } };
      expect(await memberIdentityFor(noQueries, { ...joined, member: { id: 'alice-example', groups: ['team-a'] } })).toEqual(['group:team-a', 'member:alice-example']);
      expect(await memberIdentityFor(noQueries, { ...joined, member: null })).toEqual([]);
      expect(await memberIdentityFor(engine, joined)).toEqual(['group:team-a', 'member:alice-example']);
      expect(await memberIdentityFor(noQueries, joined)).toEqual([]);
    });

    test('stdio: unbound sees no restricted page; mcp.stdio_member binds it; a disabled bound member sees none again', async () => {
      expect(await stdioGet(ALICE_SLUG)).not.toContain(CANARY);
      await engine.setConfig(STDIO_MEMBER_KEY, 'bob-example');
      expect(await stdioGet(ALICE_SLUG)).not.toContain(CANARY);
      await engine.setConfig(STDIO_MEMBER_KEY, 'alice-example');
      expect(await stdioGet(ALICE_SLUG)).toContain(CANARY);
      const whoami = JSON.parse((await dispatchToolCall(engine, 'whoami', {}, { remote: true, transport: 'stdio', sourceId: SRC })).content[0]!.text);
      expect(whoami.access).toMatchObject({ member: 'alice-example', groups: ['team-a'], bound_by: 'stdio_config' });
      await disableMember(engine, 'alice-example');
      try {
        expect(await stdioGet(ALICE_SLUG)).not.toContain(CANARY);
        const after = JSON.parse((await dispatchToolCall(engine, 'whoami', {}, { remote: true, transport: 'stdio', sourceId: SRC })).content[0]!.text);
        expect(after.access).toMatchObject({ member: null, bound_by: 'none' });
        expect(after.access.note).toContain('not an enabled member');
      } finally {
        await enableMember(engine, 'alice-example');
        await engine.setConfig(STDIO_MEMBER_KEY, '');
      }
      expect(await stdioGet(ALICE_SLUG)).not.toContain(CANARY);
    });

    test('whoami and grant_diagnosis over a legacy token report member, groups and may_act_for', async () => {
      const auth = await verify(tokens.alice!.token);
      const out = await dispatchToolCall(engine, 'whoami', {}, { remote: true, transport: 'http', auth, sourceId: SRC });
      const body = JSON.parse(out.content[0]!.text);
      expect(body.access).toEqual({ member: 'alice-example', groups: ['team-a'], may_act_for: ['member:bob-example'], bound_by: 'credential' });
      expect(body.grant_diagnosis).toMatchObject({ member: 'alice-example', groups: ['team-a'], may_act_for: ['member:bob-example'] });
      const unbound = JSON.parse((await dispatchToolCall(engine, 'whoami', {}, { remote: true, transport: 'http', auth: await verify(tokens.unbound!.token), sourceId: SRC })).content[0]!.text);
      expect(unbound.access).toMatchObject({ member: null, groups: [], bound_by: 'none' });
      expect(unbound.grant_diagnosis).toMatchObject({ member: null, may_act_for: null });
      const local = JSON.parse((await dispatchToolCall(engine, 'whoami', {}, { remote: false, sourceId: SRC })).content[0]!.text);
      expect(local.access).toMatchObject({ member: null, bound_by: 'none' });
    });

    test('a group binding follows membership on the next request', async () => {
      await addGroup(engine, 'team-c', ['bob-example']);
      expect((await verify(tokens.bob!.token)).member).toEqual({ id: 'bob-example', groups: ['team-c'] });
    });
  });
}
