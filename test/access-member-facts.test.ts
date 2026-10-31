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
import { configureGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { __resetHotMemoryCacheForTests, getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
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
const ATTEST_OPS = ['context_pack', 'delta', 'get_page', 'get_write_request', 'list_write_requests', 'recall', 'remember', 'search', 'whoami'];

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

    afterAll(async () => { await close?.(); });

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

    test('delta: Alice then Bob on one session id keep separate cursors', async () => {
      const session = 'delta-session-' + randomUUID().slice(0, 6);
      const first = await call(who.alice(), 'delta', { session_id: session });
      expect(first.isError).toBe(false);
      expect(first.all).toContain('started this session');
      const bob = await call(who.bob(), 'delta', { session_id: session });
      expect(bob.isError).toBe(false);
      expect(bob.all).toContain('started this session');
      const bobAgain = await call(who.bob(), 'delta', { session_id: session });
      expect(bobAgain.all).not.toContain(CANARY.alice);
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
      const replay = await remember(who.bob(), 'Alice signs the harbor charter ' + CANARY.alice + 'r', { request_id: requestId });
      expect(replay.isError).toBe(true);
      expect(replay.all).not.toContain('"id":"' + factId + '"');
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
      for (const n of ['one', 'two', 'three']) {
        expect((await remember(who.alice(), `Acme example harbor ledger launch slips to spring ${CANARY.alice}take ${n}`, { entity: ACME })).isError).toBe(false);
      }
      const result = await runPhaseConsolidate(engine, { sourceId: SRC, minOldestAgeMs: 0, minFactsPerBucket: 2 });
      expect(result.status).not.toBe('fail');
      const takes = await engine.executeRaw<{ claim: string }>('SELECT t.claim FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.source_id = $1', [SRC]);
      expect(takes.map(t => t.claim).join('\n')).not.toContain(CANARY.alice);
    }, 60_000);
  });
}
