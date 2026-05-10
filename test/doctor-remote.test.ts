/**
 * Tests for `src/core/doctor-remote.ts` — the thin-client doctor check set.
 *
 * Strategy: spin up a tiny in-process HTTP server that mimics `gbrain serve --http`
 * for OAuth discovery, /token, and /mcp. This tests the REAL probe code in
 * `remote-mcp-probe.ts` end-to-end, not a mocked version. Each test seeds the
 * server's behavior (200 / 401 / 404 / network drop) and asserts the resulting
 * `RemoteDoctorReport` has the expected structure.
 *
 * Anchored on `collectRemoteDoctorReport()` (the pure data collector) rather
 * than `runRemoteDoctor()` so we don't need to intercept stdout / process.exit.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { createServer, Server } from 'http';
import { collectRemoteDoctorReport } from '../src/core/doctor-remote.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';

// v0.31.1: the new oauth_client_scopes_probe check uses the MCP SDK Client
// against /mcp, which the test fixture only mocks at JSON-RPC initialize
// level (no full tools/call). Every collectRemoteDoctorReport call here
// passes {skipScopeProbe: true} via SKIP_PROBE_OPTS. Probe behavior is
// covered separately in test/oauth-scope-probe.test.ts (pure-function
// buildScopeCheck against synthetic ScopeProbeResult inputs).
const SKIP_PROBE_OPTS = { skipScopeProbe: true };

let server: Server;
let port: number;

// Per-test response control. Each test sets these before calling
// collectRemoteDoctorReport() to script the fixture's behavior.
let discoveryStatus = 200;
let discoveryBody: unknown = null;
let tokenStatus = 200;
let tokenBody: unknown = null;
let mcpStatus = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.statusCode = discoveryStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(discoveryBody ?? { token_endpoint: `http://localhost:${port}/token` }));
      return;
    }
    if (req.url === '/token') {
      res.statusCode = tokenStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(tokenBody ?? {
        access_token: 'test-token-' + Date.now(),
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'read write admin',
      }));
      return;
    }
    if (req.url === '/mcp') {
      res.statusCode = mcpStatus;
      res.setHeader('Content-Type', 'application/json');
      // MCP smoke doesn't strictly parse the body — any 2xx with the bearer
      // accepted is enough signal. We send a minimal initialize response.
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } },
      }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind fixture server');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

function reset() {
  discoveryStatus = 200;
  discoveryBody = null;
  tokenStatus = 200;
  tokenBody = null;
  mcpStatus = 200;
}

function makeConfig(overrides: Partial<NonNullable<GBrainConfig['remote_mcp']>> = {}): GBrainConfig {
  return {
    engine: 'postgres',
    remote_mcp: {
      issuer_url: `http://localhost:${port}`,
      mcp_url: `http://localhost:${port}/mcp`,
      oauth_client_id: 'test-client',
      oauth_client_secret: 'test-secret',
      ...overrides,
    },
  };
}

describe('collectRemoteDoctorReport', () => {
  test('happy path — all four checks pass', async () => {
    reset();
    const report = await collectRemoteDoctorReport(makeConfig(), SKIP_PROBE_OPTS);
    expect(report.status).toBe('ok');
    expect(report.mode).toBe('thin-client');
    expect(report.schema_version).toBe(2);
    const checkNames = report.checks.map(c => c.name);
    expect(checkNames).toContain('config_integrity');
    expect(checkNames).toContain('oauth_credentials');
    expect(checkNames).toContain('oauth_discovery');
    expect(checkNames).toContain('oauth_token');
    expect(checkNames).toContain('mcp_smoke');
    expect(report.checks.every(c => c.status === 'ok')).toBe(true);
    expect(report.oauth_scope).toBe('read write admin');
  });

  test('discovery 404 — fails with reason=http and short-circuits', async () => {
    reset();
    discoveryStatus = 404;
    const report = await collectRemoteDoctorReport(makeConfig(), SKIP_PROBE_OPTS);
    expect(report.status).toBe('fail');
    const disco = report.checks.find(c => c.name === 'oauth_discovery')!;
    expect(disco.status).toBe('fail');
    expect(disco.detail?.reason).toBe('http');
    expect(disco.detail?.status).toBe(404);
    // Token + smoke should NOT have been attempted
    expect(report.checks.find(c => c.name === 'oauth_token')).toBeUndefined();
    expect(report.checks.find(c => c.name === 'mcp_smoke')).toBeUndefined();
  });

  test('discovery returns malformed body — fails with reason=parse', async () => {
    reset();
    discoveryBody = { not_a_token_endpoint: 'whoops' };
    const report = await collectRemoteDoctorReport(makeConfig(), SKIP_PROBE_OPTS);
    expect(report.status).toBe('fail');
    const disco = report.checks.find(c => c.name === 'oauth_discovery')!;
    expect(disco.detail?.reason).toBe('parse');
  });

  test('token 401 — fails with reason=auth and stops short of mcp', async () => {
    reset();
    tokenStatus = 401;
    tokenBody = { error: 'invalid_client' };
    const report = await collectRemoteDoctorReport(makeConfig(), SKIP_PROBE_OPTS);
    expect(report.status).toBe('fail');
    const token = report.checks.find(c => c.name === 'oauth_token')!;
    expect(token.status).toBe('fail');
    expect(token.detail?.reason).toBe('auth');
    expect(token.detail?.status).toBe(401);
    expect(report.checks.find(c => c.name === 'mcp_smoke')).toBeUndefined();
  });

  test('mcp 401 — bearer rejected; fails with reason=auth', async () => {
    reset();
    mcpStatus = 401;
    const report = await collectRemoteDoctorReport(makeConfig(), SKIP_PROBE_OPTS);
    expect(report.status).toBe('fail');
    const mcp = report.checks.find(c => c.name === 'mcp_smoke')!;
    expect(mcp.status).toBe('fail');
    expect(mcp.detail?.reason).toBe('auth');
  });

  test('mcp 500 — server error; fails with reason=http', async () => {
    reset();
    mcpStatus = 500;
    const report = await collectRemoteDoctorReport(makeConfig(), SKIP_PROBE_OPTS);
    expect(report.status).toBe('fail');
    const mcp = report.checks.find(c => c.name === 'mcp_smoke')!;
    expect(mcp.detail?.reason).toBe('http');
    expect(mcp.detail?.status).toBe(500);
  });

  test('malformed issuer_url — fails config_integrity check', async () => {
    reset();
    const config = makeConfig({ issuer_url: 'not-a-url' });
    const report = await collectRemoteDoctorReport(config);
    const cfg = report.checks.find(c => c.name === 'config_integrity')!;
    expect(cfg.status).toBe('fail');
    expect(report.status).toBe('fail');
  });

  test('malformed mcp_url — fails config_integrity check', async () => {
    reset();
    const config = makeConfig({ mcp_url: 'ftp://wrong-protocol' });
    const report = await collectRemoteDoctorReport(config);
    const cfg = report.checks.find(c => c.name === 'config_integrity')!;
    expect(cfg.status).toBe('fail');
  });

  test('missing client_secret entirely — fails before any HTTP call', async () => {
    reset();
    // Clear env via withEnv() so the env-var fallback doesn't satisfy the
    // check. withEnv restores prior value on finally + satisfies R1 lint.
    await withEnv({ GBRAIN_REMOTE_CLIENT_SECRET: undefined }, async () => {
      const config = makeConfig();
      delete config.remote_mcp!.oauth_client_secret;
      const report = await collectRemoteDoctorReport(config);
      const creds = report.checks.find(c => c.name === 'oauth_credentials')!;
      expect(creds.status).toBe('fail');
      expect(creds.message).toContain('GBRAIN_REMOTE_CLIENT_SECRET');
      expect(report.checks.find(c => c.name === 'oauth_discovery')).toBeUndefined();
    });
  });

  test('missing remote_mcp on config — fails config_integrity', async () => {
    reset();
    const config: GBrainConfig = { engine: 'postgres' };
    const report = await collectRemoteDoctorReport(config);
    expect(report.status).toBe('fail');
    expect(report.checks[0].name).toBe('config_integrity');
    expect(report.checks[0].status).toBe('fail');
  });

  test('schema_version is 2 (matches local doctor schema_version)', async () => {
    reset();
    const report = await collectRemoteDoctorReport(makeConfig(), SKIP_PROBE_OPTS);
    expect(report.schema_version).toBe(2);
  });

  test('env var GBRAIN_REMOTE_CLIENT_SECRET overrides config-file secret', async () => {
    reset();
    await withEnv({ GBRAIN_REMOTE_CLIENT_SECRET: 'env-supplied-secret' }, async () => {
      const config = makeConfig({ oauth_client_secret: 'config-file-secret' });
      const report = await collectRemoteDoctorReport(config, SKIP_PROBE_OPTS);
      const creds = report.checks.find(c => c.name === 'oauth_credentials')!;
      expect(creds.status).toBe('ok');
      expect(creds.message).toContain('secret_source=env');
    });
  });
});
