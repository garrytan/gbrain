/**
 * GST-359 C2: the all-ops member sweep (dispatch, both engines).
 *
 * 1. Protects: no registered operation, read, write or agent, and no _meta channel riding a response (hot memory,
 *    access), returns one member's fact or readers page to another member, to the bare attest client or to an unbound
 *    credential, with and without the operator hatch. A new operation that reads facts or pages without the member
 *    predicates fails here, so the next tool cannot regress it.
 * 2. Fails when: any operation's text, structuredContent or _meta carries Alice's canary for Bob (as an attested actor
 *    or through his member-bound credential), the bare attest client or an unbound credential; or a sweep write by
 *    Bob changes Alice's member page.
 * 3. Existing coverage: test/access-member-facts.test.ts pins each path by name; this sweeps the whole registry.
 * 4. Real seams: dispatch with provider-issued client-credentials tokens on a repo-less brain; writes through the
 *    persistence coordinator; embeddings stubbed, no chat provider key.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { __resetHotMemoryCacheForTests, getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { attestableOp, linkMember } from '../src/core/access/actor.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { sweepArgs, type SweepFixture } from './helpers/member-sweep.ts';

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

const SRC = 'qm-sweep';
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'oidc:3f2a:bob-example';
const ACME = 'companies/acme-example';
const CANARY = 'canarysweepalice';
const PAGE_CANARY = 'canarysweeppagealice';
const NO_KEYS = { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, VOYAGE_API_KEY: undefined, GOOGLE_API_KEY: undefined };
const OP_TIMEOUT_MS = 20_000;

for (const kind of testBackends()) {
  describe('all-ops member sweep (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    let fixture: SweepFixture;

    type Who = { label: string; token: string; actor?: string };
    const CALLERS: Who[] = [
      { label: 'bob as attested actor', token: 'qm', actor: BOB_ID },
      { label: 'bob member-bound credential', token: 'bob' },
      { label: 'bare attest client', token: 'qm' },
      { label: 'unbound credential', token: 'plain' },
    ];
    async function call(as: Who, op: string, params: Record<string, unknown>): Promise<{ ok: boolean; all: string }> {
      const auth = await provider().verifyAccessToken(tokens[as.token]!) as unknown as AuthInfo;
      const run = dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], sessionId: fixture.sessionId,
        ...(as.actor !== undefined ? { actor: { header: as.actor } } : {}),
        metaHook: (name, ctx) => getBrainHotMemoryMeta(name, ctx),
      }).then(out => ({ ok: out.isError !== true, all: out.content.map(c => c.text).join('\n') + JSON.stringify(out._meta ?? {}) + JSON.stringify(out.structuredContent ?? {}) }),
        (e: unknown) => ({ ok: false, all: e instanceof Error ? e.message : String(e) }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<{ ok: boolean; all: string }>(resolve => { timer = setTimeout(() => resolve({ ok: false, all: 'timeout' }), OP_TIMEOUT_MS); });
      try { return await Promise.race([run, timeout]); } finally { clearTimeout(timer); }
    }

    async function sweep(callers: Who[], opts: { readsOnly?: boolean } = {}): Promise<{ leaks: string[]; ran: number; revealing: Set<string> }> {
      const leaks: string[] = [];
      const revealing = new Set<string>();
      let ran = 0;
      for (const op of operations) {
        // The owner's non-vacuity sweep only reads: an attested forget (GST-359 D) would withdraw the owner's own canary.
        if (opts.readsOnly && op.mutating) continue;
        for (const args of sweepArgs(op, fixture)) {
          for (const as of callers) {
            const out = await call(as, op.name, args);
            if (out.ok) ran += 1;
            if (out.all.includes(CANARY) || out.all.includes(PAGE_CANARY)) { revealing.add(op.name); leaks.push(op.name + ' as ' + as.label + ' ' + JSON.stringify(args)); }
          }
        }
      }
      return { leaks, ran, revealing };
    }

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
      await importFromContent(engine, 'notes/alice-only', '---\ntype: note\ntitle: Alice harbor notes\nreadable_by: [alice-example]\n---\n# Alice harbor notes\n\nOolong harbor ledger draft ' + PAGE_CANARY + ' about [Acme Example](../companies/acme-example.md).', { sourceId: SRC });
      const register = async (name: string) => {
        const c = await provider().registerClientManual('c2s-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        return { id: c.clientId, secret: c.clientSecret ?? '' };
      };
      const qm = await register('qm');
      await bindCredential(engine, { kind: 'client', id: qm.id }, { attestActor: 'qm', attestOps: operations.filter(op => attestableOp(op.name, op)).map(op => op.name) });
      const bob = await register('bob');
      await bindCredential(engine, { kind: 'client', id: bob.id }, { member: 'bob-example' });
      const plain = await register('plain');
      for (const [name, c] of [['qm', qm], ['bob', bob], ['plain', plain]] as const) tokens[name] = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
      fixture = { sourceId: SRC, memberSlug: 'memory/members/alice-example', entitySlug: ACME, entityName: 'Acme Example', words: 'oolong harbor ledger', factId: '0', requestId: 'c2-sweep-' + randomUUID().slice(0, 6), sessionId: 'sweep-session' };
      const saved = await call({ label: 'alice', token: 'qm', actor: ALICE_ID }, 'remember',
        { fact: 'Alice drafts the oolong harbor ledger ' + CANARY, provenance: 'sweep', entity: ACME, request_id: fixture.requestId });
      expect(saved.ok).toBe(true);
      const [fact] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE fact LIKE $1', ['%' + CANARY]);
      fixture.factId = String(fact!.id);
    }, 120_000);

    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });

    test('the canary is reachable by its owner (the sweep is not vacuous)', async () => {
      const alice: Who = { label: 'alice', token: 'qm', actor: ALICE_ID };
      expect((await call(alice, 'recall', { query: fixture.words })).all).toContain(CANARY);
      expect((await call(alice, 'get_page', { slug: fixture.memberSlug })).all).toContain(CANARY);
      expect((await call(alice, 'get_page', { slug: 'notes/alice-only' })).all).toContain(PAGE_CANARY);
      const { revealing } = await withEnv(NO_KEYS, () => sweep([alice], { readsOnly: true }));
      for (const op of ['recall', 'get_page', 'get_chunks', 'search', 'query']) expect(revealing).toContain(op);
    }, 1_800_000);

    test('no operation returns Alice\'s fact or readers page to Bob, the bare attest client or an unbound credential', async () => {
      const { leaks, ran } = await withEnv(NO_KEYS, () => sweep(CALLERS));
      expect(leaks).toEqual([]);
      expect(ran).toBeGreaterThan(150);
    }, 1_800_000);

    test('with the operator hatch on, still no leak', async () => {
      const { leaks } = await withEnv({ ...NO_KEYS, GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        __resetPrivateVisibilityCacheForTests();
        __resetHotMemoryCacheForTests();
        return sweep(CALLERS.slice(0, 2));
      });
      __resetPrivateVisibilityCacheForTests();
      expect(leaks).toEqual([]);
    }, 1_800_000);

    test('Bob\'s sweep writes left Alice\'s member page and fact intact', async () => {
      const [row] = await engine.executeRaw<{ visibility: string; source_markdown_slug: string; expired_at: unknown }>('SELECT visibility, source_markdown_slug, expired_at FROM facts WHERE fact LIKE $1', ['%' + CANARY]);
      expect(row).toMatchObject({ visibility: 'private', source_markdown_slug: fixture.memberSlug, expired_at: null });
      const [page] = await engine.executeRaw<{ page_readers: string[]; compiled_truth: string; deleted_at: unknown }>('SELECT page_readers, compiled_truth, deleted_at FROM pages WHERE source_id = $1 AND slug = $2', [SRC, fixture.memberSlug]);
      expect(page).toMatchObject({ page_readers: ['member:alice-example'], deleted_at: null });
      expect(page!.compiled_truth).toContain(CANARY);
    }, 60_000);
  });
}
