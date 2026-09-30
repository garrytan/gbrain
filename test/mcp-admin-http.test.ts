import { expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMcpAdminHttp, McpAdminError, redactAdminValue } from '../src/commands/mcp-admin-http.ts';

const owner = 'synthetic-owner-credential-'.repeat(2);
const session = 'b'.repeat(64);
const base = 'https://brain.example.com';
const login = () => Response.json({ status: 'authenticated' }, { headers: { 'Set-Cookie': `gbrain_admin=${session}; HttpOnly; Path=/admin; SameSite=Strict` } });

test('owner HTTP helper reuses one cookie session and never follows credential redirects', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ url: String(url), init: init! });
    return String(url).endsWith('/admin/login') ? login() : Response.json({ clients: [] });
  }) as unknown as typeof fetch;
  const client = createMcpAdminHttp({ url: `${base}/mcp`, bootstrapToken: owner, fetchImpl });
  await client.request('/admin/api/clients');
  await client.request('/admin/api/clients');
  expect(requests).toHaveLength(3);
  expect(JSON.parse(String(requests[0].init.body))).toEqual({ token: owner });
  for (const request of requests) expect(request.init.redirect).toBe('error');
  expect(new Headers(requests[1].init.headers).get('cookie')).toBe(`gbrain_admin=${session}`);
  expect(new Headers(requests[1].init.headers).has('authorization')).toBe(false);
});

test('explicit private credential file takes precedence and failures never fall back', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'gbrain-owner-http-'));
  try {
    const path = join(directory, 'owner-token');
    writeFileSync(path, owner, { mode: 0o600 });
    const sent: string[] = [];
    const client = createMcpAdminHttp({ url: base, adminTokenFile: path, bootstrapToken: 'different-fixture-secret', fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      sent.push(String(init?.body));
      return login();
    }) as unknown as typeof fetch });
    await client.request('/admin/api/clients');
    expect(JSON.parse(sent[0])).toEqual({ token: owner });
    const empty = join(directory, 'empty');
    writeFileSync(empty, '  \n', { mode: 0o600 });
    for (const invalid of [join(directory, 'missing'), empty]) {
      let failure: unknown;
      try {
        createMcpAdminHttp({ url: base, adminTokenFile: invalid, bootstrapToken: owner });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(McpAdminError);
      expect(failure).toMatchObject({ code: 'admin_credential_file_invalid', nextAction: expect.stringContaining('server administrator') });
      expect(String(failure)).not.toContain(owner);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('lost mutation response is unknown and never retried; read failures stay read failures', async () => {
  let mutations = 0;
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/admin/login')) return login();
    mutations++;
    throw new Error(`socket closed with ${owner}`);
  }) as unknown as typeof fetch });
  const inspection = 'gbrain mcp admin client fixture --url https://brain.example.com';
  try {
    await client.request('/admin/api/clients/fixture/lifecycle', { method: 'POST', body: {}, mutation: true, nextAction: inspection });
    throw new Error('mutation unexpectedly succeeded');
  } catch (error) {
    expect(error).toBeInstanceOf(McpAdminError);
    expect(error).toMatchObject({ code: 'admin_outcome_unknown', outcome: 'unknown', nextAction: inspection });
    expect(String(error)).not.toContain(owner);
  }
  expect(mutations).toBe(1);
  await expect(client.request('/admin/api/clients')).rejects.toMatchObject({ code: 'admin_unreachable' });
});

test('request timeout aborts the HTTP call and preserves mutation uncertainty', async () => {
  let calls = 0;
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, timeoutMs: 100, fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/admin/login')) return login();
    calls++;
    return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }));
  }) as unknown as typeof fetch });
  await expect(client.request('/admin/api/grants', { method: 'POST', body: {}, mutation: true })).rejects.toMatchObject({ outcome: 'unknown' });
  expect(calls).toBe(1);
});

test('unreadable gateway failures preserve mutation uncertainty and never retry', async () => {
  let mutations = 0;
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/admin/login')) return login();
    mutations++;
    return new Response('<html>upstream response lost</html>', { status: 502 });
  }) as unknown as typeof fetch });
  const nextAction = 'Inspect the current client before retrying.';
  await expect(client.request('/admin/api/clients/fixture/lifecycle', { method: 'POST', mutation: true, nextAction }))
    .rejects.toMatchObject({ code: 'admin_outcome_unknown', outcome: 'unknown', httpStatus: 502, nextAction });
  expect(mutations).toBe(1);
});

test('structured errors redact owner credentials and client secrets while retaining HTTP status', async () => {
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => String(url).endsWith('/admin/login')
    ? login() : Response.json({ error: 'grant_conflict', message: `stale ${owner} gbrain_cs_fixturesecret` }, { status: 409 })) as unknown as typeof fetch });
  try { await client.request('/admin/api/grants', { method: 'POST', mutation: true }); }
  catch (error) {
    expect(error).toMatchObject({ code: 'grant_conflict', httpStatus: 409 });
    expect(String(error)).not.toContain(owner);
    expect(String(error)).not.toContain('fixturesecret');
    expect((error as McpAdminError).outcome).toBeUndefined();
  }
  expect(redactAdminValue({ client: { client_secret: 'arbitrary-secret', client_secret_hash: 'hash' }, clientSecret: 'another-secret' }))
    .toEqual({ client: { client_secret: '[redacted]', client_secret_hash: '[redacted]' }, clientSecret: '[redacted]' });
});

test('safe classifications take precedence over legacy freeform error fields', async () => {
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => String(url).endsWith('/admin/login')
    ? login() : Response.json({ error: 'No OAuth client found with id "fixture"', code: 'client_not_found', message: 'Client no longer exists' }, { status: 404 })) as unknown as typeof fetch });
  await expect(client.request('/admin/api/clients/fixture')).rejects.toMatchObject({ code: 'client_not_found', httpStatus: 404 });
});

test('login link retains pending OAuth request and is never redeemed by the helper', async () => {
  const pending = 'a'.repeat(64);
  const nonce = 'c'.repeat(64);
  const calls: string[] = [];
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(url));
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${owner}`);
    expect(JSON.parse(String(init?.body))).toEqual({ oauth_request: pending });
    return Response.json({ url: `${base}/admin/auth/${nonce}?oauth_request=${pending}`, expires_in: 300 });
  }) as unknown as typeof fetch });
  expect(await client.loginLink(pending)).toMatchObject({ url: `${base}/admin/auth/${nonce}?oauth_request=${pending}`, expires_in: 300 });
  expect(calls).toEqual([`${base}/admin/api/issue-magic-link`]);
});

test('private delivery rejects plaintext remote URLs before sending credentials', () => {
  expect(() => createMcpAdminHttp({ url: 'http://brain.example.com', bootstrapToken: owner })).toThrow('HTTPS');
});

test('host-local administration can deliver the configured public owner login link', async () => {
  const nonce = 'f'.repeat(64);
  const requests: string[] = [];
  const client = createMcpAdminHttp({ url: 'http://127.0.0.1:3131', bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => {
    requests.push(String(url));
    return Response.json({ url: `${base}/admin/auth/${nonce}`, expires_in: 300 });
  }) as unknown as typeof fetch });
  expect((await client.loginLink()).url).toBe(`${base}/admin/auth/${nonce}`);
  expect(requests).toEqual(['http://127.0.0.1:3131/admin/api/issue-magic-link']);
});

test('older login-link endpoint cannot silently discard the pending OAuth approval', async () => {
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async () => Response.json({
    url: `${base}/admin/auth/${'f'.repeat(64)}`, expires_in: 300,
  })) as unknown as typeof fetch });
  await expect(client.loginLink('a'.repeat(64))).rejects.toMatchObject({ code: 'server_upgrade_required' });
});

test('expired consent retains the server restart remedy and redacts its credentials', async () => {
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async () => Response.json({
    error: 'authorization_unavailable', message: 'This OAuth request expired, completed, or the server restarted.',
    next_action: `Restart authorization in the native client, then request an owner login link with the new pending-request ID. ${owner} gbrain_cs_fixturesecret`,
  }, { status: 410 })) as unknown as typeof fetch });
  await expect(client.loginLink('a'.repeat(64))).rejects.toMatchObject({
    code: 'authorization_unavailable', httpStatus: 410,
    nextAction: 'Restart authorization in the native client, then request an owner login link with the new pending-request ID. [redacted] [redacted]',
  });
});

test('unknown mutations retain the caller inspection command over a server retry remedy', async () => {
  const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => String(url).endsWith('/admin/login')
    ? login() : Response.json({ error: 'administration_unavailable', outcome: 'unknown', next_action: 'Repeat the mutation' }, { status: 503 })) as unknown as typeof fetch });
  const nextAction = `gbrain mcp admin client fixture --url ${base}`;
  await expect(client.request('/admin/api/clients/fixture/lifecycle', { method: 'POST', mutation: true, nextAction }))
    .rejects.toMatchObject({ outcome: 'unknown', nextAction });
});

test('older servers, missing clients, rate limits and rejected owner credentials have distinct remedies', async () => {
  for (const status of [404, 405]) {
    const client = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => String(url).endsWith('/admin/login')
      ? login() : new Response('<html>unavailable</html>', { status })) as unknown as typeof fetch });
    await expect(client.request('/admin/api/clients')).rejects.toMatchObject({ code: 'server_upgrade_required', httpStatus: status });
  }
  const missing = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async (url: RequestInfo | URL) => String(url).endsWith('/admin/login')
    ? login() : Response.json({ error: 'client_not_found', message: 'Client no longer exists' }, { status: 404 })) as unknown as typeof fetch });
  await expect(missing.request('/admin/api/clients/fixture')).rejects.toMatchObject({ code: 'client_not_found', httpStatus: 404 });
  const limited = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async () => new Response('slow down', { status: 429, headers: { 'Retry-After': '42' } })) as unknown as typeof fetch });
  await expect(limited.request('/admin/api/clients')).rejects.toMatchObject({ code: 'admin_rate_limited', retryAfter: '42', httpStatus: 429 });
  const rejected = createMcpAdminHttp({ url: base, bootstrapToken: owner, fetchImpl: (async () => new Response('Invalid token', { status: 401 })) as unknown as typeof fetch });
  await expect(rejected.request('/admin/api/clients')).rejects.toMatchObject({ code: 'admin_authentication_failed', httpStatus: 401 });
});
