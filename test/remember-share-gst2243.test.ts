/**
 * GST-2243: a member's remember stays private by default, and share: true saves the fact for every reader of the source.
 *
 * 1. Protects: a member-bound credential's fact saved with share: true lands world on the subject's page and another
 *    member recalls it; one saved without share stays on the saver's member page, recalled by the saver alone; every
 *    reply names the page and visibility; an explicit visibility "world" from a member is refused (member_share_required)
 *    instead of being made private; QM's attested memory_write, which passes no share, still saves on the member page.
 * 2. Fails when: share is ignored, a member's world request is silently overridden, the reply hides where the fact
 *    went, or memory_write's per-person contract moves.
 * 3. Existing coverage: test/access-member-facts.test.ts (GST-359 C2) pins the private default.
 * 4. Real seams: OAuth client-credentials tokens bound to members, MCP dispatch as remote callers, a repo-less brain.
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
import { prepareMemoryMutation } from '../src/core/persistence/memory-prepare.ts';
import { linkMember } from '../src/core/access/actor.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { ambientOptsFrom, writebackCaller } from '../src/core/facts/writeback-config.ts';
import { buildAmbientWritebackSection } from '../src/core/facts/writeback-instructions.ts';
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

const SRC = 'qm-members';
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'bob-example@acme.test';
const ACME = 'companies/acme-example';
const TEAM_PAGE = 'companies/globex-example';
const ATTEST_OPS = ['memory_write', 'cancel_write_request', 'context_pack', 'delta', 'get_page', 'get_write_request', 'list_write_requests', 'recall', 'remember', 'search', 'whoami'];

for (const kind of testBackends()) {
  describe('remember share for member credentials (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;

    type Who = { token: string; actor?: string };
    const who = {
      alice: (): Who => ({ token: 'qm', actor: ALICE_ID }),
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
      await importFromContent(engine, TEAM_PAGE, '---\ntype: company\ntitle: Globex Example\nreadable_by: [alice-example]\n---\n# Globex Example\n\nGlobex example runs a private pilot.', { sourceId: SRC });
      const register = async (name: string) => {
        const c = await provider().registerClientManual('c2-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        return { id: c.clientId, secret: c.clientSecret ?? '' };
      };
      const qm = await register('qm');
      await bindCredential(engine, { kind: 'client', id: qm.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      const alice = await register('alice');
      await bindCredential(engine, { kind: 'client', id: alice.id }, { member: 'alice-example' });
      const bob = await register('bob');
      await bindCredential(engine, { kind: 'client', id: bob.id }, { member: 'bob-example' });
      const plain = await register('plain');
      for (const [name, c] of [['qm', qm], ['alice', alice], ['bob', bob], ['plain', plain]] as const) tokens[name] = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
    }, 120_000);

    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });
    const A = { token: 'alice' }, B = { token: 'bob' }, U = { token: 'plain' };
    const factRow = async (canary: string) => (await engine.executeRaw<Record<string, unknown>>('SELECT visibility, source_markdown_slug, entity_slug FROM facts WHERE fact LIKE $1', ['%' + canary + '%']))[0];

    test('share: true lands world on the subject page and another member recalls it; without share it stays private to the saver', async () => {
      const shared = await remember(A, 'Acme renewed for 40 seats canarysharedfact', { entity: ACME, share: true });
      const kept = await remember(A, 'Acme renewal worried me canarykeptfact', { entity: ACME });
      expect([shared.isError, shared.json.page, shared.json.visibility]).toEqual([false, ACME, 'world']);
      expect([kept.isError, kept.json.page, kept.json.visibility]).toEqual([false, 'memory/members/alice-example', 'private']);
      expect(await factRow('canarysharedfact')).toMatchObject({ visibility: 'world', source_markdown_slug: ACME, entity_slug: ACME });
      expect(await factRow('canarykeptfact')).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/alice-example', entity_slug: ACME });
      for (const params of [{ query: 'Acme renewed seats' }, { entity: ACME }]) {
        const b = await call(B, 'recall', params);
        expect([b.all.includes('canarysharedfact'), b.all.includes('canarykeptfact')]).toEqual([true, false]);
        const u = await call(U, 'recall', params);
        expect([u.all.includes('canarysharedfact'), u.all.includes('canarykeptfact')]).toEqual([true, false]);
        const a = await call(A, 'recall', params);
        expect([a.all.includes('canarysharedfact'), a.all.includes('canarykeptfact')]).toEqual([true, true]);
      }
    }, 120_000);

    test('a member asking for visibility "world" is refused with member_share_required and nothing is saved; share with visibility "private" is refused', async () => {
      const world = await remember(A, 'Acme asked for SSO canaryworldrefused', { entity: ACME, visibility: 'world' });
      expect(world.isError).toBe(true);
      expect(world.all).toContain('member_share_required');
      expect(world.all).toContain('pass share: true');
      const both = await remember(A, 'Acme wants invoices canaryboth', { entity: ACME, share: true, visibility: 'private' });
      expect([both.isError, both.all.includes('invalid_params')]).toEqual([true, true]);
      expect(await factRow('canaryworldrefused')).toBeUndefined();
      expect(await factRow('canaryboth')).toBeUndefined();
      const own = await remember(A, 'Acme note canaryownprivate', { entity: ACME, visibility: 'private' });
      expect([own.isError, own.json.page, own.json.visibility]).toEqual([false, 'memory/members/alice-example', 'private']);
    }, 120_000);

    test('share onto a page whose facts are kept private is refused with share_target_restricted and nothing is saved', async () => {
      const out = await remember(A, 'Globex pilot ends in March canaryrestricted', { entity: TEAM_PAGE, share: true });
      expect(out.isError).toBe(true);
      expect(out.all).toContain('share_target_restricted');
      expect(await factRow('canaryrestricted')).toBeUndefined();
      const explicitWorld = await remember(U, 'Globex pilot ends in May canaryrestrictedworld', { entity: TEAM_PAGE, share: true, visibility: 'world' });
      expect(explicitWorld.isError).toBe(true);
      expect(await factRow('canaryrestrictedworld')).toBeUndefined();
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [SRC, TEAM_PAGE]);
      const row = { operation: 'remember', request_id: 'gst2243-prepare-' + randomUUID().slice(0, 6), source_id: SRC, slug: TEAM_PAGE, page_id: page!.id,
        intent: { fact: 'Globex pilot ends in June canaryprepshare', kind: 'fact', visibility: 'world', visibility_defaulted: true, share: true, entity_slug: TEAM_PAGE, fence: true, valid_from: new Date().toISOString() } };
      await expect(prepareMemoryMutation(engine, row as never, {} as never)).rejects.toMatchObject({ code: 'invalid_params' });
    }, 120_000);

    test('a replayed remember and a non-member remember both name page and visibility', async () => {
      const request_id = randomUUID();
      const first = await remember(A, 'Acme signs in April canaryreplay', { entity: ACME, share: true, request_id });
      const again = await remember(A, 'Acme signs in April canaryreplay', { entity: ACME, share: true, request_id });
      expect([again.isError, again.json.page, again.json.visibility]).toEqual([false, first.json.page, first.json.visibility]);
      expect([first.json.page, first.json.visibility]).toEqual([ACME, 'world']);
      const plain = await remember(U, 'Acme ships weekly canaryplain', { entity: ACME });
      expect([plain.isError, plain.json.page, plain.json.visibility]).toEqual([false, ACME, 'world']);
    }, 120_000);

    test('a batch shares every item with a top-level share: true', async () => {
      const out = await call(A, 'remember', { items: [{ fact: 'Acme pays net 30 canarybatchone', entity: ACME }, { fact: 'Acme has 3 sites canarybatchtwo', entity: ACME }], provenance: 'qm test', share: true });
      expect(out.isError).toBe(false);
      expect(await factRow('canarybatchone')).toMatchObject({ visibility: 'world', source_markdown_slug: ACME });
      expect(await factRow('canarybatchtwo')).toMatchObject({ visibility: 'world', source_markdown_slug: ACME });
      expect((out.json.items as Array<Record<string, unknown>>).map(r => [r.page, r.visibility])).toEqual([[ACME, 'world'], [ACME, 'world']]);
      const mixed = await call(A, 'remember', { items: [{ fact: 'Acme uses SSO canarymixedone', entity: ACME }, { fact: 'Acme uses SAML canarymixedtwo', entity: ACME, visibility: 'world' }], provenance: 'qm test' });
      expect(mixed.isError).toBe(true);
      expect(mixed.all).toContain('member_share_required');
      expect(await factRow('canarymixedone')).toBeUndefined();
      expect(await factRow('canarymixedtwo')).toBeUndefined();
    }, 120_000);

    test('a QM service acting for a member is told both cases, and its plain remember with visibility "world" is refused with the exact retry', async () => {
      const opts = ambientOptsFrom({ enabled: true, mode: 'salient', transient_ttl: '3d', visibility: 'world' } as never, { remember: true, extractFacts: true, ...writebackCaller(await verify(tokens.qm!)) });
      const section = buildAmbientWritebackSection(opts!);
      expect(section).toContain('share: true');
      expect(section).toContain('visibility: "world"');
      expect(writebackCaller(await verify(tokens.plain!))).toEqual({});
      expect(writebackCaller(await verify(tokens.alice!))).toEqual({ member: true });
      const world = await remember(who.alice(), 'Acme asked for audit logs canaryactorworld', { entity: ACME, visibility: 'world' });
      expect(world.isError).toBe(true);
      // GST-2249 W1: a save made for a person never shares, so both are refused and point at the owner's approval instead.
      expect(world.all).toContain('attested_share_refused');
      expect(world.all).toContain('memory_propose');
      expect(await factRow('canaryactorworld')).toBeUndefined();
      const retried = await remember(who.alice(), 'Acme asked for audit logs canaryactorworld', { entity: ACME, share: true });
      expect([retried.isError, retried.all.includes('attested_share_refused')]).toEqual([true, true]);
      expect(await factRow('canaryactorworld')).toBeUndefined();
      const kept = await remember(who.alice(), 'Acme audit worried me canaryactorkept', { entity: ACME });
      expect([kept.isError, kept.json.page, kept.json.visibility]).toEqual([false, 'memory/members/alice-example', 'private']);
    }, 120_000);

    test('QM memory_write, which takes no share, still saves on the member page, and share is on the starter surface', async () => {
      const out = await call(who.alice(), 'memory_write', { facts: [{ fact: 'Alice prefers async standups canaryqmwrite', provenance: 'qm test' }], idempotency_key: randomUUID() });
      expect(out.isError).toBe(false);
      expect(await factRow('canaryqmwrite')).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/alice-example' });
      const refused = await call(who.alice(), 'memory_write', { facts: [{ fact: 'x canaryqmshare', provenance: 'qm test', share: true }], idempotency_key: randomUUID() });
      expect(refused.isError).toBe(true);
      const { operationsByName } = await import('../src/core/operations.ts');
      expect(operationsByName.remember!.params.share).toMatchObject({ type: 'boolean' });
      expect(operationsByName.remember!.params.share!.fullSurfaceOnly).toBeUndefined();
    }, 120_000);
  });
}
