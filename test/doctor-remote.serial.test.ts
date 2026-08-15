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
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { collectRemoteDoctorReport, runUpgradeDriftCheck } from '../src/core/doctor-remote.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { withEnv } from './helpers/with-env.ts';
import { VERSION } from '../src/version.ts';

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
// v0.31.11: per-tool result map for `tools/call` JSON-RPC requests on /mcp.
// Tests that exercise runUpgradeDriftCheck seed `mcpToolResults['get_brain_identity']`
// with the version they want the fixture to advertise. Unset → fall through to
// the legacy initialize-shaped response.
let mcpToolResults: Record<string, { content: Array<{ type: string; text: string }> }> = {};

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
      // v0.31.11: read body so we can dispatch by JSON-RPC method. Pre-v0.31.11
      // the fixture only handled `initialize` (mcp_smoke's only call); the new
      // upgrade-drift check needs `tools/call` for `get_brain_identity`.
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        res.statusCode = mcpStatus;
        res.setHeader('Content-Type', 'application/json');
        if (mcpStatus !== 200) { res.end(); return; }
        let parsed: { id?: number | string; method?: string; params?: { name?: string } } = {};
        try { parsed = JSON.parse(body); } catch { /* ignore */ }
        const id = parsed.id ?? 1;
        const method = parsed.method;
        if (method === 'tools/call') {
          const toolName = parsed.params?.name;
          const seeded = toolName ? mcpToolResults[toolName] : undefined;
          if (seeded) {
            res.end(JSON.stringify({ jsonrpc: '2.0', id, result: seeded }));
            return;
          }
          // No seeded result — return tool error so the caller can detect.
          res.end(JSON.stringify({
            jsonrpc: '2.0', id,
            result: { isError: true, content: [{ type: 'text', text: `unknown tool ${toolName}` }] },
          }));
          return;
        }
        // initialize (or anything else) — minimal handshake response.
        res.end(JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } },
        }));
      });
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
  mcpToolResults = {};
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

// v0.31.11: thin_client_upgrade_drift check.
//
// The check's pure logic (safeCompare, driftLevel, loadPromptState) is covered
// by test/thin-client-upgrade-prompt.test.ts. Here we verify the network-error
// path returns an informational 'ok' (not 'fail') so transient connectivity
// blips don't escalate doctor's overall status — the earlier mcp_smoke check
// already covers the genuinely-unreachable case with a 'fail'.
describe('runUpgradeDriftCheck', () => {
  test('unreachable host returns informational ok with inconclusive=true', async () => {
    // Point at a port that is not bound. callRemoteTool will throw; the check
    // must catch and return ok+inconclusive, not warn or fail.
    const config: GBrainConfig = {
      engine: 'postgres',
      remote_mcp: {
        issuer_url: 'http://127.0.0.1:1', // unreachable
        mcp_url: 'http://127.0.0.1:1/mcp',
        oauth_client_id: 'x',
        oauth_client_secret: 'y',
      },
    };
    const result = await runUpgradeDriftCheck(config);
    expect(result.name).toBe('thin_client_upgrade_drift');
    expect(result.status).toBe('ok');
    expect(result.detail?.inconclusive).toBe(true);
  });

  test('major drift, no prior state → warn with auto-upgrade fix hint', async () => {
    reset();
    // Use 99.99.99 so this is always a major drift regardless of current VERSION.
    mcpToolResults['get_brain_identity'] = {
      content: [{ type: 'text', text: JSON.stringify({ version: '99.99.99' }) }],
    };
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-drift-'));
    try {
      await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const result = await runUpgradeDriftCheck(makeConfig());
        expect(result.name).toBe('thin_client_upgrade_drift');
        expect(result.status).toBe('warn');
        expect(result.message).toContain('major upgrade available');
        expect(result.message).toContain(`v${VERSION}`);
        expect(result.message).toContain('v99.99.99');
        // Auto-upgrade hint (no prior failure on file)
        expect(result.message).toContain('Run `gbrain upgrade`');
        expect(result.detail?.prior_failed).toBe(false);
        expect(result.detail?.level).toBe('major');
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('major drift with prior_failed state → warn with manual-install fix hint', async () => {
    reset();
    mcpToolResults['get_brain_identity'] = {
      content: [{ type: 'text', text: JSON.stringify({ version: '99.99.99' }) }],
    };
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-drift-'));
    try {
      const config = makeConfig();
      // Seed the prompt-state file with a 'failed' entry for THIS mcp_url +
      // the same remote version the fixture is about to advertise. The check
      // should pivot the fix hint to the manual install URL.
      const stateDir = join(tmpHome, '.gbrain');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'upgrade-prompt-state.json'), JSON.stringify({
        schema_version: 1,
        entries: {
          [config.remote_mcp!.mcp_url]: {
            last_prompted_remote_version: '99.99.99',
            last_response: 'failed',
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
        },
      }));
      await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const result = await runUpgradeDriftCheck(config);
        expect(result.status).toBe('warn');
        expect(result.message).toContain('major upgrade available');
        // Manual-install hint, NOT the auto-upgrade hint
        expect(result.message).toContain('Prior `gbrain upgrade` did not advance');
        expect(result.message).toContain('https://github.com/garrytan/gbrain/releases');
        expect(result.message).not.toContain('Run `gbrain upgrade`');
        expect(result.detail?.prior_failed).toBe(true);
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('prior_failed entry for a DIFFERENT remote version → auto-upgrade hint (not stale match)', async () => {
    reset();
    // Remote bumped past the version the user previously failed to upgrade to.
    // The check must NOT pivot to the manual-install hint — that prior failure
    // doesn't apply to this new bump.
    mcpToolResults['get_brain_identity'] = {
      content: [{ type: 'text', text: JSON.stringify({ version: '99.99.99' }) }],
    };
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-drift-'));
    try {
      const config = makeConfig();
      const stateDir = join(tmpHome, '.gbrain');
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, 'upgrade-prompt-state.json'), JSON.stringify({
        schema_version: 1,
        entries: {
          [config.remote_mcp!.mcp_url]: {
            last_prompted_remote_version: '99.0.0', // OLDER than fixture's 99.99.99
            last_response: 'failed',
            last_prompted_at_iso: '2026-05-10T12:00:00Z',
          },
        },
      }));
      await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const result = await runUpgradeDriftCheck(config);
        expect(result.status).toBe('warn');
        expect(result.message).toContain('Run `gbrain upgrade`');
        expect(result.detail?.prior_failed).toBe(false);
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });

  test('local equals remote → ok, no fix hint', async () => {
    reset();
    mcpToolResults['get_brain_identity'] = {
      content: [{ type: 'text', text: JSON.stringify({ version: VERSION }) }],
    };
    const tmpHome = mkdtempSync(join(tmpdir(), 'gbrain-doctor-drift-'));
    try {
      await withEnv({ GBRAIN_HOME: tmpHome }, async () => {
        const result = await runUpgradeDriftCheck(makeConfig());
        expect(result.status).toBe('ok');
        expect(result.message).toContain(`local v${VERSION}`);
        expect(result.message).not.toContain('upgrade available');
      });
    } finally {
      rmSync(tmpHome, { recursive: true, force: true });
    }
  });
});
