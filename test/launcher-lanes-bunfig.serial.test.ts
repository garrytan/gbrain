/**
 * #8426, #8428: the stdio MCP entries for gbrain serve and the remaining hook
 * lanes (gbrain bootstrap's workspace hooks and Codex SessionEnd capture,
 * gbrain bootstrap harness's hooks, the plugin hook) never let the session
 * directory's bunfig.toml or .env run. Each entry is written by its real
 * writer and started the way the harness starts it, from a checkout whose
 * bunfig.toml preload drops a marker file; the marker must never appear.
 * serve still resolves .gbrain-source from that session directory, which the
 * launcher passes on in GBRAIN_HOOK_CWD.
 *
 * SERIAL: spawns gbrain serve against one PGLite brain and mutates HOME.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { withEnv } from './helpers/with-env.ts';
import { runBootstrap } from '../src/commands/bootstrap.ts';
import type { ExecRunner } from '../src/core/bootstrap/repo.ts';
import { writeClaudeHooksAt } from '../src/core/bootstrap/hooks.ts';
import { GBRAIN_HARNESS_MARKER_VALUE } from '../src/core/bootstrap/host-specs.ts';
import { confirm, initState, readBackHash, setAnswer } from '../src/core/bootstrap/interview.ts';
import { desiredMcpEntry } from '../src/core/setup/claude-code.ts';
import { desiredCodexMcpEntry } from '../src/core/setup/codex.ts';
import { ensureHookLauncher, hookLauncherPath } from '../src/core/setup/hook-launcher.ts';
import { launcherLaneFindings } from '../src/core/setup/launcher-lanes.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const root = mkdtempSync(join(tmpdir(), 'gbrain-launcher-lanes-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const home = join(root, 'home');
const bin = join(root, 'bin');
const hostile = join(root, 'hostile-checkout');
const tmp = join(root, 'tmp');
const marker = join(root, 'PRELOAD_RAN');
const gbrain = join(bin, 'gbrain');
const launcher = hookLauncherPath(join(home, '.gbrain'));
const env: Record<string, string> = { HOME: home, GBRAIN_HOME: home, CODEX_HOME: join(home, '.codex'), PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, GBRAIN_AGENT_INSTRUCTIONS: '0', GBRAIN_SKIP_STARTUP_HOOKS: '1' };
const procEnv = { HOME: home, GBRAIN_HOME: home, CODEX_HOME: join(home, '.codex'), CLAUDE_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined };

beforeAll(() => {
  for (const d of [home, bin, join(hostile, 'tooling'), tmp, join(root, 'source-a'), join(root, 'source-b')]) mkdirSync(d, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'bun'));
  symlinkSync(CLI, gbrain);
  writeFileSync(join(hostile, 'tooling', 'pre.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  writeFileSync(join(hostile, 'bunfig.toml'), 'preload = ["./tooling/pre.ts"]\n');
  writeFileSync(join(hostile, '.env'), 'GBRAIN_HOOKS=1\n');
  writeFileSync(join(root, 'source-a', 'a.md'), '# a\n');
  writeFileSync(join(root, 'source-b', 'b.md'), '# b\n');
  const run = (args: string[]) => {
    const r = Bun.spawnSync([gbrain, ...args], { cwd: root, env, stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
    if (r.exitCode !== 0) throw new Error(`gbrain ${args.join(' ')} failed: ${r.stderr.toString()}`);
  };
  run(['init', '--pglite', '--no-embedding']);
  // Two sources, so only the session directory's .gbrain-source picks source-b.
  run(['sources', 'add', 'source-a', '--path', join(root, 'source-a'), '--force', '--no-federated']);
  run(['sources', 'add', 'source-b', '--path', join(root, 'source-b'), '--force', '--no-federated']);
  writeFileSync(join(hostile, '.gbrain-source'), 'source-b\n');
  chmodSync(join(hostile, '.gbrain-source'), 0o600);
  ensureHookLauncher(launcher);
}, 180_000);

const clearMarker = () => rmSync(marker, { force: true });

/** Start a stdio MCP entry the way the harness does (from the session directory), write one page, and report where it landed. */
async function serveFromSession(command: string, args: string[], entryEnv: Record<string, string> = {}, slug = 'notes/probe'): Promise<string> {
  const transport = new StdioClientTransport({ command, args, env: { ...env, ...entryEnv }, cwd: hostile, stderr: 'pipe' });
  let stderr = '';
  transport.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: 'launcher-lanes', version: '1' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const r = await client.callTool({ name: 'put_page', arguments: { slug, content: '---\ntitle: probe\n---\n# probe\n' } });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    const parsed = JSON.parse(text) as { source_id?: string };
    if (!parsed.source_id) throw new Error(`put_page answered without a source: ${text}\n${stderr}`);
    return parsed.source_id;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Run a hook command the way the harness does: sh -c from the session directory, the event JSON on stdin. */
function runHook(command: string, extraEnv: Record<string, string> = {}) {
  const r = Bun.spawnSync(['sh', '-c', command], { cwd: hostile, env: { ...env, ...extraEnv }, stdin: Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 'launcher-lanes', cwd: hostile })), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  return { exitCode: r.exitCode, stderr: r.stderr.toString() };
}

async function waitForDetached() {
  for (let i = 0; i < 300 && readdirSync(tmp).length > 0; i++) await Bun.sleep(100);
  expect(readdirSync(tmp)).toEqual([]);
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('#8426: a stdio MCP entry started from a checkout whose bunfig.toml preloads code', () => {
  test('control: gbrain serve started in that checkout runs the preload (the hole the launcher closes)', async () => {
    clearMarker();
    expect(await serveFromSession(gbrain, ['serve'], {}, 'notes/control')).toBe('source-b');
    expect(existsSync(marker)).toBe(true);
  }, 90_000);

  test('gbrain setup claude-code: the MCP entry starts serve through the launcher, and serve still reads the session .gbrain-source', async () => {
    clearMarker();
    const entry = desiredMcpEntry({ name: 'gbrain', scope: 'user', launcher: gbrain, brainHome: join(home, '.gbrain'), gbrainHomeEnv: home, sourceId: null, surface: 'full', advertise: null, events: [] }) as { command: string; args: string[]; env: Record<string, string> };
    expect(entry.command).toBe(launcher);
    expect(await serveFromSession(entry.command, entry.args, entry.env, 'notes/setup-claude')).toBe('source-b');
    expect(existsSync(marker)).toBe(false);
  }, 90_000);

  test('gbrain setup codex: the [mcp_servers] table starts serve through the launcher', async () => {
    clearMarker();
    const entry = desiredCodexMcpEntry({ launcher: gbrain, brainHome: join(home, '.gbrain'), gbrainHomeEnv: home, sourceId: null, surface: 'full', advertise: null }) as { command: string; args: string[]; env: Record<string, string> };
    expect(entry.command).toBe(launcher);
    expect(await serveFromSession(entry.command, entry.args, entry.env, 'notes/setup-codex')).toBe('source-b');
    expect(existsSync(marker)).toBe(false);
  }, 90_000);
});

/** A confirmed bootstrap interview whose MCP scope is user (a project-scope .mcp.json belongs to the repository). */
function bootstrapWorkspace(): string {
  const ws = mkdtempSync(join(root, 'ws-'));
  expect(initState(ws).ok).toBe(true);
  for (const [key, value] of Object.entries({
    AGENT_NAME: 'Dispatch', PRINCIPAL_NAME: 'Pat Example',
    AGENT_PURPOSE: 'Maintain the research corpus and draft the weekly memo without re-briefing.',
    AGENT_TOP_JOBS: '- corpus upkeep\n- weekly memo\n- meeting prep',
    PRINCIPAL_CONTEXT: 'Runs a small research group; values signal over noise.',
    VOICE_REGISTER: 'Direct: three options, the second one wins.', MCP_SCOPE: 'user',
  })) {
    const r = setAnswer(ws, key, value);
    if (!r.ok) throw new Error(r.message);
  }
  const h = readBackHash(ws);
  if (!h.ok) throw new Error(h.message);
  expect(confirm(ws, h.hash).ok).toBe(true);
  return ws;
}

async function quiet<T>(fn: () => Promise<T>): Promise<{ result: T; err: string }> {
  const [log, error] = [console.log, console.error];
  let err = '';
  console.log = () => {};
  console.error = (...a: unknown[]) => { err += a.map(String).join(' ') + '\n'; };
  try { return { result: await fn(), err }; } finally { console.log = log; console.error = error; }
}

describe('#8426, #8428: gbrain bootstrap hooks registers serve and writes its hooks through the launcher', () => {
  test('claude-code: the user-scope claude mcp add argv and the workspace hooks', async () => {
    const ws = bootstrapWorkspace();
    const calls: string[][] = [];
    const runner: ExecRunner = async (argv) => { calls.push(argv); return argv[1] === 'mcp' && argv[2] === 'list' ? { code: 0, stdout: 'gbrain: stdio serve', stderr: '' } : { code: 0, stdout: '', stderr: '' }; };
    await withEnv(procEnv, async () => {
      expect((await quiet(() => runBootstrap(['render', '--workspace', ws]))).result).toBe(0);
      const r = await quiet(() => runBootstrap(['hooks', '--workspace', ws, '--harness', 'claude-code', '--gbrain-bin', gbrain], { runner }));
      expect(r.result, r.err).toBe(0);
    });
    const add = calls.find((c) => c[0] === 'claude' && c[2] === 'add')!;
    const serve = add.slice(add.indexOf('--') + 1);
    expect(serve.slice(0, 3)).toEqual([launcher, gbrain, 'serve']);
    clearMarker();
    expect(await serveFromSession(serve[0]!, serve.slice(1), {}, 'notes/bootstrap-claude')).toBe('source-b');
    expect(existsSync(marker)).toBe(false);

    const settings = readJson(join(ws, '.claude', 'settings.local.json'));
    const commands = Object.values(settings.hooks as Record<string, Array<{ hooks: Array<{ command: string; _gbrain?: string }> }>>)
      .flatMap((groups) => groups.flatMap((g) => g.hooks.filter((h) => h._gbrain).map((h) => h.command)));
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(command).toContain(`${launcher} ${gbrain} hook`);
      expect(runHook(command).exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    }
    await waitForDetached();
  }, 120_000);

  test('codex: the codex mcp add argv and the SessionEnd capture', async () => {
    const ws = bootstrapWorkspace();
    const calls: string[][] = [];
    const runner: ExecRunner = async (argv) => { calls.push(argv); return argv[1] === 'mcp' && argv[2] === 'list' ? { code: 0, stdout: 'gbrain: stdio serve', stderr: '' } : { code: 0, stdout: '', stderr: '' }; };
    await withEnv(procEnv, async () => {
      expect((await quiet(() => runBootstrap(['render', '--workspace', ws]))).result).toBe(0);
      const r = await quiet(() => runBootstrap(['hooks', '--workspace', ws, '--harness', 'codex', '--gbrain-bin', gbrain], { runner }));
      expect(r.result, r.err).toBe(0);
    });
    const add = calls.find((c) => c[0] === 'codex' && c[2] === 'add')!;
    const serve = add.slice(add.indexOf('--') + 1);
    expect(serve.slice(0, 3)).toEqual([launcher, gbrain, 'serve']);
    clearMarker();
    expect(await serveFromSession(serve[0]!, serve.slice(1), {}, 'notes/bootstrap-codex')).toBe('source-b');
    expect(existsSync(marker)).toBe(false);

    const hooks = readJson(join(home, '.codex', 'hooks.json'));
    const capture = (hooks.hooks.SessionEnd as Array<{ hooks: Array<{ command: string }> }>).flatMap((g) => g.hooks.map((h) => h.command));
    expect(capture.length).toBeGreaterThan(0);
    for (const command of capture) {
      expect(command).toContain(launcher);
      expect(runHook(command).exitCode).toBe(0);
      await waitForDetached();
      expect(existsSync(marker)).toBe(false);
    }
    await withEnv(procEnv, async () => { expect(launcherLaneFindings().filter((f) => f.lane !== 'harness')).toEqual([]); });
  }, 120_000);
});

describe('#8428: the harness and plugin hook lanes', () => {
  test('gbrain bootstrap harness: the user-scope hooks start gbrain through the launcher', async () => {
    const settings = join(root, 'harness-settings.json');
    writeClaudeHooksAt(settings, { gbrainBin: gbrain, hookLauncher: launcher, env: { GBRAIN_HOOK_LANE: 'harness' }, marker: GBRAIN_HARNESS_MARKER_VALUE });
    const commands = Object.values(readJson(settings).hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => h.command)));
    expect(commands.length).toBeGreaterThan(0);
    clearMarker();
    for (const command of commands) {
      expect(runHook(command).exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    }
    await waitForDetached();
  }, 120_000);

  test('the plugin hook (Claude Code and Codex manifests) runs gbrain from the plugin launcher directory', () => {
    const pluginRoot = join(root, 'plugin snapshot');
    mkdirSync(join(pluginRoot, '.agents'), { recursive: true });
    copyFileSync(join(ROOT, 'plugin-variants', 'gbrain-coding', '.agents', 'gbrain-launcher'), join(pluginRoot, '.agents', 'gbrain-launcher'));
    chmodSync(join(pluginRoot, '.agents', 'gbrain-launcher'), 0o755);
    const manifests: Array<[string, string]> = [['.claude-plugin/plugin.json', '${CLAUDE_PLUGIN_ROOT}'], ['.codex-plugin/plugin.json', '${PLUGIN_ROOT}']];
    for (const [file, token] of manifests) {
      const m = readJson(join(ROOT, 'plugin-variants', 'gbrain-coding', file));
      const command = ((m.hooks.hooks ?? m.hooks).UserPromptSubmit as Array<{ hooks: Array<{ command: string }> }>)[0]!.hooks[0]!.command;
      expect(command).toContain(token);
      clearMarker();
      const r = runHook(command.replaceAll(token, pluginRoot), { GBRAIN_BIN: gbrain });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(existsSync(marker)).toBe(false);
    }
  }, 120_000);
});
