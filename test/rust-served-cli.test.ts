/**
 * The agent-facing CLI on a served Rust brain (protocol v3) against the same CLI on the same brain embedded.
 *
 * One Rust brain B is made with the real CLI (`src/cli.ts`, one child process per command: `import --no-embed` of
 * test/fixtures/rust-cli-parity-brain, then `extract all --source db`, as test/rust-cli-parity.serial.test.ts does).
 * Every read command below then runs with `--json` three ways, each in its own child process:
 *
 *  1. embedded: B's own home and the addon, no serve running (run twice, to show what differs between two runs);
 *  2. served client: a second home whose config is `{ engine: 'rust', rust_server: { url, token_env } }` with no
 *     database_path, a child env WITHOUT the addon variable, GBRAIN_RUST_MULTIUSER=1 and the owner server token in
 *     GBRAIN_RUST_SERVER_TOKEN, talking to `gbrain serve --rust-listen 127.0.0.1:0` running on B;
 *  3. embedded as a second process while that serve runs (a v2 local client of the same brain).
 *
 * Comparison is on exact bytes (stdout and exit code). The one normalisation: the value of the timing keys `latency_ms`
 * and `elapsed_ms` (wall-clock milliseconds a command measured about itself, which two embedded runs of `search-exact`
 * and `orphans` already print differently) is replaced by `<ms>`. A test shows the embedded runs of every command agree
 * byte for byte under that normalisation alone, so nothing else is ever hidden.
 *
 * Negative cases: a wrong token fails with permission_denied and never prints the token; with GBRAIN_RUST_MULTIUSER
 * unset a config's rust_server is ignored, so the client behaves exactly like one whose config has no rust_server.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 * 1. Protects: that a Rust brain served to another machine answers the agent-facing CLI exactly as the embedded
 *    brain does, through the public config path (config rust_server + token env), on a client with no brain
 *    directory and no addon.
 * 2. Fails when: a served read prints other bytes or exits differently than the embedded read; the client creates a
 *    brain directory; a wrong token is accepted or its text is printed; rust_server is honoured with multi-user off.
 * 3. Existing coverage: test/rust-served-wire.test.ts drives the wire protocol in process; nothing runs the CLI
 *    across it.
 * 4. Seams: none. It runs the real CLI and the real addon (`bun run rust:build`), and skips without it
 *    (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes a missing addon an error).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const FIXTURE = join(ROOT, 'test', 'fixtures', 'rust-cli-parity-brain');
const TARGET = detectAddonTarget();
const ADDON = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(ADDON);
if (!HAVE_ADDON && (process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' || process.env.GBRAIN_TEST_REQUIRE_RUST_ADDON === '1')) {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist; run bun run rust:build`);
}

interface Run { exitCode: number; stdout: string; stderr: string }
interface Home { dir: string; db: string }
interface Overrides { addon?: boolean; multiuser?: boolean; token?: string; listen?: string }

let root = '';
let brain: Home;
let client: Home;
let ownerToken = '';
let serve: ReturnType<typeof Bun.spawn> | undefined;
let serveStderr = '';
let servePort = 0;
/** How the owner token was minted and the serve started; filled by the first test so a stale flag registry is reported, not hidden. */
const setupNotes: string[] = [];

function writeConfig(home: Home, config: Record<string, unknown>): void {
  mkdirSync(join(home.dir, '.gbrain'), { recursive: true });
  writeFileSync(join(home.dir, '.gbrain', 'config.json'), JSON.stringify(config));
}

/** The child env: the test process's, minus brain selectors and provider keys, plus this home and the given switches. */
function childEnv(home: Home, o: Overrides): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of Object.keys(out)) {
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON|GBRAIN_RUST_MULTIUSER|GBRAIN_RUST_SERVER_\w+)$/.test(key)) delete out[key];
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) delete out[key]; // keyless: no provider is ever called
  }
  return {
    ...out,
    HOME: home.dir,
    GBRAIN_HOME: home.dir,
    GBRAIN_SELF_UPGRADE_MODE: 'off',
    GBRAIN_SKIP_STARTUP_HOOKS: '1',
    GBRAIN_SWEEP: '0',
    TZ: 'UTC',
    ...(o.addon ? { GBRAIN_RUST_ENGINE_ADDON: ADDON } : {}),
    ...(o.multiuser ? { GBRAIN_RUST_MULTIUSER: '1' } : {}),
    ...(o.token !== undefined ? { GBRAIN_RUST_SERVER_TOKEN: o.token } : {}),
    ...(o.listen ? { GBRAIN_RUST_SERVER_LISTEN: o.listen } : {}),
  };
}

async function cli(home: Home, o: Overrides, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: childEnv(home, o), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

const embedded = (args: string[]) => cli(brain, { addon: true, multiuser: true }, args);
const served = (args: string[], token = ownerToken) => cli(client, { multiuser: true, token }, args);

// ---- the commands ----------------------------------------------------------------------------------------------

/** Read commands with `--json` that run keyless on the fixture (a subset of the parity test's list). */
const COMMANDS: string[][] = [
  ['get', 'people/alice-example', '--json'],
  ['get', 'companies/acme-example', '--json'],
  ['list', '--json'],
  ['list', '--type', 'person', '--json'],
  ['list', '--tag', 'search', '--json'],
  ['find', 'people/*', '--json'],
  ['search', 'keyword', '--match', 'keyword', '--json'],
  ['search', 'graph memory', '--match', 'keyword', '--json'],
  ['search-exact', 'graph memory', '--json'],
  ['query', 'keyword ranking', '--no-expand', '--json'],
  ['tags', 'people/alice-example', '--json'],
  ['links', 'people/alice-example', '--json'],
  ['backlinks', 'companies/acme-example', '--json'],
  ['graph', 'people/alice-example', '--depth', '2', '--json'],
  ['timeline', 'companies/acme-example', '--json'],
  ['history', 'people/alice-example', '--json'],
  ['whois', 'alice', '--json'],
  ['orphans', '--json'],
  ['rank-entities', '--json'],
  ['stats', '--json'],
  ['stats', '--by', 'source,type', '--json'],
  ['sources', 'list', '--json'],
];

const label = (args: string[]) => args.map((a) => (/\s|\*/.test(a) ? JSON.stringify(a) : a)).join(' ');

// ---- the one normalisation ---------------------------------------------------------------------------------------

/** Wall-clock milliseconds a command measured about itself: they differ between any two runs, embedded or served. */
const TIMING = /("(?:latency_ms|elapsed_ms)":\s*)\d+/g;
const timed = (text: string): string => text.replace(TIMING, '$1"<ms>"');

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

// ---- state -----------------------------------------------------------------------------------------------------

/** Embedded runs made before the serve started: `[first, second]` per command. */
const baseline = new Map<string, [Run, Run]>();
/** Commands whose two embedded runs differ in raw bytes (only the timing keys may differ; checked below). */
const timingOnly: string[] = [];

/** Wait for the serve's listening line; returns its port. */
async function readPort(proc: ReturnType<typeof Bun.spawn>): Promise<number> {
  const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 90_000;
  void (async () => {
    // Keep draining stderr for the life of the serve so its pipe never fills.
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      serveStderr += decoder.decode(value);
    }
  })();
  while (Date.now() < deadline) {
    const hit = /brain server listening on [\d.]+:(\d+)/.exec(serveStderr);
    if (hit) return Number(hit[1]);
    if (proc.exitCode !== null) throw new Error(`gbrain serve exited ${proc.exitCode} before listening:\n${serveStderr.slice(-2000)}`);
    await Bun.sleep(100);
  }
  throw new Error(`gbrain serve did not print its listening line in 90 s:\n${serveStderr.slice(-2000)}`);
}

/** Starts `gbrain serve --rust-listen 127.0.0.1:0` on B; stdin stays open (stdio serve exits when it closes). */
async function startServe(args: string[], extra: Overrides): Promise<void> {
  serve = Bun.spawn(['bun', 'run', CLI, 'serve', ...args], {
    cwd: root, env: childEnv(brain, { addon: true, multiuser: true, ...extra }), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  void new Response(serve.stdout as ReadableStream).text(); // drain
  servePort = await readPort(serve);
}

/** Runs the child script that mints the owner token the way `auth create --rust-server-owner` does, bypassing the CLI's flag check. */
async function mintWithoutCliFlag(): Promise<string> {
  const script = join(root, 'mint-owner-token.ts');
  writeFileSync(script, `
    import { loadConfig, toEngineConfig } from ${JSON.stringify(join(ROOT, 'src/core/config.ts'))};
    import { createEngine } from ${JSON.stringify(join(ROOT, 'src/core/engine-factory.ts'))};
    import { mintOwnerServerToken } from ${JSON.stringify(join(ROOT, 'src/core/rust-engine/served/owner-token.ts'))};
    const config = toEngineConfig(loadConfig()!);
    const engine = await createEngine(config);
    await engine.connect(config);
    const { token } = await mintOwnerServerToken(engine, 'served-cli');
    await engine.disconnect();
    console.log('TOKEN=' + token);
  `);
  const proc = Bun.spawn(['bun', 'run', script], { cwd: root, env: childEnv(brain, { addon: true, multiuser: true }), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const token = /TOKEN=(\S+)/.exec(out)?.[1];
  if (code !== 0 || !token) throw new Error(`minting the owner token in process failed (${code}): ${out}\n${err}`);
  return token;
}

describe.skipIf(!HAVE_ADDON)('the CLI on a served Rust brain prints what the CLI on the embedded brain prints', () => {
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-rust-served-cli-'));
    brain = { dir: join(root, 'brain', 'home'), db: join(root, 'brain', 'db') };
    client = { dir: join(root, 'client', 'home'), db: '' };
    writeConfig(brain, { engine: 'rust', database_path: brain.db });
    // The client's config is the public path: engine, the server's address, and the NAME of the variable holding the token.
    // It has no database_path.

    // 1. B, built with the real CLI.
    for (const args of [['import', FIXTURE, '--no-embed', '--json'], ['extract', 'all', '--source', 'db', '--json']]) {
      const r = await embedded(args);
      if (r.exitCode !== 0) throw new Error(`setup ${label(args)} failed (${r.exitCode}): ${r.stdout}\n${r.stderr}`);
    }

    // 2. embedded baseline, no serve running: two runs of every command.
    for (const args of COMMANDS) {
      const first = await embedded(args);
      const second = await embedded(args);
      baseline.set(label(args), [first, second]);
      if (first.stdout !== second.stdout) timingOnly.push(label(args));
    }

    // 3. the owner token: the CLI first, the same code in process when the CLI refuses the flag.
    const minted = await embedded(['auth', 'create', 'served-cli', '--rust-server-owner']);
    ownerToken = /gbrain_[A-Za-z0-9_-]+/.exec(minted.stdout)?.[0] ?? '';
    if (minted.exitCode !== 0 || !ownerToken) {
      setupNotes.push(`gbrain auth create served-cli --rust-server-owner exited ${minted.exitCode}: ${(minted.stderr + minted.stdout).split('\n').filter((l) => /error|unknown|fix/i.test(l)).slice(0, 2).join(' | ')}`);
      ownerToken = await mintWithoutCliFlag();
    }

    // 4. the serve: the flag first, the env variable it stands for when the CLI refuses the flag.
    try {
      await startServe(['--rust-listen', '127.0.0.1:0'], {});
    } catch (e) {
      setupNotes.push(`gbrain serve --rust-listen 127.0.0.1:0 did not start: ${String(e instanceof Error ? e.message : e).split('\n').slice(0, 2).join(' | ')}`);
      serveStderr = '';
      await startServe([], { listen: '127.0.0.1:0' });
    }
    writeConfig(client, { engine: 'rust', rust_server: { url: `gbrain+tcp://127.0.0.1:${servePort}`, token_env: 'GBRAIN_RUST_SERVER_TOKEN' } });
  }, 900_000);

  afterAll(() => {
    try { (serve?.stdin as { end?: () => void } | undefined)?.end?.(); } catch { /* already closed */ }
    try { serve?.kill(); } catch { /* already gone */ }
    if (setupNotes.length) console.log(`[rust served cli] setup notes:\n  ${setupNotes.join('\n  ')}`);
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('the owner token is minted by `auth create --rust-server-owner` and the serve starts with --rust-listen', () => {
    expect(setupNotes).toEqual([]);
  });

  test('the serve listens on a loopback port and the client config has no database_path', () => {
    expect(servePort).toBeGreaterThan(0);
    expect(serveStderr).toContain('plain TCP, loopback only');
    expect(ownerToken).toMatch(/^gbrain_/);
    const config = JSON.parse(readFileSync(join(client.dir, '.gbrain', 'config.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(config).sort()).toEqual(['engine', 'rust_server']);
  });

  test('the embedded baseline answers every command with JSON and exit 0 (the reference is sound)', () => {
    const bad = COMMANDS.filter((args) => {
      const [first] = baseline.get(label(args))!;
      return first.exitCode !== 0 || parseJson(first.stdout) === undefined;
    }).map(label);
    expect(bad).toEqual([]);
  });

  for (const args of COMMANDS) {
    test(label(args), async () => {
      const [first] = baseline.get(label(args))!;
      const [remote, local] = [await served(args), await embedded(args)]; // local: a v2 client of B while the serve runs
      for (const [side, got] of [['served client', remote], ['embedded while serving', local]] as const) {
        if (got.exitCode !== first.exitCode || timed(got.stdout) !== timed(first.stdout)) {
          console.log(`[rust served cli] ${side} differs on ${label(args)} (exit ${got.exitCode}); stderr head: ${got.stderr.slice(0, 400)}`);
        }
        expect({ side, exitCode: got.exitCode, stdout: timed(got.stdout) }).toEqual({ side, exitCode: first.exitCode, stdout: timed(first.stdout) });
      }
      // The served client printed no brain-side path or token.
      expect(remote.stdout + remote.stderr).not.toContain(ownerToken);
    }, 240_000);
  }

  test('two embedded runs of every command agree byte for byte once the timing values are replaced', () => {
    const differ = COMMANDS.filter((args) => {
      const [first, second] = baseline.get(label(args))!;
      return first.exitCode !== second.exitCode || timed(first.stdout) !== timed(second.stdout);
    }).map(label);
    expect(differ).toEqual([]);
    // Informational: the commands whose raw bytes moved between the two runs (timings only, shown by the test above).
    if (timingOnly.length) console.log(`[rust served cli] raw bytes differ between two embedded runs only in timing values: ${timingOnly.join('; ')}`);
  });

  test('the client created no brain directory and no database', () => {
    const entries = existsSync(join(client.dir, '.gbrain')) ? readdirSync(join(client.dir, '.gbrain')) : [];
    const stray = entries.filter((name) => name !== 'config.json');
    // (`.bun` in the home is Bun's own cache directory, made because HOME points at the test home.)
    // Nothing the brain would hold: no database directory, pglite or rust store, lock or owner socket.
    expect(stray.filter((name) => /brain|db|pglite|rust|store|lock|sock|\.node/i.test(name))).toEqual([]);
    expect(existsSync(join(client.dir, '.gbrain', 'brain'))).toBe(false);
    expect(readdirSync(client.dir).filter((name) => name !== '.gbrain' && name !== '.bun')).toEqual([]);
  });

  test('a wrong token exits non-zero with permission_denied and prints no token text', async () => {
    const wrong = `gbrain_${'0'.repeat(64)}`;
    const r = await served(['get', 'people/alice-example', '--json'], wrong);
    const text = r.stdout + r.stderr;
    expect(r.exitCode).not.toBe(0);
    expect(text).toContain('permission_denied');
    expect(text).not.toContain(wrong);
    expect(text).not.toContain(ownerToken);
    expect(r.stdout).not.toContain('alice');
  }, 120_000);

  test('with GBRAIN_RUST_MULTIUSER unset rust_server is ignored: the client behaves like one without it', async () => {
    const args = ['get', 'people/alice-example', '--json'];
    const withServer = await cli(client, { token: ownerToken }, args);
    const bare: Home = { dir: join(root, 'bare', 'home'), db: '' };
    writeConfig(bare, { engine: 'rust' });
    const without = await cli(bare, { token: ownerToken }, args);
    expect(withServer.exitCode).not.toBe(0);
    expect(withServer.stdout).not.toContain('alice');
    const comparable = (run: Run, home: Home) => ({
      exitCode: run.exitCode,
      stdout: run.stdout.split(home.dir).join('<home>'),
      stderr: run.stderr.split(home.dir).join('<home>').split(`${servePort}`).join('<port>'),
    });
    expect(comparable(withServer, client)).toEqual(comparable(without, bare));
  }, 120_000);
});
