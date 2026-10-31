/**
 * GBRA-231: shared agents read as the audience their harness names (plan v6 section 4).
 *
 * 1. Protects: a shared agent's call carrying an audience (the X-Gbrain-On-Behalf-Of header or request-level
 *    _meta.on_behalf_of) reads only the pages every audience entry may read (page readers and folder rules), within
 *    the agent's source grant; a guest reads no restricted page; the agent's own member binding never adds to it; a
 *    channel audience never sees a visibility: private page, whatever the agent's grant or an operator hatch says. The
 *    audience is re-read on every call, bounded by the credential's live may_act_for (stdio: mcp.stdio_may_act_for),
 *    and refused before work when it sits in tool arguments, is malformed, names someone outside may_act_for or names
 *    no enabled member. Queued writes and agent jobs keep the audience they were accepted for.
 * 2. Fails when: an audience reads a page one of its entries may not read (on any read path), the agent's own member
 *    leaks into an audience view (a guest turn sees the bot's pages), a prompt-injected argument picks the audience,
 *    a refusal carries page content, a channel sees a private page, a later call keeps an earlier audience, the
 *    semantic cache key ignores the audience, or a stored write or job reads as the credential's member instead of
 *    its audience.
 * 3. Existing coverage (member-read-access, access-writes) pins single-member credentials only.
 * 4. Real seams: legacy tokens minted by the token service, bound by the member CLI functions, verified by the
 *    serve --http verifier and by the legacy bearer transport over a real socket, dispatched through MCP dispatch on
 *    a repo-less brain (no git checkout; folder rules in the database store); embeddings stubbed.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
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
import { __resetPrivateVisibilityCacheForTests, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { knobsHash, resolveSearchMode } from '../src/core/search/mode.ts';
import { remoteCallerAccess } from '../src/core/access/caller.ts';
import { addGroup, addMember, bindCredential, disableMember } from '../src/core/access/members.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { readAudienceAssertions, STDIO_MAY_ACT_FOR_KEY, type AudiencePrincipal } from '../src/core/access/audience.ts';
import { submissionAuthority, authorizeStoredRequest } from '../src/core/persistence/authority.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { parseSubmissionAuthority, prepareRemoteAgent, withSubmissionAuthority, type RemoteAgentAuthority } from '../src/core/minions/submission-authority.ts';
import type { AuthInfo, OperationContext } from '../src/core/ops/contract.ts';
import { sharedAgentAccessEntry } from '../src/commands/doctor/checks/shared-agent-access.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
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

const SRC = 'obo-team';
const PAGES = {
  alice: { slug: 'notes/alice-plan', fm: ['readable_by: [alice-example]'], canary: 'canaryoboalice' },
  bob: { slug: 'notes/bob-plan', fm: ['readable_by: [bob-example]'], canary: 'canaryobobob' },
  both: { slug: 'notes/both-plan', fm: ['readable_by: [alice-example, bob-example]'], canary: 'canaryoboboth' },
  team: { slug: 'notes/team-plan', fm: ['readable_by: [group:team-a]'], canary: 'canaryoboteam' },
  dan: { slug: 'notes/dan-plan', fm: ['readable_by: [dan-example]'], canary: 'canaryobodan' },
  folder: { slug: 'partners/alice-example/brief', fm: [] as string[], canary: 'canaryobofolder' },
  quiet: { slug: 'notes/quiet-plan', fm: ['visibility: private'], canary: 'canaryoboquiet' },
} as const;
type Key = keyof typeof PAGES;
const RESTRICTED: Key[] = ['alice', 'bob', 'both', 'team', 'dan', 'folder', 'quiet'];
const OPEN = { slug: 'notes/open-plan', canary: 'canaryoboopen' };

const page = (key: Key) => ['---', 'type: note', 'title: ' + key + ' plan', ...PAGES[key].fm, '---', '# ' + key + ' plan', '',
  'Harbor ledger planning notes ' + PAGES[key].canary + ' for the roadmap.'].join('\n');

/** Read paths (label, op, args); a path given the slug may echo it in a not-found error, so it counts content only. */
function reads(key: Key): Array<[string, string, Record<string, unknown>]> {
  const slug = PAGES[key].slug;
  return [
    ['search hybrid', 'search', { query: 'harbor ledger planning notes', fields: 'full', limit: 30 }],
    ['search keyword', 'search', { query: 'planning notes', match: 'keyword', fields: 'full', limit: 30 }],
    ['query', 'query', { query: 'harbor ledger planning notes', expand: false, fields: 'full', limit: 30 }],
    ['get_page', 'get_page', { slug }],
    ['list_pages', 'list_pages', { slug_prefix: slug.slice(0, slug.indexOf('/') + 1) }],
    ['get_chunks', 'get_chunks', { slug }],
    ['get_versions', 'get_versions', { slug, include_body: true }],
    ['resolve_slugs', 'resolve_slugs', { partial: slug.slice(slug.lastIndexOf('/') + 1) }],
  ];
}
const ECHOES_SLUG = new Set(['get_page', 'get_chunks', 'get_versions']);
const CORE = ['search keyword', 'get_page', 'list_pages'];

type Channels = { header?: string; meta?: unknown };

for (const kind of testBackends()) {
  describe('shared agents on_behalf_of (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, { id: string; token: string }> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (who: string) => await provider().verifyAccessToken(tokens[who]!.token) as unknown as AuthInfo;

    async function call(who: string | null, op: string, params: Record<string, unknown>, ch: Channels = {}, extra: { sessionId?: string } = {}) {
      const auth = who ? await verify(who) : undefined;
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: who ? 'http' : 'stdio', auth, sourceId: auth?.sourceId ?? SRC, takesHoldersAllowList: ['world'],
        ...(extra.sessionId ? { sessionId: extra.sessionId } : {}),
        onBehalfOf: { header: ch.header, requestMeta: ch.meta === undefined ? undefined : { on_behalf_of: ch.meta } },
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json, meta: out._meta };
    }
    const seen = (text: string, key: Key, label: string) => text.includes(PAGES[key].canary) || (!ECHOES_SLUG.has(label) && text.includes(PAGES[key].slug));

    /** Restricted keys a caller (under its channels) sees on any read path, and the paths where each was seen. */
    async function visible(who: string | null, ch: Channels, keys: readonly Key[] = RESTRICTED): Promise<Record<string, string[]>> {
      const out: Record<string, string[]> = {};
      for (const key of keys) {
        for (const [label, op, params] of reads(key)) {
          const { text } = await call(who, op, params, ch);
          if (seen(text, key, label)) (out[key] ??= []).push(label);
        }
      }
      return out;
    }
    /** Exactly the allowed restricted keys are visible, each on the core paths. */
    async function expectView(who: string | null, ch: Channels, allowed: Key[]) {
      const got = await visible(who, ch);
      expect({ who, ch, keys: Object.keys(got).sort() }).toEqual({ who, ch, keys: [...allowed].sort() });
      for (const key of allowed) for (const label of CORE) expect({ key, label, seen: got[key]!.includes(label) }).toEqual({ key, label, seen: true });
    }

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example', 'dan-example', 'eve-example']) await addMember(engine, id);
      await addGroup(engine, 'team-a', ['bob-example']);
      await addGroup(engine, 'team-b');
      await disableMember(engine, 'eve-example');
      await proposeRevision(engine, SRC, [{ id: 'alice', prefix: 'partners/alice-example/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
      await importFromContent(engine, OPEN.slug, '---\ntype: note\ntitle: Open plan\n---\n# Open plan\n\nHarbor ledger planning notes ' + OPEN.canary + '.', { sourceId: SRC });
      for (const key of Object.keys(PAGES) as Key[]) {
        await importFromContent(engine, PAGES[key].slug, page(key), { sourceId: SRC });
        await engine.createVersion(PAGES[key].slug, { sourceId: SRC });
      }
      const mint = async (name: string, binding: { member?: string; mayActFor?: string[] }, scopes = ['read']) => {
        const minted = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], sourceGrant: [SRC] });
        tokens[name] = { id: minted.id, token: minted.token };
        if (binding.member || binding.mayActFor) await bindCredential(engine, { kind: 'token', id: minted.id }, binding);
      };
      await mint('bot', { mayActFor: ['member:alice-example', 'member:bob-example', 'group:team-a', 'guest'] });
      await mint('bot-dan', { member: 'dan-example', mayActFor: ['guest', 'member:alice-example', 'member:bob-example'] }, ['read', 'write']);
      await mint('narrow', { mayActFor: ['member:alice-example'] });
      await mint('wild', { mayActFor: ['*'] });
      await mint('granted', { mayActFor: ['member:alice-example', 'member:bob-example'] });
      await mint('plain', {});
      await rescopeLegacyToken(engine, parseRescopeTokenArgs(['granted', '--private-pages', 'granted-sources']));
    }, 240_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await close?.();
    }, 60_000);

    test('fixture control: without an audience the bot reads no restricted page and the dan-bound bot reads only dan\'s', async () => {
      await expectView('bot', {}, []);
      await expectView('bot-dan', {}, ['dan']);
    }, 240_000);

    test('a two-member audience reads only the pages both members may read', async () => {
      await expectView('bot', { header: 'alice-example, bob-example' }, ['both']);
      await expectView('bot', { meta: ['bob-example', 'alice-example'] }, ['both']);
    }, 240_000);

    test('a one-member audience reads as that member: page readers and folder rules', async () => {
      await expectView('bot', { meta: ['alice-example'] }, ['alice', 'both', 'folder']);
      await expectView('bot', { header: 'bob-example' }, ['bob', 'both', 'team']);
    }, 240_000);

    test('a group audience counts as one principal and reads what the group may read', async () => {
      await expectView('bot', { header: 'group:team-a' }, ['team']);
    }, 240_000);

    test('a guest reads no restricted page, and the agent\'s own member never adds to an audience view', async () => {
      await expectView('bot', { header: 'guest' }, []);
      await expectView('bot-dan', { header: 'guest' }, []);
      await expectView('bot-dan', { meta: ['alice-example', 'guest'] }, []);
      await expectView('bot-dan', { header: 'alice-example' }, ['alice', 'both', 'folder']);
    }, 240_000);

    test('the audience is read on every call: switching it mid-session never keeps an earlier view', async () => {
      const sessionId = 'obo-session-' + randomUUID();
      const get = (ch: Channels) => call('bot', 'get_page', { slug: PAGES.alice.slug }, ch, { sessionId });
      expect((await get({ header: 'alice-example' })).text).toContain(PAGES.alice.canary);
      expect((await get({ header: 'bob-example' })).text).not.toContain(PAGES.alice.canary);
      expect((await get({})).text).not.toContain(PAGES.alice.canary);
      expect((await get({ meta: ['alice-example'] })).text).toContain(PAGES.alice.canary);
    }, 120_000);

    test('an audience inside tool arguments is refused before any read, even beside a valid header', async () => {
      const cases: Array<[Record<string, unknown>, Channels]> = [
        [{ slug: PAGES.alice.slug, on_behalf_of: ['alice-example'] }, {}],
        [{ slug: PAGES.alice.slug, _meta: { on_behalf_of: ['alice-example'] } }, {}],
        [{ slug: PAGES.alice.slug, on_behalf_of: 'alice-example' }, { header: 'alice-example' }],
      ];
      for (const [params, ch] of cases) {
        const out = await call('bot', 'get_page', params, ch);
        expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code: 'on_behalf_of_in_arguments' });
        expect(out.text).not.toContain(PAGES.alice.canary);
        expect(out.json.docs).toContain('write-refusals.md#on_behalf_of_in_arguments');
      }
    }, 60_000);

    test('a malformed, empty, oversized or conflicting audience is refused before any read', async () => {
      const cases: Channels[] = [
        { header: '' }, { header: ' , ' }, { header: 'alice-example,,bob-example' }, { header: 'Not Valid' }, { header: 'ext:crm:42' },
        { meta: [] }, { meta: 'alice-example' }, { meta: [7] }, { meta: Array.from({ length: 51 }, (_, i) => 'm' + i + '-example') },
        { header: 'alice-example', meta: ['bob-example'] }, { header: 'alice-example, guest', meta: ['alice-example'] },
      ];
      for (const ch of cases) {
        const out = await call('bot', 'get_page', { slug: PAGES.both.slug }, ch);
        expect({ ch, code: out.json.code }).toEqual({ ch, code: 'on_behalf_of_invalid_audience' });
        expect(out.text).not.toContain(PAGES.both.canary);
      }
      const same = await call('bot', 'get_page', { slug: PAGES.both.slug }, { header: 'bob-example, Alice-Example', meta: ['alice-example', 'member:bob-example'] });
      expect(same.text).toContain(PAGES.both.canary);
    }, 120_000);

    test('an entry outside may_act_for is refused with the operator\'s command, before membership is checked, and no content', async () => {
      const out = await call('narrow', 'get_page', { slug: PAGES.alice.slug }, { header: 'alice-example, bob-example' });
      expect(out.json.code).toBe('on_behalf_of_not_permitted');
      expect(out.json.message).toContain('token narrow');
      expect(out.json.message).toContain('member:bob-example');
      expect(out.text).not.toContain(PAGES.alice.canary);
      const fix = out.json.fix as Record<string, unknown>;
      expect({ next: fix.next, argv: fix.argv }).toEqual({ next: 'tell_user_to_run',
        argv: ['gbrain', 'auth', 'rescope', '--token', 'narrow', '--may-act-for', 'member:alice-example,member:bob-example'] });
      expect((await call('narrow', 'get_page', { slug: PAGES.alice.slug }, { header: 'ghost-example' })).json.code).toBe('on_behalf_of_not_permitted');
      expect((await call('plain', 'get_page', { slug: PAGES.alice.slug }, { meta: ['alice-example'] })).json.code).toBe('on_behalf_of_not_permitted');
      expect((await call('bot', 'get_page', { slug: PAGES.alice.slug }, { header: 'group:team-b' })).json.code).toBe('on_behalf_of_not_permitted');
    }, 60_000);

    test('may_act_for is read on every call: narrowing it refuses the next call', async () => {
      expect((await call('narrow', 'get_page', { slug: PAGES.alice.slug }, { header: 'alice-example' })).text).toContain(PAGES.alice.canary);
      await bindCredential(engine, { kind: 'token', id: tokens.narrow!.id }, { mayActFor: null });
      try {
        expect((await call('narrow', 'get_page', { slug: PAGES.alice.slug }, { header: 'alice-example' })).json.code).toBe('on_behalf_of_not_permitted');
      } finally {
        await bindCredential(engine, { kind: 'token', id: tokens.narrow!.id }, { mayActFor: ['member:alice-example'] });
      }
    }, 60_000);

    test('an unknown or disabled member, or an unknown group, is refused rather than read as a guest', async () => {
      for (const header of ['ghost-example', 'eve-example', 'group:no-such-group', 'alice-example, ghost-example']) {
        const out = await call('wild', 'get_page', { slug: PAGES.alice.slug }, { header });
        expect({ header, code: out.json.code }).toEqual({ header, code: 'on_behalf_of_unknown_member' });
        expect(out.text).not.toContain(PAGES.alice.canary);
      }
      expect((await call('wild', 'get_page', { slug: PAGES.alice.slug }, { header: 'alice-example' })).text).toContain(PAGES.alice.canary);
    }, 60_000);

    test('privacy relaxes only for a one-member audience: granted_sources and the hatch never open a private page to a channel', async () => {
      const quiet = (ch: Channels) => call('granted', 'get_page', { slug: PAGES.quiet.slug }, ch).then(o => o.text.includes(PAGES.quiet.canary));
      expect(await quiet({ header: 'alice-example' })).toBe(true);
      expect(await quiet({ header: 'alice-example, bob-example' })).toBe(false);
      expect(await quiet({})).toBe(true);
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        expect((await call('bot', 'get_page', { slug: PAGES.quiet.slug }, { header: 'alice-example' })).text).toContain(PAGES.quiet.canary);
        expect((await call('bot', 'get_page', { slug: PAGES.quiet.slug }, { header: 'alice-example, guest' })).text).not.toContain(PAGES.quiet.canary);
        expect((await call('bot', 'search', { query: 'planning notes', match: 'keyword', fields: 'full', limit: 30 }, { header: 'group:team-a' })).text).not.toContain(PAGES.quiet.canary);
      });
    }, 120_000);

    test('every response carries _meta.access, and whoami returns the same view as access.applied', async () => {
      const out = await call('bot', 'search', { query: 'planning notes', match: 'keyword', limit: 5 }, { header: 'alice-example, bob-example' });
      const access = out.meta?.access as Record<string, unknown>;
      expect(access).toMatchObject({ member: null, groups: [], audience: ['member:alice-example', 'member:bob-example'], relaxation: 'none' });
      expect((access.policy_rev as Record<string, number>)[SRC]).toBeGreaterThan(0);
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', ['obo-other-src']);
      await proposeRevision(engine, 'obo-other-src', [{ id: 'other', prefix: 'other/', readable_by: ['member:bob-example'] }], { origin: 'cli', store: 'database' });
      const scoped = (await call('bot', 'get_page', { slug: OPEN.slug }, { header: 'alice-example' })).meta?.access as Record<string, unknown>;
      expect(Object.keys(scoped.policy_rev as Record<string, number>)).toEqual([SRC]);
      const single = await call('granted', 'get_page', { slug: OPEN.slug }, { meta: ['bob-example'] });
      expect(single.meta?.access).toMatchObject({ member: 'bob-example', groups: ['team-a'], audience: ['member:bob-example'], relaxation: 'granted_sources' });
      const plain = await call('bot-dan', 'get_page', { slug: OPEN.slug });
      expect(plain.meta?.access).toMatchObject({ member: 'dan-example', audience: null });
      const who = await call('bot-dan', 'whoami', {}, { header: 'guest' });
      expect((who.json.access as Record<string, unknown>).applied).toMatchObject({ member: null, groups: [], audience: ['guest'] });
      expect((who.json.access as Record<string, unknown>).member).toBe('dan-example');
    }, 60_000);

    test('the semantic cache key differs for each audience, and from an unbound caller', () => {
      const knobs = resolveSearchMode({ mode: 'balanced' });
      const under = (access: Parameters<typeof withCallerAccess>[0]) => withCallerAccess(access, () => knobsHash(knobs, { excludePrivate: true }));
      const unbound = under({ identity: [] });
      const pair = under({ identity: [], audience: ['member:alice-example', 'member:bob-example'], audienceIdentities: [['member:alice-example'], ['member:bob-example']] });
      const other = under({ identity: [], audience: ['guest', 'member:alice-example'], audienceIdentities: [[], ['member:alice-example']] });
      expect(new Set([unbound, pair, other]).size).toBe(3);
    });

    test('a write under an audience is checked against the audience: an unreadable target is not_found, readers must keep every entry', async () => {
      const hidden = await call('bot-dan', 'add_tag', { slug: PAGES.dan.slug, tag: 'x-tag' }, { header: 'guest' });
      expect(hidden.json.code).toBe('page_not_found');
      const lockout = await call('bot-dan', 'put_page', { slug: 'notes/channel-new', content: '---\ntype: note\nreadable_by: [alice-example]\n---\n# New\n\nNew.' }, { header: 'alice-example, bob-example' });
      expect(lockout.json).toMatchObject({ code: 'readable_by_invalid', message: expect.stringContaining('the audience this connection acts for') });
      const [rows] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM pages WHERE slug = 'notes/channel-new'");
      expect(rows!.n).toBe(0);
      const own = await call('bot-dan', 'add_tag', { slug: PAGES.dan.slug, tag: 'x-tag' });
      expect(own.isError).toBe(false);
    }, 120_000);

    test('a stored write keeps its audience: publication re-resolves it, never the principal\'s own member, and a revoked may_act_for refuses it', async () => {
      const auth = await verify('bot-dan');
      const ctx = { engine, config: { engine: 'pglite' }, sourceId: SRC, auth, remote: true, dryRun: false, takesHoldersAllowList: ['world'],
        logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
      const [source] = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1', [SRC]);
      const authority = await withCallerAccess(await remoteCallerAccess(engine, auth, undefined, 'http', ['member:alice-example']),
        () => submissionAuthority(ctx, 'add_tag', SRC, source!.incarnation, PAGES.alice.slug));
      expect(authority.actingFor).toEqual(['member:alice-example']);
      const row = await admitWrite(engine, { principal: authority.principal, authority, operation: 'add_tag', sourceId: SRC,
        sourceIncarnation: source!.incarnation, slug: PAGES.alice.slug, requestId: randomUUID(), callerIntent: {}, intent: {} });
      await authorizeStoredRequest(engine, row);
      await bindCredential(engine, { kind: 'token', id: tokens['bot-dan']!.id }, { mayActFor: ['guest'] });
      try {
        await expect(authorizeStoredRequest(engine, row)).rejects.toMatchObject({ code: 'page_not_found' });
      } finally {
        await bindCredential(engine, { kind: 'token', id: tokens['bot-dan']!.id }, { mayActFor: ['guest', 'member:alice-example', 'member:bob-example'] });
      }
      const guest = await withCallerAccess(await remoteCallerAccess(engine, auth, undefined, 'http', ['guest']),
        () => submissionAuthority(ctx, 'add_tag', SRC, source!.incarnation, OPEN.slug));
      expect({ actingFor: guest.actingFor, excludePrivate: guest.excludePrivate }).toEqual({ actingFor: ['guest'], excludePrivate: true });
      const danRow = await admitWrite(engine, { principal: guest.principal, authority: { ...guest }, operation: 'add_tag', sourceId: SRC,
        sourceIncarnation: source!.incarnation, slug: PAGES.dan.slug, requestId: randomUUID(), callerIntent: {}, intent: {} });
      await expect(authorizeStoredRequest(engine, danRow)).rejects.toMatchObject({ code: 'page_not_found' });
    }, 120_000);

    test('an agent job reads as the audience it was submitted for, never as its client\'s member', async () => {
      const { clientId } = await provider().registerClientManual('obo-agent', ['client_credentials'], 'read', [], SRC);
      await bindCredential(engine, { kind: 'client', id: clientId }, { member: 'dan-example', mayActFor: ['guest', 'member:alice-example'] });
      const tools = buildBrainTools({ subagentId: 9, engine, config: { engine: 'pglite' } as never, sourceId: SRC,
        delegatedAuth: { clientId, scopes: ['read', 'agent'], sourceId: SRC, allowedSources: [SRC] } });
      const getPage = tools.find(t => t.name === 'brain_get_page')!;
      const read = async (slug: string, actingFor?: string[]) => {
        const authority: RemoteAgentAuthority = { version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: clientId },
          grant: { scopes: ['read', 'agent'], sourceId: SRC, sourceCreatedAt: new Date(0).toISOString(), allowedTools: ['get_page'], allowedSlugPrefixes: [], ...(actingFor ? { actingFor } : {}) },
          payloadHash: '0'.repeat(64) };
        expect(parseSubmissionAuthority(authority)).not.toBeNull();
        try { return JSON.stringify(await withSubmissionAuthority(authority, () => getPage.execute({ slug }, { engine, jobId: 1, remote: true } as never))); }
        catch (e) { return String((e as Error).message); }
      };
      expect(await read(PAGES.dan.slug)).toContain(PAGES.dan.canary);
      expect(await read(PAGES.dan.slug, ['guest'])).not.toContain(PAGES.dan.canary);
      expect(await read(PAGES.alice.slug, ['member:alice-example'])).toContain(PAGES.alice.canary);
      expect(await read(PAGES.dan.slug, ['member:alice-example'])).not.toContain(PAGES.dan.canary);
      await engine.executeRaw("UPDATE oauth_clients SET scope = 'read agent', bound_tools = ARRAY['get_page'], bound_source_id = source_id, federated_read = ARRAY[source_id], delegated_namespace = 'job', delegated_slug_prefixes = NULL, bound_max_concurrent = 1 WHERE client_id = $1", [clientId]);
      const agentAuth = { token: 'x', clientId, scopes: ['read', 'agent'], sourceId: SRC, principal: { kind: 'oauth_client', id: clientId } } as unknown as AuthInfo;
      const submit = async (audience?: AudiencePrincipal[]) => withCallerAccess(await remoteCallerAccess(engine, agentAuth, undefined, 'http', audience ?? null),
        () => prepareRemoteAgent({ engine, auth: agentAuth, remote: true } as unknown as OperationContext, { source_id: SRC, allowed_tools: ['get_page'], allowed_slug_prefixes: [] }));
      expect((await submit(['member:alice-example'])).grant.actingFor).toEqual(['member:alice-example']);
      expect((await submit()).grant.actingFor).toBeUndefined();
      await bindCredential(engine, { kind: 'client', id: clientId }, { mayActFor: ['guest'] });
      expect(await read(PAGES.alice.slug, ['member:alice-example'])).not.toContain(PAGES.alice.canary);
      expect(parseSubmissionAuthority({ version: 1, kind: 'remote_agent', principal: { kind: 'oauth_client', id: clientId },
        grant: { scopes: ['agent'], sourceId: SRC, sourceCreatedAt: 'x', allowedTools: ['get_page'], allowedSlugPrefixes: [], actingFor: [] }, payloadHash: '0'.repeat(64) })).toBeNull();
    }, 120_000);

    test('a stdio server refuses every audience until mcp.stdio_may_act_for lists it', async () => {
      const refused = await call(null, 'get_page', { slug: PAGES.alice.slug }, { meta: ['alice-example'] });
      expect(refused.json.code).toBe('on_behalf_of_not_permitted');
      expect(((refused.json.fix as Record<string, unknown>).argv as string[]).slice(0, 5)).toEqual(['gbrain', 'config', 'set', STDIO_MAY_ACT_FOR_KEY, 'member:alice-example']);
      await engine.setConfig(STDIO_MAY_ACT_FOR_KEY, 'alice-example,guest');
      try {
        expect((await call(null, 'get_page', { slug: PAGES.alice.slug }, { meta: ['alice-example'] })).text).toContain(PAGES.alice.canary);
        expect((await call(null, 'get_page', { slug: PAGES.alice.slug }, { meta: ['guest'] })).text).not.toContain(PAGES.alice.canary);
        expect((await call(null, 'get_page', { slug: PAGES.bob.slug }, { meta: ['bob-example'] })).json.code).toBe('on_behalf_of_not_permitted');
      } finally {
        await engine.setConfig(STDIO_MAY_ACT_FOR_KEY, '');
      }
    }, 60_000);

    test('the legacy bearer transport reads the header and request-level _meta over a real socket', async () => {
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
      try {
        const post = async (headers: Record<string, string>, meta?: unknown) => {
          const res = await fetch('http://127.0.0.1:' + server.port + '/mcp', {
            method: 'POST', headers: { authorization: 'Bearer ' + tokens.bot!.token, 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page', arguments: { slug: PAGES.alice.slug }, ...(meta ? { _meta: meta } : {}) } }),
          });
          return await res.text();
        };
        expect(await post({ 'x-gbrain-on-behalf-of': 'alice-example' })).toContain(PAGES.alice.canary);
        expect(await post({}, { on_behalf_of: ['alice-example'] })).toContain(PAGES.alice.canary);
        expect(await post({ 'X-Gbrain-On-Behalf-Of': 'bob-example' })).not.toContain(PAGES.alice.canary);
        expect(await post({})).not.toContain(PAGES.alice.canary);
        const conflict = await post({ 'x-gbrain-on-behalf-of': 'alice-example' }, { on_behalf_of: ['bob-example'] });
        expect(conflict).toContain('on_behalf_of_invalid_audience');
        expect(conflict).not.toContain(PAGES.alice.canary);
      } finally {
        server.stop(true);
      }
    }, 60_000);

    test('doctor warns on a may_act_for of * (credential or stdio) and is ok on explicit lists', async () => {
      const run = async () => (await sharedAgentAccessEntry.run({ engine } as unknown as DoctorContext) as Array<{ name: string; status: string; message: string }>)[0]!;
      const warned = await run();
      expect(warned.status).toBe('warn');
      expect(warned.message).toContain('token wild');
      await bindCredential(engine, { kind: 'token', id: tokens.wild!.id }, { mayActFor: ['member:alice-example'] });
      try {
        expect((await run()).status).toBe('ok');
        await engine.setConfig(STDIO_MAY_ACT_FOR_KEY, '*');
        try {
          const stdio = await run();
          expect(stdio.status).toBe('warn');
          expect(stdio.message).toContain(STDIO_MAY_ACT_FOR_KEY);
        } finally {
          await engine.setConfig(STDIO_MAY_ACT_FOR_KEY, '');
        }
      } finally {
        await bindCredential(engine, { kind: 'token', id: tokens.wild!.id }, { mayActFor: ['*'] });
      }
    }, 60_000);

    test('each assertion is appended to the audit trail with its outcome', async () => {
      const before = readAudienceAssertions().length;
      await call('bot', 'get_page', { slug: OPEN.slug }, { header: 'alice-example' });
      await call('narrow', 'get_page', { slug: OPEN.slug }, { header: 'bob-example' });
      const added = readAudienceAssertions().slice(before);
      expect(added.map(e => ({ outcome: e.outcome, audience: e.audience, op: e.op, transport: e.transport }))).toEqual([
        { outcome: 'accepted', audience: ['member:alice-example'], op: 'get_page', transport: 'http' },
        { outcome: 'on_behalf_of_not_permitted', audience: ['member:bob-example'], op: 'get_page', transport: 'http' },
      ]);
      expect(added[0]!.principal).toBe('legacy_token:' + tokens.bot!.id);
    }, 60_000);
  });
}

describe('shared agents on an unrestricted brain (pglite, repo-less)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
  }, 120_000);
  afterAll(async () => {
    __resetPrivateVisibilityCacheForTests();
    await engine.disconnect();
  });

  test('a channel audience never sees a private page under the operator hatch before any member exists', async () => {
    try {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', ['obo-open-src']);
      await importFromContent(engine, 'notes/quiet', '---\ntype: note\ntitle: Quiet\nvisibility: private\n---\n# Quiet\n\nHarbor ledger canaryoboopenquiet.', { sourceId: 'obo-open-src', noEmbed: true });
      await addGroup(engine, 'room-a');
      await addGroup(engine, 'room-b');
      const minted = await mintLegacyToken(engine, { name: 'chan-bot', scopes: ['read'], takesHolders: ['world'], sourceGrant: ['obo-open-src'] });
      await bindCredential(engine, { kind: 'token', id: minted.id }, { mayActFor: ['guest', 'group:room-a', 'group:room-b'] });
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
      await withEnv({ GBRAIN_REMOTE_PRIVATE_PAGES: '1' }, async () => {
        __resetPrivateVisibilityCacheForTests();
        const auth = await provider.verifyAccessToken(minted.token) as unknown as AuthInfo;
        const read = async (op: string, params: Record<string, unknown>, header?: string) => (await dispatchToolCall(engine, op, params, {
          remote: true, transport: 'http', auth, sourceId: 'obo-open-src', takesHoldersAllowList: ['world'], ...(header ? { onBehalfOf: { header } } : {}) })).content.map(c => c.text).join('\n');
        expect(await read('get_page', { slug: 'notes/quiet' })).toContain('canaryoboopenquiet');
        for (const header of ['guest', 'group:room-a, group:room-b', 'group:room-a']) {
          expect(await read('get_page', { slug: 'notes/quiet' }, header)).not.toContain('canaryoboopenquiet');
          expect(await read('search', { query: 'harbor ledger', match: 'keyword', fields: 'full' }, header)).not.toContain('canaryoboopenquiet');
          expect(await read('list_pages', {}, header)).not.toContain('notes/quiet');
        }
      });
    } finally {
      __resetPrivateVisibilityCacheForTests();
    }
  }, 120_000);
});
