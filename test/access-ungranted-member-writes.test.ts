/**
 * GST-2051 (HARN-64): a credential bound to a member with no source grant writes to the `default` source, which every
 * no-grant credential reads (so does an OAuth client at its registration default, or a token granted --sources default). Before the fix a page it created there was readable by any other member and by an unbound
 * token on get_page, search, query, recall and list_pages.
 * 1. Protects: a page such a credential creates names its member as its only reader (readable_by), so another member
 *    and an unbound token get the canonical page_not_found and no search, query, recall or list_pages hit; the writer
 *    still reads it, rewrites it without readable_by (the stored readers carry), and widens it by naming readers. An
 *    existing shared page it edits stays shared. POST /ingest, which cannot keep a page to its member, refuses it.
 *    The documented shape (--sources private-<member>,default) is unchanged: its pages carry no stamped readers and
 *    stay out of other members' and unbound reads through the source grant.
 * 2. Fails when: a member-bound no-grant put_page lands without readers, or the documented shape is stamped or leaks.
 * 3. Existing coverage (access-writes, member-read-access) uses granted credentials only.
 * 4. Real seams: tokens minted by the token service and bound with SQL, verified by the serve --http verifier,
 *    dispatched through MCP dispatch; the durable write path of a repo-less brain (no git checkout).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const PRIVATE_SRC = 'private-alice-example';
const SHARED_PAGE = 'notes/team-shared';
const marker = (tag: string) => 'ungranted' + tag + randomUUID().slice(0, 8);
const note = (title: string, body: string, readers = '') =>
  ['---', 'type: note', 'title: ' + title, ...(readers ? ['readable_by: ' + readers] : []), '---', '# ' + title, '', body].join('\n');

for (const kind of testBackends()) {
  describe('writes to default from a member-bound credential (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let databaseUrl: string;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>) {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json };
    }
    async function revision(slug: string): Promise<string> {
      const out = await dispatchToolCall(engine, 'get_page', { slug, include_content: true }, { remote: false, sourceId: 'default' });
      return (JSON.parse(out.content.map(c => c.text).join('\n')) as { revision: string }).revision;
    }
    async function stored(slug: string, source = 'default') {
      const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; page_readers: string[] | null; body: string }>(
        'SELECT frontmatter, page_readers, compiled_truth AS body FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [source, slug]);
      return row;
    }
    /** What each read op shows `who` of a page whose body carries `canary`: true where the canary leaks. */
    async function reads(who: string, slug: string, canary: string, source?: string) {
      const scoped = source ? { source_id: source } : {};
      const seen: Record<string, boolean> = {};
      for (const [op, params] of [['get_page', { slug, ...scoped }], ['search', { query: canary }], ['query', { query: 'note ' + canary }],
        ['recall', { query: canary }], ['list_pages', {}]] as const) {
        const out = await call(who, op, params as Record<string, unknown>);
        seen[op] = op === 'list_pages' ? out.text.includes(slug) : out.text.includes(canary + '.');
      }
      return seen;
    }
    const none = { get_page: false, search: false, query: false, recall: false, list_pages: false };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close, databaseUrl } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [PRIVATE_SRC]);
      await importFromContent(engine, SHARED_PAGE, note('Team shared', 'Shared agenda.'), { sourceId: 'default', noEmbed: true });
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      // An OAuth client as registration leaves it (source_id default, federated_read {default}), bound to alice.
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
        client_id_issued_at, source_id, federated_read, member_id) VALUES ('alice-client', 'x', 'alice-client', '{}', '{client_credentials}', 'read write',
        'client_secret_post', 0, 'default', '{default}', 'alice-example')`);
      for (const [name, member, sourceGrant] of [['alice', 'alice-example', undefined], ['bob', 'bob-example', undefined], ['public', null, undefined],
        ['alice-documented', 'alice-example', [PRIVATE_SRC, 'default']], ['alice-default-grant', 'alice-example', ['default']]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], ...(sourceGrant ? { sourceGrant: [...sourceGrant] } : {}) });
        tokens[name] = minted.token;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
        else await readsUnscopedOnPurpose(engine, minted.id);
      }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('a page it creates in default names only its member: another member and an unbound token read nothing of it', async () => {
      const canary = marker('new');
      const slug = 'notes/alice-dock-' + canary;
      const put = await call('alice', 'put_page', { slug, content: note('Alice dock', 'Alice dock code ' + canary + '.'), request_id: randomUUID() });
      expect({ isError: put.isError, source: put.json.source_id ?? put.json.source }).toEqual({ isError: false, source: 'default' });
      expect(await stored(slug)).toMatchObject({ frontmatter: { readable_by: ['member:alice-example'] }, page_readers: ['member:alice-example'] });
      expect(await reads('bob', slug, canary)).toEqual(none);
      expect(await reads('public', slug, canary)).toEqual(none);
      expect((await call('bob', 'get_page', { slug })).json.code).toBe('page_not_found');
      expect((await reads('alice', slug, canary)).get_page).toBe(true);
    }, 240_000);

    test('a page derived from its page follows the rule for pages with readers: no remote caller reads it, the writer included', async () => {
      const canary = marker('origin');
      const slug = 'notes/alice-origin-' + canary;
      expect((await call('alice', 'put_page', { slug, content: note('Alice origin', 'Alice origin code ' + canary + '.') })).isError).toBe(false);
      const derived = 'notes/derived-' + canary;
      await importFromContent(engine, derived, ['---', 'type: note', 'title: Derived ' + canary, 'derived_from: [' + slug + ']', '---', '# Derived', '', 'Derived code ' + canary + '.'].join('\n'), { sourceId: 'default', noEmbed: true });
      expect((await stored(derived)).page_readers).toBeNull();
      for (const who of ['bob', 'public', 'alice']) expect((await call(who, 'get_page', { slug: derived })).json.code).toBe('page_not_found');
      const control = 'notes/derived-shared-' + canary;
      await importFromContent(engine, control, ['---', 'type: note', 'title: Control ' + canary, 'derived_from: [' + SHARED_PAGE + ']', '---', '# Control', '', 'Control code ' + canary + '.'].join('\n'), { sourceId: 'default', noEmbed: true });
      const read = await call('bob', 'get_page', { slug: control, include_content: true });
      expect({ isError: read.isError, body: read.text.includes('Control code ' + canary + '.') }).toEqual({ isError: false, body: true });
    }, 240_000);

    test('another member or an unbound token writing a slug the member created gets page_not_found and changes nothing', async () => {
      const canary = marker('claim');
      const slug = 'notes/alice-claim-' + canary;
      expect((await call('alice', 'put_page', { slug, content: note('Alice claim', 'Alice ' + canary + '.') })).isError).toBe(false);
      for (const who of ['bob', 'public']) expect((await call(who, 'put_page', { slug, content: note('Other claim', who + ' ' + canary + '.') })).json.code).toBe('page_not_found');
      expect(await stored(slug)).toMatchObject({ page_readers: ['member:alice-example'], body: expect.stringContaining('Alice ' + canary) });
    }, 240_000);

    test('a binding the write cannot read, or a write bound to a disabled member, is refused instead of publishing shared', async () => {
      const canary = marker('lookup');
      const slug = 'notes/alice-lookup-' + canary;
      const auth = await provider().verifyAccessToken(tokens.alice) as unknown as AuthInfo;
      await engine.executeRaw('ALTER TABLE access_tokens RENAME COLUMN member_id TO member_id_unreadable');
      try {
        await dispatchToolCall(engine, 'put_page', { slug, content: note('Alice lookup', 'Alice lookup code ' + canary + '.'), request_id: randomUUID() },
          { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
      } finally {
        await engine.executeRaw('ALTER TABLE access_tokens RENAME COLUMN member_id_unreadable TO member_id');
        // GST-2314: a pooled connection that prepared an access_tokens SELECT * while the column was renamed fails 0A000 on
        // its next use inside a transaction, so the later cases start on fresh connections.
        if (kind === 'postgres') { await disposePersistenceConsumer(engine); await engine.disconnect(); await engine.connect({ database_url: databaseUrl, poolSize: 4 } as never); }
      }
      expect(await stored(slug)).toBeUndefined();
      expect(await reads('public', slug, canary)).toEqual(none);
      await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', ['carol-example']);
      const minted = await mintLegacyToken(engine, { name: 'carol', scopes: ['read', 'write'], takesHolders: ['world'] });
      await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, 'carol-example']);
      tokens.carol = minted.token;
      const carolAuth = await provider().verifyAccessToken(tokens.carol) as unknown as AuthInfo;
      await engine.executeRaw('UPDATE access_members SET disabled_at = now() WHERE id = $1', ['carol-example']);
      const carolSlug = 'notes/carol-' + canary;
      const carolOut = await dispatchToolCall(engine, 'put_page', { slug: carolSlug, content: note('Carol', 'Carol code ' + canary + '.'), request_id: randomUUID() },
        { remote: true, transport: 'http', auth: carolAuth, sourceId: 'default', takesHoldersAllowList: ['world'] });
      expect(JSON.parse(carolOut.content.map(c => c.text).join('\n')).code).toBe('readable_by_invalid');
      expect(await stored(carolSlug)).toBeUndefined();
      expect(await reads('public', carolSlug, canary)).toEqual(none);
    }, 240_000);

    test('a token granted --sources default and an OAuth client at its registration default are kept to their member too', async () => {
      const canary = marker('grant');
      const slug = 'notes/alice-grant-' + canary;
      expect((await call('alice-default-grant', 'put_page', { slug, content: note('Alice grant', 'Alice grant code ' + canary + '.') })).isError).toBe(false);
      expect((await stored(slug)).page_readers).toEqual(['member:alice-example']);
      expect(await reads('bob', slug, canary)).toEqual(none);
      const clientCanary = marker('client');
      const clientSlug = 'notes/alice-client-' + clientCanary;
      const auth = { token: '', clientId: 'alice-client', clientName: 'alice-client', principal: { kind: 'oauth_client', id: 'alice-client' }, scopes: ['read', 'write'],
        member: { id: 'alice-example', groups: [] }, sourceId: 'default', allowedSources: ['default'] } as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, 'put_page', { slug: clientSlug, content: note('Alice client', 'Alice client code ' + clientCanary + '.'), request_id: randomUUID() },
        { remote: true, transport: 'http', auth, sourceId: 'default', takesHoldersAllowList: ['world'] });
      expect(out.isError === true).toBe(false);
      expect((await stored(clientSlug)).page_readers).toEqual(['member:alice-example']);
      expect(await reads('bob', clientSlug, clientCanary)).toEqual(none);
      expect(await reads('public', clientSlug, clientCanary)).toEqual(none);
    }, 240_000);

    test('the writer rewrites its page without readable_by and the readers carry; naming readers widens it', async () => {
      const canary = marker('carry');
      const slug = 'notes/alice-carry-' + canary;
      expect((await call('alice', 'put_page', { slug, content: note('Alice carry', 'First ' + canary + '.') })).isError).toBe(false);
      const rewrite = await call('alice', 'put_page', { slug, content: note('Alice carry', 'Second ' + canary + '.'), expected_revision: await revision(slug) });
      expect({ isError: rewrite.isError, code: rewrite.json.code }).toEqual({ isError: false, code: undefined });
      expect(await stored(slug)).toMatchObject({ body: expect.stringContaining('Second'), page_readers: ['member:alice-example'] });
      expect(await reads('bob', slug, canary)).toEqual(none);
      const widen = await call('alice', 'put_page', { slug, content: note('Alice carry', 'Third ' + canary + '.', '[alice-example, bob-example]'), expected_revision: await revision(slug) });
      expect(widen.isError).toBe(false);
      expect((await reads('bob', slug, canary)).get_page).toBe(true);
      expect((await reads('public', slug, canary)).get_page).toBe(false);
    }, 240_000);

    test('an existing shared page it edits stays shared', async () => {
      const canary = marker('shared');
      const out = await call('alice', 'put_page', { slug: SHARED_PAGE, content: note('Team shared', 'Shared agenda ' + canary + '.'), expected_revision: await revision(SHARED_PAGE) });
      expect(out.isError).toBe(false);
      expect((await stored(SHARED_PAGE)).page_readers).toBeNull();
      expect((await reads('bob', SHARED_PAGE, canary)).get_page).toBe(true);
    }, 240_000);

    test('a remember fact stays on the member page, as before', async () => {
      const canary = marker('fact');
      const out = await call('alice', 'remember', { fact: 'Alice escalation code ' + canary + '.', entity: 'alice-example', provenance: 'test', request_id: randomUUID() });
      expect(out.isError).toBe(false);
      for (const who of ['bob', 'public']) expect((await call(who, 'recall', { query: canary })).text).not.toContain(canary + '.');
    }, 240_000);

    test('the documented shape (--sources private-<member>,default) is unchanged: no stamped readers, nothing leaks', async () => {
      const canary = marker('doc');
      const slug = 'notes/alice-doc-' + canary;
      const put = await call('alice-documented', 'put_page', { slug, content: note('Alice doc', 'Alice doc code ' + canary + '.') });
      expect(put.isError).toBe(false);
      expect(await stored(slug, PRIVATE_SRC)).toMatchObject({ page_readers: null });
      expect((await stored(slug, PRIVATE_SRC)).frontmatter.readable_by).toBeUndefined();
      expect(await reads('bob', slug, canary, PRIVATE_SRC)).toEqual(none);
      expect(await reads('public', slug, canary, PRIVATE_SRC)).toEqual(none);
      expect((await reads('alice-documented', slug, canary, PRIVATE_SRC)).get_page).toBe(true);
    }, 240_000);

    test('POST /ingest refuses it and queues nothing; a granted member credential still reaches the route', async () => {
      const app = express();
      const pass: express.RequestHandler = (_req, _res, next) => next();
      mountWebhooks(app, { engine, resourceVerifier: provider(), resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
        ingestRateLimiter: pass, githubWebhookLimiter: pass, broadcastEvent: () => {} } as unknown as ServeHttpContext);
      const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const ingest = (who: string, body: string) => fetch(base + '/ingest', { method: 'POST', body,
          headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'text/markdown' } });
        const [before] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'ingest_capture'");
        const refused = await ingest('alice', note('Alice ingest', 'Ingest ' + marker('ingest') + '.'));
        expect(refused.status).toBe(403);
        expect(await refused.json()).toMatchObject({ error: 'permission_denied', message: expect.stringContaining('write source is default') });
        const [after] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'ingest_capture'");
        expect(after.n).toBe(before.n);
        const granted = await ingest('alice-documented', note('Alice doc ingest', 'Ingest ' + marker('ingestdoc') + '.'));
        expect(granted.status).toBe(202);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 240_000);
  });
}

for (const kind of testBackends()) {
  describe('writes to default from a member-bound credential (' + kind + ', repo brain)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-gst2051-' + kind + '-'));
    const root = join(home, 'default-repo');
    const env = { GBRAIN_HOME: home, GBRAIN_SYNC_FAILURES_DIR: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

    async function call(who: string, op: string, params: Record<string, unknown>) {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const out = await withEnv(env, () => dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] }));
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      mkdirSync(join(root, 'notes'), { recursive: true });
      git('init', '-q');
      writeFileSync(join(root, 'notes', 'team-shared.md'), note('Team shared', 'Shared agenda.'));
      git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'synthetic content');
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('UPDATE sources SET local_path=$1 WHERE id=$2', [root, 'default']);
      await withEnv(env, () => claimWorktree(engine, 'default', root));
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      expect((await withEnv(env, () => performManagedSync(engine, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true }))).status).toBe('first_sync');
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      for (const [name, member] of [['alice', 'alice-example'], ['bob', 'bob-example']] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'] });
        tokens[name] = minted.token;
        await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      }
    }, 240_000);
    afterAll(async () => { await disposePersistenceConsumer(engine); await close?.(); rmSync(home, { recursive: true, force: true }); }, 60_000);

    test('the git file carries the readers, so a sync of the checkout keeps the page to its member', async () => {
      const canary = marker('repo');
      const slug = 'notes/alice-repo-' + canary;
      const put = await call('alice', 'put_page', { slug, content: note('Alice repo', 'Alice repo code ' + canary + '.'), request_id: randomUUID() });
      expect(put.isError).toBe(false);
      const file = readFileSync(join(root, slug + '.md'), 'utf8');
      expect(file).toContain(canary);
      expect(file).toMatch(/readable_by:\s*\n\s*- member:alice-example/);
      expect((await call('bob', 'get_page', { slug })).text).not.toContain(canary + '.');
      expect((await call('alice', 'get_page', { slug })).text).toContain(canary + '.');
    }, 240_000);
  });
}
