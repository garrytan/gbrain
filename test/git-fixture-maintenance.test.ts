import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

function hermeticGitEnv(root: string, trace: string): Record<string, string> {
  const globalConfig = join(root, 'global.gitconfig');
  writeFileSync(globalConfig, '');
  const env: Record<string, string> = {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'commit.gpgsign', GIT_CONFIG_VALUE_0: 'false',
    GIT_TRACE2_EVENT: trace,
  };
  for (const key of ['PATH', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'PATHEXT', 'TEMP', 'TMP']) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
  return env;
}

test('Git fixtures suppress automatic maintenance from their first commit onward', () => {
  const root = mkdtempSync(join(tmpdir(), 'git-fixture-maintenance-'));
  const repo = join(root, 'repo');
  const trace = join(root, 'trace.jsonl');
  const env = hermeticGitEnv(root, trace);
  mkdirSync(repo);
  try {
    const script = `
      import { makeGitFixture } from ${JSON.stringify(resolve(import.meta.dir, 'helpers/git-fixture.ts'))};
      const fixture = await makeGitFixture(${JSON.stringify(repo)});
      await Bun.write(${JSON.stringify(join(repo, 'fixture.txt'))}, 'synthetic fixture');
      fixture.commitAll('Commit synthetic fixture');
      fixture.reset();
    `;
    const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
      env, stdout: 'pipe', stderr: 'pipe',
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
    const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const children = events.filter(event => event.event === 'child_start');
    expect(children.filter(event => event.argv?.some((arg: string) => arg === 'maintenance' || arg === 'gc'))).toEqual([]);
    for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0']] as const) {
      expect(execFileSync('git', ['-C', repo, 'config', '--local', '--get', key], { env, encoding: 'utf8' }).trim()).toBe(value);
    }
    expect(execFileSync('git', ['-C', repo, 'rev-list', '--count', 'HEAD'], { env, encoding: 'utf8' }).trim()).toBe('2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('large worktree fixtures commit without starting background gc before they are cloned', () => {
  const root = mkdtempSync(join(tmpdir(), 'large-worktree-maintenance-'));
  const trace = join(root, 'trace.jsonl');
  const env = hermeticGitEnv(root, trace);
  try {
    const script = `
      import { largeBareRepository } from ${JSON.stringify(resolve(import.meta.dir, 'helpers/large-worktree.ts'))};
      largeBareRepository(${JSON.stringify(root)}, 20);
    `;
    const result = Bun.spawnSync([process.execPath, '--no-env-file', '-e', script], {
      env, stdout: 'pipe', stderr: 'pipe',
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
    const events = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const children = events.filter(event => event.event === 'child_start');
    expect(children.filter(event => event.argv?.some((arg: string) => arg === 'maintenance' || arg === 'gc'))).toEqual([]);
    const work = join(root, 'bare-work');
    for (const [key, value] of [['maintenance.auto', 'false'], ['gc.auto', '0']] as const) {
      expect(execFileSync('git', ['-C', work, 'config', '--local', '--get', key], { env, encoding: 'utf8' }).trim()).toBe(value);
    }
    expect(execFileSync('git', ['-C', join(root, 'large.git'), 'rev-list', '--count', 'HEAD'], { env, encoding: 'utf8' }).trim()).toBe('1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);
