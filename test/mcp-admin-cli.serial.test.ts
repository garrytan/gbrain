// Serial: captures CLI stdout/fetch and resets the process-wide exit verdict.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMcpAdmin } from '../src/commands/mcp-admin.ts';
import { mcpNeedsEngine, runMcp } from '../src/commands/mcp.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import { validateCredentials } from '../src/core/harness/credentials.ts';
import { withEnv } from './helpers/with-env.ts';

const owner = 'fixture-owner-credential-'.repeat(2);
const base = 'https://brain.example.com';
const clientId = 'gbrain_cl_admin_fixture';
const secret = 'gbrain_cs_private_fixture';
const session = 'e'.repeat(64);
const temporaries: string[] = [];
const newDirectory = () => { const directory = mkdtempSync(join(tmpdir(), 'gbrain-admin-cli-')); temporaries.push(directory); return directory; };
const login = () => Response.json({ status: 'authenticated' }, { headers: { 'Set-Cookie': `gbrain_admin=${session}; HttpOnly` } });
const setup = (confidential = false) => ({
  kind: 'oauth-client-setup', version: 1, flow: 'authorization-code', mcp_url: `${base}/mcp`, issuer_url: base,
  scopes: ['read'], harness: 'generic', client: { client_id: clientId, client_name: 'fixture-example',
    redirect_uris: ['https://client.example.com/callback'], grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none', ...(confidential ? { client_secret: secret } : {}) }, instructions: ['Connect in the native client.'],
});

afterEach(() => {
  _resetCliExitVerdictForTests();
  process.exitCode = 0;
  for (const directory of temporaries.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function capture(args: string[], handler: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const output: string[] = [];
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const log = spyOn(console, 'log').mockImplementation((...values: unknown[]) => { output.push(values.map(String).join(' ')); });
  try {
    await runMcpAdmin([...args, '--url', base, '--json'], { bootstrapToken: owner, fetchImpl: (async (url, init) => {
      requests.push({ url: String(url), init: init! });
      return String(url).endsWith('/admin/login') ? login() : handler(String(url), init!);
    }) as typeof fetch });
    return { result: JSON.parse(output.at(-1)!), output: output.join('\n'), requests, exitCode: currentExitCode() };
  } finally { log.mockRestore(); }
}

test('every admin command routes without opening an engine; env owner credential also routes grant remotely', async () => {
  for (const command of ['clients', 'client', 'login-link', 'register', 'setup', 'revoke', 'delete', 'invalidate-tokens']) {
    expect(mcpNeedsEngine(['admin', command], undefined)).toBe(false);
  }
  await withEnv({ GBRAIN_ADMIN_BOOTSTRAP_TOKEN: undefined }, async () => {
    expect(mcpNeedsEngine(['grant', 'fixture'])).toBe(true);
    expect(mcpNeedsEngine(['grant', 'fixture', '--admin-token-file', '/private/token'])).toBe(false);
  });
  await withEnv({ GBRAIN_ADMIN_BOOTSTRAP_TOKEN: owner }, async () => {
    expect(mcpNeedsEngine(['grant', 'fixture'])).toBe(false);
    const requests: string[] = [];
    const fetchMock = spyOn(globalThis, 'fetch').mockImplementation((async url => {
      requests.push(String(url));
      return String(url).endsWith('/admin/login') ? login() : Response.json({
        dry_run: true, grant: { clientId: 'preview', budgetUsdPerDay: null }, before: null, credentials: null, credential_action: 'none',
      });
    }) as typeof fetch);
    const messages: string[] = [];
    const logger = spyOn(console, 'log').mockImplementation(message => { messages.push(String(message)); });
    try {
      await runMcp(['grant', 'fixture', '--url', `${base}/mcp`, '--dry-run', '--json']);
      expect(currentExitCode()).toBe(0);
      expect(JSON.parse(messages[0]).status).toBe('preview');
      expect(requests).toEqual([`${base}/admin/login`, `${base}/admin/api/grants`]);
      expect(messages.join('')).not.toContain(owner);
    } finally { fetchMock.mockRestore(); logger.mockRestore(); }
  });
});

test('native public registration sends all redirect URIs and creates no machine flow', async () => {
  const result = await capture(['register', 'fixture-example', '--redirect-uri', 'https://client.example.com/callback', '--redirect-uri', 'fixture-app://oauth'], (_url, init) => {
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ grantTypes: ['authorization_code', 'refresh_token'], tokenEndpointAuthMethod: 'none', redirectUris: ['https://client.example.com/callback', 'fixture-app://oauth'] });
    expect(body).not.toHaveProperty('scopes'); // Server default is read.
    return Response.json({ clientId, grant: { revision: 1 }, oauthSetup: setup() });
  });
  expect(result.exitCode).toBe(0);
  expect(result.result.status).toBe('registered');
  expect(result.requests).toHaveLength(2);
});

test('incomplete successful registration never claims a known result or repeats the mutation', async () => {
  const result = await capture(['register', 'fixture-example', '--redirect-uri', 'https://client.example.com/callback'], () => Response.json({}));
  expect(result.exitCode).toBe(1);
  expect(result.result).toMatchObject({ reason: 'admin_outcome_unknown', stage: 'register', outcome: 'unknown', endpoint: base });
  expect(result.result.next_action).toContain('admin clients');
  expect(result.requests).toHaveLength(2);
});

test('confidential metadata without a secret is never reported as a delivered private setup', async () => {
  const output = join(newDirectory(), 'missing-secret.json');
  const artifact = setup(true); delete artifact.client.client_secret;
  const result = await capture(['register', 'fixture-example', '--redirect-uri', 'https://client.example.com/callback', '--token-endpoint-auth-method', 'client_secret_post', '--credentials-out', output], () => Response.json({ clientId, oauthSetup: artifact }));
  expect(result.exitCode).toBe(1);
  expect(result.result).toMatchObject({ reason: 'credential_delivery_incomplete', client_id: clientId });
  expect(result.result.next_action).toContain('admin setup');
  expect(() => readFileSync(output)).toThrow();
});

test('confidential creation requires an unused private destination before any HTTP mutation', async () => {
  const args = ['register', 'fixture-example', '--redirect-uri', 'https://client.example.com/callback', '--token-endpoint-auth-method', 'client_secret_post'];
  const missing = await capture(args, () => { throw new Error('unexpected network'); });
  expect(missing.requests).toHaveLength(0);
  expect(missing.result.reason).toBe('credential_destination_required');
  const path = join(newDirectory(), 'occupied.json');
  writeFileSync(path, 'do not overwrite', { mode: 0o600 });
  const occupied = await capture([...args, '--credentials-out', path], () => { throw new Error('unexpected network'); });
  expect(occupied.requests).toHaveLength(0);
  expect(readFileSync(path, 'utf8')).toBe('do not overwrite');
});

test('confidential OAuth export is private, redacted on stdout, and rejected as a machine handoff', async () => {
  const output = join(newDirectory(), 'oauth.json');
  const result = await capture(['register', 'fixture-example', '--redirect-uri', 'https://client.example.com/callback', '--token-endpoint-auth-method', 'client_secret_post', '--credentials-out', output], () =>
    Response.json({ clientId, clientSecret: secret, grant: { revision: 1 }, oauthSetup: setup(true) }));
  expect(result.exitCode).toBe(0);
  const exported = JSON.parse(readFileSync(output, 'utf8'));
  expect(exported.client.client_secret).toBe(secret);
  expect(exported.kind).toBe('oauth-client-setup');
  expect(() => validateCredentials(exported)).toThrow();
  if (process.platform !== 'win32') expect(statSync(output).mode & 0o777).toBe(0o600);
  expect(result.output).not.toContain(secret);
  expect(result.output).not.toContain(owner);
});

test('safe setup never requests secrets until explicit export and passes mixed-client flow', async () => {
  const metadata = await capture(['setup', clientId, '--harness', 'generic', '--flow', 'authorization-code'], url => {
    expect(url).toContain('/setup?harness=generic&flow=authorization-code');
    return Response.json({ status: 'registered', setup: setup(), instructions: ['Authorize in the client'], grant: { revision: 1 } });
  });
  expect(metadata.requests).toHaveLength(2);
  expect(metadata.requests.some(request => request.url.includes('recover-client'))).toBe(false);
  const output = join(newDirectory(), 'public-oauth.json');
  const exported = await capture(['setup', clientId, '--flow', 'authorization-code', '--credentials-out', output], (url, init) => {
    if (url.endsWith('/recover-client')) {
      expect(JSON.parse(String(init.body))).toEqual({ clientId, harness: 'generic', flow: 'authorization-code' });
      return Response.json({ clientId, oauthSetup: setup() });
    }
    return Response.json({ status: 'registered', setup: setup(), grant: { revision: 1 }, instructions: [] });
  });
  expect(exported.requests).toHaveLength(3); // One session for safe setup and private export.
  expect(JSON.parse(readFileSync(output, 'utf8')).client).not.toHaveProperty('client_secret');
});

test('lifecycle previews by default; applies only reviewed revisions and reports uncertain responses', async () => {
  const preview = await capture(['invalidate-tokens', clientId], (_url, init) => {
    expect(JSON.parse(String(init.body))).toEqual({ action: 'invalidate-tokens', dryRun: true });
    return Response.json({ action: 'invalidate-tokens', dry_run: true, before: { revision: 4 }, consequences: ['Existing tokens stop working.'] });
  });
  expect(preview.result.dry_run).toBe(true);
  const missingRevision = await capture(['delete', clientId, '--yes'], () => { throw new Error('unexpected network'); });
  expect(missingRevision.requests).toHaveLength(0);
  expect(missingRevision.result.reason).toBe('revision_required');
  const applied = await capture(['revoke', clientId, '--yes', '--if-version', '4'], (_url, init) => {
    expect(JSON.parse(String(init.body))).toEqual({ action: 'revoke', dryRun: false, expectedRevision: 4, yes: true });
    throw new Error('connection lost');
  });
  expect(applied.result).toMatchObject({ reason: 'admin_outcome_unknown', outcome: 'unknown' });
  expect(applied.result.next_action).toContain(`client ${clientId}`);
  expect(applied.requests).toHaveLength(2);
});

test('backend failures stay visible and cannot expose the owner credential', async () => {
  const result = await capture(['clients'], () => Response.json({ error: 'service_unavailable', message: `backend unavailable ${owner}` }, { status: 503 }));
  expect(result.exitCode).toBe(1);
  expect(result.result).toMatchObject({ status: 'error', reason: 'service_unavailable', http_status: 503 });
  expect(result.output).not.toContain(owner);
  expect(result.result).not.toHaveProperty('clients');
});
