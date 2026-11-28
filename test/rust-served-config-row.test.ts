/**
 * A brain server whose multi-user mode comes only from the brain's own config row (`engine.rust.multiuser`), with the
 * environment switch GBRAIN_RUST_MULTIUSER unset in the serve process: `gbrain serve --rust-listen` starts, and a
 * served client gets the answers the embedded brain gives.
 *
 * 1. Protects: interface I-0.v2 on the server path. The store resolves the mode at open from the switch or the config
 *    row, and the serve, the owner token and the listener read the store's answer, so an operator can turn multi-user
 *    mode on per brain without the environment variable.
 * 2. Fails on: a serve, owner-token mint or listener that reads only the environment switch (it refuses with
 *    `engine_capability_missing` reason `served` while the row says on), or a config-row server that answers a served
 *    client differently from the embedded brain.
 * 3. Existing coverage: rust-served-cli.test.ts starts the serve with the environment switch only; the served parity
 *    set's config route runs an in-process owner, not `gbrain serve`.
 * 4. Seam: none. The real CLI (`src/cli.ts`, one child process per command) builds the brain, writes the row with
 *    `gbrain config set`, mints the token with `auth create --rust-server-owner` and runs `gbrain serve`. Every child of
 *    the brain's machine runs with GBRAIN_RUST_MULTIUSER removed from its environment. The client is the other machine:
 *    it has no brain and no addon, and turns the mode on with its own switch, as the design note says a client does.
 *    Needs the addon `bun run rust:build` writes.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { RUST_MULTIUSER_CONFIG_KEY, RUST_MULTIUSER_ENV } from '../src/core/rust-engine/multiuser-switch.ts';

const ROOT = join(import.meta.dir, '..');
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

let root = '';
let brain: Home;
let client: Home;
let serve: ReturnType<typeof Bun.spawn> | undefined;
let serveStderr = '';

function writeConfig(home: Home, config: Record<string, unknown>): void {
  mkdirSync(join(home.dir, '.gbrain'), { recursive: true });
  writeFileSync(join(home.dir, '.gbrain', 'config.json'), JSON.stringify(config));
}

/** The child env: the test process's minus brain selectors, provider keys and the multi-user switch, plus this home. */
function childEnv(home: Home, extra: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(DATABASE_URL|GBRAIN_DATABASE_URL|GBRAIN_BRAIN_ID|GBRAIN_SOURCE|GBRAIN_RUST_ENGINE_ADDON|GBRAIN_RUST_\w+)$/.test(key)) continue;
    if (/(_API_KEY|_API_TOKEN)(__|$)/.test(key)) continue; // keyless: no provider is ever called
    out[key] = value;
  }
  return { ...out, HOME: home.dir, GBRAIN_HOME: home.dir, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', TZ: 'UTC', ...extra };
}

/** A command on the brain's machine: the addon, and never the environment switch. */
const brainEnv = () => childEnv(brain, { GBRAIN_RUST_ENGINE_ADDON: ADDON });

async function cli(env: Record<string, string>, args: string[]): Promise<Run> {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

/** Starts `gbrain serve --rust-listen 127.0.0.1:0` on the brain; resolves with its port, or rejects with its stderr when it exits. */
async function startServe(): Promise<number> {
  serveStderr = '';
  serve = Bun.spawn(['bun', 'run', CLI, 'serve', '--rust-listen', '127.0.0.1:0'], { cwd: root, env: brainEnv(), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  void new Response(serve.stdout as ReadableStream).text();
  const reader = (serve.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  void (async () => { for (;;) { const { value, done } = await reader.read(); if (done) return; serveStderr += decoder.decode(value); } })();
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const hit = /brain server listening on [\d.]+:(\d+)/.exec(serveStderr);
    if (hit) return Number(hit[1]);
    if (serve.exitCode !== null) throw new Error(`gbrain serve exited ${serve.exitCode} before listening:\n${serveStderr.slice(-2000)}`);
    await Bun.sleep(100);
  }
  throw new Error(`gbrain serve did not print its listening line in 90 s:\n${serveStderr.slice(-2000)}`);
}

function stopServe(): void {
  try { (serve?.stdin as { end?: () => void } | undefined)?.end?.(); } catch { /* already closed */ }
  try { serve?.kill(); } catch { /* already gone */ }
  serve = undefined;
}

const COMMANDS: string[][] = [
  ['get', 'people/alice-example', '--json'],
  ['list', '--type', 'person', '--json'],
  ['backlinks', 'companies/acme-example', '--json'],
  ['stats', '--json'],
];

describe.skipIf(!HAVE_ADDON)('a brain server in multi-user mode by its config row only', () => {
  let refusedBeforeRow: Run | { exitCode: number; stderr: string } | undefined;
  let ownerToken = '';
  let port = 0;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'gb-rust-served-config-row-'));
    brain = { dir: join(root, 'brain', 'home'), db: join(root, 'brain', 'db') };
    client = { dir: join(root, 'client', 'home'), db: '' };
    writeConfig(brain, { engine: 'rust', database_path: brain.db });
    for (const args of [['import', FIXTURE, '--no-embed', '--json'], ['extract', 'all', '--source', 'db', '--json']]) {
      const r = await cli(brainEnv(), args);
      if (r.exitCode !== 0) throw new Error(`setup ${args.join(' ')} failed (${r.exitCode}): ${r.stdout}\n${r.stderr}`);
    }
    // Before the row: the serve refuses, so the mode below comes from the row and nothing else.
    try { await startServe(); refusedBeforeRow = undefined; } catch (error) { refusedBeforeRow = { exitCode: serve?.exitCode ?? -1, stderr: serveStderr || String(error) }; }
    stopServe();
    const set = await cli(brainEnv(), ['config', 'set', RUST_MULTIUSER_CONFIG_KEY, 'true']);
    if (set.exitCode !== 0) throw new Error(`gbrain config set ${RUST_MULTIUSER_CONFIG_KEY} true failed (${set.exitCode}): ${set.stdout}\n${set.stderr}`);
    const minted = await cli(brainEnv(), ['auth', 'create', 'served-config-row', '--rust-server-owner']);
    ownerToken = /gbrain_[A-Za-z0-9_-]+/.exec(minted.stdout)?.[0] ?? '';
    if (minted.exitCode !== 0 || !ownerToken) throw new Error(`auth create --rust-server-owner failed (${minted.exitCode}): ${minted.stderr}`);
    port = await startServe();
    writeConfig(client, { engine: 'rust', rust_server: { url: `gbrain+tcp://127.0.0.1:${port}`, token_env: 'GBRAIN_RUST_SERVER_TOKEN' } });
  }, 900_000);

  afterAll(() => {
    stopServe();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  test('every process on the brain machine runs without the environment switch', () => {
    expect(brainEnv()[RUST_MULTIUSER_ENV]).toBeUndefined();
    expect(Object.keys(brainEnv()).filter((k) => k.startsWith('GBRAIN_RUST_') && k !== 'GBRAIN_RUST_ENGINE_ADDON')).toEqual([]);
  });

  test('before the config row is set, gbrain serve --rust-listen refuses: multi-user Rust is off', () => {
    expect(refusedBeforeRow).toBeDefined();
    expect(refusedBeforeRow!.exitCode).not.toBe(0);
    expect(refusedBeforeRow!.stderr).toContain('needs multi-user Rust');
  });

  test('with the config row set, the owner token is minted and gbrain serve --rust-listen listens', () => {
    expect(ownerToken).toMatch(/^gbrain_/);
    expect(port).toBeGreaterThan(0);
    expect(serve?.exitCode ?? null).toBeNull();
  });

  for (const args of COMMANDS) {
    test(`served ${args.join(' ')} prints what the embedded brain prints`, async () => {
      const servedRun = await cli(childEnv(client, { [RUST_MULTIUSER_ENV]: '1', GBRAIN_RUST_SERVER_TOKEN: ownerToken }), args);
      // The embedded run is a second process on the brain while the serve owns it (a v2 local client), switch unset.
      const embeddedRun = await cli(brainEnv(), args);
      expect({ exitCode: servedRun.exitCode, stdout: servedRun.stdout }).toEqual({ exitCode: embeddedRun.exitCode, stdout: embeddedRun.stdout });
      expect(servedRun.exitCode).toBe(0);
      expect(servedRun.stdout).not.toContain(ownerToken);
    }, 120_000);
  }
});
