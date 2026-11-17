/** #9559: Claude Skill-tool catalogs must not advertise checkout internals. */
import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

const root = mkdtempSync(join(tmpdir(), 'native-depth-9559-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const skills = join(root, 'home', '.claude', 'skills');
function skill(path: string, name: string) {
  mkdirSync(join(skills, path), { recursive: true });
  writeFileSync(join(skills, path, 'SKILL.md'), `---\nname: ${name}\ndescription: Deploy the widget service safely\n---\nSteps.\n`);
}
const env = { HOME: join(root, 'home'), GBRAIN_HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: undefined,
  CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
const run = (args: string[]) => runCli(args, { env, cwd: root });

test('Claude directory builds and freshness follow native top-level entries, not nested checkout copies', async () => {
  skill('gstack', 'gstack');
  skill('gstack/office-hours', 'office-hours');
  skill('gstack/disabled', 'disabled');
  skill('gstack/test/fixtures/alpha', 'alpha');
  symlinkSync('gstack/office-hours', join(skills, 'office-hours'));
  const build = await run(['skills', 'index', 'build', '--catalog', 'native', '--dir', skills, '--harness', 'claude-code', '--json']);
  expect(build.exitCode).toBe(0);
  const receipt = JSON.parse(build.stdout);
  expect(receipt.catalog.skill_count).toBe(2);
  const resolved = await run(['skills', 'resolve', '--catalog', 'native', '--text', 'disabled', '--harness', 'claude-code', '--json']);
  expect(resolved.exitCode).toBe(0);
  expect(JSON.parse(resolved.stdout).suggestions.some((s: { id: string }) => s.id === 'disabled')).toBe(false);
  skill('gstack/test/fixtures/alpha', 'changed-fixture');
  const status = async () => JSON.parse((await run(['skills', 'index', 'status', '--catalog', 'native', '--json'])).stdout);
  expect(JSON.stringify(await status())).toContain('"fresh":true');
  skill('new-top-level', 'new-top-level');
  expect(JSON.stringify(await status())).toContain('"fresh":false');
  const hermes = await run(['skills', 'index', 'build', '--catalog', 'recursive', '--dir', skills, '--harness', 'hermes', '--json']);
  expect(hermes.exitCode).toBe(0);
  expect(JSON.parse(hermes.stdout).catalog.skill_count).toBe(5);
}, 120_000);

test('setup dry-run refuses a nested-only catalog without writing config or hooks', async () => {
  const home = join(root, 'nested-home');
  const nested = join(home, '.claude', 'skills', 'checkout', 'disabled');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'SKILL.md'), '---\nname: disabled\ndescription: Deploy the service\n---\nSteps.\n');
  const result = await runCli(['setup', 'claude-code', '--skill-loading', 'resolve', '--dry-run', '--yes', '--instructions-only'],
    { env: { ...env, HOME: home, GBRAIN_HOME: home }, cwd: root });
  expect(result.stdout + result.stderr).toContain('skill_resolver_setup_incomplete');
  expect(existsSync(join(home, '.gbrain', 'config.json'))).toBe(false);
  expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
}, 120_000);
