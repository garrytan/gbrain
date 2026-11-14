/**
 * `gbrain setup claude-code --skill-loading resolve` rebuilds a stale user
 * catalog; the rebuild keeps the `--routing` table the catalog was built with.
 */
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

setDefaultTimeout(120_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const root = mkdtempSync(join(tmpdir(), 'gbrain-setup-routing-keep-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('setup rebuild of a stale catalog keeps its routing table', async () => {
  const home = join(root, 'home'), project = join(root, 'project');
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(project, { recursive: true });
  const bin = join(root, 'bin', 'gbrain');
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  const env = { HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    GBRAIN_SKILL_LOADING: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined };
  const skills = join(home, '.claude', 'skills');
  const skillFile = join(skills, 'deploy', 'SKILL.md');
  mkdirSync(join(skills, 'deploy'), { recursive: true });
  writeFileSync(skillFile, '---\nname: deploy\ndescription: Ship a service\n---\nSteps.\n');
  const routing = join(root, 'routing.md');
  writeFileSync(routing, '- **deploy**: выкати на прод | задеплой сервис\n');

  const run = (args: string[]) => runCli(args, { env, cwd: project });
  const built = await run(['skills', 'index', 'build', '--catalog', 'claude-code-user', '--dir', skills, '--harness', 'claude-code', '--routing', routing]);
  expect(built.exitCode).toBe(0);
  writeFileSync(skillFile, '---\nname: deploy\ndescription: Ship a service now\n---\nSteps.\n');
  const setup = await run(['setup', 'claude-code', '--skill-loading', 'resolve', '--yes', '--instructions-only', '--gbrain-bin', bin]);
  expect(setup.exitCode).toBe(0);
  const status = await run(['skills', 'index', 'status', '--catalog', 'claude-code-user', '--json']);
  expect(status.stdout).toContain('--routing');
});
