/**
 * GST-1094 gap 4: owner administration of QM people over HTTP (serve-http-access.ts).
 *
 * 1. Protects: only an owner session sets a client's attest right and edits members and their canonical-id links
 *    remotely, every library refusal still applies (member-bound or public clients never attest, deferred ops never
 *    attest, links need an enabled member and never steal an id), a dry run writes nothing, and each applied change
 *    leaves an audit row.
 * 2. Fails when: a route answers without the owner session, an HTTP change skips a refusal the local CLI makes, a
 *    preview writes, or a change leaves no audit row.
 *    GST-1158: a declared member email is set only here and on the brain host, and a link made by email is the same link
 *    an id makes; no OAuth token, attested call or MCP operation reaches either.
 * 3. Real seams: the routes mounted on an Express app over a real socket, OAuth clients registered and issued tokens by
 *    the provider's client-credentials grant and verified by it, on a repo-less brain (PGLite, and Postgres when
 *    DATABASE_URL is set).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import cookieParser from 'cookie-parser';
import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { addMember, bindCredential, getMember } from '../src/core/access/members.ts';
import { listMemberLinks } from '../src/core/access/actor.ts';
import { mountAdminAccess } from '../src/commands/serve-http-access.ts';
import { createRequireAdmin } from '../src/commands/serve-http-admin-api.ts';
import { operations } from '../src/core/operations.ts';
import { readClientOpUsage } from '../src/core/mcp-usage.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

for (const kind of testBackends()) {
  describe('owner HTTP administration of QM people (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let server: Server;
    let base = '';
    const sessions = new Map<string, number>();
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const register = async (name: string, grantTypes: string[]) => (await provider().registerClientManual(name + '-' + randomUUID().slice(0, 8), grantTypes, 'read write', [], 'default'));
    async function call(method: 'GET' | 'POST', path: string, body?: unknown, owner = true) {
      const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(owner ? { Cookie: 'gbrain_admin=owner-session' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, json: await res.json() as Record<string, any> };
    }
    const audits = async () => (await engine.executeRaw<{ params: Record<string, unknown> | string }>("SELECT params FROM mcp_request_log WHERE operation = 'access_admin' ORDER BY id"))
      .map(r => typeof r.params === 'string' ? JSON.parse(r.params) : r.params);

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      sessions.set('owner-session', Date.now() + 3_600_000);
      const app = express();
      app.use(cookieParser());
      mountAdminAccess(app, createRequireAdmin(sessions), engine);
      server = app.listen(0, '127.0.0.1');
      await new Promise<void>(r => server.once('listening', () => r()));
      base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
    }, 120_000);
    afterAll(async () => {
      server?.closeAllConnections(); await new Promise<void>(r => server ? server.close(() => r()) : r());
      await close?.();
    });

    test('every route refuses a request without the owner session and changes nothing', async () => {
      const qm = await register('qm-unauth', ['client_credentials']);
      const routes: Array<['GET' | 'POST', string, unknown?]> = [
        ['GET', '/admin/api/access/members'], ['POST', '/admin/api/access/members', { action: 'add', id: 'mallory-example' }],
        ['GET', '/admin/api/access/member-links'], ['POST', '/admin/api/access/member-links', { action: 'link', member: 'mallory-example', externalId: 'ext-mallory' }],
        ['POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: 'qm' }],
      ];
      for (const [method, path, body] of routes) expect((await call(method, path, body, false)).status).toBe(401);
      expect(await getMember(engine, 'mallory-example')).toBeNull();
      const [row] = await engine.executeRaw<{ attest_actor: string | null }>('SELECT attest_actor FROM oauth_clients WHERE client_id = $1', [qm.clientId]);
      expect(row!.attest_actor).toBeNull();
      expect(await audits()).toEqual([]);
    });

    test('members: add, disable and enable apply with an audit row; a second add and a bad id are refused', async () => {
      const added = await call('POST', '/admin/api/access/members', { action: 'add', id: 'alice-example', name: 'Alice Example', groups: ['team-a'] });
      expect(added.status).toBe(200);
      expect(added.json).toMatchObject({ applied: true, member: { id: 'alice-example', status: 'enabled' }, groups_created: ['team-a'] });
      expect((await call('POST', '/admin/api/access/members', { action: 'add', id: 'alice-example' })).json).toMatchObject({ code: 'access_member_invalid', outcome: 'failed' });
      expect((await call('POST', '/admin/api/access/members', { action: 'add', id: 'Not An Id' })).status).toBe(400);
      expect((await call('POST', '/admin/api/access/members', { action: 'remove', id: 'alice-example' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/access/members', { action: 'disable', id: 'alice-example' })).json.member.status).toBe('disabled');
      expect((await call('POST', '/admin/api/access/members', { action: 'enable', id: 'alice-example' })).json.member.status).toBe('enabled');
      const listed = await call('GET', '/admin/api/access/members');
      expect(listed.json.members.map((m: { id: string }) => m.id)).toContain('alice-example');
      expect((await audits()).map(a => a.action)).toEqual(['member_add', 'member_disable', 'member_enable']);
    });

    test('links: a dry run writes nothing; link and unlink apply; a disabled member or a taken id is refused', async () => {
      await addMember(engine, 'bob-example');
      const preview = await call('POST', '/admin/api/access/member-links', { action: 'link', member: 'bob-example', externalId: 'ext-bob', dryRun: true });
      expect(preview.json).toMatchObject({ applied: false, link: { member_id: 'bob-example', external_id: 'ext-bob' } });
      expect(await listMemberLinks(engine, { member: 'bob-example' })).toEqual([]);
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', member: 'bob-example', externalId: 'ext-bob' })).json.applied).toBe(true);
      expect((await call('GET', '/admin/api/access/member-links?member=bob-example')).json.links).toMatchObject([{ system: 'qm', external_id: 'ext-bob', member_id: 'bob-example' }]);
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', member: 'alice-example', externalId: 'ext-bob' })).json).toMatchObject({ code: 'access_member_invalid', reason: 'link_exists' });
      await call('POST', '/admin/api/access/members', { action: 'disable', id: 'alice-example' });
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', member: 'alice-example', externalId: 'ext-alice' })).status).toBe(400);
      await call('POST', '/admin/api/access/members', { action: 'enable', id: 'alice-example' });
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', member: 'bob-example', externalId: 'has space' })).json.reason).toBe('invalid_external_id');
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', member: 'bob-example', externalId: 'ext-x', system: 'other' })).json.code).toBe('invalid_params');
      expect((await call('POST', '/admin/api/access/member-links', { action: 'unlink', externalId: 'ext-bob', dryRun: true })).json.applied).toBe(false);
      expect(await listMemberLinks(engine, { member: 'bob-example' })).toHaveLength(1);
      expect((await call('POST', '/admin/api/access/member-links', { action: 'unlink', externalId: 'ext-bob' })).json.applied).toBe(true);
      expect(await listMemberLinks(engine, { member: 'bob-example' })).toEqual([]);
      expect((await audits()).filter(a => String(a.action).startsWith('member_link') || a.action === 'member_unlink'))
        .toEqual([{ actor: 'admin-api', action: 'member_link', system: 'qm', external_id: 'ext-bob', member: 'bob-example' }, { actor: 'admin-api', action: 'member_unlink', system: 'qm', external_id: 'ext-bob', member: 'bob-example' }]);
    });

    test('GST-1158: email on member add and set, and link by email, apply with audit rows; refusals hold; nothing changes without the owner session', async () => {
      const qm = await register('qm-email', ['client_credentials']);
      await bindCredential(engine, { kind: 'client', id: qm.clientId }, { attestActor: 'qm' });
      const bearer = (await provider().exchangeClientCredentials(qm.clientId, qm.clientSecret!)).access_token;
      const outsider = async (path: string, body: unknown) => (await fetch(base + path, { method: 'POST', body: JSON.stringify(body),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer, 'x-qm-actor': 'ext-carol' } })).status;
      const before = (await audits()).length;
      expect(await outsider('/admin/api/access/members', { action: 'add', id: 'carol-example', email: 'carol@example.com' })).toBe(401);
      expect(await outsider('/admin/api/access/members', { action: 'set', id: 'bob-example', email: 'carol@example.com' })).toBe(401);
      expect(await outsider('/admin/api/access/member-links', { action: 'link', email: 'carol@example.com', externalId: 'ext-carol' })).toBe(401);
      expect((await call('POST', '/admin/api/access/members', { action: 'set', id: 'bob-example', email: 'carol@example.com' }, false)).status).toBe(401);
      expect(await getMember(engine, 'carol-example')).toBeNull();
      expect((await getMember(engine, 'bob-example'))!.email).toBeNull();
      expect((await audits()).length).toBe(before);
      for (const op of operations) expect(Object.keys(op.params)).not.toContain('email');

      const added = await call('POST', '/admin/api/access/members', { action: 'add', id: 'carol-example', email: 'Carol@Example.com' });
      expect(added.json).toMatchObject({ applied: true, member: { id: 'carol-example', email: 'carol@example.com' } });
      expect((await call('POST', '/admin/api/access/members', { action: 'add', id: 'dave-example', email: 'CAROL@example.com' })).json).toMatchObject({ code: 'access_member_invalid', reason: 'email_taken' });
      expect((await call('POST', '/admin/api/access/members', { action: 'add', id: 'dave-example', email: 'no-at-sign' })).json).toMatchObject({ code: 'access_member_invalid', reason: 'invalid_email' });
      expect((await call('POST', '/admin/api/access/members', { action: 'add', id: 'dave-example', email: 7 })).json).toMatchObject({ code: 'invalid_params' });
      expect(await getMember(engine, 'dave-example')).toBeNull();
      expect((await call('POST', '/admin/api/access/members', { action: 'set', id: 'bob-example' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/access/members', { action: 'set', id: 'bob-example', email: 'Bob@Example.com' })).json).toMatchObject({ applied: true, changed: true, member: { id: 'bob-example', email: 'bob@example.com' } });
      expect((await call('POST', '/admin/api/access/members', { action: 'set', id: 'bob-example', email: 'carol@example.com' })).json).toMatchObject({ code: 'access_member_invalid', reason: 'email_taken' });
      expect((await call('POST', '/admin/api/access/members', { action: 'set', id: 'bob-example', email: null })).json).toMatchObject({ applied: true, member: { email: null } });
      expect((await call('GET', '/admin/api/access/members')).json.members.find((m: { id: string }) => m.id === 'carol-example')).toMatchObject({ email: 'carol@example.com' });

      const preview = await call('POST', '/admin/api/access/member-links', { action: 'link', email: 'CAROL@example.com', externalId: 'ext-carol', dryRun: true });
      expect(preview.json).toMatchObject({ applied: false, link: { member_id: 'carol-example', external_id: 'ext-carol' } });
      expect(await listMemberLinks(engine, { member: 'carol-example' })).toEqual([]);
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', email: 'carol@example.com', member: 'carol-example', externalId: 'ext-carol' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', email: 'nobody@example.com', externalId: 'ext-nobody' })).json).toMatchObject({ code: 'not_found', outcome: 'failed' });
      expect(await getMember(engine, 'nobody-example')).toBeNull();
      expect((await call('POST', '/admin/api/access/member-links', { action: 'link', email: 'carol@example.com', externalId: 'ext-carol' })).json).toMatchObject({ applied: true, link: { member_id: 'carol-example' } });
      expect(await listMemberLinks(engine, { member: 'carol-example' })).toMatchObject([{ system: 'qm', external_id: 'ext-carol', member_id: 'carol-example' }]);
      expect((await call('POST', '/admin/api/access/member-links', { action: 'unlink', email: 'carol@example.com', externalId: 'ext-carol' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await audits()).slice(before)).toEqual([
        { actor: 'admin-api', action: 'member_add', member: 'carol-example', groups_created: [] },
        { actor: 'admin-api', action: 'member_set', member: 'bob-example', email: 'declared' },
        { actor: 'admin-api', action: 'member_set', member: 'bob-example', email: 'cleared' },
        { actor: 'admin-api', action: 'member_link', system: 'qm', external_id: 'ext-carol', member: 'carol-example' },
      ]);
    });

    test('attest: a confidential client-credentials client gets the right its next token carries; every CLI refusal holds', async () => {
      const qm = await register('qm-http', ['client_credentials']);
      const preview = await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: 'qm', dryRun: true });
      expect(preview.json).toMatchObject({ applied: false, changed: true, attest_actor: 'qm' });
      const [before] = await engine.executeRaw<{ attest_actor: string | null }>('SELECT attest_actor FROM oauth_clients WHERE client_id = $1', [qm.clientId]);
      expect(before!.attest_actor).toBeNull();
      const applied = await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: 'qm', attestOps: ['memory_recall', 'memory_write', 'get_write_request'] });
      expect(applied.json).toMatchObject({ applied: true, attest_actor: 'qm', attest_ops: ['get_write_request', 'memory_recall', 'memory_write'] });
      const token = (await provider().exchangeClientCredentials(qm.clientId, qm.clientSecret!)).access_token;
      const auth = await provider().verifyAccessToken(token) as unknown as { attest?: { system: string; ops: string[]; sources: string[] | null } | null };
      expect(auth.attest).toEqual({ system: 'qm', ops: ['get_write_request', 'memory_recall', 'memory_write'], sources: null });

      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestOps: ['capture'] })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestOps: ['admin_only_op_example'] })).json).toMatchObject({ code: 'invalid_params' });
      const bound = await register('member-bound', ['client_credentials']);
      await bindCredential(engine, { kind: 'client', id: bound.clientId }, { member: 'bob-example' });
      expect((await call('POST', '/admin/api/access/attest', { clientId: bound.clientId, attestActor: 'qm' })).json).toMatchObject({ code: 'invalid_params' });
      const pub = await register('public-pkce', ['authorization_code', 'refresh_token']);
      expect((await call('POST', '/admin/api/access/attest', { clientId: pub.clientId, attestActor: 'qm' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/access/attest', { clientId: 'no-such-client', attestActor: 'qm' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: 'other' })).status).toBe(400);
      for (const id of [bound.clientId, pub.clientId]) {
        const [row] = await engine.executeRaw<{ attest_actor: string | null }>('SELECT attest_actor FROM oauth_clients WHERE client_id = $1', [id]);
        expect(row!.attest_actor).toBeNull();
      }

      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: null })).json).toMatchObject({ applied: true, attest_actor: null });
      const cleared = await provider().verifyAccessToken((await provider().exchangeClientCredentials(qm.clientId, qm.clientSecret!)).access_token) as unknown as { attest?: unknown };
      expect(cleared.attest ?? null).toBeNull();
      expect((await audits()).filter(a => a.action === 'client_attest').map(a => [a.client_id, a.attest_actor]))
        .toEqual([[qm.clientId, 'qm'], [qm.clientId, null]]);
    });

    test('GST-1113: clearing the attest right over HTTP clears attest_sources too, as auth rescope does', async () => {
      const scope = 'scope-http-' + randomUUID().slice(0, 8);
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [scope]);
      const qm = await register('qm-scope', ['client_credentials']);
      await bindCredential(engine, { kind: 'client', id: qm.clientId }, { attestActor: 'qm', attestOps: ['get_write_request', 'memory_recall', 'memory_write'], attestSources: [scope] });
      const row = async () => (await engine.executeRaw<Record<string, unknown>>('SELECT attest_actor, attest_ops, attest_sources FROM oauth_clients WHERE client_id = $1', [qm.clientId]))[0];
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: null, dryRun: true })).json).toMatchObject({ applied: false, changed: true });
      expect(await row()).toMatchObject({ attest_actor: 'qm', attest_sources: [scope] });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: null })).json).toMatchObject({ applied: true, attest_actor: null });
      expect(await row()).toEqual({ attest_actor: null, attest_ops: null, attest_sources: null });
    });

    test('GST-2407: attestRead sets how named sources read over HTTP, as auth rescope --attest-read does; every CLI refusal holds', async () => {
      const scope = 'scope-read-http-' + randomUUID().slice(0, 8);
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [scope]);
      const qm = await register('qm-read', ['client_credentials']);
      const row = async () => (await engine.executeRaw<Record<string, unknown>>('SELECT attest_actor, attest_read FROM oauth_clients WHERE client_id = $1', [qm.clientId]))[0];
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestRead: 'person' })).json).toMatchObject({ code: 'invalid_params' });
      expect(await row()).toEqual({ attest_actor: null, attest_read: null });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: 'qm', attestRead: 'person', dryRun: true })).json)
        .toMatchObject({ applied: false, changed: true, attest_actor: 'qm', attest_read: 'person' });
      expect(await row()).toEqual({ attest_actor: null, attest_read: null });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestActor: 'qm', attestRead: 'person' })).json).toMatchObject({ applied: true, attest_read: 'person' });
      expect(await row()).toEqual({ attest_actor: 'qm', attest_read: 'person' });
      const auth = await provider().verifyAccessToken((await provider().exchangeClientCredentials(qm.clientId, qm.clientSecret!)).access_token) as unknown as { attest?: { read?: string } };
      expect(auth.attest?.read).toBe('person');
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestRead: 'scope' })).json).toMatchObject({ applied: true, attest_read: 'scope' });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestRead: 'room' })).status).toBe(400);
      await bindCredential(engine, { kind: 'client', id: qm.clientId }, { attestSources: [scope] });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestRead: 'person' })).json).toMatchObject({ code: 'invalid_params' });
      expect((await call('POST', '/admin/api/access/attest', { clientId: qm.clientId, attestRead: null })).json).toMatchObject({ applied: true, attest_read: null });
      expect(await row()).toEqual({ attest_actor: 'qm', attest_read: null });
      expect((await audits()).filter(a => a.action === 'client_attest' && a.client_id === qm.clientId).map(a => a.attest_read)).toEqual(['person', 'scope', null]);
    });

    test('the audit rows an applied change writes are never read as client usage', async () => {
      expect((await call('POST', '/admin/api/access/members', { action: 'add', id: 'usage-example' })).json).toMatchObject({ applied: true });
      expect((await audits()).some(a => a.action === 'member_add' && a.member === 'usage-example')).toBe(true);
      expect((await readClientOpUsage(engine)).map(u => u.token_name)).not.toContain('admin-api');
    });
  });
}
