/**
 * GST-2091: the brain owner's own remote credential edits, appends to and relabels a private page it already reads.
 *
 * 1. Protects: a credential bound to the brain owner (config access.owner_member) with write scope, speaking for
 *    itself, rewrites (put_page), edits (edit_page) and appends to (append_page) a `visibility: private` page and a
 *    private page whose readers list the owner, and relabels one to world (put_page or edit_page). The page revision
 *    and the journaled request name the owner's credential. A whole-page rewrite that leaves out `visibility` or
 *    `readable_by` keeps the stored ones; a relabel keeps the readers it does not mention, and pages derived from the
 *    relabelled page keep their own readers. Everyone else is refused exactly as before, on every write path: another
 *    member, an unbound legacy token, an OAuth client with no member, an attested call (an actor linked to the
 *    owner), the owner's credential asserting a shared room, the owner's credential without write scope, and the
 *    owner's credential on a page whose readers or folder rule leave the owner out.
 * 2. Fails when: an owner write to a private page it reads answers page_not_found (the behaviour before GST-2091),
 *    drops the page's privacy or readers without being asked to, is recorded under any other principal, or any
 *    refused caller's answer or the page changes.
 * 3. Existing coverage: test/access-owner-reads.test.ts (owner reads), test/access-owner-default-writes.test.ts (the
 *    owner's creates in default), test/access-hidden-page-writes.test.ts (hidden pages answer like missing ones).
 * 4. Real seams: OAuth client-credentials tokens and legacy tokens bound to members and to the owner, a folder rule
 *    through the access policy, MCP dispatch with remote=true, the durable write path of a repo-less brain (PGLite and
 *    Postgres) and of a managed repo brain (Git commit).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';

const OWNER = 'owner-example';
const WRITERS = ['put_page', 'edit_page', 'append_page'] as const;
type Writer = typeof WRITERS[number];
type Shape = 'private' | 'shared' | 'alice_only' | 'vault';
type Channel = { actor?: string; audience?: string };
type Call = { isError: boolean; code: string | null; text: string };
type PageRow = { frontmatter: Record<string, unknown>; page_readers: string[] | null; revision: string; principal_kind: string | null; principal_id: string | null; body: string };

const tag = () => randomUUID().slice(0, 8);
const FM: Record<Shape, string[]> = {
  private: ['visibility: private'],
  shared: ['visibility: private', `readable_by: [${OWNER}, alice-example]`],
  alice_only: ['visibility: private', 'readable_by: [alice-example]'],
  vault: ['visibility: private'],
};
const pageText = (title: string, body: string, lines: string[]) => ['---', 'type: note', `title: ${title}`, ...lines, '---', `# ${title}`, '', body].join('\n');

/** Every caller the matrix needs, and the helpers that write and read pages, in `sourceId` of an initialized engine. */
async function seedBrain(engine: BrainEngine, sourceId: string, writePage: (slug: string, content: string) => Promise<unknown>) {
  const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  __resetPrivateVisibilityCacheForTests();
  for (const id of ['alice-example', 'bob-example', OWNER]) await addMember(engine, id);
  await setOwner(engine, OWNER);
  await proposeRevision(engine, sourceId, [{ id: 'vault', prefix: 'vault/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database' });
  const tokens: Record<string, string> = {};
  const clients: Record<string, string> = {};
  const oauth: Record<string, { scope: string; binding: Parameters<typeof bindCredential>[2] | null }> = {
    owner: { scope: 'read write', binding: { member: OWNER } },
    owner_read_only: { scope: 'read', binding: { member: OWNER } },
    alice: { scope: 'read write', binding: { member: 'alice-example' } },
    bob: { scope: 'read write', binding: { member: 'bob-example' } },
    unbound_client: { scope: 'read write', binding: null },
    attested: { scope: 'read write', binding: { attestActor: 'qm' } },
    owner_room: { scope: 'read write', binding: { member: OWNER, mayActFor: [`member:${OWNER}`, 'member:alice-example'] } },
  };
  for (const [name, { scope, binding }] of Object.entries(oauth)) {
    const c = await provider().registerClientManual(`gst2091-${name}-${tag()}`, ['client_credentials'], scope, [], sourceId);
    if (binding) await bindCredential(engine, { kind: 'client', id: c.clientId }, binding);
    clients[name] = c.clientId;
    tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
  }
  tokens.unbound_token = (await mintLegacyToken(engine, { name: `gst2091-unbound-${tag()}`, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [sourceId] })).token;
  await linkMember(engine, OWNER, 'qm', 'U0OWNER');

  async function call(who: string, op: string, params: Record<string, unknown>, channel: Channel = {}): Promise<Call> {
    const auth = await provider().verifyAccessToken(tokens[who]!) as unknown as AuthInfo;
    const out = await dispatchToolCall(engine, op, { ...params }, {
      remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'],
      ...(channel.actor ? { actor: { header: channel.actor } } : {}), ...(channel.audience ? { onBehalfOf: { header: channel.audience } } : {}),
    });
    const text = out.content.map(c => c.text).join('\n');
    let json: Record<string, any> = {};
    try { json = JSON.parse(out.content[0]?.text ?? ''); } catch { /* prose */ }
    return { isError: out.isError === true, code: out.isError === true ? json.error ?? json.code ?? null : null, text };
  }
  async function local(slug: string): Promise<{ revision: string; content: string }> {
    const out = await dispatchToolCall(engine, 'get_page', { slug, include_content: true }, { remote: false, sourceId });
    return JSON.parse(out.content.map(c => c.text).join('\n'));
  }
  async function row(slug: string): Promise<PageRow> {
    const [r] = await engine.executeRaw<Omit<PageRow, 'body'>>(`SELECT frontmatter, page_readers, knowledge_revision::text AS revision,
      revision_principal_kind AS principal_kind, revision_principal_id AS principal_id FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL`, [sourceId, slug]);
    return { ...r!, page_readers: r!.page_readers ? [...r!.page_readers].sort() : null, body: (await local(slug)).content ?? '' };
  }
  const revision = async (slug: string) => (await local(slug)).revision;
  async function seed(shape: Shape): Promise<{ slug: string; canary: string; title: string }> {
    const t = tag();
    const canary = `gst2091${shape.replace('_', '')}${t}`;
    const page = { slug: shape === 'vault' ? `vault/note-${t}` : `notes/${shape.replace('_', '-')}-${t}`, canary, title: `Note ${t}` };
    await writePage(page.slug, pageText(page.title, `First line ${canary}.`, FM[shape]));
    return page;
  }
  /** One write of `kind` by `who`; `content` replaces the whole page for put_page (default: the stored text plus a line, no labels). */
  async function write(who: string, kind: Writer, page: { slug: string; canary: string; title: string }, channel: Channel = {}, content?: string): Promise<Call> {
    const marker = `Owner change ${page.canary}.`;
    if (kind === 'put_page') {
      return call(who, 'put_page', { slug: page.slug, content: content ?? pageText(page.title, `First line ${page.canary}.\n\n${marker}`, []),
        expected_revision: await revision(page.slug), request_id: randomUUID() }, channel);
    }
    if (kind === 'edit_page') {
      return call(who, 'edit_page', { slug: page.slug, expected_revision: await revision(page.slug), request_id: randomUUID(),
        edits: [{ old_text: `First line ${page.canary}.`, new_text: `First line ${page.canary}.\n\n${marker}` }] }, channel);
    }
    return call(who, 'append_page', { slug: page.slug, text: marker, request_id: randomUUID() }, channel);
  }
  return { call, row, revision, seed, write, clients };
}

for (const kind of testBackends()) {
  describe(`owner remote private writes (GST-2091, ${kind}, repo-less)`, () => {
    const SRC = 'source-a';
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let h: Awaited<ReturnType<typeof seedBrain>>;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      h = await seedBrain(engine, SRC, (slug, content) => importFromContent(engine, slug, content, { sourceId: SRC }));
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    for (const writer of WRITERS) {
      for (const shape of ['private', 'shared'] as const) {
        test(`the owner's credential runs ${writer} on a ${shape} page it reads, keeps its labels and is recorded as the writer`, async () => {
          const page = await h.seed(shape);
          const before = await h.row(page.slug);
          const out = await h.write('owner', writer, page);
          expect({ isError: out.isError, code: out.code, text: out.isError ? out.text : '' }).toEqual({ isError: false, code: null, text: '' });
          const after = await h.row(page.slug);
          expect(after.body).toContain(`Owner change ${page.canary}.`);
          expect(after.frontmatter.visibility).toBe('private');
          expect(after.frontmatter.readable_by ?? null).toEqual(before.frontmatter.readable_by ?? null);
          expect(after.page_readers).toEqual(before.page_readers);
          expect({ kind: after.principal_kind, id: after.principal_id }).toEqual({ kind: 'oauth_client', id: h.clients.owner! });
          const [req] = await engine.executeRaw<{ principal_kind: string; principal_id: string; owner: string | null }>(
            "SELECT principal_kind, principal_id, authority->>'ownerWrite' AS owner FROM persistence_requests WHERE source_id = $1 AND slug = $2 AND operation = $3 ORDER BY created_at DESC LIMIT 1",
            [SRC, page.slug, writer]);
          expect(req).toEqual({ principal_kind: 'oauth_client', principal_id: h.clients.owner!, owner: `member:${OWNER}` });
          for (const member of ['alice', 'bob']) expect((await h.call(member, 'get_page', { slug: page.slug })).text).not.toContain(page.canary);
        }, 120_000);
      }
    }

    test('the owner relabels a private page to world with put_page, and every reader then reads it', async () => {
      const page = await h.seed('private');
      const out = await h.write('owner', 'put_page', page, {}, pageText(page.title, `First line ${page.canary}.`, ['visibility: world']));
      expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
      const after = await h.row(page.slug);
      expect(after.frontmatter.visibility).toBe('world');
      expect(after.principal_id).toBe(h.clients.owner!);
      expect((await h.call('bob', 'get_page', { slug: page.slug })).text).toContain(page.canary);
    }, 120_000);

    test('the owner clears a private label with edit_page; the readers it does not mention stay', async () => {
      const page = await h.seed('shared');
      const out = await h.call('owner', 'edit_page', { slug: page.slug, expected_revision: await h.revision(page.slug), request_id: randomUUID(),
        edits: [{ old_text: 'visibility: private', new_text: 'visibility: world' }] });
      expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
      const after = await h.row(page.slug);
      expect(after.frontmatter.visibility).toBe('world');
      expect(after.page_readers).toEqual(['member:alice-example', `member:${OWNER}`]);
      expect((await h.call('alice', 'get_page', { slug: page.slug })).text).toContain(page.canary);
      expect((await h.call('bob', 'get_page', { slug: page.slug })).text).not.toContain(page.canary);
    }, 120_000);

    test('an owner relabel leaves the readers of pages derived from the relabelled page as they were', async () => {
      const page = await h.seed('shared');
      const derived = `notes/derived-${tag()}`;
      await importFromContent(engine, derived, pageText('Derived note', `Summary of ${page.canary}.`,
        ['visibility: private', `readable_by: [${OWNER}, alice-example]`, `derived_from: [${page.slug}]`]), { sourceId: SRC });
      const before = await h.row(derived);
      const out = await h.write('owner', 'put_page', page, {}, pageText(page.title, `First line ${page.canary}.`, ['visibility: world']));
      expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
      expect((await h.row(page.slug)).page_readers).toEqual(['member:alice-example', `member:${OWNER}`]);
      expect(await h.row(derived)).toEqual(before);
      expect((await h.call('bob', 'get_page', { slug: derived })).text).not.toContain(page.canary);
    }, 120_000);

    const privateWithoutVisibility: Array<[string, (t: string, origin: string) => string[], string]> = [
      ['a privacy alias', () => ['access: confidential'], 'note'],
      ['a pinned_question marker', () => ['pinned_question: true'], 'note'],
      ['derived_from a private page', (_t, origin) => [`derived_from: [${origin}]`], 'note'],
      ['a derived atom type', () => [], 'atom'],
    ];
    for (const [label, lines, type] of privateWithoutVisibility) {
      test(`an owner put_page that leaves out labels keeps a page private by ${label} private`, async () => {
        const origin = (await h.seed('private')).slug;
        const t = tag();
        const page = { slug: `notes/implicit-${t}`, canary: `gst2091implicit${t}`, title: `Note ${t}` };
        await importFromContent(engine, page.slug, pageText(page.title, `First line ${page.canary}.`, lines(t, origin)).replace('type: note', `type: ${type}`), { sourceId: SRC });
        expect((await h.call('bob', 'get_page', { slug: page.slug })).text).not.toContain(page.canary);
        const out = await h.write('owner', 'put_page', page);
        expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
        expect((await h.row(page.slug)).body).toContain(`Owner change ${page.canary}.`);
        for (const member of ['alice', 'bob']) expect((await h.call(member, 'get_page', { slug: page.slug })).text).not.toContain(page.canary);
      }, 120_000);
    }

    test('the owner still cannot delete a private page remotely: delete_page answers as before', async () => {
      const page = await h.seed('private');
      const before = await h.row(page.slug);
      const out = await h.call('owner', 'delete_page', { slug: page.slug, request_id: randomUUID() });
      expect({ isError: out.isError, code: out.code }).toEqual({ isError: true, code: 'page_not_found' });
      expect(await h.row(page.slug)).toEqual(before);
    }, 120_000);

    const refused: Array<[string, string, Shape, Channel]> = [
      ['another member', 'bob', 'private', {}],
      ['a member the page lists', 'alice', 'shared', {}],
      ['an unbound legacy token', 'unbound_token', 'private', {}],
      ['an OAuth client with no member', 'unbound_client', 'private', {}],
      ["the owner's credential asserting a shared room", 'owner_room', 'private', { audience: `member:${OWNER},member:alice-example` }],
      ["the owner's credential on a page whose readers leave the owner out", 'owner', 'alice_only', {}],
      ["the owner's credential on a page under a folder rule that leaves the owner out", 'owner', 'vault', {}],
      ['an attested call for the owner', 'attested', 'private', { actor: 'qm:U0OWNER' }],
      ["the owner's credential without write scope", 'owner_read_only', 'private', {}],
    ];
    for (const writer of WRITERS) {
      for (const [label, who, shape, channel] of refused) {
        test(`${writer}: ${label} is refused as before and the page is unchanged`, async () => {
          const page = await h.seed(shape);
          const before = await h.row(page.slug);
          const out = await h.write(who, writer, page, channel);
          expect({ isError: out.isError, code: out.code }).toEqual({ isError: true, code: REFUSED_CODE[who] ?? 'page_not_found' });
          expect(await h.row(page.slug)).toEqual(before);
        }, 120_000);
      }
    }
  });

  describe(`owner remote private writes (GST-2091, ${kind}, managed repo brain)`, () => {
    test('the owner rewrites a private page through Git and it stays private; another member is refused as before', async () => {
      await managedBrain(async ({ engine, root }) => {
        const h = await seedBrain(engine, 'default', async (slug, content) => {
          await dispatchToolCall(engine, 'put_page', { slug, content }, { remote: false, sourceId: 'default' });
          await settleManagedGitEffects(engine);
        });
        const page = await h.seed('private');
        const refused = await h.write('bob', 'put_page', page);
        expect({ isError: refused.isError, code: refused.code }).toEqual({ isError: true, code: 'page_not_found' });
        const out = await h.write('owner', 'put_page', page);
        expect({ isError: out.isError, text: out.isError ? out.text : '' }).toEqual({ isError: false, text: '' });
        await settleManagedGitEffects(engine);
        const file = readFileSync(join(root, `${page.slug}.md`), 'utf8');
        expect(file).toContain(`Owner change ${page.canary}.`);
        expect(file).toContain('visibility: private');
        expect((await h.row(page.slug)).principal_id).toBe(h.clients.owner!);
      }, kind === 'postgres' ? { databaseUrl: process.env.DATABASE_URL! } : {});
    }, 240_000);
  });
}

/**
 * The code each refused caller got before GST-2091 (recorded on master 503e7b65, every writer): page_not_found, except an
 * attested call (put_page, edit_page and append_page are not attestable) and a credential without write scope.
 */
const REFUSED_CODE: Record<string, string> = { attested: 'actor_not_attested', owner_read_only: 'permission_denied' };
