/**
 * E2E test for thin-client mode (multi-topology v1).
 *
 * Spins up `gbrain serve --http` against a real Postgres, registers a
 * client with `read,write,admin` scope, runs `gbrain init --mcp-only`
 * against it from a second tempdir HOME, and exercises the canonical
 * thin-client flows:
 *
 *   - `gbrain init --mcp-only` succeeds and writes remote_mcp config
 *   - `gbrain doctor` reports `mode: thin-client` with all checks green
 *   - `gbrain sync` is refused with the canonical thin-client error
 *   - re-running `gbrain init` refuses without --force
 *
 * Tier B flows (`gbrain remote ping` / `remote doctor`) are stubbed for now
 * and will be exercised when the Tier B commands ship.
 *
 * Skips when DATABASE_URL is unset (matches the e2e gate convention used
 * across the suite).
 */

import { describe, test as testRaw, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 120000);
}

const CLI = join(__dirname, '..', '..', 'src', 'cli.ts');
const DATABASE_URL = process.env.DATABASE_URL;

interface RunResult { exitCode: number; stdout: string; stderr: string; }

async function spawn(args: string[], home: string, extraEnv: Record<string, string | undefined> = {}): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GBRAIN_HOME = home;
  delete env.GBRAIN_REMOTE_CLIENT_SECRET;
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

// Skip the entire suite when DATABASE_URL is unset. Same pattern as other
// E2E tests in this directory.
const describeWhen = DATABASE_URL ? describe : describe.skip;

describeWhen('thin-client end-to-end (requires DATABASE_URL)', () => {
  let hostHome: string;          // GBRAIN_HOME for the host (with local engine)
  let clientHome: string;        // GBRAIN_HOME for the thin client (no engine)
  let serverProc: ReturnType<typeof Bun.spawn> | null = null;
  let serverPort: number;
  let clientId: string;
  let clientSecret: string;

  beforeAll(async () => {
    hostHome = mkdtempSync(join(tmpdir(), 'gbrain-thin-host-'));
    clientHome = mkdtempSync(join(tmpdir(), 'gbrain-thin-client-'));

    // 1. Init host with a real Postgres.
    const init = await spawn(['init', '--non-interactive', '--url', DATABASE_URL!], hostHome);
    if (init.exitCode !== 0) throw new Error(`host init failed: ${init.stderr || init.stdout}`);

    // 2. Pick a random free port for serve --http.
    serverPort = 30000 + Math.floor(Math.random() * 30000);

    // 3. Spawn serve --http (background, async).
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined) env[k] = v;
    }
    env.GBRAIN_HOME = hostHome;
    serverProc = Bun.spawn({
      cmd: ['bun', 'run', CLI, 'serve', '--http', '--port', String(serverPort)],
      env,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Wait for the server to be ready (poll the discovery endpoint).
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`http://127.0.0.1:${serverPort}/.well-known/oauth-authorization-server`, {
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) break;
      } catch { /* retry */ }
      await new Promise(r => setTimeout(r, 250));
    }

    // 4. Register a client with read,write,admin scope.
    const reg = await spawn([
      'auth', 'register-client', 'thin-client-test',
      '--grant-types', 'client_credentials',
      '--scopes', 'read write admin',
    ], hostHome);
    if (reg.exitCode !== 0) throw new Error(`register-client failed: ${reg.stderr || reg.stdout}`);
    const parsed = parseRegisterClientOutput(reg.stdout);
    clientId = parsed.clientId;
    clientSecret = parsed.clientSecret;
    if (!clientId || !clientSecret) {
      throw new Error(`register-client returned unexpected output: ${reg.stdout}`);
    }
  });

  function parseRegisterClientOutput(out: string): { clientId: string; clientSecret: string } {
    // `gbrain auth register-client` doesn't have --json; parse human output:
    //   Client ID:     <id>
    //   Client Secret: <secret>
    const idMatch = out.match(/Client ID:\s*(\S+)/);
    const secretMatch = out.match(/Client Secret:\s*(\S+)/);
    return {
      clientId: idMatch?.[1] ?? '',
      clientSecret: secretMatch?.[1] ?? '',
    };
  }

  afterAll(async () => {
    if (serverProc) {
      try { serverProc.kill(); } catch { /* best-effort */ }
      try { await serverProc.exited; } catch { /* ignore */ }
    }
    try { rmSync(hostHome, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(clientHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  test('init --mcp-only succeeds against the live host', async () => {
    const r = await spawn([
      'init', '--mcp-only', '--json',
      '--issuer-url', `http://127.0.0.1:${serverPort}`,
      '--mcp-url', `http://127.0.0.1:${serverPort}/mcp`,
      '--oauth-client-id', clientId,
      '--oauth-client-secret', clientSecret,
    ], clientHome);
    expect(r.exitCode).toBe(0);
    const cfgPath = join(clientHome, '.gbrain', 'config.json');
    expect(existsSync(cfgPath)).toBe(true);
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.remote_mcp.oauth_client_id).toBe(clientId);
    // No PGLite file
    expect(existsSync(join(clientHome, '.gbrain', 'brain.pglite'))).toBe(false);
  });

  test('doctor reports mode: thin-client with all checks green', async () => {
    const r = await spawn(['doctor', '--json'], clientHome);
    expect(r.exitCode).toBe(0);
    const report = JSON.parse(r.stdout.trim());
    expect(report.mode).toBe('thin-client');
    expect(report.status).toBe('ok');
    const checkNames = report.checks.map((c: { name: string }) => c.name);
    expect(checkNames).toContain('config_integrity');
    expect(checkNames).toContain('oauth_discovery');
    expect(checkNames).toContain('oauth_token');
    expect(checkNames).toContain('mcp_smoke');
    expect(report.oauth_scope).toContain('admin');
  });

  test('sync is refused with canonical thin-client error', async () => {
    const r = await spawn(['sync'], clientHome);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('thin client');
    expect(r.stderr).toContain(`http://127.0.0.1:${serverPort}/mcp`);
  });

  test('re-running init refuses without --force', async () => {
    const r = await spawn(['init', '--non-interactive', '--pglite', '--json'], clientHome);
    expect(r.exitCode).toBe(1);
    const parsed = JSON.parse(r.stdout.trim().split('\n').pop()!);
    expect(parsed.reason).toBe('thin_client_config_present');
  });

  // ─── Tier B: gbrain remote ping + remote doctor ───

  test('gbrain remote doctor returns the host DoctorReport', async () => {
    const r = await spawn(['remote', 'doctor', '--json'], clientHome);
    // Exit code reflects the host brain's health. On an empty fresh brain
    // brain_score is 0, so status is 'unhealthy' and exit is 1. That's
    // legitimate doctor output, not a transport failure. What this test
    // pins is the round-trip + JSON shape.
    const report = JSON.parse(r.stdout.trim());
    expect(report.schema_version).toBe(2);
    expect(['healthy', 'warnings', 'unhealthy']).toContain(report.status);
    const names = report.checks.map((c: { name: string }) => c.name);
    expect(names).toContain('connection');
    expect(names).toContain('schema_version');
    expect(names).toContain('brain_score');
    expect(names).toContain('queue_health');
    // Host is fresh + connected, so connection check is OK.
    const conn = report.checks.find((c: { name: string; status: string }) => c.name === 'connection');
    expect(conn.status).toBe('ok');
    // Schema version is at LATEST_VERSION on a fresh init.
    const sv = report.checks.find((c: { name: string; status: string }) => c.name === 'schema_version');
    expect(sv.status).toBe('ok');
  });

  test('gbrain remote ping triggers autopilot-cycle and returns terminal state', async () => {
    // Test budget: 60s ping wait, 120s test timeout (overhead). Empty brain
    // with no configured repo path will likely have autopilot-cycle fail-fast
    // in the sync phase — that's fine. What this test pins is the wire path:
    // submit_job → get_job poll → terminal state JSON. NOT cycle success on
    // a no-repo fixture.
    const r = await spawn(['remote', 'ping', '--json', '--timeout', '60s'], clientHome);
    expect(r.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toHaveProperty('job_id');
    expect(parsed.job_id).toBeGreaterThan(0);
    // success → completed; otherwise any terminal state OR timeout is OK.
    if (parsed.status === 'success') {
      expect(parsed.state).toBe('completed');
    } else {
      expect(['failed', 'dead', 'cancelled', 'timeout']).toContain(parsed.reason ?? parsed.state);
    }
  });

  test('client without admin scope cannot call run_doctor', async () => {
    // Register a separate client with read+write only (no admin) and verify
    // that gbrain remote doctor surfaces an auth-error message. This is the
    // codex review #7 regression guard — the verification flow MUST require
    // admin scope.
    const reg = await spawn([
      'auth', 'register-client', 'thin-client-readwrite',
      '--grant-types', 'client_credentials',
      '--scopes', 'read write',
    ], hostHome);
    if (reg.exitCode !== 0) throw new Error(`register-client failed: ${reg.stderr || reg.stdout}`);
    const parsed = parseRegisterClientOutput(reg.stdout);
    const lowScopeId = parsed.clientId;
    const lowScopeSecret = parsed.clientSecret;

    // Spin up a separate clientHome for the lower-scope client
    const lowScopeHome = mkdtempSync(join(tmpdir(), 'gbrain-thin-client-lowscope-'));
    try {
      const init = await spawn([
        'init', '--mcp-only', '--json',
        '--issuer-url', `http://127.0.0.1:${serverPort}`,
        '--mcp-url', `http://127.0.0.1:${serverPort}/mcp`,
        '--oauth-client-id', lowScopeId,
        '--oauth-client-secret', lowScopeSecret,
      ], lowScopeHome);
      if (init.exitCode !== 0) {
        throw new Error(`low-scope init exit=${init.exitCode}\nstdout:${init.stdout}\nstderr:${init.stderr}`);
      }
      expect(init.exitCode).toBe(0);

      const r = await spawn(['remote', 'doctor', '--json'], lowScopeHome);
      expect(r.exitCode).toBe(1);
      const err = JSON.parse(r.stdout.trim());
      expect(err.status).toBe('error');
      // Either the SDK 401 path or our auth_after_refresh wrap is fine —
      // the test pins "this fails because admin scope is missing".
      expect(['auth', 'auth_after_refresh', 'tool_error']).toContain(err.reason);
    } finally {
      rmSync(lowScopeHome, { recursive: true, force: true });
    }
  });

  // ─── v0.31.1 (Issue #734) — routing seam regression tests ───
  //
  // The bug being fixed: thin-client gbrain commands silently fell through to
  // the empty local PGLite, returned "No results." (exit 0), and never reached
  // the remote brain. These tests pin the routing path against a real seeded
  // host. If any of these regress, the silent-empty-results bug is back.

  test('issue #734 regression: gbrain search routes to host and returns seeded rows', async () => {
    // Seed two pages on the host via direct `gbrain put` (host has the engine).
    // Both contain the unique token "wintermute_routing_proof" so we can grep
    // the response body to prove it came from the remote brain.
    const seed1 = await spawn([
      'put', 'wiki/test/routing-proof-1',
      '--type', 'note',
      '--title', 'Routing Proof Page One',
      '--content', '# Routing Proof One\n\nUnique token: wintermute_routing_proof. This page only exists on the host.',
    ], hostHome);
    if (seed1.exitCode !== 0) throw new Error(`seed1 put failed: ${seed1.stderr || seed1.stdout}`);

    const seed2 = await spawn([
      'put', 'wiki/test/routing-proof-2',
      '--type', 'note',
      '--title', 'Routing Proof Page Two',
      '--content', '# Routing Proof Two\n\nAnother page with wintermute_routing_proof.',
    ], hostHome);
    if (seed2.exitCode !== 0) throw new Error(`seed2 put failed: ${seed2.stderr || seed2.stdout}`);

    // Now run search from the THIN CLIENT. Pre-v0.31.1 this returned
    // "No results." against the empty local PGLite. v0.31.1 routes via MCP
    // and must return at least one row referencing the seeded slug.
    const r = await spawn(['search', 'wintermute_routing_proof'], clientHome);

    // Hard-fail conditions that pin the bug fix:
    expect(r.exitCode).toBe(0);
    // The original bug: empty stdout. If this assertion ever fails, #734 has
    // regressed — silent-empty-results is back.
    expect(r.stdout.length).toBeGreaterThan(0);
    expect(r.stdout).not.toContain('No results.');
    // Seeded slug must appear in the routed response body.
    expect(r.stdout).toContain('wiki/test/routing-proof');
  });

  test('routed search emits identity banner on stderr (cherry-pick B)', async () => {
    // Run search with stderr captured. Banner is suppressed in non-TTY by
    // default per our suppression rules; opt back in with GBRAIN_BANNER=1.
    const r = await spawn(['search', 'wintermute_routing_proof'], clientHome, {
      GBRAIN_BANNER: '1',
    });
    expect(r.exitCode).toBe(0);
    // Banner format: [thin-client → host:port · brain: Npages, Nchunks · vX.Y.Z]
    expect(r.stderr).toContain('thin-client');
    expect(r.stderr).toContain(`127.0.0.1:${serverPort}`);
    expect(r.stderr).toMatch(/v\d+\.\d+\.\d+/);
  });

  test('--quiet suppresses banner even with GBRAIN_BANNER=1', async () => {
    // --quiet wins over GBRAIN_BANNER=1. Belt-and-suspenders for shell pipelines.
    const r = await spawn(['--quiet', 'search', 'wintermute_routing_proof'], clientHome, {
      GBRAIN_BANNER: '1',
    });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('thin-client →');
  });

  test('routed put round-trip: thin-client write reaches the host', async () => {
    // Write from the thin client. Pre-v0.31.1 this would have hit the empty
    // local PGLite; v0.31.1 routes through MCP put_page.
    const w = await spawn([
      'put', 'wiki/test/thin-client-write-proof',
      '--type', 'note',
      '--title', 'Written By Thin Client',
      '--content', '# Written By Thin Client\n\nThis page was created via routed MCP put.',
    ], clientHome);
    expect(w.exitCode).toBe(0);

    // Verify it landed on the host by reading it back from the host's local engine.
    const r = await spawn(['get', 'wiki/test/thin-client-write-proof'], hostHome);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Written By Thin Client');
    expect(r.stdout).toContain('routed MCP put');
  });

  test('routed stats: admin-scope client returns real numbers (not 0/0)', async () => {
    // Pre-v0.31.1: thin-client `gbrain stats` returned page_count=0 against
    // empty local PGLite. v0.31.1 routes to host's get_stats op (admin scope)
    // and surfaces real numbers. We seeded 2+ pages above — page_count must
    // reflect that, not zero.
    const r = await spawn(['stats', '--json'], clientHome);
    expect(r.exitCode).toBe(0);
    const stats = JSON.parse(r.stdout.trim());
    expect(stats.page_count).toBeGreaterThan(0);
    expect(stats.chunk_count).toBeGreaterThan(0);
  });

  test('local-only command refused with pinpoint hint (sync)', async () => {
    // Refusal is already covered upstream but this pins the v0.31.1 hint
    // format ("not routable. <hint>") instead of the v0.30 generic message.
    const r = await spawn(['sync'], clientHome);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not routable');
    expect(r.stderr).toContain('gbrain remote ping');
  });
});
