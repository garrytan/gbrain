/**
 * GBRA-284 (GST-359 G1 wave 2): personal sources. A source bound to a member (access_member_sources, v299) is read by an
 * attested call only for that member, and never by a scope read; the rule only hides inside the credential's grant.
 *
 * 1. Protects: the HARN-1 gate shape. An attest client granted {source-a, dm-alice-example, dm-bob-example}, each DM
 *    source bound to its member: attested alice-example's unnamed memory_recall returns her DM-source fact and her
 *    memory_write fact, never bob-example's DM-source fact (and the reverse for bob); query and get_page follow the same
 *    rule; a scope read naming a DM source (even the speaker's own) is refused exactly like an out-of-grant source; a
 *    person credential naming another member's DM source is refused the same way. A client whose grant omits the DM
 *    sources never reads them (the rule adds nothing). Unattested calls are unchanged.
 * 2. Fails when: an attested person reads another member's personal source through any of those ops, a scope read
 *    reads a personal source, a refusal differs from the out-of-grant refusal, a person loses their own personal source,
 *    or the rule widens a grant.
 * 3. Existing coverage: test/qm-scope-read.test.ts pins the scope read; test/access-qm-actor.test.ts the attested actor.
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
import { addMember, bindCredential, removeMember } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { bindMemberSource, listMemberSources, unbindMemberSource } from '../src/core/access/member-sources.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { attestedCallerAccess } from '../src/core/access/actor.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { prepareRemoteAgent, withSubmissionAuthority, type RemoteAgentAuthority } from '../src/core/minions/submission-authority.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
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
const DM_A = 'dm-alice-example';
const DM_B = 'dm-bob-example';
const OTHER = 'source-other';
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'U0BOB';
const OPS = ['entity', 'find_experts', 'get_backlinks', 'get_page', 'get_timeline', 'get_write_request', 'memory_recall', 'memory_write', 'query', 'search', 'volunteer_context', 'whois'];
const PAGE_A = 'notes/alice-dm-example';
const PAGE_B = 'notes/bob-dm-example';
const Q = 'harbor tide charts';
const note = (title: string, body: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', body].join('\n');

for (const kind of testBackends()) {
  describe('personal sources: an attested person reads only their own (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const clients: Record<string, string> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;

    async function call(client: string, op: string, params: Record<string, unknown>, actor: string | null = ALICE_ID, extra: { writeWaitMs?: number } = {}) {
      const auth = await verify(clients[client]!);
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? SRC, takesHoldersAllowList: ['world'],
        ...(actor !== null ? { actor: { header: actor } } : {}), ...(extra.writeWaitMs ? { writeWaitMs: extra.writeWaitMs } : {}),
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, any> = {};
      try { json = JSON.parse(out.content[0]?.text ?? ''); } catch { /* prose */ }
      return { isError: out.isError === true, text, json, structured: out.structuredContent as Record<string, any> | undefined,
        all: text + JSON.stringify(out._meta ?? {}) + JSON.stringify(out.structuredContent ?? {}) };
    }
    const recall = (client: string, actor: string | null, extra: Record<string, unknown> = {}) => call(client, 'memory_recall', { query: Q, max_chars: 12_000, ...extra }, actor);
    /** The refusal a source outside the grant gets; a hidden personal source must get exactly this (no existence oracle). */
    async function outOfGrant(client: string, op: string, params: Record<string, unknown>, actor: string | null = ALICE_ID) {
      const out = await call(client, op, { ...params, ...('source_id' in params ? { source_id: OTHER } : { source_ids: [OTHER] }) }, actor);
      expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code: 'permission_denied' });
      return out;
    }
    async function refusedLikeOutOfGrant(client: string, op: string, params: Record<string, unknown>, actor: string | null = ALICE_ID) {
      const out = await call(client, op, params, actor);
      const ref = await outOfGrant(client, op, params, actor);
      expect({ isError: out.isError, code: out.json.code, message: out.json.message }).toEqual({ isError: true, code: 'permission_denied', message: ref.json.message });
      const named = typeof params.source_id === 'string' ? params.source_id : Array.isArray(params.source_ids) && params.source_ids.length === 1 ? params.source_ids[0] as string : null;
      if (named) expect(JSON.stringify(out.json).replaceAll(named, OTHER)).toBe(JSON.stringify(ref.json));
      for (const c of ['canarydmalice', 'canarydmbob']) expect(out.all).not.toContain(c);
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of [SRC, DM_A, DM_B, OTHER]) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
      for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
      // World facts and pages ingested locally into each DM source (what a DM import or a local remember leaves).
      await engine.insertFact({ fact: 'Alice keeps the harbor tide charts in a red folder canarydmalice', kind: 'fact', entity_slug: null, source: 'test', visibility: 'world' }, { source_id: DM_A });
      await engine.insertFact({ fact: 'Bob keeps the harbor tide charts in a blue folder canarydmbob', kind: 'fact', entity_slug: null, source: 'test', visibility: 'world' }, { source_id: DM_B });
      await importFromContent(engine, PAGE_A, note('Alice DM Example', 'Harbor tide charts from the alice thread canarydmalicepage.'), { sourceId: DM_A });
      await importFromContent(engine, PAGE_B, note('Bob DM Example', 'Harbor tide charts from the bob thread canarydmbobpage.'), { sourceId: DM_B });
      await importFromContent(engine, 'notes/world-example', note('World Example', 'Harbor tide charts for everyone canaryworldpage.'), { sourceId: SRC });
      const register = async (name: string, grant: string[], read?: 'person' | 'scope') => {
        const c = await provider().registerClientManual('personal-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], grant[0]!);
        await provider().rescopeClient(c.clientId, { federatedRead: grant });
        await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: OPS, ...(read ? { attestRead: read } : {}) });
        clients[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      };
      await register('narrow', [SRC]);
      await register('wide', [SRC, DM_A, DM_B]);
      await register('person', [SRC, DM_A, DM_B], 'person');
      await register('scope', [SRC, DM_A, DM_B], 'scope');
      await register('bobdm', [DM_B]);
      await register('bobfirst', [DM_B, SRC]);
      for (const [actor, who] of [[ALICE_ID, 'alice'], [BOB_ID, 'bob']] as const) {
        const wrote = await call('wide', 'memory_write', { facts: [{ fact: `${who} wants the harbor tide charts by Friday canarymember${who}`, provenance: 'turn 1' }], idempotency_key: randomUUID() }, actor, { writeWaitMs: 30_000 });
        expect(wrote.structured?.status).toBe('committed');
      }
      expect((await bindMemberSource(engine, 'alice-example', DM_A)).applied).toBe(true);
      expect((await bindMemberSource(engine, 'bob-example', DM_B)).applied).toBe(true);
      __resetPrivateVisibilityCacheForTests();
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    }, 60_000);

    test('HARN-1: attested alice-example recalls her own DM-source fact and memory_write fact, never bob-example\'s; bob gets the reverse', async () => {
      const alice = await recall('wide', ALICE_ID);
      expect(alice.isError).toBe(false);
      expect(alice.text).toContain('canarydmalice');
      expect(alice.text).toContain('canarymemberalice');
      expect(alice.all).not.toContain('canarydmbob');
      expect(alice.all).not.toContain('canarymemberbob');
      const bob = await recall('wide', BOB_ID);
      expect(bob.text).toContain('canarydmbob');
      expect(bob.text).toContain('canarymemberbob');
      expect(bob.all).not.toContain('canarydmalice');
      expect(bob.all).not.toContain('canarymemberalice');
      for (const client of ['scope', 'person']) {
        const out = await recall(client, ALICE_ID);
        expect(out.text).toContain('canarydmalice');
        expect(out.all).not.toContain('canarydmbob');
      }
    }, 120_000);

    test('a grant without the DM sources never reads them (0 of 2): the rule only hides, it never adds a source', async () => {
      const out = await recall('narrow', ALICE_ID);
      expect(out.isError).toBe(false);
      expect(out.text).toContain('canarymemberalice');
      for (const c of ['canarydmalice', 'canarydmbob']) expect(out.all).not.toContain(c);
      await refusedLikeOutOfGrant('narrow', 'memory_recall', { query: Q, source_ids: [DM_A] });
    }, 120_000);

    test('a scope read never reads a personal source, not even the speaker\'s own: refused like an out-of-grant source', async () => {
      for (const client of ['wide', 'scope']) {
        for (const dm of [DM_A, DM_B]) {
          await refusedLikeOutOfGrant(client, 'memory_recall', { query: Q, source_ids: [dm] });
          await refusedLikeOutOfGrant(client, 'memory_recall', { query: Q, source_ids: [SRC, dm] });
          await refusedLikeOutOfGrant(client, 'query', { query: Q, source_ids: [dm] });
          await refusedLikeOutOfGrant(client, 'get_page', { slug: dm === DM_A ? PAGE_A : PAGE_B, source_id: dm });
        }
        const room = await recall(client, ALICE_ID, { source_ids: [SRC] });
        expect(room.isError).toBe(false);
        for (const c of ['canarydmalice', 'canarydmbob', 'canarymemberalice']) expect(room.all).not.toContain(c);
      }
    }, 120_000);

    test('a person read names its own personal source; another member\'s is refused like an out-of-grant source', async () => {
      expect((await recall('person', ALICE_ID, { source_ids: [DM_A] })).text).toContain('canarydmalice');
      expect((await call('person', 'get_page', { slug: PAGE_A, source_id: DM_A })).text).toContain('canarydmalicepage');
      await refusedLikeOutOfGrant('person', 'memory_recall', { query: Q, source_ids: [DM_B] });
      await refusedLikeOutOfGrant('person', 'memory_recall', { query: Q, source_ids: [DM_A, DM_B] });
      await refusedLikeOutOfGrant('person', 'get_page', { slug: PAGE_B, source_id: DM_B });
      await refusedLikeOutOfGrant('person', 'query', { query: Q, source_ids: [DM_B] });
      await refusedLikeOutOfGrant('person', 'get_page', { slug: PAGE_A, source_id: DM_A }, BOB_ID);
    }, 120_000);

    test('get_page: another member\'s DM page reads as missing, the person\'s own reads', async () => {
      const missing = await call('wide', 'get_page', { slug: 'notes/nobody-example' });
      expect(missing.json.code).toBe('page_not_found');
      const theirs = await call('wide', 'get_page', { slug: PAGE_B });
      expect({ isError: theirs.isError, code: theirs.json.code, message: theirs.json.message })
        .toEqual({ isError: true, code: missing.json.code, message: missing.json.message.replace('notes/nobody-example', PAGE_B) });
      expect(theirs.all).not.toContain('canarydmbobpage');
      expect((await call('wide', 'get_page', { slug: PAGE_A })).text).toContain('canarydmalicepage');
      expect((await call('wide', 'get_page', { slug: PAGE_B }, BOB_ID)).text).toContain('canarydmbobpage');
    }, 120_000);

    test('query and search: unnamed reads span the grant minus other members\' personal sources', async () => {
      for (const op of ['query', 'search']) {
        const alice = await call('wide', op, { query: Q, limit: 20 });
        expect(alice.isError).toBe(false);
        expect(alice.text).toContain('canaryworldpage');
        expect(alice.text).toContain('canarydmalicepage');
        expect(alice.all).not.toContain('canarydmbobpage');
        const bob = await call('wide', op, { query: Q, limit: 20 }, BOB_ID);
        expect(bob.text).toContain('canarydmbobpage');
        expect(bob.all).not.toContain('canarydmalicepage');
      }
    }, 120_000);

    test('a linked member with no personal source reads neither DM source; unattested calls are unchanged', async () => {
      await linkMember(engine, 'carol-example', 'qm', 'U0CAROL');
      const carol = await recall('wide', 'U0CAROL');
      expect(carol.isError).toBe(false);
      for (const c of ['canarydmalice', 'canarydmbob']) expect(carol.all).not.toContain(c);
      const bare = await recall('wide', null);
      expect(bare.isError).toBe(false);
      for (const c of ['canarydmalice', 'canarydmbob']) expect(bare.text).toContain(c);
      expect((await call('wide', 'get_page', { slug: PAGE_B, source_id: DM_B }, null)).text).toContain('canarydmbobpage');
    }, 120_000);

    test('an agent job submitted for an attested person on a person-read credential reads the same way: its own personal source, never another member\'s', async () => {
      const { clientId } = await provider().registerClientManual('personal-agent-' + randomUUID().slice(0, 8), ['client_credentials'], 'read', [], SRC);
      await bindCredential(engine, { kind: 'client', id: clientId }, { attestActor: 'qm', attestOps: ['get_page', 'query'], attestRead: 'person' });
      await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['get_page','query'], bound_source_id = source_id, federated_read = $2::text[], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_max_concurrent = 1 WHERE client_id = $1", [clientId, [SRC, DM_A, DM_B]]);
      const actor = { system: 'qm', external_id: ALICE_ID, member: 'alice-example' };
      const agentAuth = { token: 'x', clientId, scopes: ['read', 'agent'], sourceId: SRC, allowedSources: [SRC, DM_A, DM_B], principal: { kind: 'oauth_client', id: clientId } } as unknown as AuthInfo;
      const submitted = await withCallerAccess(await attestedCallerAccess(engine, actor, ['member:alice-example']),
        () => prepareRemoteAgent({ engine, auth: agentAuth, remote: true } as unknown as OperationContext, { source_id: SRC, allowed_tools: ['get_page', 'query'], allowed_slug_prefixes: [] }));
      const tools = buildBrainTools({ subagentId: 12, engine, config: { engine: 'pglite' } as never, sourceId: SRC,
        delegatedAuth: { clientId, scopes: ['read', 'agent'], sourceId: SRC, allowedSources: [SRC, DM_A, DM_B] } });
      const authority: RemoteAgentAuthority = { ...submitted, payloadHash: '0'.repeat(64) };
      const run = async (tool: string, input: Record<string, unknown>) => {
        try { return JSON.stringify(await withSubmissionAuthority(authority, () => tools.find(t => t.name === tool)!.execute(input, { engine, jobId: 1, remote: true } as never))); }
        catch (e) { return 'ERR ' + String((e as Error).message); }
      };
      expect(await run('brain_get_page', { slug: PAGE_A, source_id: DM_A })).toContain('canarydmalicepage');
      const theirs = await run('brain_get_page', { slug: PAGE_B, source_id: DM_B });
      expect(theirs).toContain('outside your granted sources');
      expect(theirs).not.toContain('canarydmbobpage');
      expect(await run('brain_get_page', { slug: PAGE_B })).not.toContain('canarydmbobpage');
      const found = await run('brain_query', { query: Q, limit: 20 });
      expect(found).toContain('canarydmalicepage');
      expect(found).not.toContain('canarydmbobpage');
    }, 120_000);

    test('a credential whose scalar source is another member\'s personal source neither reads nor writes there for the attested person: reads move to the kept grant, writes refuse', async () => {
      const memberPageIn = async (source: string, member: string) => Number((await engine.executeRaw<{ n: number | string }>(
        'SELECT count(*) AS n FROM pages WHERE source_id = $1 AND slug = $2', [source, 'memory/members/' + member]))[0]!.n);
      const factsIn = async (source: string, canary: string) => Number((await engine.executeRaw<{ n: number | string }>(
        "SELECT count(*) AS n FROM facts WHERE source_id = $1 AND fact LIKE '%' || $2 || '%'", [source, canary]))[0]!.n);
      expect((await verify(clients.bobdm!)).sourceId).toBe(DM_B);
      const page = await call('bobdm', 'get_page', { slug: PAGE_B });
      expect(page.isError).toBe(true);
      expect(page.all).not.toContain('canarydmbobpage');
      const wrote = await call('bobdm', 'memory_write', { facts: [{ fact: 'Alice note on the harbor tide charts canaryscalaralice', provenance: 'turn 2' }], idempotency_key: randomUUID() }, ALICE_ID, { writeWaitMs: 30_000 });
      expect({ isError: wrote.isError, status: wrote.structured?.status }).toEqual({ isError: true, status: undefined });
      expect(wrote.json.code).toBe('permission_denied');
      expect({ page: await memberPageIn(DM_B, 'alice-example'), facts: await factsIn(DM_B, 'canaryscalaralice') }).toEqual({ page: 0, facts: 0 });
      expect((await call('bobdm', 'get_page', { slug: PAGE_B }, BOB_ID)).text).toContain('canarydmbobpage');

      const first = await call('bobfirst', 'get_page', { slug: PAGE_B });
      expect(first.json.code).toBe('page_not_found');
      expect(first.all).not.toContain('canarydmbobpage');
      expect((await call('bobfirst', 'get_page', { slug: 'notes/world-example' })).text).toContain('canaryworldpage');
      const moved = await call('bobfirst', 'memory_write', { facts: [{ fact: 'Alice second note on the harbor tide charts canaryscalarfirst', provenance: 'turn 3' }], idempotency_key: randomUUID() }, ALICE_ID, { writeWaitMs: 30_000 });
      expect({ isError: moved.isError, code: moved.json.code, status: moved.structured?.status }).toEqual({ isError: true, code: 'scope_denied', status: undefined });
      expect({ dm: await factsIn(DM_B, 'canaryscalarfirst'), src: await factsIn(SRC, 'canaryscalarfirst'), page: await memberPageIn(DM_B, 'alice-example') }).toEqual({ dm: 0, src: 0, page: 0 });
      expect((await recall('bobfirst', ALICE_ID)).text).toContain('canarymemberalice');
    }, 120_000);

    test('bindings: add is idempotent and previews with dryRun; remove previews, says when the source stops being personal, and applies with apply', async () => {
      expect(await bindMemberSource(engine, 'alice-example', DM_A)).toMatchObject({ applied: false, changed: false, owners: ['alice-example'] });
      expect(await bindMemberSource(engine, 'carol-example', DM_A, { dryRun: true })).toMatchObject({ applied: false, changed: true, owners: ['alice-example', 'carol-example'] });
      expect((await listMemberSources(engine)).map(b => [b.member_id, b.source_id])).toEqual([['alice-example', DM_A], ['bob-example', DM_B]]);
      expect((await listMemberSources(engine, { member: 'bob-example' })).map(b => b.source_id)).toEqual([DM_B]);
      await expect(bindMemberSource(engine, 'alice-example', 'source-missing')).rejects.toMatchObject({ code: 'unknown_source' });
      await expect(bindMemberSource(engine, 'nobody-example', DM_A)).rejects.toMatchObject({ code: 'access_member_invalid' });
      await expect(unbindMemberSource(engine, 'carol-example', DM_A)).rejects.toMatchObject({ code: 'invalid_params' });
      const preview = await unbindMemberSource(engine, 'bob-example', DM_B);
      expect(preview).toMatchObject({ applied: false, still_personal: false, owners: [] });
      expect((await listMemberSources(engine, { member: 'bob-example' })).length).toBe(1);
      await addMember(engine, 'dora-example');
      await bindMemberSource(engine, 'dora-example', DM_B);
      expect(await unbindMemberSource(engine, 'dora-example', DM_B, { apply: true })).toMatchObject({ applied: true, still_personal: true, owners: ['bob-example'] });
      await removeMember(engine, 'dora-example');
      await expect(bindMemberSource(engine, 'dora-example', DM_B)).rejects.toMatchObject({ code: 'access_member_invalid' });
      expect((await recall('wide', ALICE_ID)).all).not.toContain('canarydmbob');
    }, 120_000);
  });
}
