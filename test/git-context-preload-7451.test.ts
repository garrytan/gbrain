/**
 * #7451: a test run started from a git hook inherits the hook's repository (GIT_DIR, GIT_WORK_TREE, ...). Test helpers
 * spawn git with `{ ...process.env }`, so with GIT_DIR set a `git -C <temp repo> config` wrote into the caller's
 * repository instead (seen: `core.bare=true`, `user.name t`). git-hermetic-preload drops every variable
 * `gitChildEnv` drops, so a run never touches the repository of the process that launched it.
 *
 * Each case spawns a real `bun test` child (cwd = repo root, so this repo's bunfig preloads apply) on a generated
 * probe that initializes a throwaway repo and writes its config the way the doctor tests do.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { GIT_LOCAL_ENV_VARS } from '../src/core/git-env.ts';

const REPO_ROOT = resolve(import.meta.dir, '..');
const dirs: string[] = [];
afterAll(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

function git(args: string[], cwd: string): string {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !(GIT_LOCAL_ENV_VARS as readonly string[]).includes(key)) env[key] = value;
  const proc = Bun.spawnSync(['git', ...args], { cwd, env, stdout: 'pipe', stderr: 'pipe' });
  return proc.stdout.toString().trim();
}

function outerRepo(spawnEnv = 'env: { ...process.env }, '): { root: string; outer: string; probe: string; inner: string } {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-git-context-'));
  dirs.push(root);
  const outer = join(root, 'outer');
  const inner = join(root, 'inner');
  git(['init', '-q', outer], root);
  const probe = join(root, 'git-context-probe.test.ts');
  writeFileSync(probe, `import { expect, test } from 'bun:test';
test('a throwaway repo gets its own config', () => {
  const run = (args: string[], cwd: string) => Bun.spawnSync(['git', ...args], { cwd, ${spawnEnv}stdout: 'pipe', stderr: 'pipe' });
  expect(run(['init', '-q', ${JSON.stringify(inner)}], ${JSON.stringify(root)}).exitCode).toBe(0);
  expect(run(['-C', ${JSON.stringify(inner)}, 'config', 'user.name', 't'], ${JSON.stringify(root)}).exitCode).toBe(0);
  expect(run(['-C', ${JSON.stringify(inner)}, 'config', 'user.email', 't@t'], ${JSON.stringify(root)}).exitCode).toBe(0);
});
`);
  return { root, outer, probe, inner };
}

function runProbe(probe: string, extra: Record<string, string>): { exitCode: number; output: string } {
  const proc = Bun.spawnSync(['bun', 'test', '--timeout=15000', probe], {
    cwd: REPO_ROOT, env: { ...process.env, ...extra }, stdout: 'pipe', stderr: 'pipe', timeout: 30_000, killSignal: 'SIGKILL',
  });
  return { exitCode: proc.exitCode ?? -1, output: proc.stdout.toString() + proc.stderr.toString() };
}

describe('git-hermetic-preload: inherited git context (#7451)', () => {
  test('a run with GIT_DIR and GIT_WORK_TREE set leaves the outer repository config untouched', () => {
    const { outer, probe, inner } = outerRepo();
    const before = git(['config', '--file', join(outer, '.git', 'config'), '--list'], outer);
    const result = runProbe(probe, { GIT_DIR: join(outer, '.git'), GIT_WORK_TREE: outer, GIT_INDEX_FILE: join(outer, '.git', 'index') });
    expect(result.output).toContain('1 pass');
    expect(result.exitCode).toBe(0);
    expect(git(['config', '--file', join(outer, '.git', 'config'), '--list'], outer)).toBe(before);
    expect(git(['config', '--file', join(outer, '.git', 'config'), '--get', 'core.bare'], outer)).toBe('false');
    expect(git(['config', '--file', join(inner, '.git', 'config'), '--get', 'user.name'], inner)).toBe('t');
  }, 60_000);

  // Bun.spawn and Bun.spawnSync called without `env` hand the child the environment the process started with, not
  // process.env as the preloads left it, so the preload makes process.env their default.
  test('a helper that spawns git without an env option leaves the outer repository config untouched too', () => {
    const { outer, probe, inner } = outerRepo('');
    const before = git(['config', '--file', join(outer, '.git', 'config'), '--list'], outer);
    const result = runProbe(probe, { GIT_DIR: join(outer, '.git'), GIT_WORK_TREE: outer, GIT_INDEX_FILE: join(outer, '.git', 'index') });
    expect(result.output).toContain('1 pass');
    expect(result.exitCode).toBe(0);
    expect(git(['config', '--file', join(outer, '.git', 'config'), '--list'], outer)).toBe(before);
    expect(git(['config', '--file', join(inner, '.git', 'config'), '--get', 'user.name'], inner)).toBe('t');
  }, 60_000);

  test('the preload drops exactly what gitChildEnv drops and keeps the gpg signing override', () => {
    const { probe } = outerRepo();
    const check = probe.replace(/git-context-probe\.test\.ts$/, 'env-probe.test.ts');
    writeFileSync(check, `import { expect, test } from 'bun:test';
test('env', () => {
  for (const key of ${JSON.stringify(GIT_LOCAL_ENV_VARS.filter(key => key !== 'GIT_CONFIG_COUNT'))}) expect(process.env[key]).toBeUndefined();
  expect(process.env.GIT_CONFIG_VALUE_0).toBe('false');
  expect(process.env.GIT_CONFIG_KEY_0).toBe('commit.gpgsign');
  expect(process.env.GIT_CONFIG_KEY_1).toBe('tag.gpgsign');
  expect(process.env.GIT_CONFIG_COUNT).toBe('2');
  expect(process.env.GIT_SSH_COMMAND).toBe('ssh -o BatchMode=yes');
});
`);
    const extra: Record<string, string> = { GIT_CONFIG_PARAMETERS: "'core.bare=true'", GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.bare', GIT_CONFIG_VALUE_0: 'true', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
    for (const key of GIT_LOCAL_ENV_VARS) if (!(key in extra)) extra[key] = '/nonexistent-git-context';
    const result = runProbe(check, extra);
    expect(result.output).toContain('1 pass');
    expect(result.exitCode).toBe(0);
  }, 60_000);
});
