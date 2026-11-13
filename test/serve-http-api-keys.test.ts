/**
 * Owner-dashboard API keys (`/admin/api/api-keys`, Lane E P0).
 *
 * Protects: a dashboard mint goes through mintLegacyToken with explicit scopes
 * (default read,write; admin only on request) and the unified grant columns;
 * the minted key is refused an op outside its scopes on the real /mcp path;
 * unknown scopes, sources and holders are refused with invalid_params naming
 * the valid values; the response reports the defaults it applied; revoke is
 * by id and leaves a same-name sibling active; the list returns ids and
 * scopes; doctor counts NULL-scope (grandfathered full-access) tokens with a
 * per-token rescope command.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { mountAdminApiKeys } from '../src/commands/serve-http-api-keys.ts';
import { legacyTokenGrantsEntry } from '../src/commands/doctor/checks/legacy-token-grants.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { generateToken, hashToken } from '../src/core/utils.ts';

let engine: PGLiteEngine;
let server: Server;
let base: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('team-a','team-a') ON CONFLICT DO NOTHING");
  await engine.putPage('notes/keys', { type: 'note', title: 'Keys', compiled_truth: 'api-key-marker prose', timeline: '', frontmatter: {} }, { sourceId: 'default' });
  const app = express();
  mountAdminApiKeys(app, (_req, _res, next) => next(), engine);
  server = app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>(r => server.close(() => r()));
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
};
const rowOf = async (id: string) => (await engine.executeRaw<Record<string, unknown>>('SELECT * FROM access_tokens WHERE id = $1::uuid', [id]))[0];

async function doctor() {
  const checks = await legacyTokenGrantsEntry.run({ engine } as unknown as DoctorContext);
  if (!Array.isArray(checks)) throw new Error('doctor entry stopped');
  return Object.fromEntries(checks.map(c => [c.name, c]));
}

async function callMcp(token: string, name: string, args: Record<string, unknown>) {
  const mcp = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
    ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }), token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }) } });
  try {
    const response = await fetch(`http://127.0.0.1:${mcp.port}/mcp`, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json() as { result: { isError?: boolean; content: Array<{ text: string }> } };
    return body.result;
  } finally { mcp.stop?.(true); }
}

describe('dashboard mint', () => {
  test('defaults to read,write (never admin), lands on the unified columns and reports the defaults it applied', async () => {
    const { status, body } = await post('/admin/api/api-keys', { name: 'dash-default' });
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: 'dash-default', scopes_applied: ['read', 'write'], sources_applied: 'default',
      takes_holders_applied: ['world'], defaults_applied: ['scopes', 'sources', 'takes_holders'] });
    expect(body.token).toStartWith('gbrain_');
    const row = await rowOf(body.id);
    expect(row.scopes).toEqual(['read', 'write']);
    expect(row).toMatchObject({ source_grant: 'default', takes_holders: ['world'], grant_revision: 1 });
  });

  test('a dashboard-minted key carries the requested scopes and is refused an op outside them', async () => {
    const { body } = await post('/admin/api/api-keys', { name: 'dash-reader', scopes: ['read'] });
    expect(body.scopes_applied).toEqual(['read']);
    expect(body.defaults_applied).toEqual(['sources', 'takes_holders']);
    const read = await callMcp(body.token, 'get_page', { slug: 'notes/keys' });
    expect(read.isError).toBeFalsy();
    for (const [op, args] of [['put_page', { slug: 'notes/keys-2', content: 'x' }], ['get_stats', {}]] as const) {
      const denied = await callMcp(body.token, op, { ...args });
      expect(denied.isError).toBe(true);
      expect(JSON.parse(denied.content[0].text)).toMatchObject({ code: 'insufficient_scope' });
    }
  }, 120_000);

  test('admin is minted only when requested explicitly', async () => {
    const { body } = await post('/admin/api/api-keys', { name: 'dash-admin', scopes: ['read', 'write', 'admin'] });
    expect(body.scopes_applied).toEqual(['read', 'write', 'admin']);
    expect((await rowOf(body.id)).scopes).toEqual(['read', 'write', 'admin']);
  });

  test('sources and takes holders are validated and stored', async () => {
    const { status, body } = await post('/admin/api/api-keys', { name: 'dash-team', sources: ['team-a', 'default'], takes_holders: ['world', 'people/alice-example'] });
    expect(status).toBe(200);
    expect(body).toMatchObject({ sources_applied: ['team-a', 'default'], takes_holders_applied: ['world', 'people/alice-example'], defaults_applied: ['scopes'] });
    expect(await rowOf(body.id)).toMatchObject({ source_grant: 'federated', source_id: 'team-a', federated_read: ['team-a', 'default'], takes_holders: ['world', 'people/alice-example'] });
  });

  test('refuses unknown scopes, sources, holders and bad names with invalid_params and a fix', async () => {
    const before = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_tokens'))[0].n;
    const scope = await post('/admin/api/api-keys', { name: 'dash-typo', scopes: ['read', 'wrtie'] });
    expect(scope.status).toBe(400);
    expect(scope.body).toMatchObject({ code: 'invalid_params', reason: 'api_key_request_invalid', contract_version: 1 });
    expect(scope.body.message).toContain('"wrtie"');
    expect(scope.body.message).toContain('read, ');
    expect(scope.body.why).toBeTruthy();
    expect(scope.body.fix.argv).toEqual(['gbrain', 'auth', 'create', 'dash-typo', '--scopes', 'read,write']);
    for (const bad of [{ name: 'dash-x', scopes: [] }, { name: 'dash-x', sources: ['nope'] }, { name: 'dash-x', sources: ['../x'] },
      { name: 'dash-x', takes_holders: ['Not A Holder'] }, { name: '' }, { name: 'x'.repeat(129) }, { name: 'dash-x', scopes: 7 }]) {
      const res = await post('/admin/api/api-keys', bad);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_params');
      expect(res.body.fix?.argv?.length).toBeGreaterThan(0);
    }
    const after = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_tokens'))[0].n;
    expect(after).toBe(before);
  });
});

describe('dashboard list and revoke', () => {
  test('two keys sharing a name: revoke one by id, the sibling keeps working', async () => {
    const a = (await post('/admin/api/api-keys', { name: 'dash-twin' })).body;
    const b = (await post('/admin/api/api-keys', { name: 'dash-twin' })).body;
    const byName = await post('/admin/api/api-keys/revoke', { name: 'dash-twin' });
    expect(byName.status).toBe(400);
    expect(byName.body.code).toBe('invalid_params');
    expect((await rowOf(a.id)).revoked_at).toBeNull();
    const revoked = await post('/admin/api/api-keys/revoke', { id: a.id });
    expect(revoked.body).toEqual({ id: a.id, revoked: true });
    expect((await rowOf(a.id)).revoked_at).not.toBeNull();
    expect((await rowOf(b.id)).revoked_at).toBeNull();
    expect((await post('/admin/api/api-keys/revoke', { id: a.id })).body.revoked).toBe(false);
    const list = await (await fetch(`${base}/admin/api/api-keys`)).json() as any[];
    expect(list.find(k => k.id === a.id)).toMatchObject({ name: 'dash-twin', status: 'revoked', scopes: ['read', 'write'] });
    expect(list.find(k => k.id === b.id)).toMatchObject({ name: 'dash-twin', status: 'active', scopes: ['read', 'write'], sources: 'default', takes_holders: ['world'], scopes_grandfathered: false });
    expect(JSON.stringify(list)).not.toContain(a.token);
  });
});

describe('doctor legacy_token_null_scope', () => {
  test('counts NULL-scope tokens with a per-token rescope command and an ask-first fix', async () => {
    const name = 'pre-fix-dashboard-key';
    const [legacy] = await engine.executeRaw<{ id: string }>('INSERT INTO access_tokens (name, token_hash) VALUES ($1, $2) RETURNING id', [name, hashToken(generateToken('gbrain_'))]);
    const check = (await doctor()).legacy_token_null_scope;
    expect(check.status).toBe('warn');
    const tokens = check.details?.tokens as Array<{ id: string; name: string; argv: string[] }>;
    expect(tokens).toContainEqual({ id: legacy.id, name, argv: ['gbrain', 'auth', 'rescope', '--id', legacy.id, '--scopes', 'read,write'] });
    expect(check.fix).toMatchObject({ consent: ['credentials'], actor: 'agent' });
    expect((check.fix as { user_message?: string }).user_message).toContain('full read, write and admin');
    await engine.executeRaw("UPDATE access_tokens SET scopes = '{read,write}' WHERE id = $1::uuid", [legacy.id]);
    const after = (await doctor()).legacy_token_null_scope;
    expect(after.status).toBe('ok');
    expect(after.details?.null_scope_count).toBe(0);
  });
});

describe('a brain that serves several people (GST-363)', () => {
  test('the dashboard refuses to mint a key bound to nobody, like auth create: credential_scope_required, nothing created', async () => {
    const { addMember, disableMember } = await import('../src/core/access/members.ts');
    const ids = ['alice-example', 'bob-example'];
    for (const id of ids) await addMember(engine, id);
    try {
      const before = (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_tokens'))[0]!.n;
      const { status, body } = await post('/admin/api/api-keys', { name: 'dash-unbound' });
      expect(status).toBe(400);
      expect(JSON.stringify(body)).toContain('credential_scope_required');
      expect(body.token).toBeUndefined();
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM access_tokens'))[0]!.n).toBe(before);
    } finally {
      for (const id of ids) await disableMember(engine, id);
    }
    expect((await post('/admin/api/api-keys', { name: 'dash-after-members' })).status).toBe(200);
  });
});
