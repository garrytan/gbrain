/**
 * The Claude Code lane does not suggest a plugin's skills in a project whose
 * .claude/settings.local.json (over .claude/settings.json) turns that plugin
 * off, while the same plugin still gets suggested in other projects.
 */
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

setDefaultTimeout(60_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

test('a plugin the project turns off gets no suggestion there, and one elsewhere', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-lane-plugins-'));
  roots.push(root);
  const home = join(root, 'home');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(home, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  const env: Record<string, string | undefined> = {
    HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CLAUDE_PROJECT_DIR: undefined, GBRAIN_HOOKS: undefined,
    GBRAIN_HOOK_LANE: undefined, GBRAIN_SKILLS_NO_AUTOREBUILD: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  };
  const off = join(root, 'off'), on = join(root, 'on');
  mkdirSync(join(off, '.claude'), { recursive: true });
  mkdirSync(on, { recursive: true });
  writeFileSync(join(off, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'acme-example@acme-market': true } }));
  writeFileSync(join(off, '.claude', 'settings.local.json'), JSON.stringify({ enabledPlugins: { 'acme-example@acme-market': false } }));

  const plugin = join(root, 'plugin');
  mkdirSync(join(plugin, '.claude-plugin'), { recursive: true });
  writeFileSync(join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"acme-manifest"}');
  mkdirSync(join(home, '.claude', 'plugins'), { recursive: true });
  writeFileSync(join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'acme-example@acme-market': [{ scope: 'user', installPath: plugin }] } }));
  mkdirSync(join(plugin, 'skills', 'acme-deploy'), { recursive: true });
  writeFileSync(join(plugin, 'skills', 'acme-deploy', 'SKILL.md'), '---\nname: acme-deploy\ndescription: Deploy the acme widget service to staging.\n---\nSteps.\n');

  mkdirSync(join(home, '.claude', 'skills', 'acme-review'), { recursive: true });
  writeFileSync(join(home, '.claude', 'skills', 'acme-review', 'SKILL.md'), '---\nname: acme-review\ndescription: Review a diff before it is pushed.\n---\nSteps.\n');
  const setup = await runCli(['setup', 'claude-code', '--instructions-only', '--skill-loading', 'resolve', '--gbrain-bin', bin], { env, cwd: on });
  expect(setup.exitCode, setup.stderr + setup.stdout).toBe(0);
  const built = await runCli(['skills', 'index', 'build', '--catalog', 'claude-code-plugins', '--dir', plugin, '--harness', 'claude-code'], { env, cwd: on });
  expect(built.exitCode, built.stderr + built.stdout).toBe(0);
  const settings = JSON.parse(await Bun.file(join(home, '.claude', 'settings.json')).text());
  const command = (settings.hooks.UserPromptSubmit as any[]).flatMap((g) => g.hooks).map((h: any) => h.command as string).find((c) => c.includes('GBRAIN_HOOK_LANE=skill-resolver'))!;

  const run = async (cwd: string, session: string) => {
    const merged: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...process.env, ...env, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_TEST_SKILL_LANE_DEADLINE_MS: '10000' })) if (v !== undefined) merged[k] = v;
    const stdin = new TextEncoder().encode(JSON.stringify({ cwd, session_id: session, prompt: 'deploy the acme widget service to staging' }));
    const proc = Bun.spawn(['sh', '-c', command], { env: merged, cwd, stdin, stdout: 'pipe', stderr: 'pipe' });
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
    return stdout;
  };
  expect(await run(on, 's-on')).toContain('acme-manifest:acme-deploy');
  expect(await run(off, 's-off')).not.toContain('acme-manifest:acme-deploy');
});
