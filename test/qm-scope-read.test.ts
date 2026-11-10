/**
 * GST-1158 E1, F3, F4: attested reads that name sources (the scope read), the attest_read credential setting, and the
 * actorless refusal on a credential set to scope.
 *
 * 1. Protects: an attested call to get_page, entity, whois, get_backlinks, get_timeline, find_experts,
 *    volunteer_context, query or memory_recall that names source_id/source_ids reads as the scope (no member identity):
 *    the person's restricted page (readable_by them) and their member page memory/members/<member> are not_found or
 *    absent, exactly like a page that does not exist; a source outside the grant is refused; __all__ and all_sources are
 *    refused under scope. A credential set --attest-read person narrows to the named sources but reads as the person. A
 *    credential set --attest-read scope refuses every call that names no person (actor_required), reading nothing; an
 *    unset one (NULL) keeps today's behavior.
 * 2. Fails when: any of those reads returns a restricted or member-page canary under scope, a refusal differs from a
 *    missing page, an out-of-grant source reads, a person credential loses its own pages, or an actorless call from a
 *    scope credential reads anything.
 * 3. Existing coverage: test/qm-memory-tools.test.ts pins memory_recall's scope read (GST-1094); test/access-qm-actor.test.ts
 *    pins the attested actor. This file pins the dispatch rule and every op in SCOPE_READ_OPS.
 * 4. Real seams: OAuth clients issued tokens by the provider's client-credentials grant, verified by the provider,
 *    dispatched through MCP dispatch with remote=true on a repo-less brain (no git checkout anywhere); writes go through
 *    the persistence coordinator; embeddings stubbed. PGLite always, Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { attestRightOf, linkMember } from '../src/core/access/actor.ts';
import { takeBindingFlags, bindingLine } from '../src/commands/auth-binding.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { attestedCallerAccess } from '../src/core/access/actor.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { prepareRemoteAgent, withSubmissionAuthority, type RemoteAgentAuthority } from '../src/core/minions/submission-authority.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

const SRC = 'source-a';
const ROOM = 'source-room';
const OTHER = 'source-other';
const ALICE_ID = 'U0ALICE';
const SCOPE_OPS = ['entity', 'find_experts', 'get_backlinks', 'get_page', 'get_timeline', 'get_write_request', 'memory_recall', 'memory_write', 'query', 'volunteer_context', 'whois'];
const RESTRICTED = 'companies/zephyr-restricted-example';
const ACME = 'companies/acme-example';
const MEMBER_PAGE = 'memory/members/alice-example';
const CANARIES = ['canaryrestrictedbody', 'canaryrestrictedtimeline', 'canaryrestrictedexpert', 'canarymemberfact', 'Memory of alice-example'];
const SLUGS = ['zephyr-restricted-example', 'ivo-galewright', 'quill-restricted-example', 'members/alice-example'];
const company = (title: string, extra: string[], body: string) => ['---', 'type: company', 'title: ' + title, ...extra, '---', '# ' + title, '', body].join('\n');
const person = (title: string, extra: string[], body: string) => ['---', 'type: person', 'title: ' + title, ...extra, '---', '# ' + title, '', body].join('\n');

describe('attest_read flag parsing (pure)', () => {
  test('--attest-read takes person, scope or none; anything else is refused', () => {
    expect(takeBindingFlags(['--attest-read', 'person']).patch).toEqual({ attestRead: 'person' });
    expect(takeBindingFlags(['--attest-read=scope']).patch).toEqual({ attestRead: 'scope' });
    expect(takeBindingFlags(['--attest-read', 'none']).patch).toEqual({ attestRead: null });
    expect(() => takeBindingFlags(['--attest-read', 'room'])).toThrow(/--attest-read room/);
  });

  test('the binding line names how named sources read, scope when unset', () => {
    expect(bindingLine({ member: null, may_act_for: null, attest_actor: 'qm', attest_ops: null, attest_read: 'person', changed: true }))
      .toContain('named sources read as: person');
    expect(bindingLine({ member: null, may_act_for: null, attest_actor: 'qm', attest_ops: null, changed: false })).toContain('named sources read as: scope (default)');
  });
});

for (const kind of testBackends()) {
  describe('scope reads, attest_read and actorless refusal (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const clients: Record<string, { id: string; secret: string; token: string }> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;

    async function call(client: string, op: string, params: Record<string, unknown>, actor: string | null = ALICE_ID, extra: { writeWaitMs?: number; remote?: boolean } = {}) {
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: extra.remote ?? true, transport: 'http', auth: await verify(clients[client]!.token), sourceId: SRC, takesHoldersAllowList: ['world'],
        ...(actor !== null ? { actor: { header: actor } } : {}), ...(extra.writeWaitMs ? { writeWaitMs: extra.writeWaitMs } : {}),
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, any> = {};
      try { json = JSON.parse(out.content[0]?.text ?? ''); } catch { /* prose */ }
      return { isError: out.isError === true, text, json, structured: out.structuredContent as Record<string, any> | undefined,
        all: text + JSON.stringify(out._meta ?? {}) + JSON.stringify(out.structuredContent ?? {}) };
    }
    const hidden = (out: { all: string }, slugs = true) => { for (const c of [...CANARIES, ...(slugs ? SLUGS : [])]) expect(out.all).not.toContain(c); };
    async function refused(p: Promise<Awaited<ReturnType<typeof call>>>, code: string, reason?: string) {
      const out = await p;
      expect({ isError: out.isError, code: out.json.code, reason: out.json.reason }).toEqual({ isError: true, code, reason });
      hidden(out, false);
      return out;
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of [SRC, ROOM, OTHER]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await importFromContent(engine, ACME, company('Acme Example', [], 'Acme example harbor ledger tariffs canaryworldacme.'), { sourceId: SRC });
      await importFromContent(engine, RESTRICTED, company('Zephyr Restricted Example', ['readable_by: [alice-example]'], 'Zephyr harbor ledger tariffs canaryrestrictedbody.'), { sourceId: SRC });
      await importFromContent(engine, 'people/quill-restricted-example', person('Quill Restricted Example', ['readable_by: [alice-example]'], 'Quill leads harbor ledger tariffs canaryrestrictedexpert.'), { sourceId: SRC });
      await importFromContent(engine, 'people/wren-world-example', person('Wren World Example', [], 'Wren leads harbor ledger tariffs canaryworldexpert.'), { sourceId: SRC });
      await importFromContent(engine, 'people/ivo-galewright', person('Ivo Galewright', ['readable_by: [alice-example]'], 'Ivo works on harbor ledgers.'), { sourceId: SRC });
      await importFromContent(engine, 'people/nell-thistlewood', person('Nell Thistlewood', [], 'Nell works on harbor ledgers canaryworldsurname.'), { sourceId: SRC });
      await importFromContent(engine, 'companies/room-example', company('Room Example', [], 'Room example harbor ledger tariffs canaryroompage.'), { sourceId: ROOM });
      await importFromContent(engine, 'companies/other-example', company('Other Example', [], 'Other example harbor ledger tariffs canaryotherpage.'), { sourceId: OTHER });
      await engine.addTimelineEntry(RESTRICTED, { date: '2026-10-01', summary: 'Zephyr board review canaryrestrictedtimeline' } as never, { sourceId: SRC });
      await engine.addTimelineEntry(ACME, { date: '2026-10-02', summary: 'Acme board review canaryworldtimeline' } as never, { sourceId: SRC });
      await engine.addLink(RESTRICTED, ACME, 'zephyr cites acme', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
      await engine.addLink('people/wren-world-example', ACME, 'wren cites acme', 'mentions', 'manual', undefined, undefined, { fromSourceId: SRC, toSourceId: SRC });
      const register = async (name: string, read?: 'person' | 'scope') => {
        const c = await provider().registerClientManual('scope-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        await provider().rescopeClient(c.clientId, { federatedRead: [SRC, ROOM] });
        await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: SCOPE_OPS, ...(read ? { attestRead: read } : {}) });
        clients[name] = { id: c.clientId, secret: c.clientSecret ?? '', token: (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token };
      };
      await register('unset');
      await register('scope', 'scope');
      await register('person', 'person');
      const wrote = await call('unset', 'memory_write', { facts: [{ fact: 'Alice prefers the harbor ledger tariffs canarymemberfact', provenance: 'turn 1' }], idempotency_key: randomUUID() }, ALICE_ID, { writeWaitMs: 30_000 });
      expect(wrote.structured?.status).toBe('committed');
      __resetPrivateVisibilityCacheForTests();
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    }, 60_000);

    test('attest_read is stored beside attest_ops, carried in the attest right, cleared with the right and refused without it', async () => {
      expect((await attestRightOf(engine, { principal: { kind: 'oauth_client', id: clients.person!.id } }))?.read).toBe('person');
      expect((await attestRightOf(engine, { principal: { kind: 'oauth_client', id: clients.scope!.id } }))?.read).toBe('scope');
      expect((await attestRightOf(engine, { principal: { kind: 'oauth_client', id: clients.unset!.id } }))?.read).toBeUndefined();
      expect((await verify(clients.person!.token)).attest?.read).toBe('person');
      const c = await provider().registerClientManual('scope-flip-' + randomUUID().slice(0, 8), ['client_credentials'], 'read', [], SRC);
      const target = { kind: 'client' as const, id: c.clientId };
      await expect(bindCredential(engine, target, { attestRead: 'person' })).rejects.toThrow(/--attest-read needs the attest right/);
      expect(await bindCredential(engine, target, { attestActor: 'qm', attestRead: 'person' })).toMatchObject({ attest_actor: 'qm', attest_read: 'person', changed: true });
      expect(await bindCredential(engine, target, { attestRead: 'person' })).toMatchObject({ attest_read: 'person', changed: false });
      expect(await bindCredential(engine, target, { attestRead: 'scope' }, { dryRun: true })).toMatchObject({ attest_read: 'scope', changed: true });
      expect((await engine.executeRaw<{ attest_read: string | null }>('SELECT attest_read FROM oauth_clients WHERE client_id = $1', [c.clientId]))[0]?.attest_read).toBe('person');
      expect(await bindCredential(engine, target, { attestRead: null })).toMatchObject({ attest_read: null, changed: true });
      await bindCredential(engine, target, { attestRead: 'scope' });
      expect(await bindCredential(engine, target, { attestActor: null })).toMatchObject({ changed: true });
      expect((await engine.executeRaw<Record<string, unknown>>('SELECT attest_actor, attest_ops, attest_read FROM oauth_clients WHERE client_id = $1', [c.clientId]))[0])
        .toEqual({ attest_actor: null, attest_ops: null, attest_read: null });
    }, 120_000);

    test('get_page that names sources reads as the scope: the restricted page and the member page are not_found like a missing page', async () => {
      expect((await call('unset', 'get_page', { slug: RESTRICTED })).text).toContain('canaryrestrictedbody');
      expect((await call('unset', 'get_page', { slug: MEMBER_PAGE })).text).toContain('Memory of alice-example');
      const missing = await call('unset', 'get_page', { slug: 'companies/nobody-example', source_id: SRC });
      expect(missing.json.code).toBe('page_not_found');
      for (const client of ['unset', 'scope']) {
        for (const slug of [RESTRICTED, MEMBER_PAGE]) {
          const out = await call(client, 'get_page', { slug, source_id: SRC });
          expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code: missing.json.code });
          expect(out.json.message).toBe(missing.json.message?.replace('companies/nobody-example', slug));
          hidden(out, false);
        }
        expect((await call(client, 'get_page', { slug: ACME, source_id: SRC })).text).toContain('canaryworldacme');
        expect((await call(client, 'get_page', { slug: 'companies/room-example', source_id: ROOM })).text).toContain('canaryroompage');
        await refused(call(client, 'get_page', { slug: 'companies/other-example', source_id: OTHER }), 'permission_denied');
        await refused(call(client, 'get_page', { slug: RESTRICTED, source_id: '__all__' }), 'invalid_params');
      }
    }, 120_000);

    test('entity and whois that name sources never find the restricted page; a source outside the grant is refused', async () => {
      expect((await call('unset', 'entity', { name: 'Zephyr Restricted Example' })).json.found).toBe(true);
      expect((await call('unset', 'whois', { query: 'Zephyr Restricted Example' })).json.matches?.length).toBe(1);
      for (const client of ['unset', 'scope']) {
        const card = await call(client, 'entity', { name: 'Zephyr Restricted Example', source_id: SRC });
        expect({ isError: card.isError, found: card.json.found }).toEqual({ isError: false, found: false });
        hidden(card);
        expect((await call(client, 'entity', { name: 'Acme Example', source_id: SRC })).json.found).toBe(true);
        const who = await call(client, 'whois', { query: 'Zephyr Restricted Example', source_id: SRC });
        expect({ isError: who.isError, matches: who.json.matches }).toEqual({ isError: false, matches: [] });
        hidden(who);
        expect((await call(client, 'whois', { query: 'Acme Example', source_id: SRC })).json.matches?.length).toBe(1);
        expect((await call(client, 'entity', { name: 'Other Example', source_id: OTHER })).isError).toBe(true);
        await refused(call(client, 'whois', { query: 'Other Example', source_id: OTHER }), 'permission_denied');
        await refused(call(client, 'whois', { query: 'Acme Example', source_id: '__all__' }), 'invalid_params');
      }
    }, 120_000);

    test('get_backlinks that names sources drops links from the restricted page; all_sources is refused under scope', async () => {
      expect((await call('unset', 'get_backlinks', { slug: ACME })).text).toContain('zephyr-restricted-example');
      for (const client of ['unset', 'scope']) {
        const out = await call(client, 'get_backlinks', { slug: ACME, source_id: SRC });
        expect(out.isError).toBe(false);
        expect(out.text).toContain('wren-world-example');
        hidden(out);
        await refused(call(client, 'get_backlinks', { slug: ACME, source_id: OTHER }), 'permission_denied');
        await refused(call(client, 'get_backlinks', { slug: ACME, source_id: SRC, all_sources: true }), 'invalid_params');
        await refused(call(client, 'get_backlinks', { slug: ACME, all_sources: true }), 'invalid_params');
      }
      expect((await call('person', 'get_backlinks', { slug: ACME, all_sources: true })).text).toContain('zephyr-restricted-example');
    }, 120_000);

    test('context_pack that names sources is refused on a scope credential, never read as the person; unnamed and person credentials are unchanged', async () => {
      const c = await provider().registerClientManual('scope-ctx-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await provider().rescopeClient(c.clientId, { federatedRead: [SRC, ROOM] });
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: [...SCOPE_OPS, 'context_pack'] });
      clients.ctx = { id: c.clientId, secret: c.clientSecret ?? '', token: (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token };
      for (const params of [{ source_id: SRC }, { all_sources: true }, { entity_refs: [{ source_id: SRC, slug: RESTRICTED }] }]) {
        const out = await refused(call('ctx', 'context_pack', { counterparty: 'Zephyr Restricted Example', ...params }), 'invalid_params');
        expect(out.all).toContain('context_pack: a call that names sources');
      }
      expect((await call('ctx', 'context_pack', { counterparty: 'Zephyr Restricted Example' })).all).not.toContain('context_pack: a call that names sources');
    }, 120_000);

    test('an agent job submitted for the person reads named sources as the scope too, exactly like the direct call', async () => {
      const job = async (read?: 'person') => {
        const c = await provider().registerClientManual('scope-agent-' + randomUUID().slice(0, 8), ['client_credentials'], 'read', [], SRC);
        await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: ['get_page', 'query'], ...(read ? { attestRead: read } : {}) });
        await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['get_page','query'], bound_source_id = source_id, federated_read = $2::text[], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_max_concurrent = 1 WHERE client_id = $1", [c.clientId, [SRC, ROOM]]);
        const actor = { system: 'qm', external_id: ALICE_ID, member: 'alice-example' };
        const agentAuth = { token: 'x', clientId: c.clientId, scopes: ['read', 'agent'], sourceId: SRC, allowedSources: [SRC, ROOM], principal: { kind: 'oauth_client', id: c.clientId } } as unknown as AuthInfo;
        const submitted = await withCallerAccess(await attestedCallerAccess(engine, actor, ['member:alice-example']),
          () => prepareRemoteAgent({ engine, auth: agentAuth, remote: true } as unknown as OperationContext, { source_id: SRC, allowed_tools: ['get_page', 'query'], allowed_slug_prefixes: [] }));
        const tools = buildBrainTools({ subagentId: 13, engine, config: { engine: 'pglite' } as never, sourceId: SRC,
          delegatedAuth: { clientId: c.clientId, scopes: ['read', 'agent'], sourceId: SRC, allowedSources: [SRC, ROOM] } });
        const authority: RemoteAgentAuthority = { ...submitted, payloadHash: '0'.repeat(64) };
        return async (tool: string, input: Record<string, unknown>) => {
          try { return JSON.stringify(await withSubmissionAuthority(authority, () => tools.find(t => t.name === tool)!.execute(input, { engine, jobId: 1, remote: true } as never))); }
          catch (e) { return 'ERR ' + String((e as Error).message); }
        };
      };
      const scoped = await job();
      expect(await scoped('brain_get_page', { slug: RESTRICTED })).toContain('canaryrestrictedbody');
      expect(await scoped('brain_get_page', { slug: RESTRICTED, source_id: SRC })).not.toContain('canaryrestrictedbody');
      expect(await scoped('brain_get_page', { slug: MEMBER_PAGE, source_id: SRC })).not.toContain('Memory of alice-example');
      const found = await scoped('brain_query', { query: 'harbor ledger tariffs', limit: 20, source_ids: [SRC] });
      expect(found).toContain('canaryworldacme');
      for (const c of CANARIES) expect(found).not.toContain(c);
      expect(await scoped('brain_get_page', { slug: RESTRICTED, all_sources: true })).not.toContain('canaryrestrictedbody');
      expect(await (await job('person'))('brain_get_page', { slug: RESTRICTED, source_id: SRC })).toContain('canaryrestrictedbody');
    }, 120_000);

    test('get_timeline narrows to source_id/source_ids inside the grant and, named, reads as the scope', async () => {
      expect((await call('unset', 'get_timeline', { slug: RESTRICTED })).text).toContain('canaryrestrictedtimeline');
      const missing = await call('unset', 'get_timeline', { slug: 'companies/nobody-example', source_id: SRC });
      for (const client of ['unset', 'scope']) {
        for (const args of [{ source_id: SRC }, { source_ids: [SRC] }, { source_ids: [SRC, ROOM] }]) {
          const out = await call(client, 'get_timeline', { slug: RESTRICTED, ...args });
          expect({ isError: out.isError, text: out.text }).toEqual({ isError: false, text: missing.text });
          hidden(out);
          expect((await call(client, 'get_timeline', { slug: ACME, ...args })).text).toContain('canaryworldtimeline');
        }
        expect((await call(client, 'get_timeline', { slug: ACME, source_ids: [ROOM] })).text).not.toContain('canaryworldtimeline');
        await refused(call(client, 'get_timeline', { slug: ACME, source_ids: [OTHER] }), 'permission_denied');
        await refused(call(client, 'get_timeline', { slug: ACME, source_id: OTHER }), 'permission_denied');
      }
      expect((await call('unset', 'get_timeline', { slug: ACME, source_ids: [ROOM] }, null)).text).not.toContain('canaryworldtimeline');
    }, 120_000);

    test('find_experts takes source_ids and, named, never ranks the restricted person', async () => {
      const asPerson = await call('unset', 'find_experts', { topic: 'harbor ledger tariffs', limit: 10 });
      expect(asPerson.isError).toBe(false);
      expect(asPerson.text).toContain('quill-restricted-example');
      for (const client of ['unset', 'scope']) {
        const out = await call(client, 'find_experts', { topic: 'harbor ledger tariffs', limit: 10, source_ids: [SRC] });
        expect(out.isError).toBe(false);
        expect(out.text).toContain('wren-world-example');
        hidden(out);
        await refused(call(client, 'find_experts', { topic: 'harbor ledger tariffs', source_ids: [OTHER] }), 'permission_denied');
      }
    }, 120_000);

    test('volunteer_context takes source_ids; under scope its pointer and lexical arms never volunteer a restricted page, and stats is refused', async () => {
      const window = 'user: what about Zephyr Restricted Example and Acme Example? did Galewright and Thistlewood reply? notes on zephyr restricted example';
      const local = await call('unset', 'volunteer_context', { window, min_confidence: 0.5, max_pages: 5 }, null, { remote: false });
      for (const slug of [RESTRICTED, 'people/ivo-galewright']) expect(local.text).toContain(slug);
      for (const client of ['unset', 'scope']) {
        const out = await call(client, 'volunteer_context', { window, min_confidence: 0.5, max_pages: 5, source_ids: [SRC] });
        expect(out.isError).toBe(false);
        for (const slug of [ACME, 'people/nell-thistlewood']) expect(out.text).toContain(slug);
        hidden(out);
        const room = await call(client, 'volunteer_context', { window: 'user: tell me about Room Example and Acme Example', min_confidence: 0.5, source_ids: [ROOM] });
        expect(room.text).toContain('companies/room-example');
        expect(room.text).not.toContain(ACME);
        await refused(call(client, 'volunteer_context', { window, source_ids: [OTHER] }), 'permission_denied');
        await refused(call(client, 'volunteer_context', { stats: true, source_ids: [SRC] }), 'invalid_params');
      }
      expect((await call('unset', 'volunteer_context', { stats: true }, null)).isError).toBe(false);
    }, 120_000);

    test('query that names sources reads as the scope: no restricted page or member-page fact', async () => {
      const asPerson = await call('unset', 'query', { query: 'harbor ledger tariffs', limit: 20 });
      expect(asPerson.text).toContain('canaryrestrictedbody');
      for (const client of ['unset', 'scope']) {
        for (const args of [{ source_id: SRC }, { source_ids: [SRC, ROOM] }]) {
          const out = await call(client, 'query', { query: 'harbor ledger tariffs', limit: 20, ...args });
          expect(out.isError).toBe(false);
          expect(out.text).toContain('canaryworldacme');
          hidden(out);
        }
        await refused(call(client, 'query', { query: 'harbor ledger tariffs', source_ids: [OTHER] }), 'permission_denied');
        await refused(call(client, 'query', { query: 'harbor ledger tariffs', source_id: '__all__' }), 'invalid_params');
      }
    }, 120_000);

    test('memory_recall keeps reading named sources as the scope through the shared rule', async () => {
      const asPerson = await call('unset', 'memory_recall', { query: 'harbor ledger tariffs', max_chars: 12_000 });
      expect(asPerson.text).toContain('canarymemberfact');
      for (const client of ['unset', 'scope']) {
        const out = await call(client, 'memory_recall', { query: 'harbor ledger tariffs', max_chars: 12_000, source_ids: [SRC] });
        expect(out.isError).toBe(false);
        hidden(out);
        await refused(call(client, 'memory_recall', { query: 'harbor ledger tariffs', source_ids: [OTHER] }), 'permission_denied');
      }
    }, 120_000);

    test('an empty source_ids names nothing, so the call reads as the person', async () => {
      expect((await call('scope', 'get_timeline', { slug: RESTRICTED, source_ids: [] })).text).toContain('canaryrestrictedtimeline');
    }, 120_000);

    test('a credential set --attest-read person narrows to the named sources but reads as the person, for every scope-read op', async () => {
      expect((await call('person', 'get_page', { slug: RESTRICTED, source_id: SRC })).text).toContain('canaryrestrictedbody');
      expect((await call('person', 'get_page', { slug: MEMBER_PAGE, source_id: SRC })).text).toContain('Memory of alice-example');
      expect((await call('person', 'entity', { name: 'Zephyr Restricted Example', source_id: SRC })).json.found).toBe(true);
      expect((await call('person', 'whois', { query: 'Zephyr Restricted Example', source_id: SRC })).json.matches?.length).toBe(1);
      expect((await call('person', 'get_backlinks', { slug: ACME, source_id: SRC })).text).toContain('zephyr-restricted-example');
      expect((await call('person', 'get_timeline', { slug: RESTRICTED, source_ids: [SRC] })).text).toContain('canaryrestrictedtimeline');
      expect((await call('person', 'find_experts', { topic: 'harbor ledger tariffs', limit: 10, source_ids: [SRC] })).text).toContain('quill-restricted-example');
      expect((await call('person', 'query', { query: 'harbor ledger tariffs', limit: 20, source_ids: [SRC] })).text).toContain('canaryrestrictedbody');
      expect((await call('person', 'memory_recall', { query: 'harbor ledger tariffs', max_chars: 12_000, source_ids: [SRC] })).text).toContain('canarymemberfact');
      expect((await call('person', 'get_page', { slug: 'companies/room-example', source_id: SRC })).json.code).toBe('page_not_found');
      await refused(call('person', 'get_page', { slug: 'companies/other-example', source_id: OTHER }), 'permission_denied');
      expect((await call('person', 'volunteer_context', { stats: true, source_ids: [SRC] })).isError).toBe(false);
    }, 120_000);

    test('F4: a credential set --attest-read scope refuses every call that names no person, reading nothing; unset and person credentials are unchanged', async () => {
      for (const [op, params] of [['get_page', { slug: ACME }], ['get_page', { slug: ACME, source_id: SRC }], ['memory_recall', { query: 'harbor ledger tariffs' }],
        ['query', { query: 'harbor ledger tariffs' }], ['get_write_request', { request_id: randomUUID() }]] as const) {
        const out = await refused(call('scope', op, params, null), 'actor_not_attested', 'actor_required');
        expect(out.json.message).toContain('--attest-read scope');
        expect(out.all).not.toContain('canaryworldacme');
      }
      for (const client of ['unset', 'person']) {
        const out = await call(client, 'get_page', { slug: ACME }, null);
        expect(out.isError).toBe(false);
        expect(out.text).toContain('canaryworldacme');
      }
    }, 120_000);
  });
}
