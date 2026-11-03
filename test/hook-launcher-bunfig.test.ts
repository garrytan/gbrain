/**
 * #8424: the hooks gbrain writes never let the session directory's bunfig.toml
 * or .env run. The script-mode install maps the gbrain bin to src/cli.ts, and
 * Bun applies a top-level bunfig.toml preload from the working directory
 * before any gbrain code; harnesses start hooks in the session's directory.
 * Every hook here is installed by the real writer, then run with sh -c from a
 * directory whose bunfig.toml preload drops a marker file, the way Claude Code
 * and Codex run it. The marker must never appear.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withEnv } from './helpers/with-env.ts';
import { buildClaudeHookCommand } from '../src/core/bootstrap/hooks.ts';
import { codexHookGroupRuns, codexHookTrustHash, codexSetupHookGroup } from '../src/core/bootstrap/codex-hooks.ts';
import { appendCodexTomlTable } from '../src/core/bootstrap/codex-toml.ts';
import { captureHookSessionCwd, hookSessionCwd } from '../src/core/setup/hook-launcher.ts';
import { syncTurnRuleHook, TURN_RULE_MARKER } from '../src/core/setup/turn-hook.ts';
import { hookLauncherProblem } from '../src/core/setup/turn-hook-check.ts';
import { HOOK_LAUNCHER_NAME, ensureHookLauncher, hookLauncherInCommand, hookLauncherPath, hookLauncherState } from '../src/core/setup/hook-launcher.ts';
import { refreshHookLaunchers } from '../src/core/setup/hook-launcher-refresh.ts';
import { hookLauncherFix, withHookLaunchers } from '../src/commands/doctor/checks/harness-wiring.ts';
import type { HookLauncherProblem } from '../src/core/setup/turn-hook-check.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

/** A temp HOME with a script-mode gbrain (a symlink to src/cli.ts, as bun install -g makes it) and a hostile checkout. */
function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-hook-launcher-'));
  roots.push(root);
  const home = join(root, 'home');
  const bin = join(root, 'bin');
  const hostile = join(root, 'hostile-checkout');
  const tmp = join(root, 'tmp');
  for (const d of [home, bin, join(hostile, 'tooling'), tmp]) mkdirSync(d, { recursive: true });
  symlinkSync(process.execPath, join(bin, 'bun'));
  symlinkSync(CLI, join(bin, 'gbrain'));
  const marker = join(root, 'PRELOAD_RAN');
  writeFileSync(join(hostile, 'tooling', 'pre.ts'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
  writeFileSync(join(hostile, 'bunfig.toml'), 'preload = ["./tooling/pre.ts"]\n');
  writeFileSync(join(hostile, '.env'), 'GBRAIN_HOOKS=1\n');
  const launcher = hookLauncherPath(join(home, '.gbrain'));
  const env: Record<string, string> = { HOME: home, GBRAIN_HOME: home, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: tmp, GBRAIN_AGENT_INSTRUCTIONS: '0' };
  return { root, home, gbrain: join(bin, 'gbrain'), hostile, tmp, marker, launcher, env };
}
type Box = ReturnType<typeof box>;

/** Run a hook command the way the harness does: sh -c from the session directory, the event JSON on stdin. */
function runHook(b: Box, command: string, cwd = b.hostile) {
  const r = Bun.spawnSync(['sh', '-c', command], { cwd, env: b.env, stdin: Buffer.from(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'hi', session_id: 'hook-launcher-test', cwd })), stdout: 'pipe', stderr: 'pipe', timeout: 60_000 });
  return { exitCode: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

/** SessionEnd detaches a grandchild that removes its payload file when it exits; wait for that. */
async function waitForDetached(b: Box) {
  for (let i = 0; i < 300 && readdirSync(b.tmp).length > 0; i++) await Bun.sleep(100);
  expect(readdirSync(b.tmp)).toEqual([]);
}

const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

describe('a hook run from a checkout whose bunfig.toml preloads code never runs that preload', () => {
  test('control: script-mode gbrain started in that checkout runs the preload (the hole the launcher closes)', () => {
    const b = box();
    const r = runHook(b, `${b.gbrain} --version`);
    expect(r.exitCode).toBe(0);
    expect(existsSync(b.marker)).toBe(true);
  });

  test('claude-code turn-rule hook (setup --instructions-only, connect --install, bootstrap harness)', () => {
    const b = box();
    const settings = join(b.home, '.claude', 'settings.json');
    const o = syncTurnRuleHook({ harness: 'claude-code', gbrainBin: b.gbrain, paths: { claudeSettings: settings, hookLauncher: b.launcher }, rerun: 'x' });
    expect(o.action).toBe('write');
    const [entry] = readJson(settings).hooks.UserPromptSubmit.flatMap((g: { hooks: unknown[] }) => g.hooks);
    expect(entry._gbrain).toBe(TURN_RULE_MARKER);
    const r = runHook(b, entry.command);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(existsSync(b.marker)).toBe(false);
  });

  test('codex turn-rule hook', () => {
    const b = box();
    const hooks = join(b.home, '.codex', 'hooks.json');
    const o = syncTurnRuleHook({ harness: 'codex', gbrainBin: b.gbrain, paths: { codexHooks: hooks, codexConfig: join(b.home, '.codex', 'config.toml'), hookLauncher: b.launcher }, rerun: 'x' });
    expect(o.action).toBe('write');
    const command = readJson(hooks).hooks.UserPromptSubmit[0].hooks[0].command;
    const r = runHook(b, command);
    expect(r.stderr).toBe('');
    expect(r.exitCode).toBe(0);
    expect(existsSync(b.marker)).toBe(false);
  });

  test('gbrain setup claude-code hook shape, every event', () => {
    const b = box();
    ensureHookLauncher(b.launcher);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'PreCompact'] as const) {
      const command = buildClaudeHookCommand(b.gbrain, event, { GBRAIN_SOURCE: 'default', GBRAIN_HOME: b.home, GBRAIN_SEAT: '' }, b.launcher);
      expect(runHook(b, command).exitCode).toBe(0);
      expect(existsSync(b.marker)).toBe(false);
    }
  });

  test('gbrain setup codex hook shape: SessionStart, UserPromptSubmit and the detached SessionEnd', async () => {
    const b = box();
    ensureHookLauncher(b.launcher);
    for (const event of ['SessionStart', 'UserPromptSubmit', 'SessionEnd'] as const) {
      const command = codexSetupHookGroup(b.gbrain, event, { GBRAIN_HOME: b.home }, 'setup', b.launcher).hooks[0]!.command;
      expect(runHook(b, command).exitCode).toBe(0);
      if (event === 'SessionEnd') await waitForDetached(b);
      expect(existsSync(b.marker)).toBe(false);
    }
  });
});

describe('the launcher', () => {
  test('passes the session directory on in GBRAIN_HOOK_CWD and runs from its own directory', () => {
    const b = box();
    ensureHookLauncher(b.launcher);
    const r = runHook(b, `${b.launcher} /bin/sh -c 'printf "%s|%s" "$GBRAIN_HOOK_CWD" "$(pwd)"'`);
    expect(r.stdout).toBe(`${b.hostile}|${dirname(b.launcher)}`);
  });

  test('refuses to start anything when its directory holds a file gbrain did not write', () => {
    const b = box();
    ensureHookLauncher(b.launcher);
    writeFileSync(join(dirname(b.launcher), 'bunfig.toml'), `preload = [${JSON.stringify(join(b.hostile, 'tooling', 'pre.ts'))}]\n`);
    const r = runHook(b, `${b.launcher} ${b.gbrain} --version`);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('refused');
    expect(existsSync(b.marker)).toBe(false);
    expect(hookLauncherState(b.launcher).state).toBe('foreign');
    expect(() => ensureHookLauncher(b.launcher)).toThrow(/did not write/);
  });

  test('a launcher path with quotes and spaces is found in every command shape, so doctor does not flag a current hook', async () => {
    const b = box();
    const odd = join(b.root, "o'example home");
    mkdirSync(odd);
    await withEnv({ HOME: b.home, GBRAIN_HOME: odd, CLAUDE_CONFIG_DIR: undefined }, async () => {
      const launcher = hookLauncherPath();
      expect(launcher).toContain("o'example home");
      for (const command of [
        buildClaudeHookCommand(b.gbrain, 'Stop', { GBRAIN_HOOK_LANE: 'turn-rule' }, launcher),
        codexSetupHookGroup(b.gbrain, 'UserPromptSubmit', {}, 'setup', launcher).hooks[0]!.command,
        codexSetupHookGroup(b.gbrain, 'SessionEnd', {}, 'setup', launcher).hooks[0]!.command,
      ]) expect(hookLauncherInCommand(command)).toBe(launcher);
      const settings = join(b.home, '.claude', 'settings.json');
      expect(syncTurnRuleHook({ harness: 'claude-code', gbrainBin: b.gbrain, paths: { claudeSettings: settings }, rerun: 'x' }).action).toBe('write');
      expect(hookLauncherProblem('claude-code')).toBeNull();
      const [entry] = readJson(settings).hooks.UserPromptSubmit.flatMap((g: { hooks: unknown[] }) => g.hooks);
      expect(runHook(b, entry.command).exitCode).toBe(0);
      expect(existsSync(b.marker)).toBe(false);
    });
  });

  test('ensureHookLauncher rewrites a changed launcher and keeps its directory private', () => {
    const b = box();
    ensureHookLauncher(b.launcher);
    writeFileSync(b.launcher, '#!/bin/sh\nexec "$@"\n');
    expect(hookLauncherState(b.launcher).state).toBe('stale');
    ensureHookLauncher(b.launcher);
    expect(hookLauncherState(b.launcher).state).toBe('current');
    expect(readdirSync(dirname(b.launcher))).toEqual([HOOK_LAUNCHER_NAME]);
  });

  test('a rewrite never leaves a temp file in the launcher directory, so a hook running meanwhile still starts', () => {
    const b = box();
    ensureHookLauncher(b.launcher);
    for (let i = 0; i < 20; i++) {
      writeFileSync(b.launcher, '#!/bin/sh\nexec "$@"\n');
      ensureHookLauncher(b.launcher);
      expect(readdirSync(dirname(b.launcher))).toEqual([HOOK_LAUNCHER_NAME]);
    }
    expect(readdirSync(dirname(dirname(b.launcher))).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('hooks written before the launcher: doctor flags them, post-upgrade moves them', () => {
  const env = (b: Box) => ({ HOME: b.home, GBRAIN_HOME: b.home, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: join(b.home, '.codex'), XDG_CONFIG_HOME: undefined });

  test('claude-code: an old turn-rule entry is flagged session_cwd, then refreshed onto the launcher', async () => {
    const b = box();
    const settings = join(b.home, '.claude', 'settings.json');
    const old = buildClaudeHookCommand(b.gbrain, 'UserPromptSubmit', { GBRAIN_HOOK_LANE: 'turn-rule' });
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: old, timeout: 15, _gbrain: TURN_RULE_MARKER }] }] } }));
    expect(runHook(b, old).exitCode).toBe(0);
    expect(existsSync(b.marker)).toBe(true);
    rmSync(b.marker);
    await withEnv(env(b), async () => {
      expect(hookLauncherProblem('claude-code')).toMatchObject({ lane: 'turn-rule', reason: 'session_cwd' });
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain('claude-code turn-rule hook now starts gbrain from its own directory');
      expect(hookLauncherProblem('claude-code')).toBeNull();
    });
    const entries = readJson(settings).hooks.UserPromptSubmit.flatMap((g: { hooks: unknown[] }) => g.hooks);
    expect(entries).toHaveLength(1);
    expect(runHook(b, entries[0].command).exitCode).toBe(0);
    expect(existsSync(b.marker)).toBe(false);
  });

  test('codex: an old turn-rule group Codex runs is flagged and named, and post-upgrade leaves hooks.json and its trust alone', async () => {
    const b = box();
    const hooks = join(b.home, '.codex', 'hooks.json');
    const config = join(b.home, '.codex', 'config.toml');
    await withEnv(env(b), async () => {
      const old = codexSetupHookGroup(b.gbrain, 'UserPromptSubmit', {}, 'turn-rule');
      mkdirSync(dirname(hooks), { recursive: true });
      writeFileSync(hooks, JSON.stringify({ hooks: { UserPromptSubmit: [old] } }));
      appendCodexTomlTable(config, ['hooks', 'state', `${hooks}:user_prompt_submit:0:0`], { trusted_hash: codexHookTrustHash('user_prompt_submit', old.hooks[0]!.command, old.hooks[0]!.timeout) }, 'test: Codex trusted the old hook');
      expect(codexHookGroupRuns(hooks, config, { event: 'UserPromptSubmit', index: 0 })).toBe(true);
      expect(hookLauncherProblem('codex')).toMatchObject({ lane: 'turn-rule', reason: 'session_cwd' });
      const before = { hooks: readFileSync(hooks, 'utf8'), config: readFileSync(config, 'utf8') };
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain('run `gbrain setup codex --instructions-only` to rewrite it');
      expect({ hooks: readFileSync(hooks, 'utf8'), config: readFileSync(config, 'utf8') }).toEqual(before);
      expect(hookLauncherProblem('codex')).toMatchObject({ lane: 'turn-rule', reason: 'session_cwd' });
    });
  });

  test('codex: a turn-rule group Codex never trusted is left as is, so post-upgrade grants no trust', async () => {
    const b = box();
    const hooks = join(b.home, '.codex', 'hooks.json');
    const config = join(b.home, '.codex', 'config.toml');
    const payload = join(b.hostile, 'tooling', 'payload');
    const group = { hooks: [{ type: 'command', command: `env GBRAIN_HOOK_LANE=turn-rule ${payload} hook user-prompt --harness codex`, timeout: 15 }] };
    mkdirSync(dirname(hooks), { recursive: true });
    writeFileSync(hooks, JSON.stringify({ hooks: { UserPromptSubmit: [group] } }));
    writeFileSync(config, '');
    await withEnv(env(b), async () => {
      const lines: string[] = [];
      await refreshHookLaunchers((l) => lines.push(l));
      expect(lines.join('\n')).toContain('the codex turn-rule hook starts gbrain in the session\'s directory, so it is left as is');
    });
    expect(readJson(hooks)).toEqual({ hooks: { UserPromptSubmit: [group] } });
    expect(codexHookGroupRuns(hooks, config, { event: 'UserPromptSubmit', index: 0 })).toBe(false);
  });

  test('the recorded session directory is resolved and dropped from the environment', async () => {
    const b = box();
    const link = join(b.root, 'link-to-checkout');
    symlinkSync(b.hostile, link);
    await withEnv({ GBRAIN_HOOK_CWD: link }, async () => {
      captureHookSessionCwd();
      expect(process.env.GBRAIN_HOOK_CWD).toBeUndefined();
      expect(hookSessionCwd()).toBe(realpathSync(b.hostile));
    });
    await withEnv({ GBRAIN_HOOK_CWD: 'relative/dir' }, async () => {
      captureHookSessionCwd();
      expect(hookSessionCwd()).toBe(process.cwd());
    });
  });

  test('a launcher whose directory gained a foreign file is flagged foreign', async () => {
    const b = box();
    await withEnv(env(b), async () => {
      const settings = join(b.home, '.claude', 'settings.json');
      syncTurnRuleHook({ harness: 'claude-code', gbrainBin: b.gbrain, paths: { claudeSettings: settings }, rerun: 'x' });
      expect(hookLauncherProblem('claude-code')).toBeNull();
      writeFileSync(join(dirname(hookLauncherPath()), '.env'), 'X=1\n');
      expect(hookLauncherProblem('claude-code')).toMatchObject({ reason: 'foreign' });
    });
  });
});

describe('doctor: the hook_session_cwd fix and how it joins the harness_wiring check', () => {
  const problem = (b: Box, over: Partial<HookLauncherProblem> = {}): HookLauncherProblem =>
    ({ harness: 'claude-code', lane: 'setup', source: join(b.home, '.claude', 'settings.json'), reason: 'session_cwd', detail: 'old hook', ...over });

  test('the fix: the agent re-runs setup for user scope; a project, a foreign file, an edited entry or any Codex rerun goes to the user', async () => {
    const b = box();
    await withEnv({ HOME: b.home, GBRAIN_HOME: b.home, CLAUDE_CONFIG_DIR: undefined }, async () => {
      expect(hookLauncherFix(problem(b))).toMatchObject({ actor: 'agent', argv: ['gbrain', 'setup', 'claude-code'] });
      expect(hookLauncherFix(problem(b, { lane: 'turn-rule' }))).toMatchObject({ actor: 'agent', argv: ['gbrain', 'setup', 'claude-code', '--instructions-only'] });
      // gbrain setup codex rewrites the shared hooks.json and its trust (it can re-enable or newly trust a group), so the agent never runs it.
      const codex = hookLauncherFix(problem(b, { harness: 'codex', lane: 'turn-rule', source: join(b.home, '.codex', 'hooks.json') }));
      expect(codex).toMatchObject({ actor: 'user', consent: [] });
      expect(codex.argv).toBeUndefined();
      expect(codex.user_message).toContain('run it yourself: gbrain setup codex --instructions-only');
      expect(hookLauncherFix(problem(b, { harness: 'codex', lane: 'mcp', source: join(b.home, '.codex', 'config.toml'), rerun: ['gbrain', 'setup', 'codex'], setupOwned: true, owner: 'setup' }))).toMatchObject({ actor: 'user', consent: [] });
      const project = join(b.root, 'proj');
      const p = hookLauncherFix(problem(b, { source: join(project, '.claude', 'settings.local.json') }));
      expect(p.actor).toBe('user');
      expect(p.user_message).toContain(`From ${project}, run: gbrain setup claude-code --scope project`);
      const foreign = hookLauncherFix(problem(b, { reason: 'foreign', detail: 'the launcher directory holds .env' }));
      expect(foreign.actor).toBe('user');
      expect(foreign.user_message).toContain('Remove that file (gbrain did not write it), then run: gbrain setup claude-code');
      const edited = hookLauncherFix(problem(b, { edited: true }));
      expect(edited.actor).toBe('user');
      expect(edited.user_message).toContain('Remove or rewrite that entry');
      expect(hookLauncherFix(problem(b, { edited: true, source: join(project, '.claude', 'settings.local.json') })).user_message).toContain(`then from ${project}, run: gbrain setup claude-code --scope project`);
    });
  });

  test('withHookLaunchers: ok becomes a warn; a fail or a warn keeps its own code and fix, with the launcher fix in details', async () => {
    const b = box();
    await withEnv({ HOME: b.home, GBRAIN_HOME: b.home, CLAUDE_CONFIG_DIR: undefined }, async () => {
      const ok = { name: 'harness_wiring', status: 'ok', message: 'Registered.' } as any;
      expect(withHookLaunchers(ok, null)).toBe(ok);
      const warned = withHookLaunchers(ok, problem(b));
      expect(warned).toMatchObject({ status: 'warn', details: { code: 'hook_session_cwd', hook_launcher_reason: 'session_cwd' }, fix: { actor: 'agent' } });
      const fail = withHookLaunchers({ ...ok, status: 'fail', details: { code: 'x' } }, problem(b));
      expect(fail).toMatchObject({ status: 'fail', details: { code: 'x', hook_launcher_fix: { actor: 'agent' } } });
      const prior = { ...ok, status: 'warn', details: { code: 'turn_hook_not_loaded' }, fix: { actor: 'agent', argv: ['gbrain', 'setup', 'claude-code', '--instructions-only'] } };
      const kept = withHookLaunchers(prior, problem(b, { reason: 'foreign' }));
      expect(kept).toMatchObject({ status: 'warn', details: { code: 'turn_hook_not_loaded', hook_launcher_fix: { actor: 'user' } }, fix: prior.fix });
      expect(kept.message).toContain('Hook launcher: old hook.');
      expect(withHookLaunchers(prior, problem(b))).toMatchObject({ details: { code: 'turn_hook_not_loaded', hook_launcher_fix: { actor: 'agent', argv: ['gbrain', 'setup', 'claude-code'] } }, fix: prior.fix });
    });
  });
});
