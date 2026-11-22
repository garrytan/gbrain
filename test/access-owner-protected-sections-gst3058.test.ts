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
import { buildOperationContext, dispatchToolCall } from '../src/mcp/dispatch.ts';
import { operations } from '../src/core/operations.ts';
import { markCliResult } from '../src/cli/room.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { credentialHolders, setOwner } from '../src/core/access/owner.ts';
import { bindCredential } from '../src/core/access/members.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { renderTakesFence } from '../src/core/takes-fence.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { readHolders } from '../src/core/ops/context.ts';
import { testBackends } from './helpers/test-backends.ts';
import { importSegmented, pageContent } from './helpers/segmented-privacy-fixture.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const take = (n: number, claim: string, holder: string) => ({ rowNum: n, claim, kind: 'take', holder, weight: 0.5, active: true });
const page = (type: string, title: string, rows: ReturnType<typeof row>[], extra = '', fm = '') =>
  '---\ntype: ' + type + '\ntitle: ' + title + '\n' + fm + '---\n# ' + title + '\n\nProfile.\n\n## Facts\n\n' + renderFactsTable(rows as never) + '\n' + extra;
const TARGET = 'people/target-example', THIRD = 'people/third-example', ACME = 'companies/acme-example', LIA = 'people/lia-example';
const MEET = 'meetings/standup-example', KIM = 'people/kim-example', CORE = 'notes/core-example', TAKER = 'people/taker-example', BACKER = 'people/backer-example';
const PRIV = 'pelicanprivcanary', HELD = 'wombatheldcanary', CORE_PRIV = 'heronprivcorecanary', CORE_HELD = 'badgerheldcorecanary', MEET_PRIV = 'lynxmeetprivcanary';
const TAKES = [['world', 'takeworldcanary'], ['brain', 'takebraincanary'], ['self', 'takeselfcanary'], [TARGET, 'takepersoncanary']] as const;
const HOPS = [{ link_type: 'works_at', toward: 'object' }];
const HOP_TAKE = 'takehopcanary';
const OWNER = 'owner-example', BOB = 'bob-example';
const CALLERS = ['local', 'ownerT', 'ownerC', 'bob', 'bobC', 'unbound', 'channel'] as const;
type Caller = typeof CALLERS[number] | 'ownerW' | 'bobW' | 'unboundW' | 'bobR';
const EDIT_OLD = 'otterprivoldcanary', EDIT_DEL = 'molefprivdelcanary';

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
      ]));
      await put(TAKER, page('person', 'Taker Example', [row(1, 'Taker likes tea'), row(2, 'Taker secret ' + PRIV, 'private')],
        '\n## Takes\n\n' + renderTakesFence(TAKES.map(([holder, canary], i) => take(i + 1, 'Taker view ' + canary, holder)) as never) + '\n'));
      await put(BACKER, page('person', 'Backer Example', [row(1, 'Backer likes tea')], '\n## Takes\n\n' + renderTakesFence([take(1, 'Backer backs [[' + ACME + ']] ' + HOP_TAKE, 'self')] as never) + '\n'));
      await engine.addLink(BACKER, ACME, 'Backer backs [[' + ACME + ']] ' + HOP_TAKE, 'works_at', 'markdown');
      await put(KIM, '---\ntype: person\ntitle: Kim Example\n---\n# Kim Example\n\nProfile.\n');
      await put(MEET, '---\ntype: meeting\ntitle: Standup Example\ndate: 2026-01-01\n---\n# Standup Example\n\n## Facts\n\n'
        + renderFactsTable([row(1, 'The standup ran long'), row(2, 'Budget raised ' + MEET_PRIV, 'private')] as never) + '\n\n## Attendees\n\n- [[' + KIM + ']]\n');
      await put(CORE, page('note', 'Core Example', [row(1, 'Core detail ' + CORE_PRIV, 'private'), row(2, 'Core detail ' + CORE_HELD), row(3, 'Core detail public')], '', 'always_load: true\n'));
      await holdRow(HELD); await holdRow(CORE_HELD);
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('source-b', 'source-b') ON CONFLICT DO NOTHING");
      for (const id of [OWNER, BOB]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member?: string, mayActFor?: string[], scopes = ['read']) => {
        const m = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'] });
        tokens[name] = m.token;
        if (member) await bindCredential(engine, { kind: 'token', id: m.id }, { member, ...(mayActFor ? { mayActFor } : {}) }); else await readsUnscopedOnPurpose(engine, m.id);
      };
      await mint('ownerT', OWNER, ['member:' + OWNER, 'member:' + BOB]); await mint('bob', BOB); await mint('unbound'); await mint('ownerW', OWNER, undefined, ['read', 'write']);
      await mint('bobW', BOB, undefined, ['read', 'write']); await mint('bobR', BOB, ['member:' + BOB]); await mint('unboundW', undefined, undefined, ['read', 'write']);
      const client = await provider().registerClientManual('owner-client-example', ['client_credentials'], 'admin skills_member_self', [], 'default', ['default', 'source-b']);
      await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: OWNER });
      tokens.ownerC = (await provider().exchangeClientCredentials(client.clientId, client.clientSecret!)).access_token;
      const bobClient = await provider().registerClientManual('member-client-example', ['client_credentials'], 'admin skills_member_self', [], 'default', ['default', 'source-b']);
      await bindCredential(engine, { kind: 'client', id: bobClient.clientId }, { member: BOB });
      tokens.bobC = (await provider().exchangeClientCredentials(bobClient.clientId, bobClient.clientSecret!)).access_token;
      await setOwner(engine, OWNER);
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); }, 60_000);

    const OWNERS: readonly Caller[] = ['ownerT', 'ownerC'];
    const OTHERS: readonly Caller[] = ['bob', 'bobC', 'unbound', 'channel'];

    test('fixture control: the local CLI reads every protected row and take, and neither client carries a holders list', async () => {
      expect(seen(await call('local', 'get_page', { slug: LIA }), [PRIV, HELD])).toHaveLength(2);
      expect(seen(await call('local', 'get_page', { slug: TAKER }), [PRIV, ...TAKES.map(t => t[1])])).toHaveLength(5);
      for (const who of ['ownerC', 'bobC']) expect((await provider().verifyAccessToken(tokens[who]!) as unknown as { takesHoldersAllowList?: string[] }).takesHoldersAllowList).toBeUndefined();
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
      // A credential with a holders list gets no takes fence in get_page (it reads takes through takes_list), so its page still round-trips through put_page.
      const want: Record<typeof CALLERS[number], { list: number; fence: number }> = { local: { list: 4, fence: 4 }, ownerC: { list: 4, fence: 4 }, ownerT: { list: 1, fence: 0 }, bob: { list: 1, fence: 0 }, bobC: { list: 1, fence: 0 }, unbound: { list: 1, fence: 0 }, channel: { list: 1, fence: 0 } };
      for (const who of CALLERS) {
        const got = {
          takes_list: seen(await call(who, 'takes_list', { page_slug: TAKER }), canaries).length,
          takes_search: seen(await call(who, 'takes_search', { query: 'Taker view' }), canaries).length,
          get_page: seen(await call(who, 'get_page', { slug: TAKER }), canaries).length,
        };
        expect({ who, ...got }).toEqual({ who, takes_list: want[who].list, takes_search: want[who].list, get_page: want[who].fence });
      }
    }, 240_000);

    test('a holders list still applies to graph hops: an owner credential with one reads no edge context cut from a takes fence', async () => {
      const hop = (who: Caller) => call(who, 'traverse_graph', { slug: BACKER, hops: HOPS });
      for (const who of ['local', 'ownerC'] as Caller[]) expect({ who, seen: seen(await hop(who), [HOP_TAKE]) }).toEqual({ who, seen: [HOP_TAKE] });
      for (const who of ['ownerT', ...OTHERS] as Caller[]) expect({ who, seen: seen(await hop(who), [HOP_TAKE]) }).toEqual({ who, seen: [] });
    }, 240_000);

    test('owner credentials round-trip a page holding private rows and takes through put_page, with or without a holders list', async () => {
      for (const who of ['ownerW', 'ownerC'] as Caller[]) {
        const read = JSON.parse(await call(who, 'get_page', { slug: TAKER, include_content: true }));
        expect({ who, priv: read.content.includes(PRIV) }).toEqual({ who, priv: true });
        await call(who, 'put_page', { slug: TAKER, content: read.content.replace(/Profile[^\n]*/, 'Profile, edited by ' + who + '.'), expected_revision: read.revision, request_id: randomUUID() });
        const after = await call('local', 'get_page', { slug: TAKER });
        expect({ who, edited: after.includes('Profile, edited by ' + who + '.'), kept: seen(after, [PRIV, ...TAKES.map(t => t[1])]).length }).toEqual({ who, edited: true, kept: 5 });
      }
    }, 240_000);
    const editSeed = async (slug: string) => { await put(slug, page('note', 'Edit Example', [row(1, 'Edit world fact'), row(2, 'Edit secret ' + EDIT_OLD, 'private'), row(3, 'Edit gone ' + EDIT_DEL, 'private')])); };
    const readFor = async (who: Caller, slug: string) => JSON.parse(await call(who, 'get_page', { slug, include_content: true })) as { content: string; revision: string };
    const count = (text: string, needle: string) => text.split(needle).length - 1;

    test('a member or unbound writer editing the page keeps the private rows it cannot read, as on master', async () => {
      for (const who of ['bobW', 'unboundW'] as Caller[]) {
        const slug = 'notes/edit-' + who.toLowerCase() + '-example';
        await editSeed(slug);
        const read = await readFor(who, slug);
        expect({ who, seen: seen(read.content, [EDIT_OLD, EDIT_DEL]) }).toEqual({ who, seen: [] });
        await call(who, 'put_page', { slug, content: read.content.replace('Edit world fact', 'Edit world fact, edited'), expected_revision: read.revision, request_id: randomUUID() });
        const after = (await readFor('local', slug)).content;
        expect({ who, edited: after.includes('Edit world fact, edited'), old: count(after, EDIT_OLD), del: count(after, EDIT_DEL) }).toEqual({ who, edited: true, old: 1, del: 1 });
      }
    }, 240_000);

    test('windowed reads: the read view is the same text for every caller, the local CLI included; the markdown view carries the private rows for the owner as for the local CLI', async () => {
      const BIG = 'notes/big-example';
      await put(BIG, page('note', 'Big Example', [row(1, 'Big world'), row(2, 'Big secret ' + PRIV, 'private')], '\n## More\n\n' + ('Lorem ipsum dolor sit amet. '.repeat(40) + '\n\n').repeat(300)));
      const reads: Array<[string, string, Record<string, unknown>, readonly Caller[]]> = [
        ['lines', LIA, { lines: { from: 1, count: 200 } }, []],
        ['bytes', LIA, { bytes: { offset: 0, length: 100_000 } }, []],
        ['section', LIA, { section: 'Facts' }, []],
        ['grep', LIA, { grep: 'owes' }, []],
        ['markdown window', LIA, { body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } }, ['local', ...OWNERS]],
        ['markdown window over the inline cap', BIG, { body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } }, ['local', ...OWNERS]],
        ['full body over the inline cap', BIG, { body: 'full' }, ['local', ...OWNERS]],
      ];
      for (const [name, slug, params, readers] of reads) for (const who of CALLERS) {
        expect({ name, who, priv: (await call(who, 'get_page', { slug, ...params })).includes(PRIV) }).toEqual({ name, who, priv: readers.includes(who) });
      }
    }, 300_000);

    test('segmented pages: the owner with no holders list pages the round-trip markdown the local CLI pages; every other caller reads it as before', async () => {
      const SEG = 'notes/seg-example';
      const before = await engine.getConfig('pages.segmented_storage');
      try {
        await importSegmented(engine, SEG, pageContent('## Facts\n\n' + renderFactsTable([row(1, 'Seg world'), row(2, 'Seg secret ' + PRIV, 'private')] as never) + '\n\n' + ('Seg prose line here. '.repeat(40) + '\n\n').repeat(1400)));
      } finally { if (before !== null && before !== undefined) await engine.setConfig('pages.segmented_storage', before); }
      const markdown = { body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } };
      for (const who of CALLERS) {
        const md = await call(who, 'get_page', { slug: SEG, ...markdown });
        expect({ who, world: md.includes('Seg world'), priv: md.includes(PRIV) }).toEqual({ who, world: true, priv: who === 'local' || who === 'ownerC' });
        expect({ who, readView: (await call(who, 'get_page', { slug: SEG, bytes: { offset: 0, length: 100_000 } })).includes(PRIV) }).toEqual({ who, readView: false });
      }
    }, 300_000);
    test('the owner client reads an inline page with its private rows, puts it back unchanged, and every private row is stored exactly once', async () => {
      const slug = 'notes/edit-ownerc-example';
      await editSeed(slug);
      const read = await readFor('ownerC', slug);
      expect(seen(read.content, [EDIT_OLD, EDIT_DEL])).toEqual([EDIT_OLD, EDIT_DEL]);
      await call('ownerC', 'put_page', { slug, content: read.content, expected_revision: read.revision, request_id: randomUUID() });
      const after = (await readFor('local', slug)).content;
      expect({ old: count(after, EDIT_OLD), del: count(after, EDIT_DEL) }).toEqual({ old: 1, del: 1 });
    }, 240_000);

    test('an owner token with a holders list reads a segmented page\'s markdown without the private row, puts it back, and the row is still stored', async () => {
      const SEG = 'notes/seg-rt-example';
      await importSegmented(engine, SEG, pageContent('## Facts\n\n' + renderFactsTable([row(1, 'Seg world'), row(2, 'Seg secret ' + PRIV, 'private')] as never) + '\n\n' + ('Seg prose line here. '.repeat(40) + '\n\n').repeat(1400)));
      const stored = async () => (await call('local', 'get_page', { slug: SEG, body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } })).includes(PRIV);
      expect(await stored()).toBe(true);
      let args: Record<string, unknown> = { slug: SEG, body: 'window', view: 'markdown', bytes: { offset: 0, length: 4_000_000 } };
      let text = '', revision = '';
      for (let i = 0; i < 200; i++) {
        const out = JSON.parse(await call('ownerW', 'get_page', args));
        text += out.window?.text ?? ''; revision = out.revision;
        if (!out.next) break;
        args = out.next.arguments;
      }
      expect({ read: text.length > 1_000_000, priv: text.includes(PRIV) }).toEqual({ read: true, priv: false });
      await call('ownerW', 'put_page', { slug: SEG, content: text.replace('Seg world', 'Seg world edited'), expected_revision: revision, request_id: randomUUID() });
      expect({ edited: (await call('local', 'get_page', { slug: SEG, body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } })).includes('Seg world edited'), kept: await stored() }).toEqual({ edited: true, kept: true });
    }, 600_000);
    const roomMark = async (who: Caller, op: string, params: Record<string, unknown>) => {
      const text = await call(who, op, { ...params, room: ['member:' + BOB] });
      const m = text.match(/"room_access":(\{[^}]*\})/);
      return { priv: text.includes(PRIV), mark: m ? JSON.parse(m[1]!) : null };
    };
    const NOT_READABLE = { readable: false, reason: 'private_label' };

    const localMark = async (params: Record<string, unknown>) => {
      const local = await operations.find(o => o.name === 'get_page')!.handler(buildOperationContext(engine, params, { remote: false }), params);
      const marked = (await markCliResult(engine, 'get_page', local, BOB, { sourceId: 'default' })).result as Record<string, unknown>;
      return { priv: JSON.stringify(marked).includes(PRIV), mark: marked.room_access };
    };

    test('room marks: in a room the owner\'s credential reads get_page as before this change and a page showing held rows is marked; the local CLI\'s --room marks private rows and takes; a page with neither stays readable', async () => {
      for (const who of OWNERS) {
        expect({ who, ...await roomMark(who, 'get_page', { slug: LIA }) }).toEqual({ who, priv: false, mark: NOT_READABLE });
        expect({ who, ...await roomMark(who, 'get_page', { slug: TAKER, include_content: true }) }).toEqual({ who, priv: false, mark: { readable: true } });
        expect({ who, ...await roomMark(who, 'get_page', { slug: LIA, body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } }) }).toEqual({ who, priv: false, mark: NOT_READABLE });
        expect({ who, ...await roomMark(who, 'get_page', { slug: LIA, lines: { from: 1, count: 200 } }) }).toEqual({ who, priv: false, mark: { readable: true } });
        expect({ who, ...await roomMark(who, 'get_page', { slug: TARGET }) }).toEqual({ who, priv: false, mark: { readable: true } });
      }
      expect(await localMark({ slug: LIA })).toEqual({ priv: true, mark: NOT_READABLE });
      expect(await localMark({ slug: TAKER, include_content: true })).toEqual({ priv: true, mark: NOT_READABLE });
      expect(await localMark({ slug: LIA, body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } })).toEqual({ priv: true, mark: NOT_READABLE });
      expect(await localMark({ slug: TARGET })).toEqual({ priv: false, mark: { readable: true } });
      const held = page('person', 'Held Room Example', [row(1, 'Held room world'), row(2, 'Held room ' + HELD + 'room')]);
      await put('people/held-room-example', held); await holdRow(HELD + 'room');
      const heldText = await call('ownerC', 'get_page', { slug: 'people/held-room-example', room: ['member:' + BOB] });
      expect({ shown: heldText.includes(HELD + 'room'), mark: JSON.parse(heldText.match(/"room_access":(\{[^}]*\})/)![1]!) }).toEqual({ shown: true, mark: NOT_READABLE });
    }, 240_000);

    test('room marks: a member in the same room reads and is marked as before', async () => {
      for (const who of ['bobR'] as Caller[]) {
        expect({ who, ...await roomMark(who, 'get_page', { slug: LIA }) }).toEqual({ who, priv: false, mark: { readable: true } });
        expect({ who, ...await roomMark(who, 'get_page', { slug: TAKER, include_content: true }) }).toEqual({ who, priv: false, mark: { readable: true } });
        expect({ who, ...await roomMark(who, 'get_page', { slug: LIA, body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } }) }).toEqual({ who, priv: false, mark: { readable: true } });
      }
    }, 240_000);

    test('room marks on a segmented page and fetch_page: in a room the owner client\'s markdown view is master\'s, the local CLI\'s is not readable for the room, a member\'s is as before, and fetch is never marked readable', async () => {
      const SEG = 'notes/seg-room-example';
      await importSegmented(engine, SEG, pageContent('## Facts\n\n' + renderFactsTable([row(1, 'Seg world'), row(2, 'Seg secret ' + PRIV, 'private')] as never) + '\n\n' + ('Seg prose line here. '.repeat(40) + '\n\n').repeat(1400)));
      const md = { slug: SEG, body: 'window', view: 'markdown', bytes: { offset: 0, length: 100_000 } };
      expect(await roomMark('ownerC', 'get_page', md)).toEqual({ priv: false, mark: { readable: true } });
      expect(await localMark(md)).toEqual({ priv: true, mark: NOT_READABLE });
      expect(await roomMark('ownerT', 'get_page', md)).toEqual({ priv: false, mark: { readable: true } });
      expect(await roomMark('bobR', 'get_page', md)).toEqual({ priv: false, mark: { readable: true } });
      for (const who of ['ownerC', 'bobR'] as Caller[]) {
        const text = await call(who, 'fetch', { id: LIA, room: ['member:' + BOB] });
        expect({ who, priv: text.includes(PRIV), readableTrue: text.includes('"readable":true') }).toEqual({ who, priv: false, readableTrue: false });
      }
    }, 600_000);
    test('an owner client\'s agent job reads as before this change: search, query, get_page and traverse_graph give it what a member token reads, plus the held rows an owner read on master', async () => {
      const { clientId } = await provider().verifyAccessToken(tokens.ownerC!) as unknown as AuthInfo;
      const jobTools = buildBrainTools({ subagentId: 9, engine, config: { engine: 'pglite' } as never, sourceId: 'default',
        delegatedAuth: { clientId, scopes: ['read', 'agent'], sourceId: 'default', allowedSources: ['default'] } });
      const job = async (op: string, input: Record<string, unknown>) => JSON.stringify(await jobTools.find(t => t.name === 'brain_' + op)!.execute(input, { engine, jobId: 1, remote: true } as never));
      const canaries = [PRIV, HELD, HOP_TAKE, ...TAKES.map(x => x[1])];
      const reads: Array<[string, Record<string, unknown>]> = [
        ['search', { query: 'Taker view' }], ['query', { query: 'Taker view' }], ['get_page', { slug: LIA }], ['get_page', { slug: TAKER }],
        ['traverse_graph', { slug: LIA, hops: HOPS }], ['traverse_graph', { slug: BACKER, hops: HOPS }],
      ];
      for (const [op, input] of reads) {
        const member = seen(await call('bob', op, input), canaries);
        const master = op === 'get_page' && input.slug === LIA ? [HELD] : member;
        expect({ op, input, job: seen(await job(op, input), canaries) }).toEqual({ op, input, job: master });
      }
      expect(seen(await job('get_page', { slug: TAKER }), [PRIV, ...TAKES.map(x => x[1])])).toEqual([]);
    }, 300_000);
    test('in a declared room the owner reads world takes and gated hop text, as before this change; with no room it reads the widened result; a member is unchanged', async () => {
      const canaries = TAKES.map(t => t[1]);
      const room = { room: ['member:' + BOB] };
      const takesFor = async (who: Caller, extra: Record<string, unknown>) => ({
        list: seen(await call(who, 'takes_list', { page_slug: TAKER, ...extra }), canaries).length,
        search: seen(await call(who, 'takes_search', { query: 'Taker view', ...extra }), canaries).length,
        fence: seen(await call(who, 'get_page', { slug: TAKER, ...extra }), canaries).length,
      });
      const hopsFor = async (who: Caller, extra: Record<string, unknown>) => ({
        priv: seen(await call(who, 'traverse_graph', { slug: LIA, hops: HOPS, ...extra }), [PRIV]).length,
        take: seen(await call(who, 'traverse_graph', { slug: BACKER, hops: HOPS, ...extra }), [HOP_TAKE]).length,
      });
      expect(await takesFor('ownerC', {})).toEqual({ list: 4, search: 4, fence: 4 });
      expect(await takesFor('ownerC', room)).toEqual({ list: 1, search: 1, fence: 0 });
      expect(await takesFor('ownerT', room)).toEqual({ list: 1, search: 1, fence: 0 });
      expect(await takesFor('bobR', room)).toEqual({ list: 1, search: 1, fence: 0 });
      expect(await hopsFor('ownerC', {})).toEqual({ priv: 1, take: 1 });
      expect(await hopsFor('ownerT', {})).toEqual({ priv: 1, take: 0 });
      for (const who of ['ownerC', 'ownerT', 'bobR'] as Caller[]) expect({ who, ...await hopsFor(who, room) }).toEqual({ who, priv: 0, take: 0 });
      const owner = await provider().verifyAccessToken(tokens.ownerC!) as unknown as AuthInfo;
      const ownerAccess = { owner: true, identity: ['member:' + OWNER] } as never;
      expect({
        switchedOn: withCallerAccess({ ...(ownerAccess as object), ownerReads: true } as never, () => readHolders({ remote: true, auth: owner } as never)),
        ownerAlone: withCallerAccess(ownerAccess, () => readHolders({ remote: true, auth: owner } as never)),
      }).toEqual({ switchedOn: undefined, ownerAlone: ['world'] });
    }, 300_000);
  });
}
