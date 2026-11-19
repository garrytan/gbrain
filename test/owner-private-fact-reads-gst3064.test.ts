/**
 * GST-3064 (read side): every full-page read the brain owner's remote credential takes shows the same Facts rows, and
 * nobody loses a private row by writing back what they read.
 *
 * 1. Protects (R94): one predicate (storedFactsShown, ownerFenceView) decides what the owner's credential reads in a
 *    page body: get_page, fetch, a segmented page's markdown view and get_page as_of on an inline page. The
 *    owner's client (no holders list) and token (with one) read the private rows on each; a member and an unbound token
 *    read none. The write-back merge is unchanged: every remote write restores the private rows it leaves out, so an
 *    owner's edit or delete of a private row is stored beside the kept row until the write side lands.
 * 2. Fails when: an owner read through get_page, fetch or as_of hides private rows another of those reads shows, a
 *    member or unbound read shows one, or any caller's write-back of any view loses, duplicates or exposes a private row.
 * 3. Real seams: tokens and clients minted by the token service and the OAuth provider, dispatched through MCP dispatch
 *    with the holders list the HTTP transports compute, written through the persistence service, on PGLite and Postgres.
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

const row = (n: number, claim: string, visibility = 'world') => ({ rowNum: n, claim, kind: 'fact', confidence: 1, visibility, notability: 'medium', active: true });
const OWNER = 'owner-example', BOB = 'bob-example';
const OLD = 'otterprivoldcanary', NEW = 'otterprivnewcanary', DEL = 'molefprivdelcanary';
const WRITERS = ['local', 'ownerC', 'ownerW', 'bobW', 'unboundW'] as const;
type Writer = typeof WRITERS[number];
type Shape = 'small' | 'big' | 'segmented';
type View = 'content' | 'markdown' | 'fetch' | 'asof';
const facts = () => renderFactsTable([row(1, 'Edit world fact'), row(2, 'Edit secret ' + OLD, 'private'), row(3, 'Edit gone ' + DEL, 'private')] as never);
const count = (text: string, needle: string) => text.split(needle).length - 1;
/** Whether the writer's read of that view shows the private rows: fetch pages a segmented or over-cap page in read-view windows. */
const shown = (who: Writer, shape: Shape, view: View) => {
  if (who === 'bobW' || who === 'unboundW') return false;
  if (shape === 'segmented') return view === 'markdown' && who !== 'ownerW';
  return !(view === 'fetch' && shape === 'big' && who !== 'local');
};

for (const kind of testBackends()) {
  describe('GST-3064 owner reads of private Facts rows agree, and write-backs keep them (' + kind + ')', () => {
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
    }, 300_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); }, 60_000);

    const CASES: Array<[Shape, View]> = [['small', 'asof'], ['small', 'content'], ['small', 'markdown'], ['small', 'fetch'], ['big', 'content'], ['big', 'markdown'], ['big', 'fetch'], ['segmented', 'markdown'], ['segmented', 'fetch']];

    test('every writer reads each full-page view, puts it back unchanged, and every private row is stored once and stays private', async () => {
      for (const [shape, view] of CASES) for (const who of WRITERS) {
        // The local CLI is trusted and never restores rows (as on master), so its write-back of a view that hid them is not a round trip.
        if (who === 'local' && !shown(who, shape, view)) continue;
        const slug = await seed(shape);
        const got = await read(who, slug, view);
        expect({ who, shape, view, rows: [got.text.includes(OLD), got.text.includes(DEL)] }).toEqual({ who, shape, view, rows: [shown(who, shape, view), shown(who, shape, view)] });
        await put(who, slug, got.text.replace('Edit world fact', 'Edit world fact, edited'), got.revision);
        const after = await stored(slug);
        expect({ who, shape, view, edited: after.includes('Edit world fact, edited'), old: count(after, OLD), del: count(after, DEL), member: await memberSees(slug, OLD) })
          .toEqual({ who, shape, view, edited: true, old: 1, del: 1, member: 0 });
      }
    }, 3_600_000);

    test('every owner read of a page body agrees: as_of shows the private rows get_page shows, at its revision', async () => {
      for (const who of ['ownerC', 'ownerW', 'bobW', 'unboundW'] as Writer[]) {
        const slug = await seed('small');
        const [content, asof] = [await read(who, slug, 'content'), await read(who, slug, 'asof')];
        const rows = (r: { text: string }) => [count(r.text, OLD), count(r.text, DEL)];
        const sees = who === 'ownerC' || who === 'ownerW' ? [1, 1] : [0, 0];
        expect({ who, content: rows(content), asof: rows(asof), revision: asof.revision })
          .toEqual({ who, content: sees, asof: sees, revision: content.revision });
      }
    }, 600_000);

    test('a writer whose read showed the private rows edits one and deletes another: both stick for the local CLI; a remote owner write keeps the stored rows beside its edit', async () => {
      for (const [shape, view] of CASES) for (const who of WRITERS.filter(w => shown(w, shape, view))) {
        const slug = await seed(shape);
        const got = await read(who, slug, view);
        await put(who, slug, got.text.replace(OLD, NEW).split('\n').filter(line => !line.includes(DEL)).join('\n'), got.revision);
        const after = await stored(slug);
        const sticks = who === 'local';
        expect({ who, shape, view, old: count(after, OLD), new: count(after, NEW), del: count(after, DEL), member: await memberSees(slug, NEW) })
          .toEqual({ who, shape, view, old: sticks ? 0 : 1, new: 1, del: sticks ? 0 : 1, member: 0 });
      }
    }, 3_600_000);

    test('an owner put_page forced with no expected revision keeps every private row it leaves out', async () => {
      for (const who of ['ownerC', 'ownerW'] as Writer[]) {
        const slug = await seed('small');
        const got = await read(who, slug, 'content');
        expect({ who, rows: [got.text.includes(OLD), got.text.includes(DEL)] }).toEqual({ who, rows: [true, true] });
        await call(who, 'put_page', { slug, force: true, request_id: randomUUID(), content: got.text.split('\n').filter(line => !line.includes(OLD) && !line.includes(DEL)).join('\n').replace('Edit world fact', 'Edit world fact, edited') });
        const after = await stored(slug);
        expect({ who, edited: after.includes('Edit world fact, edited'), old: count(after, OLD), del: count(after, DEL) }).toEqual({ who, edited: true, old: 1, del: 1 });
      }
    }, 300_000);

    test('an owner credential that may not call get_page keeps every private row its write leaves out', async () => {
      const slug = await seed('small');
      const got = await read('local', slug, 'content');
      await put('ownerP', slug, got.text.split('\n').filter(line => !line.includes(OLD) && !line.includes(DEL)).join('\n').replace('Edit world fact', 'Edit world fact, edited'), got.revision);
      const after = await stored(slug);
      expect({ edited: after.includes('Edit world fact, edited'), old: count(after, OLD), del: count(after, DEL) }).toEqual({ edited: true, old: 1, del: 1 });
    }, 300_000);
  });
}
