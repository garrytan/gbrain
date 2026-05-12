/**
 * Tests for `gbrain init --mcp-only` — thin-client setup branch.
 *
 * Strategy: subprocess invocation against a tiny in-process HTTP server that
 * mimics the host's OAuth + /mcp endpoints. Subprocess because runInit calls
 * process.exit() on error paths, which breaks in-proc test isolation.
 *
 * Each test sets `GBRAIN_HOME` to a fresh tempdir so the config write is
 * isolated and we can inspect the resulting `~/.gbrain/config.json` without
 * polluting the developer's home.
 */

import { describe, test as testRaw, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';

// `bun run src/cli.ts ...` subprocess startup is ~1-2s; the failure-path tests
// span two HTTP round-trips on top. Default 5s test timeout is too tight.
function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 30000);
}
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer, Server } from 'http';

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let server: Server;
let port: number;
let tmp: string;

// Per-test response control
let discoveryStatus = 200;
let tokenStatus = 200;
let mcpStatus = 200;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/.well-known/oauth-authorization-server') {
      res.statusCode = discoveryStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${port}/token` }));
      return;
    }
    if (req.url === '/token') {
      res.statusCode = tokenStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        access_token: 'token-' + Date.now(),
        token_type: 'bearer',
        expires_in: 3600,
        scope: 'read write admin',
      }));
      return;
    }
    if (req.url === '/mcp') {
      res.statusCode = mcpStatus;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } } }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind fixture');
  port = addr.port;
});

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
});

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-init-mcp-only-'));
  discoveryStatus = 200;
  tokenStatus = 200;
  mcpStatus = 200;
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

interface RunResult { exitCode: number; stdout: string; stderr: string; }

// CRITICAL: must use async Bun.spawn (not execFileSync). execFileSync blocks
// the test process's event loop, which means the in-process HTTP fixture
// CAN'T accept incoming connections from the subprocess — the subprocess
// hangs forever on a TCP connect that never gets accepted. With async spawn
// + await, the fixture's event loop continues to run during the subprocess
// lifetime and can accept connections normally.
async function run(args: string[], extraEnv: Record<string, string | undefined> = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GBRAIN_HOME = tmp;
  // Strip DB env vars so loadConfig() doesn't pick them up.
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_REMOTE_CLIENT_SECRET;
  delete env.GBRAIN_REMOTE_ISSUER_URL;
  delete env.GBRAIN_REMOTE_MCP_URL;
  delete env.GBRAIN_REMOTE_CLIENT_ID;
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }

  const proc = Bun.spawn({
    cmd: ['bun', 'run', CLI, ...args],
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

function configPath(): string { return join(tmp, '.gbrain', 'config.json'); }

describe('gbrain init --mcp-only — happy path', () => {
  test('writes remote_mcp config and creates NO local DB', async () => {
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(configPath())).toBe(true);
    const cfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(cfg.remote_mcp).toBeDefined();
    expect(cfg.remote_mcp.issuer_url).toBe(`http://127.0.0.1:${port}`);
    expect(cfg.remote_mcp.mcp_url).toBe(`http://127.0.0.1:${port}/mcp`);
    expect(cfg.remote_mcp.oauth_client_id).toBe('cid');
    expect(cfg.remote_mcp.oauth_client_secret).toBe('csecret');
    // CRITICAL: thin-client install must not have created a PGLite file.
    expect(existsSync(join(tmp, '.gbrain', 'brain.pglite'))).toBe(false);
    // database fields must NOT be set
    expect(cfg.database_url).toBeUndefined();
    expect(cfg.database_path).toBeUndefined();
    // JSON output verified
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.status).toBe('success');
    expect(parsed.mode).toBe('thin-client');
  });

  test('env-var-supplied secret is NOT persisted to config file', async () => {
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
    ], { GBRAIN_REMOTE_CLIENT_SECRET: 'env-secret' });
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(cfg.remote_mcp).toBeDefined();
    // Env-var secrets stay in env — disk copy is opt-in via flag
    expect(cfg.remote_mcp.oauth_client_secret).toBeUndefined();
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.oauth_secret_in_config).toBe(false);
  });

  test('trailing slashes on issuer_url are normalized', async () => {
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}///`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(cfg.remote_mcp.issuer_url).toBe(`http://127.0.0.1:${port}`);
  });
});

describe('gbrain init --mcp-only — required-flag errors', () => {
  test('missing --issuer-url exits 1 with clear error', async () => {
    const r = await run([
      'init', '--mcp-only', '--json',
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('missing_issuer_url');
  });

  test('missing --mcp-url exits 1', async () => {
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('missing_mcp_url');
  });

  test('missing --oauth-client-id exits 1', async () => {
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('missing_client_id');
  });

  test('missing --oauth-client-secret exits 1', async () => {
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
    ]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('missing_client_secret');
  });
});

describe('gbrain init --mcp-only — pre-flight smoke failures', () => {
  test('discovery 404 → exits 1 with discovery_http reason', async () => {
    discoveryStatus = 404;
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(configPath())).toBe(false); // no config written on smoke fail
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('discovery_http');
  });

  test('token 401 → exits 1 with token_auth reason', async () => {
    tokenStatus = 401;
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(configPath())).toBe(false);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('token_auth');
  });

  test('mcp smoke 500 → exits 1 with mcp_smoke_http reason', async () => {
    mcpStatus = 500;
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(configPath())).toBe(false);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('mcp_smoke_http');
  });

  test('unreachable issuer URL → exits 1 with discovery_network reason', async () => {
    // Pick a port that's almost certainly closed
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', 'http://127.0.0.1:1', // port 1 — typically refused
      '--mcp-url', 'http://127.0.0.1:1/mcp',
      '--oauth-client-id', 'cid',
      '--oauth-client-secret', 'csecret',
    ]);
    expect(r.exitCode).toBe(1);
    expect(existsSync(configPath())).toBe(false);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('discovery_network');
  });
});

describe('gbrain init re-run guard', () => {
  function seedThinClientConfig() {
    mkdirSync(join(tmp, '.gbrain'), { recursive: true });
    writeFileSync(configPath(), JSON.stringify({
      engine: 'postgres',
      remote_mcp: {
        issuer_url: 'https://existing.example',
        mcp_url: 'https://existing.example/mcp',
        oauth_client_id: 'old-cid',
        oauth_client_secret: 'old-secret',
      },
    }, null, 2));
  }

  test('default `gbrain init` (no flags) refuses when remote_mcp is set', async () => {
    seedThinClientConfig();
    const r = await run(['init', '--json', '--non-interactive']);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('thin_client_config_present');
    expect(parsed.mcp_url).toBe('https://existing.example/mcp');
  });

  test('`gbrain init --pglite` refuses when remote_mcp is set', async () => {
    seedThinClientConfig();
    const r = await run(['init', '--pglite', '--json', '--non-interactive']);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('thin_client_config_present');
  });

  test('`gbrain init --mcp-only` (no --force) refuses when remote_mcp is already set', async () => {
    seedThinClientConfig();
    const r = await run([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'new-cid',
      '--oauth-client-secret', 'new-secret',
    ]);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('thin_client_config_present');
    // Old config must still be intact
    const cfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(cfg.remote_mcp.oauth_client_id).toBe('old-cid');
  });

  test('`gbrain init --mcp-only --force` overwrites existing thin-client config', async () => {
    seedThinClientConfig();
    const r = await run([
      'init', '--mcp-only', '--force', '--json',
      '--issuer-url', `http://127.0.0.1:${port}`,
      '--mcp-url', `http://127.0.0.1:${port}/mcp`,
      '--oauth-client-id', 'new-cid',
      '--oauth-client-secret', 'new-secret',
    ]);
    expect(r.exitCode).toBe(0);
    const cfg = JSON.parse(readFileSync(configPath(), 'utf-8'));
    expect(cfg.remote_mcp.oauth_client_id).toBe('new-cid');
    expect(cfg.remote_mcp.mcp_url).toBe(`http://127.0.0.1:${port}/mcp`);
  });
});
