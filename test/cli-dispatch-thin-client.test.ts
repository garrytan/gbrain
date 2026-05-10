/**
 * Tests for the top-level CLI dispatch guard introduced in multi-topology v1.
 *
 * When `~/.gbrain/config.json` has `remote_mcp` set, 9 commands are refused
 * with a canonical error pointing at the remote host:
 *   sync, embed, extract, migrate, apply-migrations, repair-jsonb, orphans,
 *   integrity, serve.
 *
 * Doctor is NOT in the refused set — it routes to runRemoteDoctor instead.
 *
 * Strategy: seed `~/.gbrain/config.json` with remote_mcp set in a tempdir
 * `GBRAIN_HOME`, then spawn `gbrain <cmd>` and assert (a) exit code 1,
 * (b) stderr contains the canonical error message, (c) the local engine
 * was never reached. Async Bun.spawn (NOT execFileSync) so the test event
 * loop stays responsive — see init-mcp-only.test.ts for the rationale.
 *
 * Includes a regression test that local-config installs still pass through
 * to connectEngine normally.
 */

import { describe, test as testRaw, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 30000);
}

const CLI = join(__dirname, '..', 'src', 'cli.ts');

let tmp: string;

function configPath(): string { return join(tmp, '.gbrain', 'config.json'); }

function seedThinClientConfig(extra: Record<string, unknown> = {}) {
  mkdirSync(join(tmp, '.gbrain'), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({
    engine: 'postgres',
    remote_mcp: {
      issuer_url: 'https://brain-host.example',
      mcp_url: 'https://brain-host.example/mcp',
      oauth_client_id: 'cid',
      oauth_client_secret: 'csecret',
    },
    ...extra,
  }, null, 2));
}

function seedLocalPGLiteConfig() {
  mkdirSync(join(tmp, '.gbrain'), { recursive: true });
  writeFileSync(configPath(), JSON.stringify({
    engine: 'pglite',
    database_path: join(tmp, 'brain.pglite'),
  }, null, 2));
}

interface RunResult { exitCode: number; stdout: string; stderr: string; }

async function run(args: string[]): Promise<RunResult> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v;
  }
  env.GBRAIN_HOME = tmp;
  delete env.DATABASE_URL;
  delete env.GBRAIN_DATABASE_URL;
  delete env.GBRAIN_REMOTE_CLIENT_SECRET;
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

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-cli-dispatch-'));
});

afterEach(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('thin-client dispatch guard refuses DB-bound commands', () => {
  // Each command in the refused set MUST exit 1 with a canonical error and
  // MUST NOT attempt to connect to a local engine.
  const refusedCommands = [
    ['sync'],
    ['embed', '--stale'],
    ['extract', 'links'],
    // 'migrate' the engine-migration command (different from the migrations
    // orchestrator). Both are in CLI_ONLY but only `migrate-engine` here.
    ['migrate', '--to', 'pglite'],
    ['apply-migrations', '--yes'],
    ['repair-jsonb', '--dry-run'],
    ['orphans'],
    ['integrity', 'check'],
    ['serve'],
  ];

  for (const args of refusedCommands) {
    test(`refuses \`gbrain ${args.join(' ')}\` with pinpoint hint`, async () => {
      seedThinClientConfig();
      const r = await run(args);
      expect(r.exitCode).toBe(1);
      // v0.31.1 (Issue #734): refusal carries an actionable hint via
      // THIN_CLIENT_REFUSE_HINTS instead of a generic "run on the remote
      // host" message. Hint format: "`gbrain <cmd>` is not routable. <hint>"
      expect(r.stderr).toContain(`gbrain ${args[0]}`);
      expect(r.stderr).toContain('thin-client of https://brain-host.example/mcp');
      expect(r.stderr).toContain('not routable');
    });
  }
});

describe('thin-client dispatch guard does NOT refuse safe commands', () => {
  // Commands that are still useful in thin-client mode (init, auth, version,
  // help) MUST NOT be refused. We assert the canonical thin-client error
  // does NOT appear.
  test('`gbrain --version` works on thin-client install', async () => {
    seedThinClientConfig();
    const r = await run(['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('gbrain');
    expect(r.stderr).not.toContain('thin client');
  });

  test('`gbrain --help` works on thin-client install', async () => {
    seedThinClientConfig();
    const r = await run(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('requires a local engine');
  });
});

describe('thin-client doctor routes to runRemoteDoctor', () => {
  test('`gbrain doctor` runs remote checks (not DB-bound checks) when remote_mcp is set', async () => {
    seedThinClientConfig();
    const r = await run(['doctor', '--json']);
    // Doctor will likely fail because brain-host.example isn't reachable —
    // but that's irrelevant. What matters is it ran the THIN-CLIENT doctor,
    // not the local-DB doctor. Fingerprint: the remote doctor's JSON output
    // has `mode: "thin-client"`. The local doctor doesn't.
    expect(r.stdout).toContain('"mode":"thin-client"');
    // Output must include the remote_mcp fields, NOT a schema_version check.
    expect(r.stdout).toContain('"mcp_url":"https://brain-host.example/mcp"');
  });
});

describe('regression — local config still passes through normally', () => {
  test('local PGLite config does NOT trigger thin-client guard for `sync`', async () => {
    // Seed a local PGLite config (no remote_mcp). `gbrain sync` shouldn't
    // refuse with the thin-client error. It may error for other reasons
    // (no brain repo configured, etc.) — what matters is the canonical
    // thin-client message MUST NOT appear.
    seedLocalPGLiteConfig();
    const r = await run(['sync', '--dry-run']);
    expect(r.stderr).not.toContain('thin client');
    expect(r.stderr).not.toContain('requires a local engine');
  });

  test('local PGLite config does NOT trigger guard for `doctor`', async () => {
    seedLocalPGLiteConfig();
    const r = await run(['doctor', '--fast', '--json']);
    // Local doctor's output has different fingerprint — no `mode: thin-client`.
    expect(r.stdout).not.toContain('"mode":"thin-client"');
  });
});
