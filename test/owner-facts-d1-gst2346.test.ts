/**
 * GST-2346 D1: the brain owner's own credential saves and forgets facts the way it already writes pages.
 *
 * 1. Protects: an owner-bound credential speaking for itself saves a fact with no visibility shared on the subject's
 *    page, saves it private (on its own member page, and the reply says so) when that page names readers or the
 *    brain's fact default is private, honours an explicit visibility both ways, and withdraws a fact it shared. Every
 *    other caller keeps what it had: a member credential, an attested actor (even one linked to the owner), a shared
 *    room (even one the owner's credential asserts), an owner credential naming an audience, a sandboxed subagent
 *    running on the owner's credential, an owner credential fenced to slug prefixes and an unbound connection.
 * 2. Fails when: the owner's default save lands on its member page, its visibility "world" is refused, its forget
 *    answers not_found or a refusal for a fact it shared, or any non-owner caller reaches the owner's route.
 * 3. Existing coverage: test/remember-share-gst2243.test.ts (member share), test/member-forget-refusal-9101.test.ts
 *    (member forget refusal), test/qm-memory-tools.test.ts (QM contract).
 * 4. Real seams: OAuth client-credentials tokens bound to members and to the owner, MCP dispatch as remote callers,
 *    a repo-less brain and a managed one, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { operationsByName } from '../src/core/operations.ts';
import { prepareForgetMutation } from '../src/core/persistence/forget-prepare.ts';
import { withCoordinatedWrite, withTrustPromotion } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { decideTrustProposal } from '../src/core/trust/decide.ts';
import { parseTrustProposalRef } from '../src/core/trust/proposals.ts';
import { FACTS_DEFAULT_VISIBILITY_KEY } from '../src/core/facts/visibility.ts';
import { ambientOptsFrom, writebackCaller } from '../src/core/facts/writeback-config.ts';
import { buildAmbientWritebackSection } from '../src/core/facts/writeback-instructions.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';

const ACME = 'companies/acme-example';
const GLOBEX = 'companies/globex-example';
const INITECH = 'companies/initech-example';
const OWNER = 'carol-example';
const OWNER_PAGE = 'memory/members/' + OWNER;
const ATTEST_OPS = ['forget', 'forget_fact', 'get_write_request', 'memory_recall', 'memory_write', 'recall', 'remember'];

type Call = { isError: boolean; text: string; json: Record<string, any> };
type Channels = { actor?: string; audience?: string };

/** An owner, two members and every non-owner credential shape, in sourceId of an initialized engine. */
async function seedCallers(engine: BrainEngine, sourceId: string,
  writePage: (slug: string, content: string) => Promise<unknown> = (slug, content) => importFromContent(engine, slug, content, { sourceId })) {
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  __resetPrivateVisibilityCacheForTests();
  for (const id of ['alice-example', 'bob-example', OWNER]) await addMember(engine, id);
  await setOwner(engine, OWNER);
  await writePage(ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.');
  await writePage(GLOBEX, '---\ntype: company\ntitle: Globex Example\nreadable_by: [' + OWNER + ']\n---\n# Globex Example\n\nGlobex example runs a quiet pilot.');
  await writePage(INITECH, '---\ntype: company\ntitle: Initech Example\nvisibility: private\n---\n# Initech Example\n\nInitech example audits printers.');
  const tokens: Record<string, string> = {};
  const bindings: Record<string, Parameters<typeof bindCredential>[2] | null> = {
    owner: { member: OWNER }, alice: { member: 'alice-example' }, bob: { member: 'bob-example' }, plain: null,
    qm: { attestActor: 'qm', attestOps: ATTEST_OPS },
    room: { mayActFor: ['member:' + OWNER, 'member:alice-example'] },
    ownerRoom: { member: OWNER, mayActFor: ['member:' + OWNER, 'member:alice-example'] },
    fenced: { member: OWNER },
  };
  const clients: Record<string, string> = {};
  for (const [name, binding] of Object.entries(bindings)) {
    const c = await provider().registerClientManual('d1-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], sourceId);
    if (binding) await bindCredential(engine, { kind: 'client', id: c.clientId }, binding);
    clients[name] = c.clientId;
    tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
  }
  await engine.executeRaw("UPDATE oauth_clients SET bound_slug_prefixes = ARRAY['companies/'] WHERE client_id = $1", [clients.fenced]);
  await linkMember(engine, OWNER, 'qm', 'U0CAROL');
  await linkMember(engine, 'alice-example', 'qm', 'U0ALICE');
  const auth = async (who: string) => await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
  const parse = (text: string, isError: boolean, first = text): Call => {
    let json: Record<string, any> = {};
    try { json = JSON.parse(first); } catch { /* prose */ }
    return { isError, text, json };
  };
  async function call(who: string, op: string, params: Record<string, unknown>, ch: Channels = {}): Promise<Call> {
    const out = await dispatchToolCall(engine, op, { ...params }, {
      remote: true, transport: 'http', auth: await auth(who), sourceId, takesHoldersAllowList: ['world'],
      ...(ch.actor ? { actor: { header: ch.actor } } : {}), ...(ch.audience ? { onBehalfOf: { header: ch.audience } } : {}),
    });
    return parse(out.content.map(c => c.text).join('\n'), out.isError === true, out.content[0]?.text);
  }
  /** op run as a subagent tool call on the owner's credential, the way minions/tools/brain-allowlist.ts runs one. */
  async function asSubagent(op: string, params: Record<string, unknown>): Promise<Call> {
    const ownerAuth = await auth('owner');
    const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId, remote: true, dryRun: false,
      logger: { info() {}, warn() {}, error() {} }, auth: ownerAuth, viaSubagent: true, subagentId: 1, jobId: 1 };
    try {
      const out = await withCallerAccess(await remoteCallerAccess(engine, ownerAuth, []), () => operationsByName[op]!.handler(ctx, params));
      return parse(JSON.stringify(out), false);
    } catch (error) {
      return parse(JSON.stringify({ error: (error as { code?: string }).code, message: (error as Error).message }), true);
    }
  }
  const row = async (canary: string) => (await engine.executeRaw<{ id: number; visibility: string; source_markdown_slug: string | null; entity_slug: string | null; active: boolean }>(
    'SELECT id, visibility, source_markdown_slug, entity_slug, expired_at IS NULL AS active FROM facts WHERE fact LIKE $1 ORDER BY id DESC LIMIT 1', ['%' + canary + '%']))[0];
  const remember = (who: string, fact: string, extra: Record<string, unknown> = {}, ch: Channels = {}) =>
    call(who, 'remember', { fact, entity: ACME, provenance: 'owner facts test', ...extra }, ch);
  return { call, asSubagent, row, remember, auth };
}

function setupGateway() {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(() => new Array<number>(1536).fill(0).map((_, i) => (i === 0 ? 1 : 0))) })) as never);
}

for (const kind of testBackends()) {
  describe('owner facts (GST-2346 D1, ' + kind + ', repo-less)', () => {
    const SRC = 'source-a';
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let h: Awaited<ReturnType<typeof seedCallers>>;

    beforeAll(async () => {
      setupGateway();
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      h = await seedCallers(engine, SRC);
    }, 120_000);

    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });

    test("the owner's fact with no visibility is shared on the subject's page, the reply says so, and a member recalls it", async () => {
      const out = await h.remember('owner', 'Acme opened a harbor office canaryownerdefault');
      expect(out.isError ? out.text : 'ok').toBe('ok');
      expect([out.json.page, out.json.visibility]).toEqual([ACME, 'world']);
      expect(await h.row('canaryownerdefault')).toMatchObject({ visibility: 'world', source_markdown_slug: ACME, entity_slug: ACME });
      expect((await h.call('alice', 'recall', { entity: ACME })).text).toContain('canaryownerdefault');
    }, 120_000);

    test("the owner's explicit visibility is honoured both ways: world is saved shared, private stays on its own page", async () => {
      const world = await h.remember('owner', 'Acme hired a harbor pilot canaryownerworld', { visibility: 'world' });
      expect(world.isError ? world.text : 'ok').toBe('ok');
      expect(world.text).not.toContain('member_share_required');
      expect([world.json.page, world.json.visibility]).toEqual([ACME, 'world']);
      const kept = await h.remember('owner', 'Acme margin worries me canaryownerprivate', { visibility: 'private' });
      expect([kept.isError, kept.json.page, kept.json.visibility]).toEqual([false, OWNER_PAGE, 'private']);
      expect(await h.row('canaryownerprivate')).toMatchObject({ visibility: 'private', source_markdown_slug: OWNER_PAGE });
      expect((await h.call('alice', 'recall', { entity: ACME })).text).not.toContain('canaryownerprivate');
    }, 120_000);

    test("a page that names readers keeps the owner's default save private, on its own page, and the reply says so", async () => {
      const out = await h.remember('owner', 'Globex pilot slipped a month canaryownerglobex', { entity: GLOBEX });
      expect([out.isError, out.json.page, out.json.visibility]).toEqual([false, OWNER_PAGE, 'private']);
      expect(await h.row('canaryownerglobex')).toMatchObject({ visibility: 'private', source_markdown_slug: OWNER_PAGE, entity_slug: GLOBEX });
    }, 120_000);

    test("a visibility: private page keeps the owner's default save private on its own page; its explicit world onto a page that names readers is refused", async () => {
      const out = await h.remember('owner', 'Initech audit moved canaryownerinitech', { entity: INITECH });
      expect([out.isError ? out.text : 'ok', out.json.page, out.json.visibility]).toEqual(['ok', OWNER_PAGE, 'private']);
      expect(await h.row('canaryownerinitech')).toMatchObject({ visibility: 'private', source_markdown_slug: OWNER_PAGE, entity_slug: INITECH });
      const world = await h.remember('owner', 'Globex pilot in public canaryownerglobexworld', { entity: GLOBEX, visibility: 'world' });
      expect([world.isError, world.json.reason]).toEqual([true, 'share_target_restricted']);
      expect(await h.row('canaryownerglobexworld')).toBeUndefined();
    }, 120_000);

    test("the owner's default save that replaces a fact on its own page supersedes it there, private", async () => {
      const old = await h.remember('owner', 'Acme margin is thin canaryownerreplaceold', { visibility: 'private' });
      const out = await h.remember('owner', 'Acme margin recovered canaryownerreplacenew', { replaces: String(old.json.id) });
      expect([out.isError ? out.text : 'ok', out.json.status, out.json.page, out.json.visibility]).toEqual(['ok', 'superseded', OWNER_PAGE, 'private']);
      expect(await h.row('canaryownerreplacenew')).toMatchObject({ visibility: 'private', source_markdown_slug: OWNER_PAGE });
    }, 120_000);

    test("the brain's private fact default keeps the owner's default save private, on its own page, and the reply says so", async () => {
      await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'private');
      try {
        const out = await h.remember('owner', 'Acme board meets quarterly canaryownerdefaultprivate');
        expect([out.isError, out.json.page, out.json.visibility]).toEqual([false, OWNER_PAGE, 'private']);
        expect((await h.call('alice', 'recall', { entity: ACME })).text).not.toContain('canaryownerdefaultprivate');
      } finally { await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world'); }
    }, 120_000);

    test("the owner withdraws a fact it shared and one on its own page; a member's private fact stays not_found to it", async () => {
      const shared = await h.remember('owner', 'Acme closed its old dock canaryownerforgetshared');
      const out = await h.call('owner', 'forget', { id: String(shared.json.id) });
      expect(out.isError ? out.text : 'ok').toBe('ok');
      expect((await h.row('canaryownerforgetshared'))!.active).toBe(false);
      const viaShare = await h.remember('owner', 'Acme renamed its fleet canaryownerforgetshare', { share: true });
      const viaFact = await h.call('owner', 'forget_fact', { id: Number(viaShare.json.id) });
      expect(viaFact.isError ? viaFact.text : 'ok').toBe('ok');
      expect((await h.row('canaryownerforgetshare'))!.active).toBe(false);
      const own = await h.remember('owner', 'Acme note to self canaryownerforgetown', { visibility: 'private' });
      const ownOut = await h.call('owner', 'forget', { id: String(own.json.id) });
      expect(ownOut.isError ? ownOut.text : 'ok').toBe('ok');
      expect((await h.row('canaryownerforgetown'))!.active).toBe(false);
      const bobs = await h.remember('bob', 'Acme lunch plans canarybobkept');
      const hidden = await h.call('owner', 'forget', { id: String(bobs.json.id) });
      expect([hidden.isError, hidden.json.error]).toEqual([true, 'not_found']);
      expect((await h.row('canarybobkept'))!.active).toBe(true);
    }, 120_000);

    test('a member credential keeps K1: private on its member page by default, visibility "world" refused, a fact it shared refused by name', async () => {
      const kept = await h.remember('alice', 'Acme renewal worried me canaryalicekept');
      expect([kept.isError, kept.json.page, kept.json.visibility]).toEqual([false, 'memory/members/alice-example', 'private']);
      const world = await h.remember('alice', 'Acme hired canaryaliceworld', { visibility: 'world' });
      expect([world.isError, world.text.includes('member_share_required')]).toEqual([true, true]);
      expect(await h.row('canaryaliceworld')).toBeUndefined();
      const shared = await h.remember('alice', 'Acme asked for SSO canaryaliceshared', { share: true });
      const forget = await h.call('alice', 'forget', { id: String(shared.json.id) });
      expect([forget.isError, forget.json.error]).toEqual([true, 'scope_denied']);
      expect((await h.row('canaryaliceshared'))!.active).toBe(true);
    }, 120_000);

    test('an attested actor linked to the owner keeps the member route: private on the member page, sharing refused, forget of a shared fact not_found', async () => {
      const ch = { actor: 'U0CAROL' };
      const kept = await h.remember('qm', 'Acme told the owner a secret canaryattestedkept', {}, ch);
      expect([kept.isError, kept.json.page, kept.json.visibility]).toEqual([false, OWNER_PAGE, 'private']);
      const world = await h.remember('qm', 'Acme attested world canaryattestedworld', { visibility: 'world' }, ch);
      expect([world.isError, world.text.includes('attested_share_refused')]).toEqual([true, true]);
      expect(await h.row('canaryattestedworld')).toBeUndefined();
      const shared = await h.remember('owner', 'Acme expanded north canaryattestedforget', { share: true });
      const forget = await h.call('qm', 'forget', { id: String(shared.json.id) }, ch);
      expect([forget.isError, forget.json.error]).toEqual([true, 'not_found']);
      expect((await h.row('canaryattestedforget'))!.active).toBe(true);
    }, 120_000);

    test("the owner's credential naming an audience (a shared room, or the owner alone) never takes the owner's route", async () => {
      const room = await h.remember('ownerRoom', 'Acme room note canaryownerroom', {}, { audience: 'member:' + OWNER + ', member:alice-example' });
      const alone = await h.remember('ownerRoom', 'Acme alone note canaryowneraudience', {}, { audience: 'member:' + OWNER });
      const plainRoom = await h.remember('room', 'Acme plain room note canaryplainroom', {}, { audience: 'member:' + OWNER + ', member:alice-example' });
      expect([alone.isError, alone.json.page, alone.json.visibility]).toEqual([false, OWNER_PAGE, 'private']);
      expect(await h.row('canaryowneraudience')).toMatchObject({ visibility: 'private', source_markdown_slug: OWNER_PAGE });
      // A room of several (GBRA-231) writes as no single member, so it has no member page and saves on the subject's page,
      // as it did before D1; the owner's credential in the room saves exactly as any other room credential.
      for (const [out, canary] of [[room, 'canaryownerroom'], [plainRoom, 'canaryplainroom']] as const) {
        expect([out.isError, out.json.page, out.json.visibility]).toEqual([false, ACME, 'world']);
        expect(await h.row(canary)).toMatchObject({ visibility: 'world', source_markdown_slug: ACME });
      }
      const ownersOwn = await h.remember('owner', 'Acme owner private canaryroomforget', { visibility: 'private' });
      const roomForget = await h.call('ownerRoom', 'forget', { id: String(ownersOwn.json.id) }, { audience: 'member:' + OWNER + ', member:alice-example' });
      expect([roomForget.isError, roomForget.json.error]).toEqual([true, 'not_found']);
      expect((await h.row('canaryroomforget'))!.active).toBe(true);
    }, 120_000);

    test("a sandboxed subagent on the owner's credential and an owner credential fenced to slug prefixes never take the owner's route", async () => {
      const sub = await h.asSubagent('remember', { fact: 'Acme subagent note canarysubagent', entity: ACME, provenance: 'owner facts test' });
      const fenced = await h.remember('fenced', 'Acme fenced note canaryfenced');
      const fencedWorld = await h.remember('fenced', 'Acme fenced world canaryfencedworld', { visibility: 'world' });
      const shared = await h.remember('owner', 'Acme bought a crane canarysubforget');
      const subForget = await h.asSubagent('forget', { id: String(shared.json.id) });
      const fencedForget = await h.call('fenced', 'forget', { id: String(shared.json.id) });
      expect([sub.isError, sub.json.error]).toEqual([true, 'scope_denied']);
      expect([fenced.isError, fenced.json.error, fenced.text.includes(OWNER_PAGE)]).toEqual([true, 'scope_denied', true]);
      expect([fencedWorld.isError, fencedWorld.json.reason]).toEqual([true, 'member_share_required']);
      expect([subForget.isError, subForget.json.error]).toEqual([true, 'scope_denied']);
      expect([fencedForget.isError, fencedForget.json.error]).toEqual([true, 'permission_denied']);
      for (const canary of ['canarysubagent', 'canaryfenced', 'canaryfencedworld']) expect(await h.row(canary)).toBeUndefined();
      expect((await h.row('canarysubforget'))!.active).toBe(true);
    }, 120_000);

    test("with writeback on, the owner's credential is not told its saves stay private; a member and a fenced owner credential still are", async () => {
      const section = async (who: string) => buildAmbientWritebackSection(ambientOptsFrom({ enabled: true, mode: 'salient', transient_ttl: '3d', visibility: 'world' } as never,
        { remember: true, extractFacts: true, ...writebackCaller(await h.auth(who), OWNER) })!);
      expect([writebackCaller(await h.auth('owner'), OWNER), writebackCaller(await h.auth('fenced'), OWNER), writebackCaller(await h.auth('alice'), OWNER)])
        .toEqual([{}, { member: true }, { member: true }]);
      expect([(await section('owner')).includes('stay private to you'), (await section('alice')).includes('stay private to you')]).toEqual([false, true]);
      await engine.setConfig('mcp.publish_memory_settings', 'true');
      await engine.setConfig('memory.auto_writeback', 'salient');
      try {
        const rule = async (who: string) => JSON.stringify((await h.call(who, 'get_memory_settings', {})).json);
        expect([(await rule('owner')).includes('stay private to you'), (await rule('alice')).includes('stay private to you')]).toEqual([false, true]);
      } finally { await engine.setConfig('memory.auto_writeback', 'off'); }
    }, 120_000);

    /** A private fact the brain host wrote (the trusted local caller) about Acme, or about the entity extra names. */
    const hostFact = async (fact: string, extra: Record<string, unknown> = {}) => {
      const out = await dispatchToolCall(engine, 'remember', { fact, entity: ACME, provenance: 'owner facts test', visibility: 'private', ...extra }, { remote: false, sourceId: SRC });
      expect(out.isError === true ? out.content[0]?.text : 'ok').toBe('ok');
      return String(JSON.parse(out.content[0]!.text).id);
    };

    test("the owner withdraws a private fact the brain host wrote, by forget and by forget_fact; a member never read it", async () => {
      const id = await hostFact('Acme host kept a quiet reserve canaryhostprivate');
      expect(await h.row('canaryhostprivate')).toMatchObject({ visibility: 'private', source_markdown_slug: ACME });
      expect((await h.call('owner', 'recall', { entity: ACME })).text).toContain('canaryhostprivate');
      expect((await h.call('alice', 'recall', { entity: ACME })).text).not.toContain('canaryhostprivate');
      const out = await h.call('owner', 'forget', { id });
      expect(out.isError ? out.text : 'ok').toBe('ok');
      expect((await h.row('canaryhostprivate'))!.active).toBe(false);
      const second = await hostFact('Acme host kept a second reserve canaryhostsecond');
      const viaFact = await h.call('owner', 'forget_fact', { id: Number(second) });
      expect(viaFact.isError ? viaFact.text : 'ok').toBe('ok');
      expect((await h.row('canaryhostsecond'))!.active).toBe(false);
    }, 120_000);

    test("a member, an attested actor, a shared room, a subagent and a fenced owner credential still cannot withdraw a host-written private fact", async () => {
      const id = await hostFact('Acme host kept a sealed note canaryhostsealed');
      const room = { audience: 'member:' + OWNER + ', member:alice-example' };
      const answers = {
        member: (await h.call('alice', 'forget', { id })).json.error,
        unbound: (await h.call('plain', 'forget', { id })).json.error,
        actor: (await h.call('qm', 'forget', { id }, { actor: 'U0CAROL' })).json.error,
        room: (await h.call('room', 'forget', { id }, room)).json.error,
        ownerRoom: (await h.call('ownerRoom', 'forget', { id }, room)).json.error,
        ownerAlone: (await h.call('ownerRoom', 'forget', { id }, { audience: 'member:' + OWNER })).json.error,
        subagent: (await h.asSubagent('forget', { id })).json.error,
        fenced: (await h.call('fenced', 'forget', { id })).json.error,
        viaFact: (await h.call('alice', 'forget_fact', { id: Number(id) })).json.error,
      };
      // Each answer is the one that caller got before the owner's route existed.
      expect(answers).toEqual({ member: 'not_found', unbound: 'not_found', actor: 'not_found', room: 'not_found', ownerRoom: 'not_found',
        ownerAlone: 'scope_denied', subagent: 'scope_denied', fenced: 'permission_denied', viaFact: 'fact_not_found' });
      expect((await h.row('canaryhostsealed'))!.active).toBe(true);
    }, 120_000);

    test("a private fact on a page kept from remote writers stays with the brain host, and the refusal names it", async () => {
      const id = await hostFact('Initech host kept a sealed audit canaryhostinitech', { entity: INITECH });
      const out = await h.call('owner', 'forget', { id });
      expect([out.isError, out.json.error, out.text.includes('brain host'), out.text.includes('gbrain forget ' + id)]).toEqual([true, 'scope_denied', true, true]);
      expect((await h.row('canaryhostinitech'))!.active).toBe(true);
    }, 120_000);

    test("a host-written private fact more trusted than an agent's writes is not withdrawn: the owner is asked, as for a shared one", async () => {
      const id = await hostFact('Acme host confirmed its charter canaryhostconfirmed');
      await engine.transaction(tx => withCoordinatedWrite(tx, [SRC], () => withTrustPromotion(tx, 'user_confirmed', () =>
        tx.executeRaw("UPDATE facts SET trust_tier='user_confirmed' WHERE id=$1", [Number(id)])), TEST_WRITE_ATTRIBUTION));
      const out = await h.call('owner', 'forget', { id });
      expect([out.isError, out.json.error, out.json.code]).toEqual([true, 'scope_denied', 'forget_requires_owner']);
      expect((await h.row('canaryhostconfirmed'))!.active).toBe(true);
      // The proposal names the fact by id and tier only, and the owner's accept on the brain host applies the forget.
      const ref = JSON.parse(out.json.detail).proposal_ref as string;
      const [proposal] = await engine.executeRaw<{ stored: string }>('SELECT row_to_json(t)::text AS stored FROM trust_proposals t WHERE id=$1', [parseTrustProposalRef(ref)!]);
      expect([proposal!.stored.includes('"forget"'), proposal!.stored.includes('canaryhostconfirmed')]).toEqual([true, false]);
      expect((await decideTrustProposal(engine, parseTrustProposalRef(ref)!, 'accept', { confirmation: { via: 'tty' as const } })).status).toBe('accepted');
      expect((await h.row('canaryhostconfirmed'))!.active).toBe(false);
    }, 120_000);

    test("preparation judges the owner again from the stored principal: a stored request from any other writer reads the fact as not found", async () => {
      const id = await hostFact('Acme host kept a dated note canaryhostprepare');
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id=$1 AND slug=$2', [SRC, ACME]);
      const prepare = async (who: string, authority: Record<string, unknown> = {}, intent: Record<string, unknown> = { owner_reach: true }) => prepareForgetMutation(engine, {
        operation: 'forget', id: randomUUID(), request_id: randomUUID(), source_id: SRC, slug: ACME, page_id: page!.id, worktree_id: null, intent: { id, ...intent },
        authority: { version: 1, remote: true, principal: (await h.auth(who) as unknown as { principal: unknown }).principal, sourceId: SRC, slugPrefixes: null, ...authority },
      } as never, {} as never).then(() => 'prepared', (error: { code?: string }) => error.code);
      expect(await prepare('owner')).toBe('prepared');
      expect(await prepare('owner', {}, {})).toBe('not_found');
      expect(await prepare('alice')).toBe('not_found');
      expect(await prepare('plain')).toBe('not_found');
      expect(await prepare('owner', { actingFor: ['member:' + OWNER] })).toBe('not_found');
      expect(await prepare('owner', { restrictedNamespace: true })).toBe('not_found');
      expect(await prepare('owner', { slugPrefixes: ['companies/'] })).toBe('not_found');
      await setOwner(engine, 'bob-example');
      try {
        expect(await prepare('owner')).toBe('not_found');
        expect(await prepare('bob')).toBe('prepared');
      } finally { await setOwner(engine, OWNER); __resetPrivateVisibilityCacheForTests(); }
      expect((await h.row('canaryhostprepare'))!.active).toBe(true);
    }, 120_000);

    test("an unbound connection never reads or withdraws the owner's private fact", async () => {
      const kept = await h.remember('owner', 'Acme private owner note canaryunboundhidden', { visibility: 'private' });
      expect((await h.call('plain', 'recall', { entity: ACME })).text).not.toContain('canaryunboundhidden');
      const forget = await h.call('plain', 'forget', { id: String(kept.json.id) });
      expect([forget.isError, forget.json.error]).toEqual([true, 'not_found']);
      expect((await h.row('canaryunboundhidden'))!.active).toBe(true);
    }, 120_000);
  });

  describe('owner facts (GST-2346 D1, ' + kind + ', managed)', () => {
    afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

    test("on a managed brain the owner's default fact is shared on the subject's page file and its forget withdraws it", async () => {
      setupGateway();
      await managedBrain(async ({ engine, ctx, root }) => {
        const h = await seedCallers(engine, 'default', (slug, content) => operationsByName.put_page!.handler(ctx, { slug, content }));
        const out = await h.remember('owner', 'Acme moved its HQ canarymanagedowner');
        expect(out.isError ? out.text : 'ok').toBe('ok');
        expect([out.json.page, out.json.visibility]).toEqual([ACME, 'world']);
        await settleManagedGitEffects(engine);
        const file = join(root, ACME + '.md');
        expect(existsSync(file) && readFileSync(file, 'utf8').includes('canarymanagedowner')).toBe(true);
        const forget = await h.call('owner', 'forget', { id: String(out.json.id) });
        expect(forget.isError ? forget.text : 'ok').toBe('ok');
        expect((await h.row('canarymanagedowner'))!.active).toBe(false);
        // A private fact the brain host wrote sits in the page's file; the owner's forget strikes it there.
        const kept = await operationsByName.remember!.handler(ctx, { fact: 'Acme host kept a ledger canarymanagedhost', entity: ACME, provenance: 'owner facts test', visibility: 'private' }) as { id: string };
        await settleManagedGitEffects(engine);
        expect(readFileSync(file, 'utf8')).toContain('| Acme host kept a ledger canarymanagedhost |');
        const hostForget = await h.call('owner', 'forget', { id: String(kept.id) });
        expect(hostForget.isError ? hostForget.text : 'ok').toBe('ok');
        expect((await h.row('canarymanagedhost'))!.active).toBe(false);
        await settleManagedGitEffects(engine);
        expect(readFileSync(file, 'utf8')).toContain('~~Acme host kept a ledger canarymanagedhost~~');
        const member = await h.remember('alice', 'Acme member note canarymanagedmember');
        expect([member.isError, member.json.page, member.json.visibility]).toEqual([false, 'memory/members/alice-example', 'private']);
      }, kind === 'postgres' ? { databaseUrl: process.env.DATABASE_URL! } : {});
    }, 240_000);
  });
}
