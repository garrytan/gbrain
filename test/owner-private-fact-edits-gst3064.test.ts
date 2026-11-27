/**
 * GST-3064 (write side): a remote put_page never edits or deletes a private Facts row, the brain owner's included, and
 * the owner changes private rows remotely by naming them: forget_fact deletes one, a put_page that adds a row adds one.
 *
 * 1. Protects (R94): every view that hides a page's private rows (a member's known_as_of, a declared room, a member, an unbound
 *    token, an agent job, fetch's paged read view, the markdown view with a holders list), written back by the owner with
 *    the revision it returned, keeps every private row. The owner's client and token find a private fact's id with
 *    recall, forget it, and add its replacement as a new private row: get_page shows the old row struck and the new one,
 *    and a member sees neither.
 * 2. Fails when: a write built from a filtered read loses or duplicates a private row, or the owner cannot forget a
 *    private row or add a private row remotely.
 * 3. Real seams: tokens and clients minted by the token service and the OAuth provider, dispatched through MCP dispatch
 *    with the holders list the HTTP transports compute, agent-job tools, the belief ledger, written through the persistence
 *    service, on PGLite and Postgres.
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
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { testBackends } from './helpers/test-backends.ts';
import { importSegmented, pageContent } from './helpers/segmented-privacy-fixture.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';
import { enableBeliefLedger } from '../src/core/belief/coverage.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';

const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const OWNER = 'owner-example', BOB = 'bob-example';
const OLD = 'otterprivoldcanary', NEW = 'otterprivnewcanary', DEL = 'molefprivdelcanary', KEEP = 'voleprivkeepcanary';
const WRITERS = ['local', 'ownerC', 'ownerW', 'bobW', 'unboundW'] as const;
type Writer = typeof WRITERS[number];
type Shape = 'small' | 'big' | 'segmented';
type View = 'content' | 'markdown' | 'fetch' | 'asof';
const facts = () => renderFactsTable([row(1, 'Edit world fact'), row(2, 'Edit secret ' + OLD, 'private'), row(3, 'Edit gone ' + DEL, 'private'), row(4, 'Edit kept ' + KEEP, 'private')] as never);
const count = (text: string, needle: string) => text.split(needle).length - 1;

for (const kind of testBackends()) {
  describe('GST-3064 remote writes keep private Facts rows; the owner changes them by naming them (' + kind + ')', () => {
    let engine: BrainEngine; let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    async function call(who: Writer | 'ownerP', op: string, params: Record<string, unknown>): Promise<string> {
      __resetPrivateVisibilityCacheForTests();
      let out;
      if (who === 'local') out = await dispatchToolCall(engine, op, { ...params }, { remote: false, sourceId: 'default' });
      else {
        const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo & { takesHoldersAllowList?: string[] };
        out = await dispatchToolCall(engine, op, { ...params }, {
          remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default',
          takesHoldersAllowList: await credentialHolders(engine, auth.takesHoldersAllowList, auth.member?.id),
        });
      }
      expect(out.isError, who + ' ' + op + ': ' + out.content.map(c => c.text).join('\n').slice(0, 300)).toBeFalsy();
      return out.content[0]!.text;
    }
    const put = (who: Writer | 'ownerP', slug: string, content: string, revision?: string) =>
      call(who, 'put_page', { slug, content, request_id: randomUUID(), ...(revision ? { expected_revision: revision } : {}) });
    async function read(who: Writer, slug: string, view: View): Promise<{ text: string; revision: string }> {
      if (view === 'asof') {
        const out = JSON.parse(await call(who, 'get_page', { slug, as_of: '2099-01-01' }));
        expect({ who, view, body: typeof out.compiled_truth }).toEqual({ who, view, body: 'string' });
        return { text: '---\ntype: note\ntitle: Edit Example\nvalid_from: 2026-01-01\n---\n' + out.compiled_truth + (out.timeline ? '\n\n---\n\n' + out.timeline : ''), revision: out.revision };
      }
      if (view === 'content') { const out = JSON.parse(await call(who, 'get_page', { slug, include_content: true, body: 'full' })); return { text: out.content, revision: out.revision }; }
      let text = '', revision = '';
      if (view === 'fetch') {
        let id = slug;
        for (let i = 0; i < 400 && id; i++) {
          const out = JSON.parse(await call(who, 'fetch', { id }));
          text += out.text; revision ||= out.metadata?.revision ?? '';
          id = out.metadata?.next_id;
        }
        return { text, revision: revision || JSON.parse(await call(who, 'get_page', { slug })).revision };
      }
      let args: Record<string, unknown> = { slug, body: 'window', view: 'markdown', bytes: { offset: 0, length: 4_000_000 } };
      for (let i = 0; i < 200; i++) {
        const out = JSON.parse(await call(who, 'get_page', args));
        text += out.window?.text ?? ''; revision = out.revision;
        if (!out.next) break;
        args = out.next.arguments;
      }
      return { text, revision };
    }
    const stored = async (slug: string) => (await read('local', slug, 'markdown')).text;
    const memberSees = async (slug: string, needle: string) => count((await read('bobW', slug, 'markdown')).text, needle);
    let n = 0;
    async function seed(shape: Shape): Promise<string> {
      const slug = 'notes/rt-' + (++n) + '-example';
      const prose = (times: number) => ('Seg prose line here. '.repeat(40) + '\n\n').repeat(times);
      if (shape !== 'segmented') {
        await put('local', slug, '---\ntype: note\ntitle: Edit Example\nvalid_from: 2026-01-01\n---\n# Edit Example\n\nProfile.\n\n## Facts\n\n' + facts() + '\n' + (shape === 'big' ? '\n## More\n\n' + prose(400) : ''));
        return slug;
      }
      const before = await engine.getConfig('pages.segmented_storage');
      try { await importSegmented(engine, slug, pageContent('## Facts\n\n' + facts() + '\n\n' + prose(1400))); }
      finally { if (before !== null && before !== undefined) await engine.setConfig('pages.segmented_storage', before); }
      return slug;
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await registerLocalWriter(engine, 'cli');
      for (const id of [OWNER, BOB]) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      const mint = async (name: string, member: string | undefined, scopes: string[], allowedOperations?: string[]) => {
        const m = await mintLegacyToken(engine, { name, scopes, takesHolders: ['world'], ...(allowedOperations ? { allowedOperations } : {}) });
        tokens[name] = m.token;
        if (member) await bindCredential(engine, { kind: 'token', id: m.id }, { member }); else await readsUnscopedOnPurpose(engine, m.id);
      };
      await mint('ownerW', OWNER, ['read', 'write']); await mint('ownerP', OWNER, ['read', 'write'], ['put_page']);
      await mint('bobW', BOB, ['read', 'write']); await mint('unboundW', undefined, ['read', 'write']);
      const client = await provider().registerClientManual('owner-client-example', ['client_credentials'], 'admin skills_member_self', [], 'default', ['default']);
      await bindCredential(engine, { kind: 'client', id: client.clientId }, { member: OWNER });
      tokens.ownerC = (await provider().exchangeClientCredentials(client.clientId, client.clientSecret!)).access_token;
      await setOwner(engine, OWNER);
      await enableBeliefLedger(engine, 'default');
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); }, 60_000);

    const rows = (text: string) => ({ old: count(text, OLD), new: count(text, NEW), del: count(text, DEL), keep: count(text, KEEP) });
    const KEPT_ALL = { old: 1, new: 0, del: 1, keep: 1 };

    test('every filtered read, then the owner writes it back with the returned revision: no private row is lost', async () => {
      const room = { room: ['member:' + BOB] };
      const { clientId } = await provider().verifyAccessToken(tokens.ownerC!) as unknown as AuthInfo;
      const jobTools = buildBrainTools({ subagentId: 9, engine, config: { engine: kind } as never, sourceId: 'default',
        delegatedAuth: { clientId, scopes: ['read', 'agent'], sourceId: 'default', allowedSources: ['default'] } });
      const head = '---\ntype: note\ntitle: Edit Example\nvalid_from: 2026-01-01\n---\n';
      const fromBody = (o: Record<string, unknown>) => typeof o.content === 'string' ? o.content : head + String(o.compiled_truth ?? '') + (o.timeline ? '\n\n---\n\n' + String(o.timeline) : '');
      const filtered: Array<[string, Shape, (slug: string) => Promise<{ text: string; revision: string }>]> = [
        ['known_as_of as a member', 'small', async slug => { await Bun.sleep(5); const o = JSON.parse(await call('bobW', 'get_page', { slug, known_as_of: new Date().toISOString() })); return { text: fromBody(o), revision: o.revision }; }],
        ['as_of in a room', 'small', async slug => { const o = JSON.parse(await call('ownerC', 'get_page', { slug, as_of: '2099-01-01', ...room })); return { text: fromBody(o), revision: o.revision }; }],
        ['get_page in a room', 'small', async slug => { const o = JSON.parse(await call('ownerC', 'get_page', { slug, include_content: true, body: 'full', ...room })); return { text: o.content, revision: o.revision }; }],
        ['member', 'small', slug => read('bobW', slug, 'content')],
        ['unbound token', 'small', slug => read('unboundW', slug, 'content')],
        ['agent job', 'small', async slug => {
          const out = await jobTools.find(t => t.name === 'brain_get_page')!.execute({ slug, include_content: true, body: 'full' }, { engine, jobId: 1, remote: true } as never);
          const o = (typeof out === 'string' ? JSON.parse(out) : out) as Record<string, unknown>;
          return { text: fromBody(o), revision: String(o.revision ?? '') };
        }],
        ['fetch read view, over-cap page', 'big', slug => read('ownerC', slug, 'fetch')],
        ['fetch read view, segmented page', 'segmented', slug => read('ownerC', slug, 'fetch')],
        ['markdown view with a holders list, segmented page', 'segmented', slug => read('ownerW', slug, 'markdown')],
      ];
      for (const [name, shape, readIt] of filtered) {
        const slug = await seed(shape);
        const got = await readIt(slug);
        expect({ name, read: rows(got.text) }).toEqual({ name, read: { old: 0, new: 0, del: 0, keep: 0 } });
        const revision = got.revision || JSON.parse(await call('ownerC', 'get_page', { slug })).revision;
        await put('ownerC', slug, got.text.replace('Edit world fact', 'Edit world fact, edited'), revision);
        const after = await stored(slug);
        expect({ name, edited: after.includes('Edit world fact, edited'), after: rows(after) }).toEqual({ name, edited: true, after: KEPT_ALL });
      }
      const slug = await seed('small');
      await Bun.sleep(5);
      const owner = JSON.parse(await call('ownerC', 'get_page', { slug, known_as_of: new Date().toISOString() }));
      expect({ ownerKnownAsOf: rows(fromBody(owner)) }).toEqual({ ownerKnownAsOf: KEPT_ALL });
      await put('ownerC', slug, fromBody(owner).replace('Edit world fact', 'Edit world fact, edited'), owner.revision);
      const after = await stored(slug);
      expect({ edited: after.includes('Edit world fact, edited'), after: rows(after) }).toEqual({ edited: true, after: KEPT_ALL });
    }, 1_800_000);

    test('the owner\'s client and token forget a private fact and add its replacement as a new private row', async () => {
      for (const who of ['ownerC', 'ownerW'] as Writer[]) {
        const slug = await seed('small');
        const recalled = JSON.parse(await call(who, 'recall', { entity: slug })).facts as Array<{ id: number; fact: string; visibility: string }>;
        const target = recalled.find(f => f.fact.includes(OLD))!;
        expect({ who, visibility: target?.visibility }).toEqual({ who, visibility: 'private' });
        await call(who, 'forget_fact', { id: target.id, request_id: randomUUID() });
        const got = JSON.parse(await call(who, 'get_page', { slug, include_content: true, body: 'full' }));
        const added = got.content.replace(/(\| 4 \|[^\n]*\n)/, '$1| 5 | Edit secret ' + NEW + ' | fact | 1.0 | private | medium |  |  |  |  |\n');
        expect({ who, added: added.includes(NEW) }).toEqual({ who, added: true });
        await put(who, slug, added, got.revision);
        const back = JSON.parse(await call(who, 'get_page', { slug, include_content: true, body: 'full' })).content as string;
        const line = (needle: string) => back.split('\n').find(l => l.includes(needle)) ?? '';
        const active = (JSON.parse(await call(who, 'recall', { entity: slug })).facts as Array<{ fact: string }>).map(f => f.fact);
        expect({ who, oldStruck: line(OLD).includes('~~'), oldForgotten: line(OLD).includes('forgotten'), newRow: /\| private \|/.test(line(NEW)),
          recallOld: active.some(f => f.includes(OLD)), recallNew: active.some(f => f.includes(NEW)), member: await memberSees(slug, NEW) + await memberSees(slug, OLD) })
          .toEqual({ who, oldStruck: true, oldForgotten: true, newRow: true, recallOld: false, recallNew: true, member: 0 });
      }
    }, 600_000);
    test('a put_page that leaves out or rewords private rows tells the owner which counts were kept and points at recall; a member and an unbound token get no advisory', async () => {
      const kept = async (who: Writer, edit: (text: string) => string, readAs: Writer = who) => {
        const slug = await seed('small');
        const got = await read(readAs, slug, 'content');
        const out = JSON.parse(await put(who, slug, edit(got.text), got.revision)) as Record<string, unknown>;
        const text = JSON.stringify(out);
        return { advisory: out.private_rows_kept as Record<string, unknown> | undefined, mentions: /private_rows_kept|private fact row/.test(text), after: rows(await stored(slug)) };
      };
      const dropOne = (text: string) => text.split('\n').filter(line => !line.includes(DEL)).join('\n');
      const reword = (text: string) => text.replace(OLD, NEW);
      for (const who of ['ownerC', 'ownerW'] as Writer[]) {
        const dropped = await kept(who, dropOne);
        expect({ who, count: dropped.advisory?.count, renumbered: dropped.advisory?.renumbered, fix: (dropped.advisory?.fix as { mcp?: { tool?: string; arguments?: unknown } })?.mcp, after: dropped.after })
          .toEqual({ who, count: 1, renumbered: 0, fix: { tool: 'recall', arguments: { entity: expect.any(String), source_id: 'default' } }, after: KEPT_ALL });
        const reworded = await kept(who, reword);
        expect({ who, count: reworded.advisory?.count, renumbered: reworded.advisory?.renumbered, after: reworded.after })
          .toEqual({ who, count: 1, renumbered: 1, after: { old: 1, new: 1, del: 1, keep: 1 } });
        expect({ who, text: JSON.stringify(dropped.advisory) + JSON.stringify(reworded.advisory) }).not.toEqual({ who, text: expect.stringContaining('canary') });
        const unchanged = await kept(who, text => text);
        expect({ who, advisory: unchanged.advisory }).toEqual({ who, advisory: undefined });
      }
      for (const who of ['bobW', 'unboundW'] as Writer[]) {
        const restored = await kept(who, text => text.replace('Edit world fact', 'Edit world fact, edited'));
        expect({ who, advisory: restored.advisory, mentions: restored.mentions, after: restored.after }).toEqual({ who, advisory: undefined, mentions: false, after: KEPT_ALL });
      }
      const room = { room: ['member:' + BOB] };
      const said = (text: string) => ({ advisory: !!(JSON.parse(text).private_rows_kept ?? JSON.parse(text).outcome?.private_rows_kept), mentions: /private_rows_kept|private fact row/.test(text) });
      for (const who of ['ownerC', 'ownerW'] as Writer[]) {
        const slug = await seed('small');
        const got = await read(who, slug, 'content');
        const write = { slug, content: dropOne(got.text), request_id: randomUUID(), expected_revision: got.revision };
        const first = said(await call(who, 'put_page', write));
        const receipt = (args: Record<string, unknown>) => call(who, 'get_write_request', { request_id: write.request_id, ...args }).then(said);
        const replay = (args: Record<string, unknown>) => call(who, 'put_page', { ...write, ...args }).then(said);
        expect({ who, first, receipt: await receipt({}), receiptInRoom: await receipt(room), replay: await replay({}), replayInRoom: await replay(room) }).toEqual({ who,
          first: { advisory: true, mentions: true }, receipt: { advisory: true, mentions: true }, receiptInRoom: { advisory: false, mentions: false },
          replay: { advisory: true, mentions: true }, replayInRoom: { advisory: false, mentions: false } });
      }
      for (const who of ['ownerC', 'ownerW'] as Writer[]) {
        const slug = await seed('small');
        const target = (JSON.parse(await call(who, 'recall', { entity: slug })).facts as Array<{ id: number; fact: string }>).find(f => f.fact.includes(OLD))!;
        await call(who, 'forget_fact', { id: target.id, request_id: randomUUID() });
        const withoutForgotten = (text: string) => text.split('\n').filter(line => !line.includes(OLD)).join('\n');
        await kept(who, withoutForgotten);
        const slugRead = await read(who, slug, 'content');
        const again = JSON.parse(await put(who, slug, withoutForgotten(slugRead.text), slugRead.revision)) as Record<string, unknown>;
        const line = (await stored(slug)).split('\n').find(l => l.includes(OLD)) ?? '';
        expect({ who, advisory: again.private_rows_kept, struck: line.includes('~~') }).toEqual({ who, advisory: undefined, struck: true });
      }
    }, 600_000);
  });
}
