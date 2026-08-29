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
 *   - daily-driver verbs: `search` / `query` / `recall --json` from the
 *     thin-client HOME return host-seeded rows with the same top-level JSON
 *     shape as a local-engine run (key sets pinned)
 *   - invalid/revoked credentials and a stopped host both surface the
 *     canonical RemoteMcpError rendering with a non-zero exit, fail-fast
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

    // 1. Init host with a real Postgres. `--no-embedding` defers embedding
    //    setup (v0.37.10.0+ requires an explicit embedding provider OR the
    //    deferral flag); thin-client tests exercise the routing surface, not
    //    embedding, so no provider is needed.
    const init = await spawn(['init', '--non-interactive', '--no-embedding', '--url', DATABASE_URL!], hostHome);
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
    // refuseThinClient() emits "(thin-client of <mcp_url>)" with the hyphenated
    // form. Allow either spelling so a future format tweak doesn't false-fail.
    expect(r.stderr).toMatch(/thin[- ]client/);
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

  // Skipped: the test fixture is structurally incompatible with what this
  // assertion needs. `gbrain serve --http` does NOT start a job worker
  // (workers run via the separate `gbrain jobs work` process). So a
  // submit_job(autopilot-cycle) call from this fixture leaves the job in
  // `waiting` forever — no worker to advance it. The test was supposed to
  // fall back to the self-imposed `--timeout` firing, but `gbrain remote
  // ping --timeout` doesn't actually honor the cap when callRemoteTool
  // hangs (the polling loop only checks elapsed time between iterations;
  // a single in-flight callTool with no AbortSignal blocks forever).
  //
  // Two real follow-ups would unblock this:
  //   1. Thread an AbortSignal through callRemoteTool's MCP `callTool`
  //      path so `--timeout` actually caps individual calls (not just
  //      the loop overhead).
  //   2. OR start a `gbrain jobs work` subprocess in this test's beforeAll
  //      so the autopilot-cycle job actually fails-fast on a no-repo
  //      fixture and reaches a real terminal state.
  //
  // Either fix is its own PR. The wire path (callRemoteTool, OAuth, MCP
  // dispatch) is exercised by the doctor + low-scope tests in this file
  // and by the entire serve-http-oauth.test.ts suite, so coverage of the
  // protocol is not lost while this test sits skipped.
  testRaw.skip('gbrain remote ping triggers autopilot-cycle and returns terminal state', async () => {
    const r = await spawn(['remote', 'ping', '--json', '--timeout', '5s'], clientHome);
    expect(r.stdout.length).toBeGreaterThan(0);
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed).toHaveProperty('job_id');
    expect(parsed.job_id).toBeGreaterThan(0);
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

  // ─── G3: the daily-driver verbs over the live host serve ───
  //
  // ORDERING NOTE: bun runs tests in declaration order within a file. The
  // 'stopped host' test below KILLS the shared serve process, so it must stay
  // the LAST test in this file — add new live-serve tests ABOVE it.

  const G3_MARKER = 'peridot-gyroscope-mangrove-e2e';
  const G3_SLUG = 'thin-client-daily-driver-marker';

  /**
   * Seed the HOST brain through its own local-engine CLI: one page (found by
   * the search/query keyword arm — the host was inited --no-embedding, so the
   * vector arm degrades and keyword carries the match) and one
   * world-visibility fact (the recall arm; remote callers see world-only).
   * Idempotent: `put` overwrites the slug, `remember` dedups to
   * status=duplicate on re-runs against a shared e2e database.
   */
  async function seedHostMarker(): Promise<void> {
    const content = [
      '---',
      'title: Daily Driver Marker Page',
      'type: note',
      '---',
      '',
      `The secret phrase is ${G3_MARKER} and it lives only in the host brain.`,
      '',
    ].join('\n');
    // Shared-DB hygiene: a prior suite in the full-glob run can leave
    // `sync.repo_path` in the shared config table pointing at a deleted temp
    // repo, which makes put_page's reverse-write refuse (repo_not_found).
    // Clear it — suites that need it set it themselves.
    await spawn(['config', 'unset', 'sync.repo_path'], hostHome);
    const put = await spawn(['put', G3_SLUG, '--content', content], hostHome);
    if (put.exitCode !== 0) throw new Error(`seed put failed: ${put.stderr || put.stdout}`);
    const rem = await spawn(
      ['remember', `The rendezvous codeword is ${G3_MARKER}`, '--provenance', 'thin-client e2e seed'],
      hostHome,
    );
    if (rem.exitCode !== 0) throw new Error(`seed remember failed: ${rem.stderr || rem.stdout}`);
  }

  interface VerbRuns {
    hostSearch: RunResult;
    clientSearch: RunResult;
    hostQuery: RunResult;
    clientQuery: RunResult;
    hostRecall: RunResult;
    clientRecall: RunResult;
  }

  test('daily-driver verbs (search/query/recall) return host-brain rows with local-parity --json envelopes', async () => {
    // The e2e database is shared with other suites that truncate pages/facts
    // in their own setup. Bounded seed+read retry keeps this test honest
    // under a concurrent wipe without loosening any assertion: every attempt
    // seeds first, then requires ALL six runs to be complete before pinning.
    let runs: VerbRuns | null = null;
    for (let attempt = 0; attempt < 3 && !runs; attempt++) {
      await seedHostMarker();
      // Local-engine runs (host HOME) and routed runs (thin-client HOME) of
      // the same three verbs. All reads — safe to run in parallel.
      const [hostSearch, clientSearch, hostQuery, clientQuery, hostRecall, clientRecall] = await Promise.all([
        spawn(['search', G3_MARKER, '--json'], hostHome),
        spawn(['search', G3_MARKER, '--json'], clientHome),
        spawn(['query', G3_MARKER, '--json'], hostHome),
        spawn(['query', G3_MARKER, '--json'], clientHome),
        spawn(['recall', '--grep', G3_MARKER, '--json'], hostHome),
        spawn(['recall', '--grep', G3_MARKER, '--json'], clientHome),
      ]);
      const candidate: VerbRuns = { hostSearch, clientSearch, hostQuery, clientQuery, hostRecall, clientRecall };
      const complete =
        Object.values(candidate).every(r => r.exitCode === 0) &&
        [hostSearch, clientSearch, hostQuery, clientQuery].every(r => r.stdout.includes(G3_SLUG)) &&
        [hostRecall, clientRecall].every(r => r.stdout.includes(G3_MARKER));
      if (complete) runs = candidate;
    }
    if (!runs) {
      throw new Error('marker rows never materialized across 3 seed+read attempts (concurrent shared-DB truncation?)');
    }

    // search + query --json: top-level shape is an ARRAY of result rows
    // (formatResult's search/query case prints JSON.stringify(results)).
    // The routed envelope must carry the SAME per-row key set as the
    // local-engine run — cli.ts normalizes the local path via
    // normalizeLocalResult (ENG-2: renderer parity by data shape) exactly so
    // these two match.
    const pinRowParity = (local: RunResult, routed: RunResult, verb: string) => {
      const localRows = JSON.parse(local.stdout.trim()) as Array<Record<string, unknown>>;
      const routedRows = JSON.parse(routed.stdout.trim()) as Array<Record<string, unknown>>;
      expect(Array.isArray(localRows)).toBe(true);
      expect(Array.isArray(routedRows)).toBe(true);
      const localRow = localRows.find(r => r.slug === G3_SLUG);
      const routedRow = routedRows.find(r => r.slug === G3_SLUG);
      if (!localRow || !routedRow) throw new Error(`${verb}: marker row missing after complete-run gate`);
      // Rows come from the HOST brain: the host-seeded marker string rides
      // the routed row's chunk text.
      expect(String(routedRow.chunk_text)).toContain(G3_MARKER);
      // Daily-driver core keys, pinned by name — agents branch on these.
      for (const key of ['slug', 'page_id', 'title', 'type', 'chunk_text', 'chunk_source', 'score', 'evidence', 'source_id', 'stale']) {
        expect(Object.keys(routedRow)).toContain(key);
      }
      // Full key-set parity local ↔ routed.
      expect(Object.keys(routedRow).sort()).toEqual(Object.keys(localRow).sort());
    };
    pinRowParity(runs.hostSearch, runs.clientSearch, 'search');
    pinRowParity(runs.hostQuery, runs.clientQuery, 'query');

    // recall --json: top-level shape is the {facts, total} envelope on BOTH
    // paths (runRecallOnce renders factRowToJson locally and re-renders the
    // remote op's rows through the same serializer on the routed path).
    const localEnv = JSON.parse(runs.hostRecall.stdout.trim()) as { facts: Array<Record<string, unknown>>; total: number };
    const routedEnv = JSON.parse(runs.clientRecall.stdout.trim()) as { facts: Array<Record<string, unknown>>; total: number };
    expect(Object.keys(localEnv).sort()).toEqual(['facts', 'total']);
    expect(Object.keys(routedEnv).sort()).toEqual(['facts', 'total']);
    const localFact = localEnv.facts.find(f => String(f.fact).includes(G3_MARKER));
    const routedFact = routedEnv.facts.find(f => String(f.fact).includes(G3_MARKER));
    if (!localFact || !routedFact) throw new Error('recall: marker fact missing after complete-run gate');
    for (const key of ['id', 'fact', 'kind', 'entity_slug', 'visibility', 'confidence', 'effective_confidence', 'created_at']) {
      expect(Object.keys(routedFact)).toContain(key);
    }
    expect(Object.keys(routedFact).sort()).toEqual(Object.keys(localFact).sort());
    // Same host row over the wire, not a lookalike.
    expect(routedFact.id).toBe(localFact.id);
  });

  test('invalid/revoked client credentials fail with the canonical remote error and non-zero exit', async () => {
    // GBRAIN_REMOTE_CLIENT_SECRET overrides the config-file secret
    // (mcp-client resolveSecret), so this exercises the exact wire path a
    // revoked/rotated credential takes: the host's /token endpoint answers
    // 400 invalid_grant (RFC 6749 §5.2) for bad AND revoked clients alike.
    const r = await spawn(['search', G3_MARKER, '--json'], clientHome, {
      GBRAIN_REMOTE_CLIENT_SECRET: 'gbrain_cs_definitely_not_the_real_secret',
    });
    expect(r.exitCode).toBe(1);
    // No fabricated results — stdout stays empty on the error path.
    expect(r.stdout.trim()).toBe('');
    // Canonical RemoteMcpError surface. mcp-client maps the non-401 /token
    // HTTP failure to reason 'discovery' today ("OAuth discovery failed at
    // <issuer>."); allow the 'auth' spelling too so a future 401
    // reclassification on the host doesn't false-fail the guard.
    expect(r.stderr).toMatch(/OAuth (discovery|auth) failed/);
  });

  test('stopped host: routed verbs fail fast with the canonical unreachable error, not a hang', async () => {
    // Kill the live serve. This test is LAST in the file by design (see the
    // ordering note above); afterAll's kill is a no-op afterwards.
    if (serverProc) {
      serverProc.kill();
      await serverProc.exited;
    }
    const t0 = Date.now();
    // Routed-op lane (runThinClientRouted): connection refused surfaces the
    // RemoteMcpError network/unreachable rendering with the mcp_url named.
    const search = await spawn(['search', G3_MARKER, '--json'], clientHome);
    // CLI_ONLY lane (runRecall's thin-client branch): the same RemoteMcpError
    // class propagates with its raw discovery-failure message.
    const recall = await spawn(['recall', '--grep', G3_MARKER, '--json'], clientHome);
    // Fail-fast bound: connection-refused returns in milliseconds; even the
    // routed default timeout is 30s. Anything near the 120s test timeout is
    // the hang this test exists to forbid.
    expect(Date.now() - t0).toBeLessThan(60_000);
    expect(search.exitCode).toBe(1);
    expect(search.stdout.trim()).toBe('');
    expect(search.stderr).toContain(`Cannot reach http://127.0.0.1:${serverPort}/mcp`);
    expect(recall.exitCode).toBe(1);
    expect(recall.stdout.trim()).toBe('');
    expect(recall.stderr).toMatch(/OAuth discovery failed/);
  });
});
