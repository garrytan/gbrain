/**
 * GST-2784: after `gbrain setup codex`, Codex starts gbrain serve through the
 * hook launcher with whatever PATH the Codex process has. The script-mode
 * install's gbrain is src/cli.ts, whose shebang is `#!/usr/bin/env bun`, so a
 * Codex started without bun on its PATH (the desktop app, a launcher) failed
 * with "/usr/bin/env: 'bun': No such file or directory" and showed no tools.
 * Every entry setup writes runs through the launcher, which now carries the
 * Bun that setup ran under; a compiled gbrain needs no Bun and gets none.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { readCodexTomlTable } from '../src/core/bootstrap/codex-toml.ts';
import { HOOK_LAUNCHER_SCRIPT, ensureHookLauncher, hookLauncherScript, hookLauncherState, launcherRuntimeDir } from '../src/core/setup/hook-launcher.ts';
import { hookLauncherProblem } from '../src/core/setup/turn-hook-check.ts';
import { launcherLaneFindings } from '../src/core/setup/launcher-lanes.ts';
import { refreshHookLaunchers } from '../src/core/setup/hook-launcher-refresh.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const BARE_PATH = '/usr/bin:/bin';
const SPAWN_TIMEOUT_MS = 60_000;
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A temp HOME with a script-mode gbrain: a symlink to src/cli.ts in a bin directory that holds no bun, as `bun install -g` leaves it when bun itself lives elsewhere. */
function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-bare-path-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bun-global', 'bin');
  const session = join(root, 'session');
  for (const d of [home, bin, session]) mkdirSync(d, { recursive: true });
  symlinkSync(CLI, join(bin, 'gbrain'));
  const env = { HOME: home, GBRAIN_HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SURFACE: undefined, GBRAIN_HOOKS: undefined };
  return { root, home, gbrain: join(bin, 'gbrain'), session, env, launcher: join(home, '.gbrain', 'hook-launcher', 'gbrain-hook') };
}
type Box = ReturnType<typeof box>;

/** The environment a Codex desktop app hands a stdio server or hook: no bun anywhere on PATH. */
function bareEnv(b: Box): Record<string, string> {
  expect(Bun.which('bun', { PATH: BARE_PATH })).toBeNull();
  return { HOME: b.home, GBRAIN_HOME: b.home, PATH: BARE_PATH };
}

async function setupCodex(b: Box) {
  const r = await runCli(['setup', 'codex', '--json', '--gbrain-bin', b.gbrain], { env: b.env });
  expect(r.exitCode).toBe(0);
  return r;
}

/** Start the recorded MCP command from the session directory and send an initialize request; returns the first reply line. */
async function initializeRecordedServer(b: Box): Promise<{ reply: string; stderr: string }> {
  const entry = readCodexTomlTable(join(b.home, '.codex', 'config.toml'), ['mcp_servers', 'gbrain']) as { command: string; args: string[] };
  const proc = Bun.spawn([entry.command, ...entry.args], { cwd: b.session, env: bareEnv(b), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bare-path-test', version: '0' } } })}\n`);
  proc.stdin.flush();
  const reader = proc.stdout.getReader();
  let out = '';
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (!out.includes('\n') && Date.now() < deadline) {
    const chunk = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => null)]);
    if (!chunk || chunk.done) break;
    out += new TextDecoder().decode(chunk.value);
  }
  proc.kill();
  const stderr = await new Response(proc.stderr).text();
  return { reply: out.split('\n')[0] ?? '', stderr };
}

describe('gbrain setup codex: the recorded entries start gbrain without bun on PATH (GST-2784)', () => {
  test('the MCP server entry starts serve and answers initialize under a PATH with no bun', async () => {
    const b = box();
    await setupCodex(b);
    const { reply, stderr } = await initializeRecordedServer(b);
    expect(stderr).not.toContain('No such file or directory');
    expect(JSON.parse(reply)).toMatchObject({ jsonrpc: '2.0', id: 1, result: { serverInfo: expect.any(Object) } });
  }, 120_000);

  test('the hooks setup writes run under a PATH with no bun', async () => {
    const b = box();
    await setupCodex(b);
    const hooks = JSON.parse(readFileSync(join(b.home, '.codex', 'hooks.json'), 'utf8')).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const commands = Object.values(hooks).flat().flatMap((g) => g.hooks.map((h) => h.command)).filter((c) => c.includes(b.launcher) && !c.includes('nohup'));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      const r = Bun.spawnSync(['sh', '-c', command], { cwd: b.session, env: bareEnv(b), stdin: Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 'bare-path', cwd: b.session })), stdout: 'pipe', stderr: 'pipe', timeout: SPAWN_TIMEOUT_MS });
      expect(r.stderr.toString()).not.toContain('No such file or directory');
      expect(r.exitCode).toBe(0);
    }
  }, 120_000);

  test('doctor reports a launcher that does not carry the runtime, and rerunning setup codex repairs it', async () => {
    const b = box();
    await setupCodex(b);
    writeFileSync(b.launcher, HOOK_LAUNCHER_SCRIPT);
    chmodSync(b.launcher, 0o700);
    await withEnv(b.env, async () => {
      expect(hookLauncherState(b.launcher)).toMatchObject({ state: 'stale', detail: expect.stringContaining('bun') });
      expect(hookLauncherProblem('codex')).toMatchObject({ reason: 'stale' });
      expect(launcherLaneFindings().filter((f) => f.harness === 'codex' && f.lane === 'mcp')).toMatchObject([{ reason: 'stale', rerun: expect.arrayContaining(['setup', 'codex']) }]);
    });
    await setupCodex(b);
    await withEnv(b.env, async () => {
      expect(hookLauncherState(b.launcher).state).toBe('current');
      expect(hookLauncherProblem('codex')).toBeNull();
      expect(launcherLaneFindings().filter((f) => f.harness === 'codex')).toEqual([]);
    });
    expect(JSON.parse((await initializeRecordedServer(b)).reply)).toMatchObject({ id: 1, result: expect.any(Object) });
  }, 180_000);

  test('post-upgrade rewrites a launcher that does not carry the runtime, without touching config.toml or hooks.json', async () => {
    const b = box();
    await setupCodex(b);
    const files = [join(b.home, '.codex', 'config.toml'), join(b.home, '.codex', 'hooks.json')];
    const before = files.map((f) => readFileSync(f, 'utf8'));
    writeFileSync(b.launcher, HOOK_LAUNCHER_SCRIPT);
    const lines: string[] = [];
    await withEnv(b.env, async () => {
      await refreshHookLaunchers((l) => lines.push(l));
      expect(hookLauncherState(b.launcher).state).toBe('current');
      expect(hookLauncherProblem('codex')).toBeNull();
    });
    expect(lines.join('\n')).toContain(`rewrote ${b.launcher}`);
    expect(files.map((f) => readFileSync(f, 'utf8'))).toEqual(before);
    expect(JSON.parse((await initializeRecordedServer(b)).reply)).toMatchObject({ id: 1, result: expect.any(Object) });
  }, 180_000);
});

describe('the launcher carries the runtime setup ran under, and only when gbrain needs one', () => {
  test('a Bun in a non-default directory is the one the launcher puts first on PATH', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-launcher-runtime-'));
    roots.push(root);
    const bunDir = join(root, 'opt', "o'dd bun", 'bin');
    mkdirSync(bunDir, { recursive: true });
    symlinkSync(process.execPath, join(bunDir, 'bun'));
    const launcher = join(root, 'home', 'hook-launcher', 'gbrain-hook');
    ensureHookLauncher(launcher, bunDir);
    expect(readFileSync(launcher, 'utf8')).toBe(hookLauncherScript(bunDir));
    expect(hookLauncherState(launcher, bunDir).state).toBe('current');
    const r = Bun.spawnSync([launcher, 'sh', '-c', 'command -v bun'], { cwd: root, env: { PATH: BARE_PATH }, stdout: 'pipe', stderr: 'pipe' });
    expect(r.stdout.toString().trim()).toBe(join(bunDir, 'bun'));
    rmSync(join(bunDir, 'bun'));
    expect(hookLauncherState(launcher, bunDir)).toMatchObject({ state: 'stale', detail: expect.stringContaining(join(bunDir, 'bun')) });
  });

  test('the bun on PATH is recorded when it is this same Bun, so a per-version install directory a Bun upgrade deletes is not', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-launcher-onpath-'));
    roots.push(root);
    const stable = join(root, 'stable', 'bin');
    const other = join(root, 'other', 'bin');
    mkdirSync(stable, { recursive: true });
    mkdirSync(other, { recursive: true });
    symlinkSync(process.execPath, join(stable, 'bun'));
    writeFileSync(join(other, 'bun'), '#!/bin/sh\n');
    chmodSync(join(other, 'bun'), 0o755);
    expect(launcherRuntimeDir(`${stable}:${BARE_PATH}`)).toBe(stable);
    expect(launcherRuntimeDir(`${other}:${BARE_PATH}`)).toBe(resolve(process.execPath, '..'));
  });

  test('setup moves a launcher that records another Bun onto the one it runs under', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-launcher-switch-'));
    roots.push(root);
    const [a, b] = ['a', 'b'].map((n) => join(root, n, 'bin'));
    for (const d of [a!, b!]) { mkdirSync(d, { recursive: true }); symlinkSync(process.execPath, join(d, 'bun')); }
    const launcher = join(root, 'home', 'hook-launcher', 'gbrain-hook');
    ensureHookLauncher(launcher, a!);
    expect(hookLauncherState(launcher, b!).state).toBe('current');
    ensureHookLauncher(launcher, b!);
    expect(readFileSync(launcher, 'utf8')).toBe(hookLauncherScript(b!));
    ensureHookLauncher(launcher, null);
    expect(readFileSync(launcher, 'utf8')).toBe(hookLauncherScript(b!));
  });

  test('a compiled gbrain (no runtime) keeps the launcher it had, which needs no bun', () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-launcher-compiled-'));
    roots.push(root);
    const launcher = join(root, 'home', 'hook-launcher', 'gbrain-hook');
    ensureHookLauncher(launcher, null);
    expect(readFileSync(launcher, 'utf8')).toBe(HOOK_LAUNCHER_SCRIPT);
    expect(hookLauncherScript(null)).toBe(HOOK_LAUNCHER_SCRIPT);
    expect(hookLauncherState(launcher, null).state).toBe('current');
    const fake = join(root, 'gbrain');
    writeFileSync(fake, '#!/bin/sh\necho compiled-ok\n');
    chmodSync(fake, 0o755);
    const r = Bun.spawnSync([launcher, fake], { cwd: root, env: { PATH: BARE_PATH }, stdout: 'pipe' });
    expect(r.stdout.toString().trim()).toBe('compiled-ok');
    expect(existsSync(launcher)).toBe(true);
  });
});
