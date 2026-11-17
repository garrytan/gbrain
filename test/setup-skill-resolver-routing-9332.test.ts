/**
 * #9332: when setup rebuilds a stale skill-resolver catalog, the rebuild keeps
 * the --routing table the catalog was built with, so routing rows still match.
 */
import { afterAll, expect, setDefaultTimeout, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCli } from './helpers/cli-spawn.ts';

setDefaultTimeout(120_000);
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const root = mkdtempSync(join(tmpdir(), 'gbrain-routing-9332-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test('a setup rebuild of a stale catalog keeps its routing table', async () => {
  const home = join(root, 'home');
  const project = join(root, 'project');
  const skills = join(home, '.claude', 'skills');
  const skillFile = join(skills, 'deploy', 'SKILL.md');
  const routing = join(root, 'routing.md');
  const bin = join(root, 'bin', 'gbrain');
  for (const d of [join(root, 'bin'), project, join(skills, 'deploy')]) mkdirSync(d, { recursive: true });
  writeFileSync(bin, `#!/bin/sh\nexec '${process.execPath}' --no-env-file '${CLI}' "$@"\n`);
  chmodSync(bin, 0o755);
  writeFileSync(skillFile, '---\nname: deploy\ndescription: Ship a service\n---\nSteps.\n');
  writeFileSync(routing, '- **deploy**: roll it out to prod | ship the service now\n');
  const env = {
    HOME: home, GBRAIN_HOME: home, PATH: '/usr/bin:/bin', CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined,
    GBRAIN_SKILL_LOADING: undefined, GBRAIN_HOOK_LANE: undefined, GBRAIN_AGENT_INSTRUCTIONS: undefined, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined,
  };
  const run = (args: string[]) => runCli(args, { env, cwd: project });

  expect((await run(['skills', 'index', 'build', '--catalog', 'claude-code-user', '--dir', skills, '--harness', 'claude-code', '--routing', routing])).exitCode).toBe(0);
  writeFileSync(skillFile, '---\nname: deploy\ndescription: Ship a service safely\n---\nSteps.\n');
  const setup = await run(['setup', 'claude-code', '--skill-loading', 'resolve', '--yes', '--instructions-only', '--gbrain-bin', bin]);
  expect(setup.exitCode).toBe(0);
  const status = JSON.parse((await run(['skills', 'index', 'status', '--catalog', 'claude-code-user', '--json'])).stdout);
  expect(JSON.stringify(status)).toContain('--routing');
  expect(JSON.stringify(status)).toContain('"fresh":true');
  const hit = await run(['skills', 'resolve', '--catalog', 'claude-code-user', '--text', 'ship the service now', '--json']);
  expect(hit.stdout).toContain('deploy');
});
