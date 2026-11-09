/**
 * GST-2059 x GST-2051: the brain owner's credential bound with no source grant writes to `default` like any member, but
 * its new pages are meant for the whole brain, so the GST-2051 new-page stamp (readable_by: [member:<id>]) skips it.
 * 1. Protects: an owner-token create in default stays shared (no readable_by, other members read it); a non-owner
 *    member's create is still stamped; an owner rewrite of another member's restricted page with no readable_by keeps
 *    the stored readers (the carry still runs for the owner); POST /ingest still refuses the owner, because the
 *    capture job writes without the readers carry and could strip readable_by from a page the owner may read.
 * 2. Fails when: the owner's new page is stamped, a non-owner's is not, or the owner's rewrite drops stored readers.
 * 3. Real seams: tokens minted by the token service and bound with SQL, verified by the serve --http verifier,
 *    dispatched through MCP dispatch with remote=true; the durable write path of a repo-less brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { mountWebhooks } from '../src/commands/serve-http-webhooks.ts';
import type { ServeHttpContext } from '../src/commands/serve-http.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { defaultSourceWriterIsOwner } from '../src/core/persistence/page-visibility.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const marker = (tag: string) => 'ownerdefault' + tag + randomUUID().slice(0, 8);
const note = (title: string, body: string, readers = '') =>
  ['---', 'type: note', 'title: ' + title, ...(readers ? ['readable_by: ' + readers] : []), '---', '# ' + title, '', body].join('\n');

for (const kind of testBackends()) {
  describe('owner writes to default (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const tokens: Record<string, string> = {};
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

    async function call(who: string, op: string, params: Record<string, unknown>) {
      const auth = await provider().verifyAccessToken(tokens[who]) as unknown as AuthInfo;
      const out = await dispatchToolCall(engine, op, { ...params }, { remote: true, transport: 'http', auth, sourceId: auth.sourceId ?? 'default', takesHoldersAllowList: ['world'] });
      return { isError: out.isError === true, text: out.content.map(c => c.text).join('\n') };
    }
    async function readers(slug: string) {
      const [row] = await engine.executeRaw<{ frontmatter: Record<string, unknown>; page_readers: string[] | null }>(
        "SELECT frontmatter, page_readers FROM pages WHERE source_id='default' AND slug=$1 AND deleted_at IS NULL", [slug]);
      return { readable_by: row.frontmatter.readable_by, page_readers: row.page_readers };
    }
    async function revision(slug: string): Promise<string> {
      const out = await dispatchToolCall(engine, 'get_page', { slug, include_content: true }, { remote: false, sourceId: 'default' });
      return (JSON.parse(out.content.map(c => c.text).join('\n')) as { revision: string }).revision;
    }

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      for (const id of ['owner-example', 'alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
      await setOwner(engine, 'owner-example');
      for (const [name, member] of [['owner', 'owner-example'], ['alice', 'alice-example'], ['bob', 'bob-example']] as const) {
        const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'] });
        tokens[name] = minted.token;
        await engine.executeRaw('UPDATE access_tokens SET member_id = $2 WHERE id = $1::uuid', [minted.id, member]);
      }
    }, 240_000);
    afterAll(async () => { await close?.(); }, 60_000);

    test('an owner-token create in default stays shared, and another member reads it', async () => {
      const canary = marker('new');
      const slug = 'notes/owner-note-' + canary;
      expect((await call('owner', 'put_page', { slug, content: note('Owner note', 'Owner code ' + canary + '.'), request_id: randomUUID() })).isError).toBe(false);
      expect(await readers(slug)).toEqual({ readable_by: undefined, page_readers: null });
      expect((await call('bob', 'get_page', { slug })).text).toContain(canary + '.');
    }, 240_000);

    test('a non-owner member create in default is still kept to its member', async () => {
      const canary = marker('member');
      const slug = 'notes/alice-note-' + canary;
      expect((await call('alice', 'put_page', { slug, content: note('Alice note', 'Alice code ' + canary + '.'), request_id: randomUUID() })).isError).toBe(false);
      expect(await readers(slug)).toEqual({ readable_by: ['member:alice-example'], page_readers: ['member:alice-example'] });
      expect((await call('bob', 'get_page', { slug })).text).not.toContain(canary + '.');
    }, 240_000);

    test('an owner rewrite of a member page with no readable_by keeps the stored readers', async () => {
      const canary = marker('carry');
      const slug = 'notes/alice-shared-with-owner-' + canary;
      expect((await call('alice', 'put_page', { slug, content: note('Alice and owner', 'First ' + canary + '.', '[alice-example, owner-example]'), request_id: randomUUID() })).isError).toBe(false);
      const rewrite = await call('owner', 'put_page', { slug, content: note('Alice and owner', 'Second ' + canary + '.'), expected_revision: await revision(slug) });
      expect(rewrite.isError).toBe(false);
      expect((await readers(slug)).page_readers?.slice().sort()).toEqual(['member:alice-example', 'member:owner-example']);
      expect((await call('bob', 'get_page', { slug })).text).not.toContain(canary + '.');
    }, 240_000);

    test('POST /ingest still refuses the owner, whose capture job would not keep a stored page\'s readers, and other members', async () => {
      const app = express();
      const pass: express.RequestHandler = (_req, _res, next) => next();
      mountWebhooks(app, { engine, resourceVerifier: provider(), resourceMetadataUrl: 'http://127.0.0.1/.well-known/oauth-protected-resource',
        ingestRateLimiter: pass, githubWebhookLimiter: pass, broadcastEvent: () => {} } as unknown as ServeHttpContext);
      const server = await new Promise<Server>(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      try {
        const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
        const ingest = (who: string, body: string) => fetch(base + '/ingest', { method: 'POST', body,
          headers: { authorization: 'Bearer ' + tokens[who], 'content-type': 'text/markdown' } });
        expect((await ingest('owner', note('Owner ingest', 'Ingest ' + marker('owneringest') + '.'))).status).toBe(403);
        expect((await ingest('alice', note('Alice ingest', 'Ingest ' + marker('aliceingest') + '.'))).status).toBe(403);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 240_000);

    test('only the enabled owner member counts: a disabled owner or another member keeps the stamp', async () => {
      expect(await defaultSourceWriterIsOwner(engine, 'member:owner-example')).toBe(true);
      expect(await defaultSourceWriterIsOwner(engine, 'member:alice-example')).toBe(false);
      expect(await defaultSourceWriterIsOwner(engine, null)).toBe(false);
      await engine.executeRaw('UPDATE access_members SET disabled_at = now() WHERE id = $1', ['owner-example']);
      try {
        expect(await defaultSourceWriterIsOwner(engine, 'member:owner-example')).toBe(false);
      } finally {
        await engine.executeRaw('UPDATE access_members SET disabled_at = NULL WHERE id = $1', ['owner-example']);
      }
    }, 240_000);
  });
}
