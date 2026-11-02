/**
 * GST-359 C1: the attested actor (x-qm-actor) and member links.
 *
 * 1. Protects: a QM call reads and writes as exactly the member its canonical person id is linked to, and only when
 *    the credential holds the attest right (a client-credentials client or member-less legacy token, checked on the
 *    token's own grant), the operation is in its attested list, and any acting_user argument equals the header. An
 *    attested call never reads a visibility: private page, whatever the attest client's grant or the operator hatch
 *    says. Links compare exactly, and unlink or disable take effect on the next call, at write publication and at a
 *    job's next tool call (one coverage function, actorCoverage).
 * 2. Fails when: a header widens a client that holds no right, an argument picks or changes the person, an id is
 *    case-folded or truncated, an attested call inherits granted_sources or the hatch, a stored write or job keeps
 *    reading as a member after the link is gone, a refusal lacks structuredContent.error, or initialize loses its
 *    description or changes its instructions.
 * 3. Existing coverage: test/access-on-behalf-of.test.ts pins B's audience path, which this reuses for one member.
 * 4. Real seams: OAuth clients registered and issued tokens by the provider's client-credentials grant, legacy tokens
 *    minted by the token service, verified by the serve --http verifier and by the legacy bearer transport over a real
 *    socket, dispatched through MCP dispatch on a repo-less brain; embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { parseRescopeTokenArgs, rescopeLegacyToken } from '../src/core/grants/legacy-token.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { GBRAIN_MCP_INSTRUCTIONS, MCP_SERVER_DESCRIPTION } from '../src/mcp/instructions.ts';
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential, disableMember, enableMember } from '../src/core/access/members.ts';
import { ACTOR_DEFERRED_OPS, attestedCallerAccess, linkMember, listMemberLinks, parseAttestOps, unlinkMember } from '../src/core/access/actor.ts';
import { readAudienceAssertions } from '../src/core/access/audience.ts';
import { operationsByName } from '../src/core/operations.ts';
import { submissionAuthority, authorizeStoredRequest } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { parseSubmissionAuthority, prepareRemoteAgent, withSubmissionAuthority, type RemoteAgentAuthority } from '../src/core/minions/submission-authority.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
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

const SRC = 'qm-team';
const PAGES = {
  alice: { slug: 'notes/qm-alice', fm: ['readable_by: [alice-example]'], canary: 'canaryqmalice' },
  bob: { slug: 'notes/qm-bob', fm: ['readable_by: [bob-example]'], canary: 'canaryqmbob' },
  both: { slug: 'notes/qm-both', fm: ['readable_by: [alice-example, bob-example]'], canary: 'canaryqmboth' },
  quiet: { slug: 'notes/qm-quiet', fm: ['visibility: private'], canary: 'canaryqmquiet' },
  open: { slug: 'notes/qm-open', fm: [] as string[], canary: 'canaryqmopen' },
} as const;
type Key = keyof typeof PAGES;
const page = (key: Key) => ['---', 'type: note', 'title: ' + key + ' qm plan', ...PAGES[key].fm, '---', '# ' + key + ' qm plan', '',
  'Harbor ledger qm notes ' + PAGES[key].canary + ' for the roadmap.'].join('\n');

const ALICE_ID = 'U0ALICE';
const BOB_ID = 'bob-example@acme.test';
const OIDC_ID = 'oidc:3f2a9c:alice-example';
const LONG_ID = 'L'.repeat(256);
const ATTEST_OPS = ['add_tag', 'get_page', 'list_pages', 'search', 'whoami'];

for (const kind of testBackends()) {
  describe('attested actor x-qm-actor (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const clients: Record<string, { id: string; secret: string; token: string }> = {};
    const tokens: Record<string, { id: string; token: string }> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;
    const issue = async (name: string) => {
      const c = clients[name]!;
      c.token = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
    };

    async function call(bearer: string | null, op: string, params: Record<string, unknown>, ch: { actor?: string; obo?: string; meta?: unknown } = {}) {
      const auth = bearer ? await verify(bearer) : undefined;
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: bearer ? 'http' : 'stdio', auth, sourceId: SRC, takesHoldersAllowList: ['world'],
        ...(ch.actor !== undefined ? { actor: { header: ch.actor } } : {}),
        onBehalfOf: { header: ch.obo, requestMeta: ch.meta === undefined ? undefined : { on_behalf_of: ch.meta } },
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json, meta: out._meta, structured: out.structuredContent as { error?: Record<string, unknown> } | undefined };
    }
    const qm = () => clients.qm!.token;
    const getAs = (actor: string | undefined, key: Key, bearer = qm(), extra: Record<string, unknown> = {}) =>
      call(bearer, 'get_page', { slug: PAGES[key].slug, ...extra }, actor === undefined ? {} : { actor });
    async function refused(p: Promise<Awaited<ReturnType<typeof call>>>, code: string, reason?: string) {
      const out = await p;
      expect({ isError: out.isError, code: out.json.code, reason: out.json.reason }).toEqual({ isError: true, code, reason });
      expect(out.structured?.error).toMatchObject({ code, ...(reason ? { reason } : {}) });
      for (const key of Object.keys(PAGES) as Key[]) expect(out.text).not.toContain(PAGES[key].canary);
      return out;
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example', 'dan-example']) await addMember(engine, id);
      for (const key of Object.keys(PAGES) as Key[]) await importFromContent(engine, PAGES[key].slug, page(key), { sourceId: SRC });
      const register = async (name: string, grantTypes = ['client_credentials']) => {
        const c = await provider().registerClientManual('qm-' + name + '-' + randomUUID().slice(0, 8), grantTypes, 'read write', [], SRC);
        clients[name] = { id: c.clientId, secret: c.clientSecret ?? '', token: '' };
        return c.clientId;
      };
      await bindCredential(engine, { kind: 'client', id: await register('qm') }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      await register('plain');
      await bindCredential(engine, { kind: 'client', id: await register('defaults') }, { attestActor: 'qm' });
      await register('code', ['authorization_code']);
      for (const name of ['qm', 'plain', 'defaults']) await issue(name);
      await engine.executeRaw("UPDATE oauth_clients SET private_pages = 'granted_sources' WHERE client_id = $1", [clients.qm!.id]);
      const minted = await mintLegacyToken(engine, { name: 'qm-legacy', scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
      tokens.legacy = { id: minted.id, token: minted.token };
      await bindCredential(engine, { kind: 'token', id: minted.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['qm-legacy', '--private-pages', 'granted-sources']));
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'alice-example', 'qm', OIDC_ID);
      await linkMember(engine, 'alice-example', 'qm', LONG_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('an attested call reads as the linked member, reports it in _meta.access, and never echoes the id', async () => {
      const out = await getAs(ALICE_ID, 'alice');
      expect(out.isError).toBe(false);
      expect(out.text).toContain(PAGES.alice.canary);
      expect(out.meta?.access).toMatchObject({ member: 'alice-example', audience: ['member:alice-example'], actor: { system: 'qm' }, relaxation: 'none' });
      expect(JSON.stringify(out.meta?.access)).not.toContain(ALICE_ID);
      expect((await getAs(ALICE_ID, 'both')).text).toContain(PAGES.both.canary);
      expect((await getAs(ALICE_ID, 'bob')).text).not.toContain(PAGES.bob.canary);
      expect((await getAs(undefined, 'alice')).text).not.toContain(PAGES.alice.canary);
      const legacy = await getAs(ALICE_ID, 'alice', tokens.legacy!.token);
      expect(legacy.text).toContain(PAGES.alice.canary);
    }, 120_000);

    test('two linked members: each reads only their own readers pages through the same attest client', async () => {
      const keyword = (actor: string) => call(qm(), 'search', { query: 'harbor ledger qm notes', match: 'keyword', fields: 'full', limit: 30 }, { actor });
      const alice = (await keyword(ALICE_ID)).text;
      const bob = (await keyword(BOB_ID)).text;
      expect([alice.includes(PAGES.alice.canary), alice.includes(PAGES.bob.canary), alice.includes(PAGES.both.canary)]).toEqual([true, false, true]);
      expect([bob.includes(PAGES.alice.canary), bob.includes(PAGES.bob.canary), bob.includes(PAGES.both.canary)]).toEqual([false, true, true]);
      expect((await getAs(BOB_ID, 'alice')).text).not.toContain(PAGES.alice.canary);
      const list = (await call(qm(), 'list_pages', { slug_prefix: 'notes/' }, { actor: BOB_ID })).text;
      expect(list.includes(PAGES.alice.slug)).toBe(false);
      expect(list.includes(PAGES.bob.slug)).toBe(true);
    }, 120_000);

    test('an attested call never reads a visibility: private page, even with granted_sources on the client and the operator hatch', async () => {
      expect((await getAs(undefined, 'quiet')).text).toContain(PAGES.quiet.canary);
      expect((await getAs(ALICE_ID, 'quiet')).text).not.toContain(PAGES.quiet.canary);
      expect((await getAs(ALICE_ID, 'quiet', tokens.legacy!.token)).text).not.toContain(PAGES.quiet.canary);
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        __resetPrivateVisibilityCacheForTests();
        try {
          expect((await getAs(ALICE_ID, 'quiet')).text).not.toContain(PAGES.quiet.canary);
          const search = await call(qm(), 'search', { query: 'harbor ledger qm notes', match: 'keyword', fields: 'full', limit: 30 }, { actor: ALICE_ID });
          expect(search.text).not.toContain(PAGES.quiet.canary);
          expect(search.text).toContain(PAGES.open.canary);
          const list = await call(qm(), 'list_pages', { slug_prefix: 'notes/' }, { actor: ALICE_ID });
          expect(list.text).not.toContain(PAGES.quiet.slug);
          expect(search.meta?.access).toMatchObject({ relaxation: 'none' });
        } finally {
          __resetPrivateVisibilityCacheForTests();
        }
      });
    }, 120_000);

    test('acting_user equal to the header is accepted and stripped before the handler', async () => {
      const out = await getAs(ALICE_ID, 'alice', qm(), { acting_user: ALICE_ID });
      expect(out.isError).toBe(false);
      expect(out.text).toContain(PAGES.alice.canary);
      expect(out.text).not.toContain('acting_user');
      expect(JSON.stringify(out.meta ?? {})).not.toContain('acting_user');
    }, 60_000);

    test('refusals: no right, op not attested, argument mismatch, argument without attestation, invalid id', async () => {
      const noRight = await refused(getAs(ALICE_ID, 'alice', clients.plain!.token), 'actor_not_attested', 'no_attest_right');
      expect((noRight.json.fix as { argv: string[] }).argv).toEqual(['gbrain', 'auth', 'rescope', '--client', clients.plain!.id, '--attest-actor', 'qm']);
      expect((noRight.structured!.error!.fix as { argv: string[] }).argv).toEqual(['gbrain', 'auth', 'rescope', '--client', clients.plain!.id, '--attest-actor', 'qm']);
      expect(noRight.json.docs).toContain('write-refusals.md#actor_not_attested');
      const op = await refused(call(qm(), 'resolve_slugs', { partial: 'qm-alice' }, { actor: ALICE_ID }), 'actor_not_attested', 'op_not_attested');
      expect((op.json.fix as { argv: string[] }).argv.slice(-2)).toEqual(['--attest-ops', [...ATTEST_OPS, 'resolve_slugs'].sort().join(',')]);
      await refused(getAs(ALICE_ID, 'alice', clients.defaults!.token), 'actor_not_attested', 'op_not_attested');
      await refused(getAs(ALICE_ID, 'alice', qm(), { acting_user: BOB_ID }), 'actor_not_attested', 'argument_mismatch');
      await refused(getAs(ALICE_ID, 'alice', qm(), { acting_user: 'u0alice' }), 'actor_not_attested', 'argument_mismatch');
      await refused(getAs(undefined, 'alice', qm(), { acting_user: ALICE_ID }), 'actor_not_attested', 'argument_without_attestation');
      await refused(getAs(ALICE_ID, 'alice', clients.plain!.token, { acting_user: ALICE_ID }), 'actor_not_attested', 'argument_without_attestation');
      await refused(call(null, 'get_page', { slug: PAGES.alice.slug, acting_user: ALICE_ID }), 'actor_not_attested', 'argument_without_attestation');
      for (const bad of ['', 'U0 ALICE', 'U0ALICE\u0007', 'L'.repeat(257), 'caf\u00e9']) {
        await refused(getAs(bad, 'alice'), 'actor_not_attested', 'invalid_actor_id');
      }
      await refused(getAs(ALICE_ID, 'alice', qm(), { acting_user: 'L'.repeat(257) }), 'actor_not_attested', 'invalid_actor_id');
      await refused(getAs(ALICE_ID, 'alice', qm(), { acting_user: 7 }), 'actor_not_attested', 'invalid_actor_id');
    }, 120_000);

    test('the right follows the token\'s grant: an authorization-code token of an attest client is not attested', async () => {
      const hash = createHash('sha256').update(qm()).digest('hex');
      await engine.executeRaw("UPDATE oauth_tokens SET grant_type = 'authorization_code' WHERE token_hash = $1", [hash]);
      try {
        await refused(getAs(ALICE_ID, 'alice'), 'actor_not_attested', 'no_attest_right');
      } finally {
        await engine.executeRaw("UPDATE oauth_tokens SET grant_type = 'client_credentials' WHERE token_hash = $1", [hash]);
      }
      await engine.executeRaw('UPDATE oauth_tokens SET grant_type = NULL WHERE token_hash = $1', [hash]);
      try {
        const old = await refused(getAs(ALICE_ID, 'alice'), 'actor_not_attested', 'no_attest_right');
        expect(old.json.message).toContain('holds the attest right');
        expect(String(old.json.suggestion ?? old.json.next ?? old.text)).toContain('grant_type=client_credentials');
        expect(old.structured!.error!.fix).toBeUndefined();
      } finally {
        await engine.executeRaw("UPDATE oauth_tokens SET grant_type = 'client_credentials' WHERE token_hash = $1", [hash]);
      }
      const plain = await refused(getAs(ALICE_ID, 'alice', clients.plain!.token), 'actor_not_attested', 'no_attest_right');
      expect(plain.json.message).not.toContain('holds the attest right');
      expect((await getAs(ALICE_ID, 'alice')).text).toContain(PAGES.alice.canary);
    }, 60_000);

    test('the header beside an on_behalf_of audience is refused as an invalid audience', async () => {
      await refused(call(qm(), 'get_page', { slug: PAGES.alice.slug }, { actor: ALICE_ID, obo: 'alice-example' }), 'on_behalf_of_invalid_audience');
      await refused(call(qm(), 'get_page', { slug: PAGES.alice.slug }, { actor: ALICE_ID, meta: ['alice-example'] }), 'on_behalf_of_invalid_audience');
    }, 60_000);

    test('links compare exactly: case, 256 characters and colons; unlink and disable apply on the next call', async () => {
      expect((await getAs(OIDC_ID, 'alice')).text).toContain(PAGES.alice.canary);
      expect((await getAs(LONG_ID, 'alice')).text).toContain(PAGES.alice.canary);
      const unlinked = await refused(getAs('u0alice', 'alice'), 'actor_unlinked');
      expect((unlinked.json.fix as { argv: string[] }).argv).toEqual(['gbrain', 'access', 'member', 'link', '<member>', '--qm', 'u0alice']);
      expect(unlinked.json.docs).toContain('write-refusals.md#actor_unlinked');
      await refused(getAs('L'.repeat(255), 'alice'), 'actor_unlinked');
      await refused(getAs(OIDC_ID.toUpperCase(), 'alice'), 'actor_unlinked');
      await unlinkMember(engine, 'qm', OIDC_ID);
      try {
        await refused(getAs(OIDC_ID, 'alice'), 'actor_unlinked');
      } finally {
        await linkMember(engine, 'alice-example', 'qm', OIDC_ID);
      }
      await disableMember(engine, 'bob-example');
      try {
        await refused(getAs(BOB_ID, 'both'), 'actor_unlinked');
      } finally {
        await enableMember(engine, 'bob-example');
      }
      expect((await getAs(BOB_ID, 'both')).text).toContain(PAGES.both.canary);
    }, 120_000);

    test('link commands refuse duplicates, invalid ids and members that are not enabled; previews write nothing', async () => {
      await expect(linkMember(engine, 'bob-example', 'qm', ALICE_ID)).rejects.toMatchObject({ code: 'access_member_invalid', reason: 'link_exists' });
      await expect(linkMember(engine, 'alice-example', 'qm', ALICE_ID)).rejects.toMatchObject({ code: 'access_member_invalid', reason: 'link_exists' });
      for (const bad of ['', 'has space', 'L'.repeat(257), 'tab\there']) {
        await expect(linkMember(engine, 'alice-example', 'qm', bad)).rejects.toMatchObject({ code: 'access_member_invalid', reason: 'invalid_external_id' });
      }
      await expect(linkMember(engine, 'ghost-example', 'qm', 'U0GHOST')).rejects.toMatchObject({ code: 'access_member_invalid', reason: 'unknown' });
      await disableMember(engine, 'dan-example');
      try {
        await expect(linkMember(engine, 'dan-example', 'qm', 'U0DAN')).rejects.toMatchObject({ code: 'access_member_invalid', reason: 'disabled' });
      } finally {
        await enableMember(engine, 'dan-example');
      }
      const preview = await linkMember(engine, 'dan-example', 'qm', 'U0DAN', { dryRun: true });
      expect(preview.applied).toBe(false);
      expect((await listMemberLinks(engine, { member: 'dan-example' })).length).toBe(0);
      await expect(unlinkMember(engine, 'qm', 'U0DAN')).rejects.toMatchObject({ reason: 'unknown_link' });
      for (const bad of ['L'.repeat(257), 'has space', 'bell\u0007', 'caf\u00e9', '']) {
        await expect(engine.executeRaw("INSERT INTO access_member_links (system, external_id, member_id) VALUES ('qm', $1, 'dan-example')", [bad])).rejects.toThrow();
      }
      expect((await listMemberLinks(engine, { member: 'alice-example' })).map(l => l.external_id).sort()).toEqual([ALICE_ID, LONG_ID, OIDC_ID].sort());
    }, 60_000);

    test('the attest right is granted only to a member-less client-credentials client or legacy token, for attestable ops', async () => {
      await expect(bindCredential(engine, { kind: 'client', id: clients.code!.id }, { attestActor: 'qm' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(bindCredential(engine, { kind: 'client', id: clients.qm!.id }, { member: 'dan-example' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(bindCredential(engine, { kind: 'client', id: clients.plain!.id }, { attestOps: ['get_page'] })).rejects.toMatchObject({ code: 'invalid_params' });
      const minted = await mintLegacyToken(engine, { name: 'qm-bound', scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      await bindCredential(engine, { kind: 'token', id: minted.id }, { member: 'dan-example' });
      await expect(bindCredential(engine, { kind: 'token', id: minted.id }, { attestActor: 'qm' })).rejects.toMatchObject({ code: 'invalid_params' });
      const lookup = (name: string) => operationsByName[name];
      for (const op of ['get_stats', 'run_doctor', 'sync_brain', 'file_upload', 'purge_fact', 'no_such_op']) expect(() => parseAttestOps(op, lookup)).toThrow();
      expect(parseAttestOps('memory_write,get_page,memory_recall', lookup)).toEqual(['get_page', 'memory_recall', 'memory_write']);
      const cleared = await bindCredential(engine, { kind: 'client', id: clients.defaults!.id }, { attestActor: null }, { dryRun: true });
      expect(cleared.attest_actor).toBeUndefined();
    }, 60_000);

    test('a pending attested write publishes as the member and is refused after unlink, relink to another member, or disable', async () => {
      const auth = await verify(qm());
      const ctx = { engine, config: { engine: 'pglite' }, sourceId: SRC, auth, remote: true, dryRun: false, takesHoldersAllowList: ['world'],
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SRC]);
      const actor = { system: 'qm', external_id: ALICE_ID, member: 'alice-example' };
      const authority = await withCallerAccess(await attestedCallerAccess(engine, actor, ['member:alice-example']),
        () => submissionAuthority(ctx, 'add_tag', SRC, source!.incarnation, PAGES.alice.slug));
      expect({ actingFor: authority.actingFor, excludePrivate: authority.excludePrivate }).toEqual({ actingFor: actor, excludePrivate: true });
      const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'add_tag', sourceId: SRC,
        sourceIncarnation: source!.incarnation, slug: PAGES.alice.slug, requestId: randomUUID(), callerIntent: {}, intent: {} });
      await authorizeStoredRequest(engine, row);
      await unlinkMember(engine, 'qm', ALICE_ID);
      try {
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'actor_unlinked' });
        await linkMember(engine, 'bob-example', 'qm', ALICE_ID);
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'actor_unlinked' });
        await unlinkMember(engine, 'qm', ALICE_ID);
      } finally {
        await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      }
      await authorizeStoredRequest(engine, row);
      await disableMember(engine, 'alice-example');
      try {
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'actor_unlinked' });
      } finally {
        await enableMember(engine, 'alice-example');
      }
      await bindCredential(engine, { kind: 'client', id: clients.qm!.id }, { attestActor: null });
      try {
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'actor_not_attested' });
      } finally {
        await bindCredential(engine, { kind: 'client', id: clients.qm!.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      }
      await bindCredential(engine, { kind: 'client', id: clients.qm!.id }, { attestActor: 'qm', attestOps: ATTEST_OPS.filter(op => op !== 'add_tag') });
      try {
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'actor_not_attested', reason: 'op_not_attested' });
      } finally {
        await bindCredential(engine, { kind: 'client', id: clients.qm!.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      }
      await authorizeStoredRequest(engine, row);
      const live = await call(qm(), 'add_tag', { slug: PAGES.alice.slug, tag: 'qm-tag' }, { actor: ALICE_ID });
      expect(live.isError).toBe(false);
      const hidden = await call(qm(), 'add_tag', { slug: PAGES.bob.slug, tag: 'qm-tag' }, { actor: ALICE_ID });
      expect(hidden.json.code).toBe('page_not_found');
    }, 120_000);

    test('an agent job submitted for an attested actor reads as the member until the link is gone', async () => {
      const { clientId } = await provider().registerClientManual('qm-agent-' + randomUUID().slice(0, 8), ['client_credentials'], 'read', [], SRC);
      await bindCredential(engine, { kind: 'client', id: clientId }, { attestActor: 'qm', attestOps: ['get_page'] });
      await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['get_page'], bound_source_id = source_id, federated_read = ARRAY[source_id], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_max_concurrent = 1 WHERE client_id = $1", [clientId]);
      const actor = { system: 'qm', external_id: BOB_ID, member: 'bob-example' };
      const agentAuth = { token: 'x', clientId, scopes: ['read', 'agent'], sourceId: SRC, principal: { kind: 'oauth_client', id: clientId } } as unknown as AuthInfo;
      const submitted = await withCallerAccess(await attestedCallerAccess(engine, actor, ['member:bob-example']),
        () => prepareRemoteAgent({ engine, auth: agentAuth, remote: true } as unknown as OperationContext, { source_id: SRC, allowed_tools: ['get_page'], allowed_slug_prefixes: [] }));
      expect({ actor: submitted.grant.actor, actingFor: submitted.grant.actingFor }).toEqual({ actor, actingFor: undefined });
      const tools = buildBrainTools({ subagentId: 11, engine, config: { engine: 'pglite' } as never, sourceId: SRC,
        delegatedAuth: { clientId, scopes: ['read', 'agent'], sourceId: SRC, allowedSources: [SRC] } });
      const getPage = tools.find(t => t.name === 'brain_get_page')!;
      const authority: RemoteAgentAuthority = { ...submitted, payloadHash: '0'.repeat(64) };
      expect(parseSubmissionAuthority(authority)).not.toBeNull();
      const read = async (slug: string) => {
        try { return JSON.stringify(await withSubmissionAuthority(authority, () => getPage.execute({ slug }, { engine, jobId: 1, remote: true } as never))); }
        catch (e) { return String((e as Error).message); }
      };
      expect(await read(PAGES.bob.slug)).toContain(PAGES.bob.canary);
      expect(await read(PAGES.alice.slug)).not.toContain(PAGES.alice.canary);
      await unlinkMember(engine, 'qm', BOB_ID);
      try {
        const after = await read(PAGES.bob.slug);
        expect(after).not.toContain(PAGES.bob.canary);
        expect(after).toContain('not linked');
      } finally {
        await linkMember(engine, 'bob-example', 'qm', BOB_ID);
      }
      await bindCredential(engine, { kind: 'client', id: clientId }, { attestActor: 'qm', attestOps: ['search'] });
      try {
        const removed = await read(PAGES.bob.slug);
        expect(removed).not.toContain(PAGES.bob.canary);
        expect(removed).toContain('get_page is not in this connection');
      } finally {
        await bindCredential(engine, { kind: 'client', id: clientId }, { attestActor: 'qm', attestOps: ['get_page'] });
      }
      expect(await read(PAGES.bob.slug)).toContain(PAGES.bob.canary);
      const bad = (grant: Record<string, unknown>) => parseSubmissionAuthority({ ...authority, grant: { ...authority.grant, ...grant } });
      expect(bad({ actor: { ...actor, external_id: 'has space' } })).toBeNull();
      expect(bad({ actingFor: ['member:bob-example'] })).toBeNull();
    }, 120_000);

    test('operations not keyed to the person yet are never attested: refused at rescope, at bind and at every call', async () => {
      const lookup = (name: string) => operationsByName[name];
      for (const op of ACTOR_DEFERRED_OPS) {
        expect(() => parseAttestOps('get_page,' + op, lookup)).toThrow(/cannot run yet/);
        await expect(bindCredential(engine, { kind: 'client', id: clients.qm!.id }, { attestActor: 'qm', attestOps: ['get_page', op] })).rejects.toMatchObject({ code: 'invalid_params' });
      }
      // GST-359 C2 keyed remember, delta, the write receipts and agent jobs to the person (test/access-member-facts.test.ts);
      // D keyed forget and forget_fact to the person's own member page (test/qm-memory-tools.test.ts).
      for (const op of ['capture', 'extract_facts', 'takes_add', 'list_write_conflicts']) {
        expect(ACTOR_DEFERRED_OPS.has(op)).toBe(true);
      }
      for (const op of ['get_agent_job', 'submit_agent', 'get_write_request', 'list_write_requests', 'cancel_write_request', 'delta', 'remember', 'forget', 'forget_fact']) {
        expect(ACTOR_DEFERRED_OPS.has(op)).toBe(false);
      }
      const { clientId, clientSecret } = await provider().registerClientManual('qm-jobs-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await engine.executeRaw("UPDATE oauth_clients SET scope = 'read write agent', bound_tools = $2, bound_source_id = source_id, federated_read = ARRAY[source_id], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_max_concurrent = 1 WHERE client_id = $1", [clientId, ['get_page', ...ACTOR_DEFERRED_OPS]]);
      await bindCredential(engine, { kind: 'client', id: clientId }, { attestActor: 'qm', attestOps: ['get_page'] });
      await engine.executeRaw('UPDATE oauth_clients SET attest_ops = $2 WHERE client_id = $1', [clientId, ['get_page', ...ACTOR_DEFERRED_OPS]]);
      const bearer = (await provider().exchangeClientCredentials(clientId, clientSecret!)).access_token;
      const deferredCalls: Array<[string, Record<string, unknown>]> = [
        ['list_write_conflicts', {}], ['capture', { content: 'note' }], ['extract_facts', { text: 'x' }],
        ['takes_add', { page_slug: PAGES.alice.slug, claim: 'x' }],
      ];
      for (const [op, params] of deferredCalls) {
        const out = await refused(call(bearer, op, params, { actor: ALICE_ID }), 'actor_not_attested', 'op_not_attested');
        expect(out.structured!.error!.fix).toBeUndefined();
      }
      expect((await call(bearer, 'get_page', { slug: PAGES.alice.slug }, { actor: ALICE_ID })).text).toContain(PAGES.alice.canary);
    }, 120_000);

    test('the legacy bearer transport reads x-qm-actor over a real socket and serves the description on initialize', async () => {
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
      try {
        const post = async (headers: Record<string, string>, body: Record<string, unknown>) => {
          const res = await fetch('http://127.0.0.1:' + server.port + '/mcp', {
            method: 'POST', headers: { authorization: 'Bearer ' + tokens.legacy!.token, 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
          });
          return await res.json() as { result: Record<string, unknown> };
        };
        const tool = (headers: Record<string, string>, args: Record<string, unknown> = {}) => post(headers, { method: 'tools/call', params: { name: 'get_page', arguments: { slug: PAGES.alice.slug, ...args } } });
        expect(JSON.stringify(await tool({ 'x-qm-actor': ALICE_ID }))).toContain(PAGES.alice.canary);
        expect(JSON.stringify(await tool({}))).not.toContain(PAGES.alice.canary);
        const mismatch = await tool({ 'X-QM-Actor': ALICE_ID }, { acting_user: BOB_ID });
        expect((mismatch.result.structuredContent as { error: { code: string; reason: string } }).error).toMatchObject({ code: 'actor_not_attested', reason: 'argument_mismatch' });
        const init = await post({ 'x-qm-actor': ALICE_ID }, { method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
        expect((init.result.serverInfo as { description: string }).description).toBe(MCP_SERVER_DESCRIPTION);
      } finally {
        server.stop(true);
      }
    }, 60_000);

    test('each actor assertion is appended to the audit trail with outcome and reason, never page content', async () => {
      const before = readAudienceAssertions().length;
      await getAs(ALICE_ID, 'alice');
      await getAs(ALICE_ID, 'alice', clients.plain!.token);
      await getAs('u0alice', 'alice');
      const added = readAudienceAssertions().slice(before);
      expect(added.map(e => ({ outcome: e.outcome, audience: e.audience, actor: e.actor }))).toEqual([
        { outcome: 'accepted', audience: ['member:alice-example'], actor: { system: 'qm', external_id: ALICE_ID } },
        { outcome: 'actor_not_attested', audience: [], actor: { system: 'qm', external_id: ALICE_ID, reason: 'no_attest_right' } },
        { outcome: 'actor_unlinked', audience: [], actor: { system: 'qm', external_id: 'u0alice' } },
      ]);
      expect(JSON.stringify(added)).not.toContain(PAGES.alice.canary);
    }, 60_000);
  });
}

describe('serverInfo.description (GST-359 item 6)', () => {
  test('fits 120 characters, carries the brain-first rule, and leaves instructions byte-identical', () => {
    expect(MCP_SERVER_DESCRIPTION.length).toBeLessThanOrEqual(120);
    expect(MCP_SERVER_DESCRIPTION).toContain('gbrain');
    expect(MCP_SERVER_DESCRIPTION).toContain('remember');
    expect(createHash('sha256').update(GBRAIN_MCP_INSTRUCTIONS).digest('hex')).toBe('4b6a1ea876614592681a2e63daf8e68046cbb238bf4b7399425f781311f27cb8');
  });
});
