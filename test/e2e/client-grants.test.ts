/** Actual Postgres + HTTP proof of canonical grant previews, CAS and stable
 * OAuth credentials. No model providers or production brain are opened. */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { GBrainOAuthProvider } from '../../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../../src/core/sql-query.ts';
import { readClientGrant, rescopeClientGrant, resolveGrantProfile } from '../../src/core/grants/service.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const port = 19937;
const base = `http://127.0.0.1:${port}`;
suite('client capability grants — Postgres and admin HTTP', () => {
  let engine: PostgresEngine; let home: string; let server: ChildProcess | undefined; let cookie = '';
  const clients: string[] = []; const jobs: number[] = []; const sources: string[] = [];
  const adminToken = 'grant-admin-test-' + randomUUID().replaceAll('-', '');
  beforeAll(async () => {
    assertSafeE2eDatabaseUrl(databaseUrl!);
    engine = new PostgresEngine(); await engine.connect({ database_url: databaseUrl!, poolSize: 8 }); await engine.initSchema();
    home = mkdtempSync(join(tmpdir(), 'gbrain-grant-http-'));
    writeFileSync(join(home, 'config.json'), JSON.stringify({ engine: 'postgres', database_url: databaseUrl, embedding: { disabled: true } }), { mode: 0o600 });
    const env = keylessBrainEnv(process.env, home, { DATABASE_URL: databaseUrl, GBRAIN_DATABASE_URL: databaseUrl, GBRAIN_ADMIN_BOOTSTRAP_TOKEN: adminToken,
      GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_REMOTE_TOKEN: undefined, GBRAIN_BRAIN_ID: undefined, GBRAIN_MCP_URL: undefined });
    server = spawn('bun', ['--no-env-file', 'run', resolve('src/cli.ts'), 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', base], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; server.stderr?.on('data', data => { stderr = (stderr + String(data)).slice(-3000); });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try { if ((await fetch(base + '/health')).ok) { ready = true; break; } } catch { /* startup */ }
      await Bun.sleep(250);
    }
    if (!ready) throw new Error('Grant HTTP server did not start: ' + stderr.replaceAll(adminToken, '[redacted]'));
    const login = await fetch(base + '/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) });
    expect(login.status).toBe(200); cookie = login.headers.get('set-cookie')!.split(';')[0];
  }, 60_000);
  afterAll(async () => {
    if (server && server.exitCode === null) {
      const exited = new Promise<void>(done => server!.once('exit', () => done())); server.kill('SIGTERM');
      await Promise.race([exited, Bun.sleep(5000)]); if (server.exitCode === null) { server.kill('SIGKILL'); await exited; }
    }
    if (engine) {
      for (const id of jobs) await engine.executeRaw('DELETE FROM minion_jobs WHERE id = $1', [id]);
      for (const id of clients) { await engine.executeRaw('DELETE FROM oauth_grant_audit WHERE client_id = $1', [id]); await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id = $1', [id]); }
      for (const id of sources) await engine.executeRaw('DELETE FROM sources WHERE id = $1', [id]);
      await engine.disconnect();
    }
    if (home) rmSync(home, { recursive: true, force: true });
  }, 15_000);
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });

  test('concurrent CAS accepts one edit and atomically freezes finite legacy job bounds', async () => {
    const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
    const client = await provider.registerClientManual('cas-pg-' + randomUUID(), ['client_credentials'], 'read write agent', [], 'default', undefined, undefined, undefined,
      { ...resolveGrantProfile({ profile: 'delegating-agent', sourceId: 'default', boundTools: ['search'] }), budgetUsdPerDay: '3.00', boundMaxConcurrent: 2 });
    clients.push(client.clientId);
    const data = JSON.stringify({ __owner_client_id: client.clientId, source_id: 'default', allowed_tools: ['search'] });
    const [job] = await engine.executeRaw("INSERT INTO minion_jobs (name, status, data) VALUES ('subagent', 'waiting', $1::text::jsonb) RETURNING id", [data]); jobs.push(Number(job.id));
    const attempts = await Promise.allSettled([1, 2].map(() => rescopeClientGrant(engine, client.clientId, { budgetUsdPerDay: null, boundMaxConcurrent: 8 }, { actor: 'pg-test', expectedRevision: 1 })));
    expect(attempts.filter(a => a.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(a => a.status === 'rejected')).toHaveLength(1);
    const [row] = await engine.executeRaw('SELECT data FROM minion_jobs WHERE id = $1', [job.id]);
    expect((row.data as any).__delegation_grant.budgetUsdPerDay).toBe('3.00');
    expect((row.data as any).__delegation_grant.maxConcurrent).toBe(2);
    expect((row.data as any).__delegation_grant.tools).toEqual(['search']);
    expect(await engine.executeRaw('SELECT id FROM oauth_grant_audit WHERE client_id = $1', [client.clientId])).toHaveLength(2);
  });

  test('admin preview/create/edit keeps secret stable, denies stale forms and validates TTL', async () => {
    const name = 'admin-preview-' + randomUUID();
    const request = { name, profile: 'memory-writer', sourceId: 'default' };
    const preview = await post('/admin/api/register-client', { ...request, dryRun: true }); expect(preview.status).toBe(200);
    const previewBody = await preview.json() as any; expect(previewBody.after.tokenTtlSeconds).toBe(3600); expect(previewBody.after.budgetUsdPerDay).toBeNull();
    expect(await engine.executeRaw('SELECT client_id FROM oauth_clients WHERE client_name = $1', [name])).toHaveLength(0);
    const registration = await post('/admin/api/register-client', request); expect(registration.status).toBe(200);
    const created = await registration.json() as any; clients.push(created.clientId);
    const before = await readClientGrant(engine, created.clientId); expect(before.profile).toBe('memory-writer');
    const previewEdit = await post('/admin/api/rescope-client', { clientId: created.clientId, scopes: ['read'], expectedRevision: before.revision, dryRun: true });
    expect(previewEdit.status).toBe(200); expect((await readClientGrant(engine, created.clientId)).revision).toBe(before.revision);
    const edit = await post('/admin/api/rescope-client', { clientId: created.clientId, scopes: ['read'], expectedRevision: before.revision }); expect(edit.status).toBe(200);
    const stale = await post('/admin/api/rescope-client', { clientId: created.clientId, scopes: ['admin'], expectedRevision: before.revision }); expect(stale.status).toBe(409);
    const invalidTtl = await post('/admin/api/update-client-ttl', { clientId: created.clientId, tokenTtl: 31536000 }); expect(invalidTtl.status).toBe(400);
    const token = await fetch(base + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'client_credentials', client_id: created.clientId, client_secret: created.clientSecret }) });
    expect(token.status).toBe(200); expect((await token.json() as any).scope).toBe('read');
    const detail = await fetch(base + '/admin/api/grants/' + created.clientId, { headers: { Cookie: cookie } }); expect(detail.status).toBe(200);
    expect(JSON.stringify(await detail.json())).not.toContain(created.clientSecret);
    const noAuth = await fetch(base + '/admin/api/grants/' + created.clientId); expect(noAuth.status).toBe(401);
  });

  test('legacy admin output stays compatible and raw incomplete agent grants return 400', async () => {
    const invalid = await post('/admin/api/register-client', { name: 'invalid-agent-' + randomUUID(), scopes: 'read write agent' }); expect(invalid.status).toBe(400);
    const source = 'grant-source-' + randomUUID().slice(0, 12); sources.push(source);
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [source]);
    const registration = await post('/admin/api/register-client', { name: 'legacy-api-' + randomUUID(), scopes: 'read', tokenTtl: 7200, source, federatedRead: ['default', source] }); expect(registration.status).toBe(200);
    const created = await registration.json() as any; clients.push(created.clientId);
    const initial = await readClientGrant(engine, created.clientId); expect(initial.sourceId).toBe(source); expect(initial.federatedRead).toEqual(['default', source]);
    const result = await post('/admin/api/rescope-client', { clientId: created.clientId, sourceId: 'default', federatedRead: ['default'] }); expect(result.status).toBe(200);
    const body = await result.json() as any; expect(Object.keys(body).sort()).toEqual(['clientId', 'clientName', 'federatedRead', 'sourceId']);
  });

  test('admin credential delivery can be recovered without another grant or secret rotation', async () => {
    const name = 'delivery-admin-' + randomUUID();
    const request = { name, profile: 'memory-reader', sourceId: 'default' };
    const registration = await post('/admin/api/register-client', request);
    expect(registration.status).toBe(200); expect(registration.headers.get('cache-control')).toBe('no-store');
    const created = await registration.json() as any; clients.push(created.clientId);
    const before = await readClientGrant(engine, created.clientId);
    const originalHash = await engine.executeRaw('SELECT client_secret_hash FROM oauth_clients WHERE client_id=$1', [created.clientId]);
    // A client can rediscover its committed ID after a lost registration
    // response. Repeating registration must never create a second client.
    const duplicate = await post('/admin/api/register-client', request); expect(duplicate.status).toBe(409);
    expect((await duplicate.json() as any).client_id).toBe(created.clientId);
    const recovered = await post('/admin/api/recover-client', { clientId: created.clientId });
    expect(recovered.status).toBe(200); expect(recovered.headers.get('cache-control')).toBe('no-store');
    const body = await recovered.json() as any;
    expect(body.clientSecret).toBe(created.clientSecret); expect(body.name).toBe(name);
    expect(body.credentials.client_id).toBe(created.clientId); expect(body.credentials.mcp_url).toBe(base + '/mcp');
    expect(body.credentials.access_token).toBeUndefined();
    expect(await readClientGrant(engine, created.clientId)).toEqual(before);
    expect(await engine.executeRaw('SELECT client_secret_hash FROM oauth_clients WHERE client_id=$1', [created.clientId])).toEqual(originalHash);
    expect(await engine.executeRaw('SELECT id FROM oauth_grant_audit WHERE client_id=$1', [created.clientId])).toHaveLength(1);
    expect(await engine.executeRaw('SELECT client_id FROM oauth_clients WHERE client_name=$1', [name])).toHaveLength(1);
    const journal = join(home, '.gbrain', 'credential-deliveries', `${created.clientId}.json`);
    expect(statSync(journal).mode & 0o077).toBe(0);
    expect(JSON.parse(readFileSync(journal, 'utf8')).client_secret).toBe(created.clientSecret);
    const anonymous = await fetch(base + '/admin/api/recover-client', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientId: created.clientId }) });
    expect(anonymous.status).toBe(401);
    await engine.executeRaw('UPDATE oauth_clients SET client_secret_hash=$1 WHERE client_id=$2', ['rotated-fixture-hash', created.clientId]);
    const stale = await post('/admin/api/recover-client', { clientId: created.clientId }); expect(stale.status).toBe(409);
    expect(JSON.stringify(await stale.json())).not.toContain(created.clientSecret);
    await engine.executeRaw('UPDATE oauth_clients SET deleted_at=now() WHERE client_id=$1', [created.clientId]);
    const revoked = await post('/admin/api/recover-client', { clientId: created.clientId }); expect(revoked.status).toBe(404);
  });

  for (const method of ['none', 'client_secret_post']) {
    test(`${method}: real owner consent, PKCE, resource binding and refresh intersection`, async () => {
      const redirectUri = 'https://client.example.com/callback';
      const registration = await post('/admin/api/register-client', { name: 'consent-' + randomUUID(), profile: 'memory-writer', grantTypes: ['authorization_code', 'refresh_token'], redirectUris: [redirectUri], tokenEndpointAuthMethod: method });
      expect(registration.status).toBe(200); const created = await registration.json() as any; clients.push(created.clientId);
      const verifier = 'grant-http-verifier-example-'.repeat(3);
      const query = new URLSearchParams({ client_id: created.clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'read write', state: 'state-example',
        code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: base + '/mcp' });
      const authorizeUrl = base + '/authorize?' + query;
      expect((await fetch(authorizeUrl, { redirect: 'manual' })).status).toBe(401);
      const consent = await fetch(authorizeUrl, { headers: { Cookie: cookie }, redirect: 'manual' }); expect(consent.status).toBe(200);
      const nonce = (await consent.text()).match(/name="nonce" value="([a-f0-9]+)"/)?.[1]; expect(nonce).toBeTruthy();
      const approval = await fetch(base + '/authorize/consent', { method: 'POST', redirect: 'manual', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce: nonce!, decision: 'approve' }) });
      expect(approval.status).toBe(303);
      const issued = await fetch(base + approval.headers.get('location'), { headers: { Cookie: cookie }, redirect: 'manual' }); expect(issued.status).toBe(302);
      const location = new URL(issued.headers.get('location')!); expect(location.searchParams.get('state')).toBe('state-example');
      const code = location.searchParams.get('code'); expect(code).toBeTruthy();
      const tokenRequest = (values: Record<string, string>) => fetch(base + '/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: created.clientId, ...(created.clientSecret ? { client_secret: created.clientSecret } : {}), ...values }) });
      const form = { grant_type: 'authorization_code', code: code!, redirect_uri: redirectUri, code_verifier: verifier, resource: base + '/mcp' };
      expect((await tokenRequest({ ...form, code_verifier: 'x'.repeat(64) })).status).toBe(400);
      expect((await tokenRequest({ ...form, resource: 'https://other.example.com/mcp' })).status).toBe(400);
      const tokensResponse = await tokenRequest(form); expect(tokensResponse.status).toBe(200); const tokens = await tokensResponse.json() as any;
      const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine) });
      expect((await provider.verifyAccessToken(tokens.access_token)).resource?.toString()).toBe(base + '/mcp');
      await rescopeClientGrant(engine, created.clientId, { scopes: ['read'] }, { actor: 'test' });
      const renewed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: base + '/mcp' });
      expect(renewed.status).toBe(200); expect((await renewed.json() as any).scope).toBe('read');
      expect((await tokenRequest(form)).status).toBe(400);
    });
  }
});
