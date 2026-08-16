/**
 * E2E: `gbrain bootstrap harness` lifecycle against a REAL `serve --http` on
 * a hermetic PGLite brain (#4043).
 *
 * The real seams the unit suite injects away: an actual /health probe, the
 * actual StreamableHTTP + bearer smoke (probeBrainIdentity), the PGLite
 * single-writer reality (mint refused under a live serve → the --token lane
 * is the documented escape), and the dispatcher path (runBootstrap →
 * home-lock → apply/status/remove) with real receipt/install-log files.
 *
 * The claude CLI is a recording fake (runBootstrap's runner seam); the codex
 * lane writes the real managed TOML block into a temp CODEX_HOME; HOME is
 * remapped so user-scope writes land in the sandbox.
 *
 * Serial: env remapping (HOME / CODEX_HOME / GBRAIN_HOME) + a spawned serve.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn, execFileSync, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { runBootstrap } from '../../src/commands/bootstrap.ts';
import type { ExecRunner } from '../../src/core/bootstrap/repo.ts';
import { readHarnessReceiptState } from '../../src/core/bootstrap/format.ts';
import { CODEX_TOML_BLOCK_BEGIN } from '../../src/core/bootstrap/host-specs.ts';
import { withEnv } from '../helpers/with-env.ts';

const PORT = 19741; // unique to this suite (19735 = connect-bearer, 19131 = oauth)
const BASE = `http://127.0.0.1:${PORT}`;

describe('bootstrap harness lifecycle E2E (PGLite + real serve --http)', () => {
  let parent: string; // GBRAIN_HOME parent for the brain
  let sandboxHome: string; // HOME for user-scope writes
  let codexHome: string;
  let server: ChildProcess | null = null;
  let token = '';
  let serverReady = false;

  const userSettings = () => join(sandboxHome, '.claude', 'settings.json');
  const codexConfig = () => join(codexHome, 'config.toml');

  function makeClaudeRunner(): { runner: ExecRunner; calls: string[][] } {
    const calls: string[][] = [];
    const runner: ExecRunner = async (argv: string[]) => {
      calls.push(argv);
      if (argv[0] === 'claude' && argv[2] === 'get') return { code: 1, stdout: '', stderr: 'No MCP server found' };
      return { code: 0, stdout: '', stderr: '' };
    };
    return { runner, calls };
  }

  async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
    const origLog = console.log;
    const origErr = console.error;
    let out = '';
    let err = '';
    console.log = (...a: unknown[]) => { out += a.map(String).join(' ') + '\n'; };
    console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
    try {
      return { result: await fn(), out, err };
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
  }

  // CLAUDE_CONFIG_DIR is the load-bearing override: Bun's homedir() ignores a
  // remapped HOME (it reads the password database), so HOME alone does NOT
  // sandbox user-scope writes — that leak is exactly why claudeUserSettingsPath
  // honors CLAUDE_CONFIG_DIR/HOME explicitly now.
  const envFor = () => ({
    GBRAIN_HOME: parent,
    HOME: sandboxHome,
    CLAUDE_CONFIG_DIR: join(sandboxHome, '.claude'),
    CODEX_HOME: codexHome,
    // The e2e lane exports DATABASE_URL; the IN-PROCESS runBootstrap calls
    // (unlike the spawned children scrubbed in beforeAll) would otherwise
    // resolve it via loadConfig's env>file precedence and mint tokens
    // against Postgres while the live serve is PGLite-backed — turning the
    // expected refusal into an invalid_token rollback. withEnv treats
    // undefined as delete-with-restore.
    DATABASE_URL: undefined,
    GBRAIN_DATABASE_URL: undefined,
  });

  beforeAll(async () => {
    parent = mkdtempSync(join(tmpdir(), 'gb-harness-e2e-'));
    sandboxHome = mkdtempSync(join(tmpdir(), 'gb-harness-home-'));
    codexHome = mkdtempSync(join(tmpdir(), 'gb-harness-codex-'));
    // codex "installed" for detection purposes: the config file exists.
    writeFileSync(codexConfig(), '# preexisting codex config\nmodel = "o5"\n');

    const env: Record<string, string | undefined> = { ...process.env, GBRAIN_HOME: parent };
    delete env.DATABASE_URL;
    delete env.GBRAIN_DATABASE_URL;

    execFileSync('bun', ['run', 'src/cli.ts', 'init', '--pglite', '--no-embedding', '--non-interactive'], {
      cwd: process.cwd(), env, stdio: 'ignore',
    });
    // Pre-mint the scoped token BEFORE serve starts — PGLite is single-writer,
    // which is exactly the documented reason the --token lane exists.
    const authOut = execFileSync(
      'bun',
      ['run', 'src/cli.ts', 'auth', 'create', 'bootstrap-harness', '--scopes', 'read,write'],
      { cwd: process.cwd(), env, encoding: 'utf8' },
    );
    token = (authOut.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    if (!token) throw new Error(`auth create did not yield a token:\n${authOut}`);
    expect(authOut).toContain('scopes=["read","write"]');

    server = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--bind', '127.0.0.1', '--port', String(PORT),
      '--public-url', BASE,
    ], { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let serr = '';
    server.stderr?.on('data', (d: Buffer) => { serr += d.toString(); });
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { serverReady = true; break; }
      } catch { /* not up yet */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!serverReady) throw new Error(`serve --http did not become ready:\n${serr}`);
  }, 90_000);

  afterAll(() => {
    if (server) { try { server.kill('SIGTERM'); } catch { /* best-effort */ } }
    for (const d of [parent, sandboxHome, codexHome]) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });

  test('mint under the live PGLite serve refuses with the two escape hatches', async () => {
    expect(serverReady).toBe(true);
    const { runner } = makeClaudeRunner();
    const { result, err } = await withEnv(envFor(), () =>
      capture(() =>
        runBootstrap(['harness', '--yes', '--port', String(PORT), '--harness', 'codex'], { runner }),
      ),
    );
    expect(result).toBe(1);
    expect(err).toMatch(/pre-mint|--token/);
    expect(err).toMatch(/stop the serve/);
  }, 60_000);

  test('apply with --token: real health + real bearer smoke; both harnesses wired; receipt + install log', async () => {
    expect(serverReady).toBe(true);
    const { runner, calls } = makeClaudeRunner();
    const { result, out } = await withEnv(envFor(), () =>
      capture(() =>
        runBootstrap(
          [
            'harness', '--yes',
            '--port', String(PORT),
            '--token', token,
            '--gbrain-bin', '/opt/fake/gbrain',
          ],
          { runner },
        ),
      ),
    );
    expect(result).toBe(0);
    // real smoke against the live serve — identity round-tripped over bearer
    expect(out).toMatch(/smoke test:/);
    expect(out).toMatch(/"engine": "pglite"/);
    // the sandbox held: nothing touched the operator's real user scope
    expect(out).not.toContain(`${process.env.HOME}/.claude/settings.json`);

    // claude lane: exec'd through the runner with user scope + our token
    const add = calls.find((c) => c[0] === 'claude' && c[2] === 'add');
    expect(add).toBeDefined();
    expect(add!.join(' ')).toContain('--scope user');
    expect(add!.join(' ')).toContain(`Bearer ${token}`);

    // user-scope sandbox writes
    const settings = JSON.parse(readFileSync(userSettings(), 'utf8')) as Record<string, unknown>;
    expect((settings.permissions as { allow: string[] }).allow).toContain('mcp__gbrain');
    expect(Object.keys(settings.hooks as object).length).toBe(5);

    // codex lane: managed block with the inline token; preexisting content intact
    const toml = readFileSync(codexConfig(), 'utf8');
    expect(toml).toContain('# preexisting codex config');
    expect(toml).toContain(CODEX_TOML_BLOCK_BEGIN);
    expect(toml).toContain(`bearer_token = "${token}"`);

    // receipt: all confirmed; supplied token → minted:false
    const home = join(parent, '.gbrain');
    const state = readHarnessReceiptState(home);
    expect(state.state).toBe('ok');
    const receipt = (state as { receipt: { targets: Array<{ state: string }>; token: { minted: boolean } } }).receipt;
    expect(receipt.targets.every((t) => t.state === 'confirmed')).toBe(true);
    expect(receipt.token.minted).toBe(false);

    // install log carries the harness phase
    const log = readFileSync(join(home, 'bootstrap', 'install.jsonl'), 'utf8');
    expect(log).toMatch(/"phase":"harness".*"outcome":"ok"/);
  }, 60_000);

  test('--status: live probes, token recovered from the codex block, exit 0', async () => {
    const { runner } = makeClaudeRunner();
    const { result, out } = await withEnv(envFor(), () =>
      capture(() => runBootstrap(['harness', '--status'], { runner })),
    );
    expect(result).toBe(0);
    expect(out).toMatch(/serve: OK/);
    expect(out).toMatch(/token: OK .*codex config block/);
  }, 60_000);

  test('--remove: host wiring cleared, codex config byte-identical to pre-apply, receipt consumed', async () => {
    const { runner } = makeClaudeRunner();
    const { result } = await withEnv(envFor(), () =>
      capture(() => runBootstrap(['harness', '--remove', '--yes'], { runner })),
    );
    expect(result).toBe(0);
    expect(readFileSync(codexConfig(), 'utf8')).toBe('# preexisting codex config\nmodel = "o5"\n');
    const settings = JSON.parse(readFileSync(userSettings(), 'utf8')) as Record<string, unknown>;
    expect(settings.permissions).toBeUndefined();
    expect(settings.hooks).toBeUndefined();
    expect(readHarnessReceiptState(join(parent, '.gbrain'))).toEqual({ state: 'absent' });
  }, 60_000);

  test('scoped token is honored end-to-end: an admin-scope op is refused over MCP', async () => {
    // The minted token carries scopes {read,write}; get_stats is an
    // admin-scope MCP op — the per-op hasScope gate must refuse it while
    // read/write ops keep working (proven by the smoke above).
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'get_stats', arguments: {} },
      }),
    });
    const text = await res.text();
    expect(text).toMatch(/insufficient_scope|requires .*admin|not permitted|scope/i);
  }, 30_000);
});
