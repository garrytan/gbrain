/**
 * GST-3058: a remote caller bound to the brain owner reads the protected parts of a page the way the local CLI does.
 *
 * 1. Protects (R94): an owner-bound credential, the legacy token with an explicit [world] holders list (T) and an
 *    OAuth client shaped like a hosted owner client with no holders list (C), reads the private and held rows of a
 *    page's Facts fence through get_page, the edge context of a graph hop whose evidence page holds such a fence, and
 *    takes: C reads every holder, T only the holders it lists. Every other caller reads what it read before: another
 *    member, an unbound token and the owner's credential speaking for a channel get no private row, no take in
 *    get_page and world takes only.
 * 2. Fails when: an owner-bound caller misses a row the local CLI reads on these paths, or any other caller gains one.
 * 3. Real seams: tokens and clients minted by the token service and the OAuth provider, verified by the provider,
 *    dispatched through MCP dispatch with the holders list the HTTP transports compute, on PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { credentialHolders, setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const take = (n: number, claim: string, holder: string) => ({ rowNum: n, claim, kind: 'take', holder, weight: 0.5, active: true });
const page = (type: string, title: string, rows: ReturnType<typeof row>[], extra = '', fm = '') =>
  '---\ntype: ' + type + '\ntitle: ' + title + '\n' + fm + '---\n# ' + title + '\n\nProfile.\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n' + extra;
const TARGET = 'people/target-example', THIRD = 'people/third-example', ACME = 'companies/acme-example', LIA = 'people/lia-example';
const MEET = 'meetings/standup-example', KIM = 'people/kim-example', CORE = 'notes/core-example';
const PRIV = 'pelicanprivcanary', HELD = 'wombatheldcanary', CORE_PRIV = 'heronprivcorecanary', CORE_HELD = 'badgerheldcorecanary', MEET_PRIV = 'lynxmeetprivcanary';
const TAKES = [['world', 'takeworldcanary'], ['brain', 'takebraincanary'], ['self', 'takeselfcanary'], [TARGET, 'takepersoncanary']] as const;
const HOPS = [{ link_type: 'works_at', toward: 'object' }];
const OWNER = 'owner-example', BOB = 'bob-example';
const CALLERS = ['local', 'ownerT', 'ownerC', 'bob', 'unbound', 'channel'] as const;
type Caller = typeof CALLERS[number];

for (const kind of testBackends()) {
  describe('GST-3058 owner-bound remote callers read protected page parts (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: Caller, op: string, params: Record<string, unknown>): Promise<string> {
      __resetPrivateVisibilityCacheForTests();
      let out;
      if (who === 'local') out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: 'default' });
      else {
        const credential = who === 'channel' ? 'ownerT' : who;
        const auth = await provider().verifyAccessToken(tokens[credential]!) as unknown as AuthInfo & { takesHoldersAllowList?: string[] };
        out = await dispatchToolCall(engine, op, { ...params }, {
          remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default',
          takesHoldersAllowList: await credentialHolders(engine, auth.takesHoldersAllowList, auth.member?.id),
          ...(who === 'channel' ? { onBehalfOf: { header: 'member:' + OWNER + ',member:' + BOB } } : {}),
        });
      }
      const text = out.content.map(c => c.text).join('\n');
      expect(out.isError, who + ' ' + op + ': ' + text.slice(0, 300)).toBeFalsy();
      return text;
    }
    const put = (slug: string, content: string) => call('local', 'put_page', { slug, content, request_id: randomUUID() });
    const holdRow = (canary: string) => engine.transaction(tx => withCoordinatedWrite(tx, ['default'],
      () => tx.executeRaw("UPDATE facts SET visibility = 'private' WHERE fact LIKE '%' || $1 || '%'", [canary]), TEST_WRITE_ATTRIBUTION));
    const seen = (text: string, canaries: readonly string[]) => canaries.filter(c => text.includes(c));

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      for (const [slug, title] of [[TARGET, 'Target Example'], [THIRD, 'Third Example']]) await put(slug, page('person', title, [row(1, title + ' likes tea')]));
      await put(ACME, page('company', 'Acme Example', [row(1, 'Acme makes widgets')]));
      await put(LIA, page('person', 'Lia Example', [
        row(1, 'Lia owes [[' + TARGET + ']] money ' + PRIV, 'private'),
        row(2, 'Lia works at [[' + ACME + ']] as an engineer'),
        row(3, 'Lia dated [[' + THIRD + ']] ' + HELD),
      ], '\n## Takes\n\n' + renderTakesFence(TAKES.map(([holder, canary], i) => take(i + 1, 'Lia view ' + canary, holder)) as never) + '\n'));
      await put(KIM, '---\ntype: person\ntitle: Kim Example\n---\n# Kim Example\n\nProfile.\n');
      await put(MEET, '---\ntype: meeting\ntitle: Standup Example\ndate: 2026-01-01\n---\n# Standup Example\n\n## Facts\n\n'
        + renderFactsTable([row(1, 'The standup ran long'), row(2, 'Budget raised ' + MEET_PRIV, 'private')] as never) + '\n\n## Attendees\n\n- [[' + KIM + ']]\n');
      await put(CORE, page('note', 'Core Example', [row(1, 'Core detail ' + CORE_PRIV, 'private'), row(2, 'Core detail ' + CORE_HELD), row(3, 'Core detail public')], '', 'always_load: true\n'));
      await holdRow(HELD); await holdRow(CORE_HELD);
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING");
      for (const id of [OWNER, BOB]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member?: string, mayActFor?: string[]) => {
        const m = await mintLegacyToken(engine, { name, scopes: ['read'], takesHolders: ['world'] });
        tokens[name] = m.token;
        if (member) await bindCredential(engine, { kind: 'token', id: m.id }, { member, ...(mayActFor ? { mayActFor } : {}) }); else await readsUnscopedOnPurpose(engine, m.id);
      };
      await mint('ownerT', OWNER, ['member:' + OWNER, 'member:' + BOB]); await mint('bob', BOB); await mint('unbound');
      const client = await provider().registerClientManual('owner-client-example', ['client_credentials'], 'admin skills_member_self', [], 'default', ['default', 'source-b']);
      await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: OWNER });
      tokens.ownerC = (await provider().exchangeClientCredentials(client.clientId, client.clientSecret!)).access_token;
      await setOwner(engine, OWNER);
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); }, 60_000);

    const OWNERS: readonly Caller[] = ['ownerT', 'ownerC'];
    const OTHERS: readonly Caller[] = ['bob', 'unbound', 'channel'];

    test('fixture control: the local CLI reads every protected row and take, and the owner client carries no holders list', async () => {
      expect(seen(await call('local', 'get_page', { slug: LIA }), [PRIV, HELD, ...TAKES.map(t => t[1])])).toHaveLength(6);
      expect((await provider().verifyAccessToken(tokens.ownerC!) as unknown as { takesHoldersAllowList?: string[] }).takesHoldersAllowList).toBeUndefined();
    }, 120_000);

    test('get_page: owner-bound callers read the private and held Facts rows; no other caller does', async () => {
      const reads: Array<[string, string[]]> = [[LIA, [PRIV, HELD]], [MEET, [MEET_PRIV]], [CORE, [CORE_PRIV, CORE_HELD]]];
      for (const [slug, canaries] of reads) {
        for (const who of ['local', ...OWNERS] as Caller[]) expect({ who, slug, seen: seen(await call(who, 'get_page', { slug }), canaries) }).toEqual({ who, slug, seen: canaries });
        for (const who of OTHERS) expect({ who, slug, seen: seen(await call(who, 'get_page', { slug }), canaries) }).toEqual({ who, slug, seen: [] });
      }
    }, 240_000);

    test('traverse_graph hops: owner-bound callers read the edge context the evidence page holds; no other caller does', async () => {
      for (const who of ['local', ...OWNERS] as Caller[]) expect({ who, seen: seen(await call(who, 'traverse_graph', { slug: LIA, hops: HOPS }), [PRIV]) }).toEqual({ who, seen: [PRIV] });
      for (const who of OTHERS) {
        const out = JSON.parse(await call(who, 'traverse_graph', { slug: LIA, hops: HOPS }));
        expect({ who, contexts: out.paths.flatMap((p: { edges: Array<{ context: unknown }> }) => p.edges.map(e => e.context)) }).toEqual({ who, contexts: [null] });
      }
    }, 240_000);

    test('traverse_graph attendee read is unchanged: owner-bound callers read the edge context, no other caller does', async () => {
      for (const who of OWNERS) expect({ who, seen: seen(await call(who, 'traverse_graph', { slug: KIM, depth: 1 }), [MEET_PRIV]) }).toEqual({ who, seen: [MEET_PRIV] });
      for (const who of OTHERS) expect({ who, seen: seen(await call(who, 'traverse_graph', { slug: KIM, depth: 1 }), [MEET_PRIV]) }).toEqual({ who, seen: [] });
    }, 240_000);

    test('takes: an owner-bound caller with no holders list reads every holder, an explicit list stays honoured, every other caller reads world takes', async () => {
      const canaries = TAKES.map(t => t[1]);
      const want: Record<Caller, { list: number; fence: number }> = { local: { list: 4, fence: 4 }, ownerC: { list: 4, fence: 4 }, ownerT: { list: 1, fence: 1 }, bob: { list: 1, fence: 0 }, unbound: { list: 1, fence: 0 }, channel: { list: 1, fence: 0 } };
      for (const who of CALLERS) {
        const got = {
          takes_list: seen(await call(who, 'takes_list', { page_slug: LIA }), canaries).length,
          takes_search: seen(await call(who, 'takes_search', { query: 'Lia view' }), canaries).length,
          get_page: seen(await call(who, 'get_page', { slug: LIA }), canaries).length,
        };
        expect({ who, ...got }).toEqual({ who, takes_list: want[who].list, takes_search: want[who].list, get_page: want[who].fence });
      }
    }, 240_000);
  });
}
