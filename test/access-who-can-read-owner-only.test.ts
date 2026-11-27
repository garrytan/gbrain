/**
 * gbrain access who-can-read and gbrain access serves on a brain that has, or once had, an owner-only source.
 *
 * 1. Protects: who-can-read names exactly the members whose keys read a page through get_page and search, and the
 *    open-page count (access serves, doctor open_shared_pages) counts exactly the unlabelled pages every member's key
 *    reads, before an owner-only source exists, while one exists, and after it is removed.
 * 2. Fails when: these reports build the member read without the brain's schema version, so the owner-only test takes
 *    its closed form and every page reads as owner-only once an owner-only source exists or ever existed: who-can-read
 *    then says no member reads a page a member does read, and access serves says no page is open; or when who-can-read
 *    says "every caller entitled to the source" for a page in an owner-only source, which only the owner reads; or when
 *    the fix changes what the owner's own callers read (a trusted local caller and the owner's key, pinned unchanged).
 * 3. Existing coverage: access-who-can-read-folder-rules pins folder rules; open-shared-pages pins the open count on a
 *    brain with no owner-only source; owner-only-removal-lineage pins the read path itself.
 * 4. Real seams: PGLite (Postgres when DATABASE_URL is set), real members and folder rules, member-bound tokens read
 *    through dispatchToolCall as a remote http caller; repo-less brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import { openPages } from '../src/core/access/open-pages.ts';
import { removeSource } from '../src/core/sources-ops.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { whoCanRead } from '../src/commands/access.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const OWNER = 'owner-example';
const MEMBERS = [OWNER, 'alice-example', 'bob-example'];
const OTHERS = MEMBERS.filter(m => m !== OWNER);
const IMSG = 'imsg';
type Page = { source: string; slug: string; canary: string; fm: string[] };
const page = (source: string, slug: string, canary: string, fm: string[] = []): Page => ({ source, slug, canary, fm });
/** Pages in the default source: one per kind of label, plus open pages in two folders. */
const DEFAULT_PAGES: Page[] = [
  page('default', 'notes/alice-only', 'canaryalicezq', ['readable_by: [alice-example]']),
  page('default', 'notes/owner-and-bob', 'canaryownerbobzq', ['readable_by: [owner-example, bob-example]']),
  page('default', 'notes/open', 'canaryopenzq'),
  page('default', 'team/plan', 'canaryteamzq'),
  page('default', 'ideas/open-idea', 'canaryideazq'),
];
/** Pages in the owner-only source: an open one and one that names a member. */
const IMSG_PAGES: Page[] = [
  page(IMSG, 'chats/dm-open', 'canarydmopenzq'),
  page(IMSG, 'chats/dm-alice', 'canarydmalicezq', ['readable_by: [alice-example]']),
];
const text = (p: Page) => ['---', 'type: note', `title: ${p.slug}`, ...p.fm, '---', `# ${p.slug}`, '', `Harbor ledger ${p.canary} body.`].join('\n');

for (const kind of testBackends()) {
  describe(`who-can-read and access serves agree with real reads on an owner-only brain (${kind}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(member: string, op: string, params: Record<string, unknown>): Promise<string> {
      const auth = await provider().verifyAccessToken(tokens[member]!) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, params, {
        remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: auth.takesHoldersAllowList ?? ['world'] });
      return out.content.map(c => c.text).join('\n');
    }

    /** The members whose keys read `p` through get_page, checked against search (both paths must agree). */
    async function realReaders(p: Page): Promise<string[]> {
      const readers: string[] = [];
      for (const member of MEMBERS) {
        const got = (await call(member, 'get_page', { slug: p.slug, source_id: p.source })).includes(p.canary);
        const found = (await call(member, 'search', { query: p.canary, source_id: p.source })).includes(p.canary);
        expect({ member, page: p.slug, got }).toEqual({ member, page: p.slug, got: found });
        if (got) readers.push(member);
      }
      return readers.sort();
    }

    /** who-can-read's answer as a member list; every key here reads every source, so "every source reader" is everyone. */
    async function reportedReaders(p: Page): Promise<string[]> {
      const [entry] = await whoCanRead(engine, p.slug, p.source);
      return entry!.members === 'every_source_reader' ? [...MEMBERS].sort() : [...entry!.members].sort();
    }

    /**
     * The owner's own reads are pinned unchanged: a trusted local caller (remote: false) reads every page, and the
     * owner's key reads every page that names the owner or no one, including the owner-only source's open page.
     */
    async function ownerReads(pages: Page[]): Promise<{ local: string[]; ownerKey: string[] }> {
      const local: string[] = [];
      const ownerKey: string[] = [];
      for (const p of pages) {
        const out = await dispatchToolCall(engine, 'get_page', { slug: p.slug, source_id: p.source }, { remote: false, sourceId: p.source });
        if (out.content.map(c => c.text).join('\n').includes(p.canary)) local.push(`${p.source}:${p.slug}`);
        if ((await call(OWNER, 'get_page', { slug: p.slug, source_id: p.source })).includes(p.canary)) ownerKey.push(`${p.source}:${p.slug}`);
      }
      return { local: local.sort(), ownerKey: ownerKey.sort() };
    }
    const keys = (pages: Page[]) => pages.map(p => `${p.source}:${p.slug}`).sort();
    const OWNER_KEY_READS = ['default:ideas/open-idea', 'default:notes/open', 'default:notes/owner-and-bob'];

    /** For each page: what who-can-read reports and what the members' keys really read. */
    async function compare(pages: Page[]): Promise<{ reported: Record<string, string[]>; real: Record<string, string[]> }> {
      __resetPrivateVisibilityCacheForTests();
      const reported: Record<string, string[]> = {};
      const real: Record<string, string[]> = {};
      for (const p of pages) {
        reported[`${p.source}:${p.slug}`] = await reportedReaders(p);
        real[`${p.source}:${p.slug}`] = await realReaders(p);
      }
      return { reported, real };
    }

    /** The open-page count per folder, and the folders of the unlabelled pages every member other than the owner reads. */
    async function openCount(pages: Page[]): Promise<{ counted: Record<string, number>; read: Record<string, number> }> {
      __resetPrivateVisibilityCacheForTests();
      const open = await openPages(engine);
      const counted = Object.fromEntries(open.folders.map(f => [`${f.source}/${f.folder}`, f.pages]));
      const read: Record<string, number> = {};
      for (const p of pages) {
        if (p.fm.length || p.slug.startsWith('team/')) continue;
        const readers = await realReaders(p);
        if (!OTHERS.every(m => readers.includes(m))) continue;
        const key = `${p.source}/${p.slug.split('/')[0]}`;
        read[key] = (read[key] ?? 0) + 1;
      }
      return { counted, read };
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      for (const id of MEMBERS) await addMember(engine, id);
      await setOwner(engine, OWNER);
      const rule = await proposeRevision(engine, 'default', [{ id: 'team-bob', prefix: 'team/', readable_by: ['member:bob-example'] }], { origin: 'cli' });
      expect(rule.state).toBe('applied');
      for (const p of DEFAULT_PAGES) await importFromContent(engine, p.slug, text(p), { sourceId: p.source, noEmbed: true });
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [IMSG]);
      for (const member of MEMBERS) {
        const minted = await mintLegacyToken(engine, { name: `key-${member}`, scopes: ['read'], takesHolders: ['world'], sourceGrant: ['default', IMSG] });
        tokens[member] = minted.token;
        await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
      }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('fixture control: before any owner-only source, who-can-read and the open count match the real reads', async () => {
      const { reported, real } = await compare(DEFAULT_PAGES);
      expect(real).toEqual({
        'default:notes/alice-only': ['alice-example'],
        'default:notes/owner-and-bob': ['bob-example', OWNER],
        'default:notes/open': [...MEMBERS].sort(),
        'default:team/plan': ['bob-example'],
        'default:ideas/open-idea': [...MEMBERS].sort(),
      });
      expect(reported).toEqual(real);
      const { counted, read } = await openCount(DEFAULT_PAGES);
      expect(read).toEqual({ 'default/notes': 1, 'default/ideas': 1 });
      expect(counted).toEqual(read);
      expect(await ownerReads(DEFAULT_PAGES)).toEqual({ local: keys(DEFAULT_PAGES), ownerKey: OWNER_KEY_READS });
    }, 240_000);

    test('with an iMessage source, who-can-read and the open count still match what each member reads', async () => {
      await engine.executeRaw(`UPDATE sources SET config = '{"kind":"imessage"}'::jsonb WHERE id = $1`, [IMSG]);
      for (const p of IMSG_PAGES) await importFromContent(engine, p.slug, text(p), { sourceId: p.source, noEmbed: true });
      const pages = [...DEFAULT_PAGES, ...IMSG_PAGES];
      const { reported, real } = await compare(pages);
      expect(real).toMatchObject({
        'default:notes/alice-only': ['alice-example'],
        'imsg:chats/dm-open': [OWNER],
        'imsg:chats/dm-alice': [],
      });
      expect(reported).toEqual(real);
      const [dm] = await whoCanRead(engine, 'chats/dm-open', IMSG);
      expect(dm!.note).toContain('owner-only source');
      const { counted, read } = await openCount(pages);
      expect(read).toEqual({ 'default/notes': 1, 'default/ideas': 1 });
      expect(counted).toEqual(read);
      expect(await ownerReads(pages)).toEqual({ local: keys(pages), ownerKey: [...OWNER_KEY_READS, 'imsg:chats/dm-open'].sort() });
    }, 240_000);

    test('after the owner-only source is removed, who-can-read and the open count still match the real reads', async () => {
      await removeSource(engine, { id: IMSG, confirmDestructive: true, yes: true } as never);
      expect(await engine.executeRaw('SELECT id FROM sources WHERE id = $1', [IMSG])).toEqual([]);
      const { reported, real } = await compare(DEFAULT_PAGES);
      expect(real['default:notes/alice-only']).toEqual(['alice-example']);
      expect(reported).toEqual(real);
      const { counted, read } = await openCount(DEFAULT_PAGES);
      expect(read).toEqual({ 'default/notes': 1, 'default/ideas': 1 });
      expect(counted).toEqual(read);
      expect(await ownerReads(DEFAULT_PAGES)).toEqual({ local: keys(DEFAULT_PAGES), ownerKey: OWNER_KEY_READS });
    }, 240_000);
  });
}
