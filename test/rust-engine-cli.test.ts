/**
 * Selecting the Rust engine through the real CLI: constructEngine loads the verified addon, turns a loader refusal into
 * the same typed error before the brain is touched, and opens the engine shell, which refuses every command with
 * engine_capability_missing. Also proves nobody on PGLite loads the loader or the shell.
 *
 * Authoring gate (docs/TESTING.md):
 * 1. Protects: `engine: rust` in config reaches loadRustEngineAddon then openRustEngine; a missing or mismatched addon
 *    ends in rust_engine_addon_missing or rust_engine_addon_mismatch (same code and reason the loader raised); a good
 *    addon ends in engine_capability_missing on every command; none of it writes the brain, and `engine status --probe`
 *    reports the refusal. A PGLite brain never imports the loader, the shell or its member table.
 * 2. Credible regressions: constructEngine falling back to PGLite or Postgres for rust; swallowing the loader refusal;
 *    a command that works on a rust brain by treating it as Postgres; importing the shell for every engine.
 * 3. Why not already covered: test/rust-engine-addon-loader.test.ts stops at the loader; test/rust-engine-shell.test.ts
 *    stops at the shell. Only the CLI joins them.
 * 4. Production seam: none. It spawns `src/cli.ts` with GBRAIN_HOME and GBRAIN_RUST_ENGINE_ADDON.
 *
 * The happy-path tests need the real addon from `bun run rust:build`; without it they skip (set
 * GBRAIN_TEST_RUST_ADDON_REQUIRED=1, as the `addon` job in .github/workflows/rust-engine.yml does on both targets after
 * its build step, to fail instead).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';

const ROOT = join(import.meta.dir, '..');
const TARGET = detectAddonTarget();
const BUILT = TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '';
const HAVE_ADDON = !!TARGET && existsSync(BUILT);

/**
 * A refused command writes no store data. Opening a Rust brain elects its owner first (owner IPC), which may leave
 * `<database_path>.gbrain-owner.lock` beside the brain and a `<database_path>/` directory holding only the owner
 * socket's entries; anything else there is store data.
 */
const OWNER_IPC_ENTRIES = new Set(['.gbrain-owner.sock', '.gbrain-owner.sock.bind.lock']);
function expectNoStoreData(home: string, dbPath: string): void {
  if (existsSync(dbPath)) {
    expect(statSync(dbPath).isDirectory()).toBe(true);
    expect(readdirSync(dbPath).filter((e) => !OWNER_IPC_ENTRIES.has(e))).toEqual([]);
  }
  const base = dbPath.slice(dbPath.lastIndexOf('/') + 1);
  const beside = readdirSync(home).filter((e) => e.startsWith(base) && e !== base && e !== `${base}.gbrain-owner.lock`);
  expect(beside).toEqual([]);
}
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') {
  throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${BUILT || 'no addon target'} does not exist; run bun run rust:build`);
}
const withAddon = test.skipIf(!HAVE_ADDON);

let dirs: string[] = [];
beforeEach(() => { dirs = []; });
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

describe('selecting the rust engine through the real CLI', () => {
  async function runCli(args: string[], env: Record<string, string>, preload?: string) {
    const proc = Bun.spawn([process.execPath, ...(preload ? ['--preload', preload] : []), join(ROOT, 'src', 'cli.ts'), ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: env.GBRAIN_HOME!, GBRAIN_NO_AUTOPILOT_INSTALL: '1', ...env },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { out: stdout + stderr, code };
  }
  function rustHome(): { home: string; dbPath: string } {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-rust-cli-'));
    dirs.push(home);
    const dbPath = join(home, 'brain.rust');
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: dbPath }));
    return { home, dbPath };
  }

  test('an addon that cannot be found refuses with rust_engine_addon_missing before the brain is created', async () => {
    const { home, dbPath } = rustHome();
    const { out, code } = await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: join(home, 'missing.node') });
    expect(code).toBe(1);
    expect(out).toContain('Error [rust_engine_addon_missing]');
    expect(out).toContain('GBRAIN_RUST_ENGINE_ADDON');
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 60_000);

  test('an addon file that does not load refuses with rust_engine_addon_mismatch (load_failed) before the brain is created', async () => {
    const { home, dbPath } = rustHome();
    const bad = join(home, 'bad.node');
    writeFileSync(bad, 'not an addon');
    const { out, code } = await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: bad });
    expect(code).toBe(1);
    expect(out).toContain('Error [rust_engine_addon_mismatch]');
    expect(out).toContain('could not be loaded');
    expect(existsSync(dbPath)).toBe(false);
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 60_000);

  test('a rust brain with no absolute database_path refuses with config_error before the addon loads', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-rust-nopath-'));
    dirs.push(home);
    mkdirSync(join(home, '.gbrain'), { recursive: true });
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'rust', database_path: 'relative/brain.rust' }));
    const { out, code } = await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: join(home, 'missing.node') });
    expect(code).toBe(1);
    expect(out).toContain('Error [config_error]');
    expect(out).toContain('absolute database_path');
    expect(out).not.toContain('rust_engine_addon_');
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 60_000);

  withAddon('a verified addon reaches the engine shell, which refuses engine_capability_missing and writes no store data', async () => {
    const { home, dbPath } = rustHome();
    const { out, code } = await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT });
    expect(code).toBe(1);
    expect(out).toContain('Error [engine_capability_missing]');
    expect(out).toContain('the raw_sql capability');
    expect(out).toContain('so nothing ran');
    expect(out).not.toContain('rust_engine_addon_');
    expectNoStoreData(home, dbPath);
  }, 60_000);

  withAddon('engine status --probe on a rust brain with a real addon reports the shell\'s capability refusal', async () => {
    const { home, dbPath } = rustHome();
    const { out, code } = await runCli(['engine', 'status', '--json', '--probe'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT });
    expect(code).toBe(1);
    const report = JSON.parse(out.slice(out.indexOf('{')));
    expect(report.probe).toMatchObject({ ok: false, note: 'engine_capability_missing', refusal: { code: 'engine_capability_missing', reason: 'raw_sql' } });
    expectNoStoreData(home, dbPath);
  }, 60_000);

  withAddon('a spread of commands on a rust brain all stop at a typed refusal and write no store data', async () => {
    const { home, dbPath } = rustHome();
    for (const args of [['get', 'x'], ['search', 'x'], ['stats'], ['sources', 'list'], ['config', 'get', 'x'], ['jobs', 'list']]) {
      const { out, code } = await runCli(args, { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: BUILT });
      expect({ args, code, refused: out.includes('Error [engine_capability_missing]') }).toEqual({ args, code: 1, refused: true });
    }
    expectNoStoreData(home, dbPath);
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
  }, 120_000);

  test('PGLite never loads the loader, the shell or its member table, or creates engines/, through init, put and get', async () => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-no-rust-'));
    dirs.push(home);
    const log = join(home, 'rust-engine-loads.log');
    const preload = join(home, 'trace-loads.ts');
    writeFileSync(preload, `
      import { appendFileSync } from 'node:fs';
      Bun.plugin({ name: 'trace-rust-engine', setup(b) {
        b.onResolve({ filter: /rust-engine(\\.ts|\\/(addon-|members))/ }, (args) => { appendFileSync(${JSON.stringify(log)}, args.path + '\\n'); return undefined; });
      } });
    `);
    const env = { GBRAIN_HOME: home };
    expect((await runCli(['init', '--pglite', '--no-embedding'], env, preload)).code).toBe(0);
    const put = Bun.spawn([process.execPath, '--preload', preload, join(ROOT, 'src', 'cli.ts'), 'put', 'people/no-rust'], {
      cwd: ROOT, env: { PATH: process.env.PATH ?? '', HOME: home, GBRAIN_NO_AUTOPILOT_INSTALL: '1', GBRAIN_HOME: home }, stdin: new Blob(['---\ntitle: No Rust\n---\n\nplain pglite\n']), stdout: 'pipe', stderr: 'pipe',
    });
    expect(await put.exited).toBe(0);
    const get = await runCli(['get', 'people/no-rust'], env, preload);
    expect(get.code).toBe(0);
    expect(get.out).toContain('plain pglite');
    expect(existsSync(join(home, '.gbrain', 'engines'))).toBe(false);
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
  }, 180_000);

  test('the trace sees the loader when the rust engine is selected (the PGLite proof above can fail)', async () => {
    const { home } = rustHome();
    const log = join(home, 'loads.log');
    const preload = join(home, 'trace-loads.ts');
    writeFileSync(preload, `
      import { appendFileSync } from 'node:fs';
      Bun.plugin({ name: 'trace-rust-engine', setup(b) {
        b.onResolve({ filter: /rust-engine(\\.ts|\\/(addon-|members))/ }, (args) => { appendFileSync(${JSON.stringify(log)}, args.path + '\\n'); return undefined; });
      } });
    `);
    await runCli(['list'], { GBRAIN_HOME: home, GBRAIN_RUST_ENGINE_ADDON: join(home, 'missing.node') }, preload);
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toContain('addon-loader');
  }, 60_000);
});

