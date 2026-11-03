/**
 * The per-turn rule hook on every install path (src/core/setup/turn-hook.ts,
 * turn-hook-check.ts), and the loud failure when it cannot load:
 *  - setup <claude-code|codex> --instructions-only (a plain `mcp add`) writes the
 *    turn-rule hook, runs it once and exits 0; a hook that fails or adds no rule
 *    exits 1 with turn_hook_not_loaded; with no absolute binary it prints the step;
 *  - the installer lanes (connect --install, the hosted harness install,
 *    bootstrap harness) share installerTurnHook;
 *  - OpenClaw and Hermes verify through their own inspect commands.
 * Spawns `bun src/cli.ts setup` against a temp HOME / GBRAIN_HOME.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';
import { withEnv } from './helpers/with-env.ts';
import { installerTurnHook, verifyTurnHook } from '../src/core/setup/turn-hook-check.ts';
import { TURN_RULE_LANE_TOKEN, TURN_RULE_MARKER } from '../src/core/setup/turn-hook.ts';
import { syncHermesTurnHook } from '../src/core/setup/hermes-turn-hook.ts';
import { BRAIN_FIRST_BEGIN, brainFirstTurnRule } from '../src/core/setup/brain-first.ts';
import { openclawTurnPluginDir, openclawTurnPluginFiles } from '../src/core/setup/openclaw-turn-plugin.ts';

const CLI = resolve(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function box() {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-turn-hook-'));
  roots.push(root);
  const home = join(root, 'home');
  const project = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  mkdirSync(join(root, 'bin'));
  const script = (name: string, body: string) => { const p = join(root, 'bin', name); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
  const bin = script('gbrain', `exec '${process.execPath}' --no-env-file '${CLI}' "$@"`);
  const env: Record<string, string | undefined> = {
    HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    OPENCLAW_STATE_DIR: undefined, OPENCLAW_WORKSPACE_DIR: undefined, OPENCLAW_PROFILE: undefined, OPENCLAW_CONFIG_PATH: undefined, HERMES_HOME: undefined,
    GBRAIN_AGENT_INSTRUCTIONS: undefined, GBRAIN_SURFACE: undefined, GBRAIN_SOURCE: undefined, GBRAIN_HOOKS: undefined, GBRAIN_HOOK_LANE: undefined,
    CLAUDECODE: undefined, CLAUDE_CODE_ENTRYPOINT: undefined, CODEX_SANDBOX: undefined, CODEX_CI: undefined,
  };
  return { root, home, project, bin, script, env };
}
type Box = ReturnType<typeof box>;

async function setup(b: Box, args: string[]) {
  const r = await runCli(['setup', ...args], { env: b.env, cwd: b.project });
  let doc: any = null;
  try { doc = JSON.parse(r.stdout); } catch { doc = null; }
  return { ...r, doc };
}
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));
const claudePromptEntries = (b: Box) => (readJson(join(b.home, '.claude', 'settings.json')).hooks?.UserPromptSubmit ?? []).flatMap((g: any) => g.hooks);

describe('setup --instructions-only after a plain mcp add', () => {
  test('claude-code: writes the turn-rule hook, runs it and passes; a re-run keeps one entry', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', b.bin, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.turn_hook).toMatchObject({ harness: 'claude-code', action: 'write' });
    expect(r.doc.turn_hook_check).toMatchObject({ ok: true, reason: 'ran' });
    const entries = claudePromptEntries(b);
    expect(entries).toEqual([expect.objectContaining({ _gbrain: TURN_RULE_MARKER })]);
    expect(entries[0].command).toContain(TURN_RULE_LANE_TOKEN);
    expect(entries[0].command).toContain(`${b.bin} hook user-prompt`);
    expect((await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', b.bin, '--json'])).exitCode).toBe(0);
    expect(claudePromptEntries(b)).toHaveLength(1);
  });

  test('codex: writes the hooks.json group and its config.toml trust entry, runs it and passes', async () => {
    const b = box();
    const r = await setup(b, ['codex', '--instructions-only', '--gbrain-bin', b.bin, '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.turn_hook_check).toMatchObject({ ok: true, reason: 'ran' });
    expect(readFileSync(join(b.home, '.codex', 'hooks.json'), 'utf8')).toContain(TURN_RULE_LANE_TOKEN);
    expect(readFileSync(join(b.home, '.codex', 'config.toml'), 'utf8')).toContain('user_prompt_submit');
  });

  test('a hook that fails to run exits 1 with turn_hook_not_loaded and names the native check', async () => {
    const b = box();
    const broken = b.script('gbrain-broken', 'exit 3');
    const json = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', broken, '--json']);
    expect(json.exitCode).toBe(1);
    expect(json.doc.turn_hook_check).toMatchObject({ ok: false, reason: 'hook_failed' });
    const text = await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', broken]);
    expect(text.exitCode).toBe(1);
    expect(text.stderr + text.stdout).toContain('turn_hook_not_loaded');
    expect(text.stderr + text.stdout).toContain("The harness's own check: /hooks (inside a Claude Code session).");
    expect(text.stderr + text.stdout).toContain('exited non-zero (no output)');
  });

  test('a hook that runs but adds no rule exits 1 (no_rule)', async () => {
    const b = box();
    const silent = b.script('gbrain-silent', 'exit 0');
    const r = await setup(b, ['codex', '--instructions-only', '--gbrain-bin', silent, '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.doc.turn_hook_check).toMatchObject({ ok: false, reason: 'no_rule' });
  });

  test('no absolute gbrain binary: nothing is installed, the one-line next step is printed, exit 0', async () => {
    const b = box();
    const r = await setup(b, ['claude-code', '--instructions-only', '--json']);
    expect(r.exitCode).toBe(0);
    expect(r.doc.turn_hook).toMatchObject({ action: 'print', next: 'gbrain setup claude-code --instructions-only' });
    expect(r.doc.turn_hook_check).toBeUndefined();
    expect(existsSync(join(b.home, '.claude', 'settings.json'))).toBe(false);
  });

  test('--no-instructions removes the turn-rule hook with the block', async () => {
    const b = box();
    await setup(b, ['claude-code', '--instructions-only', '--gbrain-bin', b.bin, '--json']);
    expect(claudePromptEntries(b)).toHaveLength(1);
    expect((await setup(b, ['claude-code', '--instructions-only', '--no-instructions', '--json'])).exitCode).toBe(0);
    expect(claudePromptEntries(b)).toHaveLength(0);
  });
});

describe('review fixes: repo-committed hooks, the hooks opt-outs, Hermes without a SOUL.md', () => {
  test('a project whose committed .claude/settings.json carries a bare gbrain marker is never run, and does not count as carrying the rule', async () => {
    const b = box();
    const ran = join(b.root, 'ran');
    mkdirSync(join(b.project, '.claude'), { recursive: true });
    writeFileSync(join(b.project, '.claude', 'settings.json'), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: `touch '${ran}'`, _gbrain: 'setup-v1' }] }] } }));
    const r = await setup(b, ['claude-code', '--instructions-only', '--scope', 'project', '--gbrain-bin', b.bin, '--json']);
    expect(existsSync(ran)).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.doc.turn_hook).toMatchObject({ action: 'write' });
    expect(readFileSync(join(b.project, '.claude', 'settings.local.json'), 'utf8')).toContain(TURN_RULE_LANE_TOKEN);
  });

  test('--no-hooks and GBRAIN_HOOKS=0 write no per-turn hook and pass', async () => {
    const b = box();
    const flagged = await setup(b, ['codex', '--instructions-only', '--no-hooks', '--gbrain-bin', b.bin, '--json']);
    expect(flagged.exitCode).toBe(0);
    expect(existsSync(join(b.home, '.codex', 'hooks.json')) ? readFileSync(join(b.home, '.codex', 'hooks.json'), 'utf8') : '').not.toContain(TURN_RULE_LANE_TOKEN);
    const env = await runCli(['setup', 'codex', '--instructions-only', '--gbrain-bin', b.bin, '--json'], { env: { ...b.env, GBRAIN_HOOKS: '0' }, cwd: b.project });
    expect(env.exitCode).toBe(0);
    expect(existsSync(join(b.home, '.codex', 'hooks.json')) ? readFileSync(join(b.home, '.codex', 'hooks.json'), 'utf8') : '').not.toContain(TURN_RULE_LANE_TOKEN);
    await withEnv({ ...b.env, GBRAIN_HOOKS: '0' }, async () => {
      expect(installerTurnHook({ harness: 'codex', accepted: true, gbrainBin: b.bin, rerun: '' })).toMatchObject({ outcome: { action: 'skip' }, verdict: null });
    });
  });

  test('hermes without a SOUL.md: no block, so no hook, no allowlist lock file, nothing written beside it', async () => {
    const b = box();
    const hermesHome = join(b.home, '.hermes');
    mkdirSync(hermesHome, { recursive: true });
    const r = await runCli(['setup', 'hermes', '--instructions-only', '--json'], { env: b.env, cwd: b.project });
    expect(r.exitCode).toBe(0);
    expect(readdirSync(hermesHome)).toEqual([]);
  });
});

describe('the rule follows the recorded decision (#7962)', () => {
  test('codex: --no-instructions after an AGENTS.override.md appears also strips the AGENTS.md block, so the rule stops', async () => {
    const b = box();
    const agents = join(b.home, '.codex', 'AGENTS.md');
    mkdirSync(join(b.home, '.codex'), { recursive: true });
    writeFileSync(agents, '# Codex house rules\n');
    expect((await setup(b, ['codex', '--instructions-only', '--gbrain-bin', b.bin, '--json'])).exitCode).toBe(0);
    expect(readFileSync(agents, 'utf8')).toContain(BRAIN_FIRST_BEGIN);
    writeFileSync(join(b.home, '.codex', 'AGENTS.override.md'), '# my override\n');
    expect((await setup(b, ['codex', '--instructions-only', '--no-instructions', '--json'])).exitCode).toBe(0);
    expect(readFileSync(agents, 'utf8')).toBe('# Codex house rules\n');
    await withEnv(b.env, async () => { expect(brainFirstTurnRule('codex', b.project)).toBeNull(); });
  });

  test('claude-code: a project-scope install rules only inside its project once the user scope declines', async () => {
    const b = box();
    expect((await setup(b, ['claude-code', '--instructions-only', '--scope', 'project', '--gbrain-bin', b.bin, '--json'])).exitCode).toBe(0);
    expect((await setup(b, ['claude-code', '--instructions-only', '--no-instructions', '--json'])).exitCode).toBe(0);
    const elsewhere = join(b.root, 'elsewhere');
    mkdirSync(elsewhere);
    await withEnv(b.env, async () => {
      expect(brainFirstTurnRule('claude-code', join(b.project, 'src'))).toContain('GBrain: before answering this turn');
      expect(brainFirstTurnRule('claude-code', elsewhere)).toBeNull();
    });
  });
});

describe('installer lanes (connect --install, hosted harness install, bootstrap harness)', () => {
  test('installerTurnHook writes the hook beside a pointed-at config, removes it on decline, and never fails a print', async () => {
    const b = box();
    const paths = { claudeSettings: join(b.root, 'cfg', 'settings.json') };
    await withEnv(b.env, async () => {
      const wrote = installerTurnHook({ harness: 'claude-code', accepted: true, gbrainBin: b.bin, paths, rerun: 'gbrain setup claude-code --instructions-only' });
      expect(wrote.outcome.action).toBe('write');
      expect(readFileSync(paths.claudeSettings, 'utf8')).toContain(TURN_RULE_LANE_TOKEN);
      expect(installerTurnHook({ harness: 'claude-code', accepted: false, gbrainBin: b.bin, paths, rerun: '' }).outcome.action).toBe('remove');
      expect(readFileSync(paths.claudeSettings, 'utf8')).not.toContain(TURN_RULE_LANE_TOKEN);
      const printed = installerTurnHook({ harness: 'codex', accepted: true, gbrainBin: null, rerun: 'gbrain setup codex --instructions-only' });
      expect(printed.outcome).toMatchObject({ action: 'print', next: 'gbrain setup codex --instructions-only' });
      expect(printed.verdict).toBeNull();
      expect(installerTurnHook({ harness: 'opencode', accepted: true, gbrainBin: b.bin, rerun: '' }).outcome.action).toBe('skip');
    });
  });

  test('a written hook that does not load fails the install with a verdict (default paths)', async () => {
    const b = box();
    const broken = b.script('gbrain-broken', 'exit 3');
    await withEnv(b.env, async () => {
      const r = installerTurnHook({ harness: 'claude-code', accepted: true, gbrainBin: broken, rerun: 'gbrain setup claude-code --instructions-only' });
      expect(r.outcome.action).toBe('write');
      expect(r.verdict).toMatchObject({ ok: false, reason: 'hook_failed' });
    });
  });
});

describe('OpenClaw and Hermes verify with their own inspect commands', () => {
  const access = { kind: 'mcp', server: 'gbrain' } as const;

  function openclaw(b: Box, entry: Record<string, unknown>) {
    const state = join(b.root, 'openclaw');
    const env = { ...b.env, OPENCLAW_STATE_DIR: state };
    return withEnv(env, async () => {
      const dir = openclawTurnPluginDir();
      mkdirSync(dir, { recursive: true });
      for (const [name, body] of Object.entries(openclawTurnPluginFiles(access))) writeFileSync(join(dir, name), body);
      writeFileSync(join(state, 'openclaw.json'), JSON.stringify({ plugins: { entries: { 'gbrain-turn-rule': entry } } }));
    }).then(() => env);
  }

  test('openclaw: loaded with before_prompt_build passes; an error status fails not_loaded; no allowConversationAccess is untrusted', async () => {
    const b = box();
    const env = await openclaw(b, { enabled: true, hooks: { allowConversationAccess: true } });
    const which = () => '/usr/local/bin/openclaw';
    await withEnv(env, async () => {
      const seen: string[][] = [];
      const loaded = verifyTurnHook('openclaw', { which, run: (argv) => { seen.push(argv); return { ok: true, output: '{"id":"gbrain-turn-rule","status":"loaded","imported":true,"hooks":["before_prompt_build"]}' }; } });
      expect(loaded).toMatchObject({ ok: true, reason: 'ran' });
      expect(seen[0]).toEqual(['/usr/local/bin/openclaw', 'plugins', 'inspect', 'gbrain-turn-rule', '--runtime', '--json']);
      expect(verifyTurnHook('openclaw', { which, run: () => ({ ok: true, output: '{"id":"gbrain-turn-rule","status":"error","hooks":["before_prompt_build"]}' }) })).toMatchObject({ ok: false, reason: 'not_loaded' });
    });
    const untrusted = await openclaw(box(), { enabled: true });
    await withEnv(untrusted, async () => {
      expect(verifyTurnHook('openclaw', { which, run: () => ({ ok: true, output: '' }) })).toMatchObject({ ok: false, reason: 'untrusted' });
    });
  });

  test('hermes: a healthy hooks doctor block passes; a ✗ line fails not_loaded', async () => {
    const b = box();
    const hermesHome = join(b.root, 'hermes');
    mkdirSync(hermesHome, { recursive: true });
    writeFileSync(join(hermesHome, 'SOUL.md'), 'You are a careful assistant.\n');
    const env = { ...b.env, HERMES_HOME: hermesHome };
    await withEnv(env, async () => {
      expect(syncHermesTurnHook({ hermesHome, access, dryRun: false }).action).toBe('write');
      const which = () => '/usr/local/bin/hermes';
      const doctor = (mark: string) => () => ({ ok: true, output: `Shell hooks\n  [pre_llm_call] /bin/echo '{"context":"GBrain: before answering this turn"}'\n    ${mark}\n  [post_tool_call] /bin/true\n    ✓ allowlisted\n` });
      expect(verifyTurnHook('hermes', { which, run: doctor('✓ allowlisted, script present') })).toMatchObject({ ok: true, reason: 'ran' });
      expect(verifyTurnHook('hermes', { which, run: doctor('✗ not allowlisted') })).toMatchObject({ ok: false, reason: 'not_loaded' });
      expect(verifyTurnHook('hermes', { which: () => null })).toMatchObject({ ok: true, reason: 'native_unavailable' });
    });
  });
});
