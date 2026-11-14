/**
 * #8982 item 1: GST-2051 keeps a page a member-bound credential creates to that member when it writes where every
 * credential without a source grant reads. That floor is `default` plus every federated source
 * (`config.federated`, noGrantFederatedScope), so a member-bound token granted `--sources <federated-source>` used to
 * publish its pages unstamped there, readable by another member's no-grant token and by an unbound token.
 * 1. Protects: a page such a credential creates in a federated source names its member as its only reader, so another
 *    member and an unbound token (reading the federated set as the HTTP transports do) get page_not_found and no
 *    search, query, recall or list_pages hit, and POST /ingest refuses it. The same holds for a streamed upload over the
 *    single-string ceiling, and a write whose source config cannot be read is refused rather than published unstamped.
 *    A non-federated source keeps the audience its grants give it (no stamp), and a member-bound write cannot land in a
 *    source outside its grant.
 * 2. Fails when: a member-bound put_page into a federated source lands without readers, or a write leaves its source.
 * 3. Existing coverage (access-ungranted-member-writes) only writes to `default`.
 * 4. Real seams: tokens minted by the token service and bound with SQL, verified by the serve --http verifier, read
 *    scope from noGrantFederatedScope (the transports' helper), dispatched through MCP dispatch on a repo-less brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { noGrantFederatedScope } from '../src/core/source-resolver.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import { assertWebhookWriterMayReplace } from '../src/core/minions/handlers/ingest-capture.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

const MiB = 1024 ** 2;
const PART_CHARS = 3_900_000;
const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const FEDERATED = 'source-a';
const ISOLATED = 'source-b';
const marker = (tag: string) => 'fedmember' + tag + randomUUID().slice(0, 8);
const note = (title: string, body: string) => ['---', 'type: note', 'title: ' + title, '---', '# ' + title, '', body].join('\n');

for (const kind of testBackends()) {
  describe('writes to a federated source from a member-bound credential (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const tokenIds: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>) {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const sourceId = auth.sourceId ?? 'default';
      const localFederatedSourceIds = await noGrantFederatedScope(engine, auth.hasSourceGrant, sourceId);
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId, takesHoldersAllowList: ['world'], inboundFrameBytes: 4 * MiB,
        ...(localFederatedSourceIds ? { localFederatedSourceIds } : {}) });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, unknown> = {};
      try { json = JSON.parse(text); } catch { /* prose */ }
      return { isError: out.isError === true, text, json };
    }
    async function stored(slug: string, source: string) {
      const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; page_readers: string[] | null }>(
        'SELECT frontmatter, page_readers FROM pages WHERE source_id=$1 AND slug=$2 AND deleted_at IS NULL', [source, slug]);
      return row;
    }
    /** What each read op shows `who` of a page whose body carries `canary`: true where the canary leaks. */
    async function reads(who: string, slug: string, canary: string, source: string) {
      const seen: Record<string, boolean> = {};
      for (const [key, op, params] of [['get_page', 'get_page', { slug, source_id: source }], ['get_page_unqualified', 'get_page', { slug }],
        ['search', 'search', { query: canary }], ['query', 'query', { query: 'note ' + canary }], ['recall', 'recall', { query: canary }], ['list_pages', 'list_pages', {}]] as const) {
        const out = await call(who, op, params as Record<string, unknown>);
        seen[key] = op === 'list_pages' ? out.text.includes(slug) : out.text.includes(canary + '.');
      }
      return seen;
    }
    const none = { get_page: false, get_page_unqualified: false, search: false, query: false, recall: false, list_pages: false };

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{"federated": true}'::jsonb), ($2, $2, '{"federated": false}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET config = EXCLUDED.config`, [FEDERATED, ISOLATED]);
      for (const id of ['alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await engine.executeRaw(`INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, grant_types, scope, token_endpoint_auth_method,
        client_id_issued_at, source_id, federated_read, member_id) VALUES ('alice-fed-client', 'x', 'alice-fed-client', '{}', '{client_credentials}', 'read write',
        'client_secret_post', 0, $1, ARRAY[$1]::text[], 'alice-example')`, [FEDERATED]);
      for (const [name, member, sourceGrant] of [['alice-a', 'alice-example', [FEDERATED]], ['alice-b', 'alice-example', [ISOLATED]], ['bob-b', 'bob-example', [ISOLATED]],
        ['bob', 'bob-example', undefined], ['public', null, undefined]] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], ...(sourceGrant ? { sourceGrant: [...sourceGrant] } : {}) });
        tokens[name] = minted.token;
        tokenIds[name] = minted.id;
        if (member) await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
        else await readsUnscopedOnPurpose(engine, minted.id);
      }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('the no-grant floor reads the federated source, not the isolated one', async () => {
      expect(await noGrantFederatedScope(engine, false, 'default')).toEqual(['default', FEDERATED]);
    }, 60_000);

    test('a page it creates in a federated source names only its member: another member and an unbound token read nothing of it', async () => {
      const canary = marker('new');
      const slug = 'notes/alice-fed-' + canary;
      const put = await call('alice-a', 'put_page', { slug, content: note('Alice fed', 'Alice fed code ' + canary + '.'), request_id: randomUUID() });
      expect({ isError: put.isError, source: put.json.source_id ?? put.json.source }).toEqual({ isError: false, source: FEDERATED });
      expect(await stored(slug, FEDERATED)).toMatchObject({ frontmatter: { readable_by: ['member:alice-example'] }, page_readers: ['member:alice-example'] });
      expect(await reads('bob', slug, canary, FEDERATED)).toEqual(none);
      expect(await reads('public', slug, canary, FEDERATED)).toEqual(none);
      expect((await call('public', 'get_page', { slug, source_id: FEDERATED })).json.code).toBe('page_not_found');
      expect((await call('alice-a', 'get_page', { slug })).text).toContain(canary + '.');
    }, 240_000);

    test('a non-federated source keeps the audience its grants give it: no stamped readers, unbound tokens cannot reach it', async () => {
      const canary = marker('iso');
      const slug = 'notes/alice-iso-' + canary;
      expect((await call('alice-b', 'put_page', { slug, content: note('Alice iso', 'Alice iso code ' + canary + '.') })).isError).toBe(false);
      expect(await stored(slug, ISOLATED)).toMatchObject({ page_readers: null });
      expect((await stored(slug, ISOLATED)).frontmatter.readable_by).toBeUndefined();
      expect(await reads('public', slug, canary, ISOLATED)).toEqual(none);
      expect(await reads('bob', slug, canary, ISOLATED)).toEqual(none);
      expect((await call('bob-b', 'get_page', { slug })).text).toContain(canary + '.');
    }, 240_000);

    test('an OAuth client bound to a member with a federated write source is kept to its member too', async () => {
      const canary = marker('client');
      const slug = 'notes/alice-client-' + canary;
      const auth = { token: '', clientId: 'alice-fed-client', clientName: 'alice-fed-client', principal: { kind: 'oauth_client', id: 'alice-fed-client' }, scopes: ['read', 'write'],
        member: { id: 'alice-example', groups: [] }, sourceId: FEDERATED, allowedSources: [FEDERATED] } as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, 'put_page', { slug, content: note('Alice client', 'Alice client code ' + canary + '.'), request_id: randomUUID() },
        { remote: true, transport: 'http', auth, sourceId: FEDERATED, takesHoldersAllowList: ['world'] });
      expect(out.isError === true).toBe(false);
      expect((await stored(slug, FEDERATED)).page_readers).toEqual(['member:alice-example']);
      expect(await reads('bob', slug, canary, FEDERATED)).toEqual(none);
      expect(await reads('public', slug, canary, FEDERATED)).toEqual(none);
    }, 240_000);

    test('with default isolated the no-grant floor is default alone, so a federated write source is not stamped and stays unread', async () => {
      await engine.executeRaw(`UPDATE sources SET config = config || '{"federated": false}'::jsonb WHERE id = 'default'`);
      try {
        expect(await noGrantFederatedScope(engine, false, 'default')).toBeUndefined();
        const canary = marker('isodefault');
        const slug = 'notes/alice-isodefault-' + canary;
        expect((await call('alice-a', 'put_page', { slug, content: note('Alice isodefault', 'Alice isodefault code ' + canary + '.') })).isError).toBe(false);
        expect(await stored(slug, FEDERATED)).toMatchObject({ page_readers: null });
        expect(await reads('public', slug, canary, FEDERATED)).toEqual(none);
      } finally {
        await engine.executeRaw(`UPDATE sources SET config = config || '{"federated": true}'::jsonb WHERE id = 'default'`);
      }
    }, 240_000);

    test('a member-bound write is refused when the source config cannot be read, not published unstamped', async () => {
      const canary = marker('unreadable');
      const slug = 'notes/alice-unreadable-' + canary;
      const target = engine as unknown as { executeRaw: (this: BrainEngine, sql: string, ...rest: unknown[]) => Promise<unknown> };
      const original = Object.getPrototypeOf(engine).executeRaw as typeof target.executeRaw;
      let rejected = 0;
      target.executeRaw = function (sql, ...rest) {
        if (/^\s*SELECT id, config(, archived)? FROM sources\b/.test(sql)) { rejected++; return Promise.reject(new Error('sources unreadable (test fixture)')); }
        return original.call(this, sql, ...rest);
      };
      let put: Awaited<ReturnType<typeof call>>;
      try {
        put = await call('alice-a', 'put_page', { slug, content: note('Alice unreadable', 'Alice unreadable code ' + canary + '.'), request_id: randomUUID() });
      } finally {
        delete (target as Partial<typeof target>).executeRaw;
      }
      expect({ rejected: rejected > 0, isError: put.isError }).toEqual({ rejected: true, isError: true });
      expect(await stored(slug, FEDERATED)).toBeUndefined();
      expect(await reads('public', slug, canary, FEDERATED)).toEqual(none);
    }, 240_000);

    test('a streamed upload over the single-string ceiling into a federated source is kept to its member', async () => {
      await engine.executeRaw("INSERT INTO config (key, value) VALUES ('write_gate.agent_mode', 'off') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
      try {
        const canary = marker('upload');
        const slug = 'notes/alice-upload-' + canary;
        const filler = 'We agreed to ship the review checklist first and revisit pricing next week. '.repeat(64) + '\n\n';
        const text = '# Alice upload ' + canary + '\n\n' + filler.repeat(Math.ceil(25 * MiB / filler.length)) + 'Alice upload code ' + canary + '.';
        const begin = await call('alice-a', 'begin_page_upload', { slug, mode: 'create', total_bytes: Buffer.byteLength(text), sha256: sha(text), request_id: randomUUID() });
        expect(begin.isError).toBe(false);
        for (let part = 0, at = 0; at < text.length; part++, at += PART_CHARS) {
          const piece = text.slice(at, at + PART_CHARS);
          expect((await call('alice-a', 'upload_page_part', { upload_id: begin.json.upload_id, part, text: piece, part_sha256: sha(piece) })).isError).toBe(false);
        }
        let commit = await call('alice-a', 'commit_page_upload', { upload_id: begin.json.upload_id, wait_ms: 30_000 });
        for (let attempt = 0; commit.json.code === 'write_pending' && attempt < 40; attempt++) commit = await call('alice-a', 'commit_page_upload', { upload_id: begin.json.upload_id, wait_ms: 30_000 });
        expect({ isError: commit.isError, state: commit.json.state }).toEqual({ isError: false, state: 'committed' });
        const [row] = await engine.executeRaw<{ body_storage: string; page_readers: string[] | null }>(
          'SELECT body_storage, page_readers FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [FEDERATED, slug]);
        expect(row).toEqual({ body_storage: 'segmented', page_readers: ['member:alice-example'] });
        expect((await call('alice-a', 'list_pages', {})).text).toContain(slug);
        for (const who of ['bob', 'public']) {
          expect((await call(who, 'list_pages', {})).text).not.toContain(slug);
          expect((await call(who, 'get_page', { slug, source_id: FEDERATED })).json.code).toBe('page_not_found');
        }
      } finally {
        await engine.executeRaw("DELETE FROM config WHERE key = 'write_gate.agent_mode'");
      }
    }, 900_000);

    test('a member-bound write cannot leave the source its grant names', async () => {
      const canary = marker('wrong');
      const slug = 'notes/alice-wrong-' + canary;
      for (const target of ['default', ISOLATED]) {
        const out = await call('alice-a', 'put_page', { slug, source_id: target, content: note('Alice wrong', 'Alice wrong code ' + canary + '.'), request_id: randomUUID() });
        expect(out.isError).toBe(true);
        expect(await stored(slug, target)).toBeUndefined();
      }
      expect(await stored(slug, FEDERATED)).toBeUndefined();
    }, 240_000);

    test('POST /ingest refuses it and queues nothing; a non-federated grant still reaches the route', async () => {
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
        const refused = await ingest('alice-a', note('Alice ingest', 'Ingest ' + marker('ingest') + '.'));
        expect(refused.status).toBe(403);
        const body = await refused.json();
        expect(body).toMatchObject({ error: 'permission_denied', code: 'permission_denied', message: expect.stringContaining('write source is ' + FEDERATED),
          docs: 'docs/guides/multi-source-brains.md#lay-out-sources-by-who-may-read-them',
          fix: { actor: 'host_admin', next: 'tell_user_to_run', argv: ['gbrain', 'auth', 'rescope-token', '--id', tokenIds['alice-a'], '--sources', '<sources>'],
            inputs: [{ name: 'sources', how: expect.any(String) }] } });
        expect(typeof body.suggestion).toBe('string');
        const [after] = await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE name = 'ingest_capture'");
        expect(after.n).toBe(before.n);
        expect((await ingest('alice-b', note('Alice iso ingest', 'Ingest ' + marker('ingestiso') + '.'))).status).toBe(202);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 240_000);

    test('an ingest_capture job it queued earlier is refused at write time and stores nothing', async () => {
      const slug = 'notes/alice-queued-' + marker('queued');
      const writer = { principal: { kind: 'legacy_token', id: tokenIds['alice-a'] } };
      await expect(assertWebhookWriterMayReplace(engine, writer, FEDERATED, slug, note('Alice queued', 'Queued.')))
        .rejects.toMatchObject({ code: 'permission_denied', message: expect.stringContaining('write source is ' + FEDERATED) });
      expect(await stored(slug, FEDERATED)).toBeUndefined();
      expect(await assertWebhookWriterMayReplace(engine, { principal: { kind: 'legacy_token', id: tokenIds['alice-b'] } }, ISOLATED, slug, note('Alice queued', 'Queued.'))).toBeNull();
    }, 60_000);
  });
}
