/**
 * GBRA-188 follow-up: the Claude Code and Codex plugins declare setup's own
 * UserPromptSubmit hook (same subcommand and timeout, launched through the
 * plugin's launcher with GBRAIN_HOOK_LANE=plugin). The plugin hook yields to
 * any other gbrain lane wiring the event, so a machine with both fires once.
 * The rule itself stays gated on an installed brain-first block, and doctor
 * harness_wiring and post-upgrade point plugin-only installs at
 * `gbrain setup <harness> --instructions-only`. Hermetic temp HOME, CODEX_HOME,
 * CLAUDE_CONFIG_DIR and GBRAIN_HOME.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildClaudeHookCommand } from '../src/core/bootstrap/hooks.ts';
import { codexSetupHookGroup, codexSetupTrustEntry } from '../src/core/bootstrap/codex-hooks.ts';
import { CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS } from '../src/core/bootstrap/host-specs.ts';
import { claudePluginProvidesName, codexPluginProvidesName, enabledPluginLanes, pluginHookYields } from '../src/core/bootstrap/plugin-lanes.ts';
import { runHook } from '../src/commands/hook.ts';
import { harnessWiringCheck, instructionBlockUpgradeHints } from '../src/commands/doctor/checks/harness-wiring.ts';
import { renderBrainFirstTurnRule } from '../src/core/setup/brain-first.ts';
import { printBrainFirstUpgradeNotice } from '../src/core/setup/brain-first-upgrade-notice.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';

const ROOT = resolve(import.meta.dir, '..');
const CLI = join(ROOT, 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

const json = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const tail = (command: string, bin: string) => command.slice(command.indexOf(bin) + bin.length + 1);

describe('plugin manifests declare the hook setup installs', () => {
  const claudeSetup = buildClaudeHookCommand('/x/gbrain', 'UserPromptSubmit', {});
  const codexSetup = codexSetupHookGroup('/x/gbrain', 'UserPromptSubmit', {}).hooks[0]!;
  for (const [dir, identity] of [['.', ''], ['plugin-variants/gbrain-coding', 'GBRAIN_PLUGIN=gbrain-coding '], ['plugin-variants/gbrain-daily', 'GBRAIN_PLUGIN=gbrain-daily ']]) {
    test(`${dir}: Claude Code and Codex UserPromptSubmit, setup's subcommand and timeout, through the launcher, naming its variant`, () => {
      expect(existsSync(join(ROOT, dir, '.agents', 'gbrain-launcher'))).toBe(true);
      expect(json(join(dir, '.claude-plugin', 'plugin.json')).hooks).toEqual({ UserPromptSubmit: [{ hooks: [{ type: 'command',
        command: `env GBRAIN_HOOK_LANE=plugin ${identity}"\${CLAUDE_PLUGIN_ROOT}/.agents/gbrain-launcher" ${tail(claudeSetup, '/x/gbrain')}`,
        timeout: CLAUDE_HOOK_DEFAULT_TIMEOUT_SECS.UserPromptSubmit }] }] });
      // Codex's inline form is a whole hooks.json document (the `hooks` wrapper); Claude Code's is the bare event map.
      expect(json(join(dir, '.codex-plugin', 'plugin.json')).hooks).toEqual({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command',
        command: `env GBRAIN_HOOK_LANE=plugin ${identity}"\${PLUGIN_ROOT}/.agents/gbrain-launcher" ${tail(codexSetup.command, '/x/gbrain')}`,
        timeout: codexSetup.timeout }] }] } });
    });
  }
});

interface Box { root: string; home: string; env: Record<string, string | undefined> }

function box(): Box {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-plugin-turn-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home, env: {
    HOME: home, GBRAIN_HOME: home, CODEX_HOME: join(root, 'codex'), CLAUDE_CONFIG_DIR: join(root, 'claude'), XDG_CONFIG_HOME: join(root, 'xdg'),
    GBRAIN_HOOK_LANE: 'plugin', GBRAIN_PLUGIN: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_HOOKS: undefined, GBRAIN_SURFACE: undefined, GBRAIN_SOURCE: undefined,
    CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined, OPENCODE: undefined, OPENCODE_PID: undefined,
  } };
}

function claudeSettings(b: Box, extra: Record<string, unknown> = {}): void {
  mkdirSync(b.env.CLAUDE_CONFIG_DIR!, { recursive: true });
  writeFileSync(join(b.env.CLAUDE_CONFIG_DIR!, 'settings.json'), JSON.stringify({ enabledPlugins: { 'gbrain@gbrain': true }, ...extra }));
}

async function userPrompt(b: Box, harness: 'claude-code' | 'codex'): Promise<string> {
  let out = '';
  await withEnv(b.env, async () => {
    const code = await runHook(['user-prompt', '--harness', harness], {
      stdin: JSON.stringify({ prompt: 'what did alice-example decide about the launch?', session_id: 's1' }),
      write: (s) => { out += s; }, cwd: b.root, configOverride: null, disablePushBanner: true, disableTelemetry: true,
    });
    expect(code).toBe(0);
  });
  return out;
}

const RULE = renderBrainFirstTurnRule({ kind: 'mcp', server: 'gbrain' });

describe('plugin lane: one hook per event, rule only with a block', () => {
  test('Claude Code plugin only: no block, no rule; doctor and post-upgrade name --instructions-only; after it, the plugin hook carries the rule', async () => {
    const b = box();
    claudeSettings(b);
    expect(await userPrompt(b, 'claude-code')).not.toContain('check GBrain first');
    await withEnv(b.env, async () => {
      const check = await harnessWiringCheck({ smoke: false });
      expect(check.status).toBe('warn');
      expect(check.fix?.argv).toEqual(['gbrain', 'setup', 'claude-code', '--instructions-only']);
      expect(check.details?.instructions).toEqual([expect.objectContaining({ harness: 'claude-code', state: 'missing', from: 'default_path' })]);
      const hints = instructionBlockUpgradeHints();
      expect(hints).toHaveLength(1);
      expect(hints[0]).toContain('Run `gbrain setup claude-code --instructions-only` to write only that block');
      const printed: string[] = [];
      printBrainFirstUpgradeNotice((l) => printed.push(l));
      expect(printed).toEqual(hints);
    });

    const bin = join(b.root, 'gbrain');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    const r = await runCli(['setup', 'claude-code', '--instructions-only', '--json'], { env: { ...b.env, GBRAIN_HOOK_LANE: undefined }, cwd: b.root });
    expect(r.exitCode).toBe(0);

    expect(JSON.parse((await userPrompt(b, 'claude-code')).trim()).hookSpecificOutput).toEqual({ hookEventName: 'UserPromptSubmit', additionalContext: RULE });
    await withEnv(b.env, async () => {
      expect(instructionBlockUpgradeHints()).toEqual([]);
      expect((await harnessWiringCheck({ smoke: false })).status).toBe('ok');
    });
  });

  test('Claude Code: the plugin hook yields to setup\'s own UserPromptSubmit entry, and to a workspace bootstrap entry in the cwd', async () => {
    const b = box();
    const setupEntry = { type: 'command', command: 'env /opt/g hook user-prompt', timeout: 3, _gbrain: 'setup-v1' };
    claudeSettings(b, { hooks: { UserPromptSubmit: [{ hooks: [setupEntry] }] } });
    await withEnv(b.env, async () => {
      expect(pluginHookYields('claude-code', 'user-prompt', b.root)).toBe(true);
      expect(pluginHookYields('claude-code', 'session-start', b.root)).toBe(false);
    });
    mkdirSync(join(b.home, '.gbrain'), { recursive: true });
    writeFileSync(join(b.home, '.gbrain', 'agent-instructions.json'), JSON.stringify({ version: 1, entries: [{ harness: 'claude-code', status: 'installed',
      path: join(b.home, 'CLAUDE.md'), block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'test', created_file: false, updated_at: '2026-10-28T00:00:00.000Z' }] }));
    expect(await userPrompt(b, 'claude-code')).toBe('');

    const ws = box();
    claudeSettings(ws, { hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo unrelated' }] }] } });
    await withEnv(ws.env, async () => { expect(pluginHookYields('claude-code', 'user-prompt', ws.root)).toBe(false); });
    mkdirSync(join(ws.root, '.claude'), { recursive: true });
    writeFileSync(join(ws.root, '.claude', 'settings.local.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'gbrain hook user-prompt', _gbrain: 'bootstrap-v1' }] }] } }));
    await withEnv(ws.env, async () => { expect(pluginHookYields('claude-code', 'user-prompt', ws.root)).toBe(true); });
  });

  test('a recorded `gbrain setup claude-code --no-hooks` turns the plugin hook off too, block or not', async () => {
    const b = box();
    claudeSettings(b);
    const bin = join(b.root, 'gbrain');
    writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
    chmodSync(bin, 0o755);
    const r = await runCli(['setup', 'claude-code', '--no-hooks', '--gbrain-bin', bin, '--json'], { env: { ...b.env, GBRAIN_HOOK_LANE: undefined }, cwd: b.root });
    expect(r.stdout + r.stderr).toContain('no hooks');
    await withEnv(b.env, async () => { expect(pluginHookYields('claude-code', 'user-prompt', b.root)).toBe(true); });
    expect(await userPrompt(b, 'claude-code')).toBe('');
  });

  test('Codex: the plugin hook yields to setup\'s hooks.json group, and runs when hooks.json holds none', async () => {
    const b = box();
    mkdirSync(b.env.CODEX_HOME!, { recursive: true });
    mkdirSync(join(b.home, '.gbrain'), { recursive: true });
    writeFileSync(join(b.home, '.gbrain', 'agent-instructions.json'), JSON.stringify({ version: 1, entries: [{ harness: 'codex', status: 'installed',
      path: join(b.home, 'AGENTS.md'), block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'test', created_file: false, updated_at: '2026-10-28T00:00:00.000Z' }] }));
    expect(JSON.parse((await userPrompt(b, 'codex')).trim()).hookSpecificOutput.additionalContext).toBe(RULE);
    const group = codexSetupHookGroup('/opt/g', 'UserPromptSubmit', {});
    const hooksPath = join(b.env.CODEX_HOME!, 'hooks.json');
    writeFileSync(hooksPath, JSON.stringify({ hooks: { UserPromptSubmit: [group] } }));
    const trust = codexSetupTrustEntry(hooksPath, 'UserPromptSubmit', 0, group);
    writeFileSync(join(b.env.CODEX_HOME!, 'config.toml'), `[hooks.state."${trust.key}"]\ntrusted_hash = "${trust.trusted_hash}"\n`);
    expect(await userPrompt(b, 'codex')).toBe('');
    writeFileSync(join(b.env.CODEX_HOME!, 'hooks.json'), '{ not json');
    await withEnv(b.env, async () => { expect(pluginHookYields('codex', 'user-prompt', b.root)).toBe(false); });
  });
});

describe('Codex: yield only to a setup group Codex runs (#7963)', () => {
  test('an untrusted, stale-hash or disabled setup group leaves the plugin hook running; a trusted one wins', async () => {
    const b = box();
    mkdirSync(b.env.CODEX_HOME!, { recursive: true });
    mkdirSync(join(b.home, '.gbrain'), { recursive: true });
    writeFileSync(join(b.home, '.gbrain', 'agent-instructions.json'), JSON.stringify({ version: 1, entries: [{ harness: 'codex', status: 'installed',
      path: join(b.home, 'AGENTS.md'), block_version: 2, access: { kind: 'mcp', server: 'gbrain' }, writer: 'test', created_file: false, updated_at: '2026-10-28T00:00:00.000Z' }] }));
    const hooksPath = join(b.env.CODEX_HOME!, 'hooks.json');
    const configPath = join(b.env.CODEX_HOME!, 'config.toml');
    const other = { hooks: [{ type: 'command', command: 'echo unrelated', timeout: 5 }] };
    const group = codexSetupHookGroup('/opt/g', 'UserPromptSubmit', {});
    writeFileSync(hooksPath, JSON.stringify({ hooks: { UserPromptSubmit: [other, group] } }));
    const trust = codexSetupTrustEntry(hooksPath, 'UserPromptSubmit', 1, group);
    const rule = async () => JSON.parse((await userPrompt(b, 'codex')).trim()).hookSpecificOutput.additionalContext;

    expect(await rule()).toBe(RULE);
    writeFileSync(configPath, `[hooks.state."${trust.key}"]\ntrusted_hash = "sha256:${'0'.repeat(64)}"\n`);
    expect(await rule()).toBe(RULE);
    writeFileSync(configPath, `[hooks.state."${trust.key}"]\nenabled = false\ntrusted_hash = "${trust.trusted_hash}"\n`);
    expect(await rule()).toBe(RULE);
    writeFileSync(configPath, `[hooks.state."${trust.key.replace(':1:0', ':0:0')}"]\ntrusted_hash = "${trust.trusted_hash}"\n`);
    expect(await rule()).toBe(RULE);
    writeFileSync(configPath, `[hooks.state."${trust.key}"]\ntrusted_hash = "${trust.trusted_hash}"\n`);
    expect(await userPrompt(b, 'codex')).toBe('');
    writeFileSync(configPath, '[hooks.state\nnot toml');
    await withEnv(b.env, async () => { expect(pluginHookYields('codex', 'user-prompt', b.root)).toBe(false); });
  });
});

describe('persona variants count as the gbrain plugin, and only one plugin hook fires (#7963)', () => {
  test('Claude Code: a variant alone is a plugin lane; the variants yield to an enabled higher-precedence plugin', async () => {
    const b = box();
    claudeSettings(b, { enabledPlugins: { 'gbrain-daily@gbrain': true } });
    const settings = join(b.env.CLAUDE_CONFIG_DIR!, 'settings.json');
    expect(claudePluginProvidesName(settings, 'gbrain')).toBe('gbrain-daily@gbrain');
    expect(claudePluginProvidesName(settings, 'other-server')).toBeNull();
    await withEnv(b.env, async () => {
      expect(enabledPluginLanes('gbrain')).toEqual([{ harness: 'claude-code', plugin: 'gbrain-daily@gbrain' }]);
      for (const plugin of [undefined, 'gbrain-coding', 'gbrain-daily']) {
        await withEnv({ GBRAIN_PLUGIN: plugin }, async () => { expect(pluginHookYields('claude-code', 'user-prompt', b.root)).toBe(false); });
      }
    });
    claudeSettings(b, { enabledPlugins: { 'gbrain-daily@gbrain': true, 'gbrain-coding@gbrain': true, 'gbrain@gbrain': false } });
    expect(claudePluginProvidesName(settings, 'gbrain')).toBe('gbrain-coding@gbrain');
    await withEnv(b.env, async () => {
      await withEnv({ GBRAIN_PLUGIN: 'gbrain-daily' }, async () => { expect(pluginHookYields('claude-code', 'user-prompt', b.root)).toBe(true); });
      await withEnv({ GBRAIN_PLUGIN: 'gbrain-coding' }, async () => { expect(pluginHookYields('claude-code', 'user-prompt', b.root)).toBe(false); });
    });
    claudeSettings(b, { enabledPlugins: { 'gbrain-coding@gbrain': true, 'gbrain@gbrain': true } });
    await withEnv(b.env, async () => {
      await withEnv({ GBRAIN_PLUGIN: 'gbrain-coding' }, async () => { expect(pluginHookYields('claude-code', 'user-prompt', b.root)).toBe(true); });
      await withEnv({ GBRAIN_PLUGIN: undefined }, async () => { expect(pluginHookYields('claude-code', 'user-prompt', b.root)).toBe(false); });
    });
  });

  test('Codex: [plugins."<variant>@<mkt>"] counts, and the lower variant yields', async () => {
    const b = box();
    mkdirSync(b.env.CODEX_HOME!, { recursive: true });
    const config = join(b.env.CODEX_HOME!, 'config.toml');
    writeFileSync(config, '[plugins."gbrain-daily@gbrain"]\nenabled = true\n');
    expect(codexPluginProvidesName(config, 'gbrain')).toBe('gbrain-daily@gbrain');
    await withEnv(b.env, async () => {
      expect(enabledPluginLanes('gbrain')).toEqual([{ harness: 'codex', plugin: 'gbrain-daily@gbrain' }]);
      await withEnv({ GBRAIN_PLUGIN: 'gbrain-daily' }, async () => { expect(pluginHookYields('codex', 'user-prompt', b.root)).toBe(false); });
    });
    writeFileSync(config, '[plugins."gbrain-daily@gbrain"]\nenabled = true\n\n[plugins."gbrain-coding@gbrain"]\nenabled = true\n');
    expect(codexPluginProvidesName(config, 'gbrain')).toBe('gbrain-coding@gbrain');
    await withEnv(b.env, async () => {
      await withEnv({ GBRAIN_PLUGIN: 'gbrain-daily' }, async () => { expect(pluginHookYields('codex', 'user-prompt', b.root)).toBe(true); });
      await withEnv({ GBRAIN_PLUGIN: 'gbrain-coding' }, async () => { expect(pluginHookYields('codex', 'user-prompt', b.root)).toBe(false); });
    });
  });
});

describe('the plugin launcher on the per-turn hook (#7963)', () => {
  const LAUNCHER = join(ROOT, '.agents', 'gbrain-launcher');
  const launch = (env: Record<string, string>, args: string[]) => {
    const r = Bun.spawnSync(['/bin/sh', LAUNCHER, ...args], { env: { PATH: '/usr/bin:/bin', ...env }, stdout: 'pipe', stderr: 'pipe' });
    return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
  };
  function fakeCli(b: Box, version: string): { bin: string; calls: () => string[] } {
    const bin = join(b.root, 'fake-gbrain');
    const log = join(b.root, 'calls.log');
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\nif [ "$1" = --version ]; then echo "gbrain ${version}"; exit 0; fi\necho "ran $*"\n`);
    chmodSync(bin, 0o755);
    const mtime = new Date(Date.now() - 60_000);
    utimesSync(bin, mtime, mtime);
    writeFileSync(log, '');
    return { bin, calls: () => readFileSync(log, 'utf8').split('\n').filter(Boolean) };
  }

  test('no gbrain binary: hook exits 0 with no output; serve keeps exit 127 and the recovery text', () => {
    const b = box();
    expect(launch({ HOME: b.home }, ['hook', 'user-prompt'])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(launch({ HOME: b.home, GBRAIN_BIN: join(b.root, 'missing') }, ['hook', 'user-prompt'])).toEqual({ code: 0, stdout: '', stderr: '' });
    const serve = launch({ HOME: b.home }, ['serve', '--surface', 'full']);
    expect(serve.code).toBe(127);
    expect(serve.stderr).toContain('gbrain binary not found');
    expect(launch({ HOME: b.home, GBRAIN_BIN: join(b.root, 'missing') }, ['serve']).code).toBe(127);
  });

  test('a CLI older than the plugin lane: the plugin hook exits 0 silently, probing once per binary', () => {
    const b = box();
    const cli = fakeCli(b, '0.60.497.0');
    const env = { HOME: b.home, GBRAIN_BIN: cli.bin, GBRAIN_HOOK_LANE: 'plugin' };
    expect(launch(env, ['hook', 'user-prompt'])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(cli.calls()).toEqual(['--version']);
    expect(launch(env, ['hook', 'user-prompt'])).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(cli.calls()).toEqual(['--version']);
    expect(existsSync(join(b.home, '.gbrain', 'cache', 'plugin-hook-cli'))).toBe(true);
    // Setup's own hook (no plugin lane) still runs on the old CLI.
    expect(launch({ HOME: b.home, GBRAIN_BIN: cli.bin }, ['hook', 'user-prompt']).stdout).toBe('ran hook user-prompt\n');
    // Upgrading the binary (newer mtime than the cached verdict) re-probes.
    const cache = join(b.home, '.gbrain', 'cache', 'plugin-hook-cli');
    utimesSync(cache, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    const upgraded = fakeCli(b, '0.60.498.0');
    expect(launch(env, ['hook', 'user-prompt']).stdout).toBe('ran hook user-prompt\n');
    expect(upgraded.calls()).toEqual(['--version', 'hook user-prompt']);
    expect(launch(env, ['hook', 'user-prompt']).stdout).toBe('ran hook user-prompt\n');
    expect(upgraded.calls()).toEqual(['--version', 'hook user-prompt', 'hook user-prompt']);
  });

  test('GBRAIN_HOME places the probe cache; a lane-aware CLI runs the hook', () => {
    const b = box();
    const cli = fakeCli(b, '0.61.0.0');
    const gHome = join(b.root, 'ghome');
    expect(launch({ HOME: b.home, GBRAIN_HOME: gHome, GBRAIN_BIN: cli.bin, GBRAIN_HOOK_LANE: 'plugin' }, ['hook', 'user-prompt', '--harness', 'codex']))
      .toEqual({ code: 0, stdout: 'ran hook user-prompt --harness codex\n', stderr: '' });
    expect(readFileSync(join(gHome, '.gbrain', 'cache', 'plugin-hook-cli'), 'utf8')).toBe(`${cli.bin}\n0.60.498.0\nok\n`);
  });
});
