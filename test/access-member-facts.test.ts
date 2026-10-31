/**
 * GST-359 C2: member facts and member-scoped reads.
 *
 * 1. Protects: a fact a member saves remotely (as an attested actor or through a credential bound to the member)
 *    lands on that member's own page, memory/members/<member> (readable_by the member alone, created by the first
 *    fact, the entity kept as metadata), as a private row. Only that member reads it back: recall, hot memory and
 *    delta admit it for its owner, and no other member, the bare attest client or an unbound credential reads it by
 *    any path, the operator hatch included. Caches and session state keyed on the caller (hot memory, the delta
 *    cursor, write receipts) never cross from one person to another behind one credential and one session id.
 *    Dedup never merges two members' facts. A fence rebuild, relink and consolidation keep the fact on its page.
 * 2. Fails when: a member fact lands on the entity page or as a world row, another member or the bare client reads
 *    it, a hot-memory payload, delta cursor or receipt warmed by Alice is served to Bob, Bob's identical fact
 *    deduplicates into Alice's, a re-import widens the row, or consolidation writes it as a take on the entity page.
 * 3. Existing coverage: test/access-qm-actor.test.ts (C1) pins the actor itself; test/member-read-access.test.ts
 *    the page matrix. The all-ops sweep is test/access-member-sweep.test.ts.
 * 4. Real seams: OAuth clients issued tokens by the provider's client-credentials grant, verified by the provider,
 *    dispatched through MCP dispatch on a repo-less brain; remember goes through the persistence coordinator;
 *    embeddings stubbed.
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
import { __resetHotMemoryCacheForTests, getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { memberPageSlug } from '../src/core/access/member-facts.ts';
import { decideSingleFact, type SingleFactIntent } from '../src/core/facts/single-prepare.ts';
import { prepareMemoryMutation } from '../src/core/persistence/memory-prepare.ts';
import { runFactsRelink } from '../src/core/facts/relink.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';

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

const SRC = 'qm-members';
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'bob-example@acme.test';
const ACME = 'companies/acme-example';
const CANARY = { alice: 'canaryfactalice', bob: 'canaryfactbob' } as const;
const ATTEST_OPS = ['cancel_write_request', 'context_pack', 'delete_page', 'delta', 'edit_page', 'get_page', 'get_write_request', 'list_write_requests', 'put_page', 'recall', 'remember', 'search', 'whoami'];

for (const kind of testBackends()) {
  describe('member facts and member-scoped reads (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;

    type Who = { token: string; actor?: string };
    const who = {
      alice: (): Who => ({ token: 'qm', actor: ALICE_ID }),
      bob: (): Who => ({ token: 'qm', actor: BOB_ID }),
      bobToken: (): Who => ({ token: 'bob' }),
      bare: (): Who => ({ token: 'qm' }),
      unbound: (): Who => ({ token: 'plain' }),
    };
    async function call(as: Who, op: string, params: Record<string, unknown>, extra: { sessionId?: string } = {}) {
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth: await verify(tokens[as.token]!), sourceId: SRC, takesHoldersAllowList: ['world'],
        ...(as.actor !== undefined ? { actor: { header: as.actor } } : {}),
        ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
        metaHook: (name, ctx) => getBrainHotMemoryMeta(name, ctx),
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json, meta: out._meta, all: text + JSON.stringify(out._meta ?? {}) + JSON.stringify(out.structuredContent ?? {}) };
    }
    const remember = (as: Who, fact: string, extra: Record<string, unknown> = {}) => call(as, 'remember', { fact, provenance: 'qm test', ...extra });

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      __resetHotMemoryCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example']) await addMember(engine, id);
      await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.', { sourceId: SRC });
      const register = async (name: string) => {
        const c = await provider().registerClientManual('c2-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        return { id: c.clientId, secret: c.clientSecret ?? '' };
      };
      const qm = await register('qm');
      await bindCredential(engine, { kind: 'client', id: qm.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      const bob = await register('bob');
      await bindCredential(engine, { kind: 'client', id: bob.id }, { member: 'bob-example' });
      const plain = await register('plain');
      for (const [name, c] of [['qm', qm], ['bob', bob], ['plain', plain]] as const) tokens[name] = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
    }, 120_000);

    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });

    test('an attested member fact lands private on the member page, created by it, with the entity kept as metadata', async () => {
      const out = await remember(who.alice(), 'Alice prefers oolong for harbor reviews ' + CANARY.alice, { entity: ACME, visibility: 'world' });
      expect(out.isError).toBe(false);
      expect(out.json.status).toBe('inserted');
      const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT visibility, source_markdown_slug, entity_slug, row_num FROM facts WHERE fact LIKE $1', ['%' + CANARY.alice + '%']);
      expect(row).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/alice-example', entity_slug: ACME });
      const [pageRow] = await engine.executeRaw<{ page_readers: string[]; compiled_truth: string }>('SELECT page_readers, compiled_truth FROM pages WHERE source_id = $1 AND slug = $2', [SRC, 'memory/members/alice-example']);
      expect(pageRow!.page_readers).toEqual(['member:alice-example']);
      expect(pageRow!.compiled_truth).toContain(CANARY.alice);
      const acme = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id = $1 AND slug = $2', [SRC, ACME]);
      expect(acme[0]!.compiled_truth).not.toContain(CANARY.alice);
    }, 60_000);

    test('a member-bound credential writes to its own member page too', async () => {
      const out = await remember(who.bobToken(), 'Bob keeps the harbor keys ' + CANARY.bob, { entity: ACME });
      expect(out.isError).toBe(false);
      const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT visibility, source_markdown_slug FROM facts WHERE fact LIKE $1', ['%' + CANARY.bob + '%']);
      expect(row).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/bob-example' });
    }, 60_000);

    test('each member recalls only its own facts; the bare client and an unbound credential recall neither', async () => {
      const mine = await call(who.alice(), 'recall', { query: 'harbor' });
      expect(mine.all).toContain(CANARY.alice);
      expect(mine.all).not.toContain(CANARY.bob);
      const bobs = await call(who.bobToken(), 'recall', { query: 'harbor' });
      expect(bobs.all).toContain(CANARY.bob);
      expect(bobs.all).not.toContain(CANARY.alice);
      for (const as of [who.bob(), who.bare(), who.unbound()]) {
        for (const params of [{ query: 'harbor' }, { entity: ACME }, { since: '2000-01-01' }]) {
          const out = await call(as, 'recall', params);
          expect(out.all).not.toContain(CANARY.alice);
        }
      }
    }, 60_000);

    test('another member never reads the fact through the member page, the entity page, search or context_pack', async () => {
      for (const as of [who.bob(), who.bobToken(), who.bare(), who.unbound()]) {
        for (const [op, params] of [['get_page', { slug: 'memory/members/alice-example' }], ['get_page', { slug: ACME }], ['search', { query: CANARY.alice }],
          ['search', { query: 'oolong harbor' }], ['context_pack', { query: 'harbor oolong', entities: [ACME] }], ['whoami', {}]] as const) {
          const out = await call(as, op, params as Record<string, unknown>);
          expect(out.all).not.toContain(CANARY.alice);
        }
      }
      expect((await call(who.alice(), 'get_page', { slug: 'memory/members/alice-example' })).all).toContain(CANARY.alice);
    }, 120_000);

    test('a member reads only private facts on its own live member page, never an operator\'s private fact or a page-less member slug', async () => {
      const operator = 'canaryoperatorprivate harbor ledger budget';
      const orphan = 'canaryorphanmember harbor ledger budget';
      await engine.insertFact({ fact: operator, kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'private' }, { source_id: SRC });
      await engine.insertFact({ fact: orphan, kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'private' }, { source_id: SRC });
      await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact = $2', ['memory/members/carol-example', orphan]);
      for (const hatch of [undefined, '1']) {
        await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: hatch }, async () => {
          __resetPrivateVisibilityCacheForTests();
          for (const as of [who.alice(), who.bob(), who.bobToken(), who.bare(), who.unbound()]) {
            for (const params of [{ query: 'harbor ledger budget' }, { entity: ACME }, { since: '2000-01-01' }]) {
              const out = await call(as, 'recall', params);
              expect(out.all).not.toContain('canaryoperatorprivate');
              expect(out.all).not.toContain('canaryorphanmember');
            }
          }
        });
      }
      __resetPrivateVisibilityCacheForTests();
    }, 60_000);

    test('a member stops reading its own facts once its page\'s readers no longer name it', async () => {
      const bobPage = 'memory/members/bob-example';
      await engine.executeRaw(`UPDATE pages SET frontmatter = jsonb_set(frontmatter, '{readable_by}', '["group:team-a"]'::jsonb) WHERE source_id = $1 AND slug = $2`, [SRC, bobPage]);
      __resetPrivateVisibilityCacheForTests();
      const [narrowed] = await engine.executeRaw<{ page_readers: string[] }>('SELECT page_readers FROM pages WHERE source_id = $1 AND slug = $2', [SRC, bobPage]);
      expect(narrowed!.page_readers).toEqual(['group:team-a']);
      try {
        for (const hatch of [undefined, '1']) {
          await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: hatch }, async () => {
            __resetPrivateVisibilityCacheForTests();
            for (const params of [{ query: 'harbor' }, { entity: ACME }, { since: '2000-01-01' }]) expect((await call(who.bobToken(), 'recall', params)).all).not.toContain(CANARY.bob);
          });
        }
      } finally {
        await engine.executeRaw("UPDATE pages SET frontmatter = jsonb_set(frontmatter, '{readable_by}', jsonb_build_array('member:bob-example')) WHERE source_id = $1 AND slug = $2", [SRC, bobPage]);
        __resetPrivateVisibilityCacheForTests();
      }
      expect((await call(who.bobToken(), 'recall', { query: 'harbor' })).all).toContain(CANARY.bob);
    }, 60_000);

    test('the operator hatch on: an attested or member-bound caller still never reads another member\'s fact', async () => {
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        __resetPrivateVisibilityCacheForTests();
        __resetHotMemoryCacheForTests();
        for (const as of [who.bob(), who.bobToken(), who.bare(), who.unbound()]) {
          for (const [op, params] of [['recall', { query: 'harbor' }], ['recall', { entity: ACME }], ['get_page', { slug: 'memory/members/alice-example' }], ['search', { query: CANARY.alice }]] as const) {
            expect((await call(as, op, params as Record<string, unknown>)).all).not.toContain(CANARY.alice);
          }
        }
      });
      __resetPrivateVisibilityCacheForTests();
    }, 60_000);

    test('hot memory: Alice then Bob on one session id never share a payload', async () => {
      __resetHotMemoryCacheForTests();
      const session = 'shared-session-' + randomUUID().slice(0, 6);
      const a = await call(who.alice(), 'get_page', { slug: ACME }, { sessionId: session });
      expect(JSON.stringify(a.meta?.brain_hot_memory ?? {})).toContain(CANARY.alice);
      const b = await call(who.bob(), 'get_page', { slug: ACME }, { sessionId: session });
      expect(JSON.stringify(b.meta ?? {})).not.toContain(CANARY.alice);
      const bare = await call(who.bare(), 'get_page', { slug: ACME }, { sessionId: session });
      expect(JSON.stringify(bare.meta ?? {})).not.toContain(CANARY.alice);
    }, 60_000);

    test('delta: Alice, Bob and the bare client on one session id keep separate cursors, and only Alice sees her new fact', async () => {
      const session = 'delta-session-' + randomUUID().slice(0, 6);
      for (const as of [who.alice(), who.bob(), who.bare()]) {
        const first = await call(as, 'delta', { session_id: session });
        expect(first.isError).toBe(false);
        expect(first.all).toContain('started this session');
      }
      expect((await remember(who.alice(), 'Alice moves the harbor review to friday ' + CANARY.alice + 'delta')).isError).toBe(false);
      expect((await call(who.alice(), 'delta', { session_id: session })).all).toContain(CANARY.alice + 'delta');
      for (const as of [who.bob(), who.bare()]) {
        const later = await call(as, 'delta', { session_id: session });
        expect(later.isError).toBe(false);
        expect(later.all).not.toContain(CANARY.alice);
      }
    }, 60_000);

    test('receipts: Alice\'s write receipt is invisible to Bob and the bare client, and her request_id never replays for Bob', async () => {
      const requestId = 'c2-receipt-' + randomUUID().slice(0, 6);
      const written = await remember(who.alice(), 'Alice signs the harbor charter ' + CANARY.alice + 'r', { request_id: requestId });
      expect(written.isError).toBe(false);
      const factId = String(written.json.id);
      expect((await call(who.alice(), 'get_write_request', { request_id: requestId })).isError).toBe(false);
      for (const as of [who.bob(), who.bare()]) {
        const got = await call(as, 'get_write_request', { request_id: requestId });
        expect(got.isError).toBe(true);
        expect(got.json.code ?? got.json.error).toMatch(/not_found/);
        const listed = await call(as, 'list_write_requests', {});
        expect(listed.all).not.toContain(requestId);
      }
      expect((await call(who.alice(), 'list_write_requests', {})).all).toContain(requestId);
      for (const as of [who.bob(), who.bare()]) {
        const cancelled = await call(as, 'cancel_write_request', { request_id: requestId });
        expect({ isError: cancelled.isError, code: cancelled.json.code ?? cancelled.json.error }).toEqual({ isError: true, code: 'not_found' });
      }
      const own = await call(who.alice(), 'cancel_write_request', { request_id: requestId });
      expect(own.json.code ?? own.json.error ?? own.json.state).not.toBe('not_found');
      const replay = await remember(who.bob(), 'Alice signs the harbor charter ' + CANARY.alice + 'r', { request_id: requestId });
      expect(replay.isError).toBe(true);
      expect(replay.all).not.toContain('"id":"' + factId + '"');
      // A write on a page both can read: the receipt still belongs to the person it was written for.
      const shared = 'c2-shared-' + randomUUID().slice(0, 6);
      const content = '---\ntype: note\ntitle: Shared harbor plan\n---\n# Shared harbor plan\n\nShared plan ' + shared + '.';
      expect((await call(who.alice(), 'put_page', { slug: 'notes/' + shared, content, request_id: shared })).isError).toBe(false);
      expect((await call(who.alice(), 'get_write_request', { request_id: shared })).isError).toBe(false);
      for (const as of [who.bob(), who.bare()]) {
        const got = await call(as, 'get_write_request', { request_id: shared });
        expect({ isError: got.isError, code: got.json.code ?? got.json.error }).toEqual({ isError: true, code: 'not_found' });
        expect((await call(as, 'list_write_requests', {})).all).not.toContain(shared);
      }
      const bobReplay = await call(who.bob(), 'put_page', { slug: 'notes/' + shared, content, request_id: shared });
      expect(bobReplay.isError).toBe(true);
      expect(bobReplay.json.code ?? bobReplay.json.error).toBe('idempotency_conflict');
    }, 60_000);

    test('agent jobs: Alice\'s job is hers alone, and two people\'s identical submissions never share a job', async () => {
      const reg = await provider().registerClientManual('c2-agent-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await engine.executeRaw("UPDATE oauth_clients SET scope = 'read write agent', bound_tools = $2, bound_source_id = source_id, federated_read = ARRAY[source_id], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_max_concurrent = 5 WHERE client_id = $1", [reg.clientId, ['get_page', 'search']]);
      await bindCredential(engine, { kind: 'client', id: reg.clientId }, { attestActor: 'qm', attestOps: ['get_agent_job', 'get_page', 'submit_agent'] });
      tokens.agent = (await provider().exchangeClientCredentials(reg.clientId, reg.clientSecret!)).access_token;
      const as = { alice: { token: 'agent', actor: ALICE_ID }, bob: { token: 'agent', actor: BOB_ID }, bare: { token: 'agent' } };
      const prompt = 'Summarize the harbor ledger notes';
      const ids: Record<string, number> = {};
      for (const [name, caller] of Object.entries(as)) {
        const out = await call(caller, 'submit_agent', { prompt });
        expect(out.isError, out.text).toBe(false);
        expect(out.json.coalesced).toBeUndefined();
        ids[name] = Number(out.json.id);
      }
      expect(new Set(Object.values(ids)).size).toBe(3);
      const canary = 'canaryagentjobalice';
      await engine.executeRaw("UPDATE minion_jobs SET status = 'completed', result = jsonb_build_object('text', $2::text), finished_at = now() WHERE id = $1", [ids.alice, canary]);
      expect((await call(as.alice, 'get_agent_job', { id: ids.alice })).all).toContain(canary);
      for (const caller of [as.bob, as.bare]) {
        const got = await call(caller, 'get_agent_job', { id: ids.alice });
        expect({ isError: got.isError, code: got.json.code ?? got.json.error }).toEqual({ isError: true, code: 'not_found' });
        expect(got.all).not.toContain(canary);
      }
      expect((await call(as.bob, 'get_agent_job', { id: ids.bob })).isError).toBe(false);
      expect((await call(as.bare, 'get_agent_job', { id: ids.bare })).isError).toBe(false);
      // The agent-scoped job reads and cancel (no header: the client's own lane) never reach a person's job.
      for (const [op, params] of [['get_job', {}], ['wait_job', { timeout_s: 1 }], ['get_job_progress', {}], ['cancel_job', {}]] as const) {
        const got = await call(as.bare, op, { id: ids.alice, ...params });
        expect({ op, isError: got.isError, code: got.json.code ?? got.json.error }).toMatchObject({ op, isError: true });
        expect(got.all).not.toContain(canary);
        expect(got.all).not.toContain(prompt);
      }
      for (const params of [{}, { status: 'completed' }, { finished_since: '0:0' }]) {
        const listed = await call(as.bare, 'list_jobs', params);
        expect(listed.isError, listed.text).toBe(false);
        expect(listed.all).not.toContain(canary);
        expect(listed.all).not.toContain('"id":' + ids.alice + ',');
      }
      expect((await call(as.bare, 'get_job', { id: ids.bare })).isError).toBe(false);
      expect((await call(as.bare, 'list_jobs', {})).all).toContain('"id":' + ids.bare + ',');
      const [state] = await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [ids.alice]);
      expect(state!.status).toBe('completed');
      const [bobState] = await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [ids.bob]);
      expect((await call(as.bare, 'cancel_job', { id: ids.bob })).isError).toBe(true);
      expect((await engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [ids.bob]))[0]!.status).toBe(bobState!.status);
    }, 60_000);

    test('member pages: nobody else writes one remotely, and a squatted or widened page takes no member fact', async () => {
      const CAROL_ID = 'U0CAROL';
      const DAVE_ID = 'U0DAVE';
      for (const [id, ext] of [['carol-example', CAROL_ID], ['dave-example', DAVE_ID]] as const) {
        await addMember(engine, id);
        await linkMember(engine, id, 'qm', ext);
      }
      const carol = { token: 'qm', actor: CAROL_ID };
      const dave = { token: 'qm', actor: DAVE_ID };
      const squat = '---\ntype: note\ntitle: Memory of carol-example\nreadable_by:\n  - member:bob-example\n  - member:carol-example\n---\n# Memory of carol-example\n';
      for (const as of [who.bob(), who.bobToken(), who.bare()]) {
        const put = await call(as, 'put_page', { slug: 'memory/members/carol-example', content: '---\ntype: note\ntitle: Squat\n---\n# Squat\n' });
        expect({ isError: put.isError, code: put.json.code ?? put.json.error }).toEqual({ isError: true, code: 'permission_denied' });
        const edit = await call(as, 'edit_page', { slug: 'memory/members/alice-example', expected_revision: '00000000-0000-0000-0000-000000000000', edits: [{ old_text: 'Memory', new_text: 'Mine' }] });
        expect({ isError: edit.isError, code: edit.json.code ?? edit.json.error }).toEqual({ isError: true, code: 'permission_denied' });
        const del = await call(as, 'delete_page', { slug: 'memory/members/alice-example' });
        expect({ isError: del.isError, code: del.json.code ?? del.json.error }).toEqual({ isError: true, code: 'permission_denied' });
      }
      const [alicePage] = await engine.executeRaw<{ deleted_at: unknown; page_readers: string[] }>('SELECT deleted_at, page_readers FROM pages WHERE source_id = $1 AND slug = $2', [SRC, 'memory/members/alice-example']);
      expect(alicePage).toMatchObject({ deleted_at: null, page_readers: ['member:alice-example'] });
      expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug = $2', [SRC, 'memory/members/carol-example'])).toHaveLength(0);
      // A page squatted before Carol's first fact (readers Bob and Carol) takes none of her facts.
      await importFromContent(engine, 'memory/members/carol-example', squat, { sourceId: SRC });
      const squatId = 'c2-squat-' + randomUUID().slice(0, 6);
      const squatted = await remember(carol, 'Carol keeps the harbor ledger key canarycarolsquat', { request_id: squatId });
      // remember answers in its verb contract: an authorization refusal is scope_denied.
      expect({ isError: squatted.isError, code: squatted.json.code, message: squatted.json.message }).toMatchObject({ isError: true, code: 'scope_denied', message: expect.stringContaining('does not name its member alone') });
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE fact LIKE $1', ['%canarycarolsquat%'])).toHaveLength(0);
      // Refused at submission: nothing was accepted, so there is no receipt.
      expect((await call(carol, 'get_write_request', { request_id: squatId })).json.code).toBe('not_found');
      // Dave's page later made world: his next fact is refused, never saved where every reader recalls it.
      expect((await remember(dave, 'Dave books the harbor dock canarydaveone')).isError).toBe(false);
      await importFromContent(engine, 'memory/members/dave-example', '---\ntype: note\ntitle: Memory of dave-example\n---\n# Memory of dave-example\n', { sourceId: SRC });
      const widened = await remember(dave, 'Dave books the harbor crane canarydavetwo');
      expect({ isError: widened.isError, code: widened.json.code, message: widened.json.message }).toMatchObject({ isError: true, code: 'scope_denied', message: expect.stringContaining('does not name its member alone') });
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE fact LIKE $1', ['%canarydavetwo%'])).toHaveLength(0);
    }, 120_000);

    test('preparation refuses a member fact once its page no longer names that member alone', async () => {
      const slug = 'memory/members/erin-example';
      await importFromContent(engine, slug, '---\ntype: note\ntitle: Memory of erin-example\nreadable_by:\n  - member:bob-example\n  - member:erin-example\n---\n# Memory of erin-example\n', { sourceId: SRC });
      const row = { operation: 'remember', request_id: 'c2-prepare-' + randomUUID().slice(0, 6), source_id: SRC, slug, page_id: null,
        intent: { fact: 'Erin signs the harbor lease canaryerinprep', kind: 'fact', visibility: 'private', entity_slug: null, fence: true, member_page: true, valid_from: new Date().toISOString() } };
      await expect(prepareMemoryMutation(engine, row as never, {} as never)).rejects.toMatchObject({ code: 'permission_denied' });
    }, 60_000);

    test('a member id whose page slug a repo brain would rename holds no member facts', async () => {
      for (const id of ['frank--example', 'gina-']) {
        await addMember(engine, id);
        await linkMember(engine, id, 'qm', 'U0' + id.replace(/[^a-z]/g, '').toUpperCase());
        const out = await remember({ token: 'qm', actor: 'U0' + id.replace(/[^a-z]/g, '').toUpperCase() }, 'A harbor fact canaryslug' + id.length);
        expect({ isError: out.isError, code: out.json.code ?? out.json.error }).toEqual({ isError: true, code: 'invalid_params' });
        expect(await engine.executeRaw('SELECT 1 FROM pages WHERE source_id = $1 AND slug LIKE $2', [SRC, 'memory/members/' + id.slice(0, 4) + '%'])).toHaveLength(0);
      }
    }, 60_000);

    test('two members saving the same words get two facts, each on its own page', async () => {
      const words = 'I like jasmine tea at the harbor canarydupword';
      const a = await remember(who.alice(), words);
      const b = await remember(who.bobToken(), words);
      expect(a.json.status).toBe('inserted');
      expect(b.json.status).toBe('inserted');
      expect(b.json.id).not.toBe(a.json.id);
      const rows = await engine.executeRaw<{ source_markdown_slug: string }>('SELECT source_markdown_slug FROM facts WHERE fact = $1 AND expired_at IS NULL ORDER BY id', [words]);
      expect(rows.map(r => r.source_markdown_slug)).toEqual(['memory/members/alice-example', 'memory/members/bob-example']);
      expect((await remember(who.alice(), words)).json.id).toBe(a.json.id);
    }, 60_000);

    test('a member fact never supersedes or dedups against another page\'s fact about the same entity', async () => {
      const model = 'synthetic:c2-member';
      await engine.setConfig('facts.supersession_thresholds', JSON.stringify({ [`${model}@${DIMS}`]: 0.95 }));
      const embedding = new Float32Array(DIMS);
      embedding[0] = 1;
      const fact = 'Acme example renews its harbor ledger contract for two more years';
      await engine.insertFact({ fact, kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'private', embedding, embedding_model: model }, { source_id: SRC });
      await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact = $2', [ACME, fact]);
      const intent = { fact: fact + ' again', kind: 'fact', entity_slug: ACME, visibility: 'private', page_slug: memberPageSlug('alice-example') } as SingleFactIntent;
      expect((await decideSingleFact(engine, SRC, intent, embedding, model)).status).toBe('inserted');
      expect((await decideSingleFact(engine, SRC, { ...intent, page_slug: undefined }, embedding, model)).status).not.toBe('inserted');
    }, 60_000);

    test('a fence rebuild keeps the member fact private on its page; relink and consolidation leave it there', async () => {
      const snap = await engine.readPageSnapshot('memory/members/alice-example', { sourceId: SRC });
      const markdown = serializePageToMarkdown(snap!.page, snap!.tags);
      expect((await importFromContent(engine, 'memory/members/alice-example', markdown.replace('# Memory of alice-example', '# Memory of alice-example\n\nEdited by hand.'), { sourceId: SRC })).status).toBe('imported');
      const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT visibility, source_markdown_slug FROM facts WHERE fact LIKE $1 AND expired_at IS NULL', ['%oolong%' + CANARY.alice]);
      expect(row).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/alice-example' });
      __resetHotMemoryCacheForTests();
      expect((await call(who.bob(), 'recall', { query: 'harbor' })).all).not.toContain(CANARY.alice);
      expect((await call(who.alice(), 'recall', { query: 'harbor' })).all).toContain(CANARY.alice);
      await withEnv({ ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined }, () => runFactsRelink(engine, { sourceId: SRC, llm: false, config: {} as never }));
      const after = await engine.executeRaw<Record<string, unknown>>('SELECT source_markdown_slug FROM facts WHERE fact LIKE $1', ['%' + CANARY.alice + '%']);
      expect(after.every(r => r.source_markdown_slug === 'memory/members/alice-example')).toBe(true);
    }, 60_000);

    test('consolidation never turns member facts into takes on the entity page', async () => {
      const BETA = 'companies/beta-example';
      await importFromContent(engine, BETA, '---\ntype: company\ntitle: Beta Example\n---\n# Beta Example\n\nBeta example ships ledgers.', { sourceId: SRC });
      expect((await remember(who.alice(), 'Beta example ledger launch slips to spring quarter ' + CANARY.alice + 'take', { entity: BETA })).isError).toBe(false);
      const local = await dispatchToolCall(engine, 'remember', { fact: 'Beta example ledger launch slips to spring quarter controltake', provenance: 'operator', entity: BETA }, { remote: false, sourceId: SRC });
      expect(local.isError).not.toBe(true);
      // Two more copies of each (the write path would dedup them), so each page holds a cluster of three.
      for (let n = 0; n < 2; n++) {
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, confidence, embedding, embedding_model, embedded_text_hash, valid_from)
          SELECT source_id, entity_slug, fact, kind, visibility, notability, source, source_markdown_slug, confidence, embedding, embedding_model, embedded_text_hash, valid_from - interval '1 day'
          FROM facts WHERE entity_slug = $1 AND row_num IS NOT NULL`, [BETA]);
      }
      await engine.executeRaw("UPDATE facts SET valid_from = valid_from - interval '3 days' WHERE entity_slug = $1", [BETA]);
      const result = await runPhaseConsolidate(engine, { sourceId: SRC, minOldestAgeMs: 0, minFactsPerBucket: 2 });
      expect(result.status).not.toBe('fail');
      const takes = (await engine.executeRaw<{ claim: string }>('SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1', [SRC])).map(t => t.claim).join('\n');
      expect(takes).toContain('controltake');
      expect(takes).not.toContain(CANARY.alice);
    }, 60_000);
  });
}
