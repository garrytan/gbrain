/**
 * #4992 batch 1: the two detached `gbrain hook` launches a user feels on
 * Windows (the Stop-hook workspace push and the session-end backup check) and
 * the three wave-13 holdovers (`brain-repo-durability.ts`, `hardened-git.ts`,
 * `claude-cli-language-model.ts`) go through `src/core/spawn.ts`, so every
 * launch carries `windowsHide: true`, and their git launches build their env
 * with `gitChildEnv()`. The spy sits on `node:child_process` itself, which the
 * seam looks up at call time, so a launch that bypassed the seam would reach
 * the spy without `windowsHide` and fail here.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runHook } from '../src/commands/hook.ts';
import { GIT_LOCAL_ENV_VARS } from '../src/core/git-env.ts';
import { writeReceipt } from '../src/core/bootstrap/format.ts';
import type { RepoReceipt } from '../src/core/bootstrap/repo.ts';
import { __resetOperatorGitConfigForTests, hardenedGitSync } from '../src/core/hardened-git.ts';

const ENV_KEYS = ['GBRAIN_HOME', 'DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_SOURCE', 'GBRAIN_HOOKS', 'GBRAIN_STOP_PUSH',
  'GBRAIN_STOP_PUSH_DEBOUNCE_MIN', 'CLAUDE_CODE_REMOTE', 'CLAUDE_CODE_REMOTE_SESSION_ID', 'GH_TOKEN', 'GITHUB_TOKEN',
  'GBRAIN_BACKUP_CHECK', 'GBRAIN_BACKUP_CHECK_DAYS', 'GBRAIN_FORCE_BACKUP_NAG', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_CONFIG_NOSYSTEM'] as const;

let tmp: string;
let saved: Record<string, string | undefined>;
type SpawnCall = { command: string; args: string[]; options: Record<string, unknown> };
let spawns: SpawnCall[];
let execFiles: SpawnCall[];
let spawnSpy: ReturnType<typeof spyOn>;
let execFileSpy: ReturnType<typeof spyOn>;
const realExecFile = childProcess.execFile;
const { execFileSync } = childProcess;

function fakeChild(): childProcess.ChildProcess {
  const child = new EventEmitter() as childProcess.ChildProcess;
  (child as { unref: () => void }).unref = () => {};
  return child;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gb-spawn-seam-'));
  saved = {};
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.GBRAIN_HOME = tmp;
  // A system gitconfig with url.insteadOf (a builder machine) would rewrite the origin the push gate checks.
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  // A repository-locating variable the hook's git children must not inherit.
  process.env.GIT_DIR = join(tmp, 'not-a-repo', '.git');
  spawns = []; execFiles = [];
  // Detached gbrain re-executions are recorded, never started.
  spawnSpy = spyOn(childProcess, 'spawn').mockImplementation(((command: string, args: string[], options: Record<string, unknown>) => {
    spawns.push({ command, args, options });
    return fakeChild();
  }) as typeof childProcess.spawn);
  // The hook's git probes run for real (the test needs their answers) and are recorded on the way through.
  execFileSpy = spyOn(childProcess, 'execFile').mockImplementation(((command: string, args: string[], options: Record<string, unknown>, callback: unknown) => {
    execFiles.push({ command, args, options });
    return (realExecFile as unknown as (...a: unknown[]) => childProcess.ChildProcess)(command, args, options, callback);
  }) as typeof childProcess.execFile);
});

afterEach(() => {
  spawnSpy.mockRestore(); execFileSpy.mockRestore();
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  rmSync(tmp, { recursive: true, force: true });
});

const home = () => join(tmp, '.gbrain');

/** An initialized bootstrap workspace with unpushed work and a completed repo phase: the shape that spawns the push. */
function bootstrapWorkspace(name: string): string {
  const repo = join(tmp, name);
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo, env: { ...process.env, GIT_DIR: undefined } });
  writeFileSync(join(repo, 'untracked-work.txt'), 'unsaved work\n');
  writeFileSync(join(repo, 'agent.json'), JSON.stringify({ format_version: 1, initialized: true, agent_name: 'test-agent', created_by: 'test', created_at: '2026-01-01T00:00:00.000Z', source_id: 'workspace' }, null, 2) + '\n');
  const repoUrl = 'https://github.com/alice/boot-repo';
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', repoUrl], { env: { ...process.env, GIT_DIR: undefined } });
  const toplevel = execFileSync('git', ['-C', repo, 'rev-parse', '--show-toplevel'], { encoding: 'utf8', env: { ...process.env, GIT_DIR: undefined } }).trim();
  mkdirSync(join(home(), 'bootstrap'), { recursive: true });
  writeReceipt(home(), {
    receipt_version: 1, workspace_dir: toplevel, source_id: 'workspace', agent_name: 'test-agent', created_at: '2026-01-01T00:00:00.000Z',
    created_by: 'test', brain_created_by_bootstrap: false, created_paths: [], registrations: [], repo_url: repoUrl,
  } as RepoReceipt);
  return repo;
}

describe('gbrain hook detached launches (#4992 batch 1)', () => {
  test('the session-start workspace push is spawned detached with windowsHide: true', async () => {
    const repo = bootstrapWorkspace('boot-repo');
    expect(await runHook(['session-start'], { write: () => {}, stdin: '', cwd: repo })).toBe(0);
    const pushes = spawns.filter(call => call.args.includes('push'));
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.command).toBe(process.execPath);
    expect(pushes[0]!.args.slice(-4)).toEqual(['sources', 'push', '--path', pushes[0]!.args.at(-1)!]);
    expect(pushes[0]!.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
  });

  test('the session-end backup check is spawned detached with windowsHide: true and the startup-hook skip', async () => {
    const repo = bootstrapWorkspace('boot-repo-end');
    expect(await runHook(['session-end'], { write: () => {}, stdin: JSON.stringify({ session_id: 'sess-seam', cwd: repo }) })).toBe(0);
    const checks = spawns.filter(call => call.args.includes('backup'));
    expect(checks).toHaveLength(1);
    expect(checks[0]!.args.slice(-3)).toEqual(['backup', 'check', '--quiet']);
    expect(checks[0]!.options).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true });
    expect((checks[0]!.options.env as Record<string, string>).GBRAIN_SKIP_STARTUP_HOOKS).toBe('1');
    for (const call of spawns) expect(call.options.windowsHide).toBe(true);
  });

  test("the hook's git probes go through the seam with gitChildEnv(): windowsHide set, repository-locating variables dropped", async () => {
    const repo = bootstrapWorkspace('boot-repo-git');
    await runHook(['session-start'], { write: () => {}, stdin: '', cwd: repo });
    const gits = execFiles.filter(call => call.command === 'git');
    expect(gits.length).toBeGreaterThan(0);
    for (const call of gits) {
      expect(call.options.windowsHide).toBe(true);
      const env = call.options.env as Record<string, string | undefined>;
      expect(env.GBRAIN_HOME).toBe(tmp);
      for (const key of GIT_LOCAL_ENV_VARS) expect(env[key]).toBeUndefined();
    }
  });
});

describe('wave-13 holdovers launch through the seam', () => {
  test('hardenedGitSync spawns git with windowsHide: true', () => {
    const spy = spyOn(childProcess, 'spawnSync').mockImplementation(((command: string, args: string[], options: Record<string, unknown>) => {
      spawns.push({ command, args, options });
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from(''), pid: 1, output: [], signal: null };
    }) as unknown as typeof childProcess.spawnSync);
    __resetOperatorGitConfigForTests();
    try {
      expect(hardenedGitSync(tmp, ['rev-parse', '--show-toplevel'], { timeoutMs: 1000, maxBytes: 1024 }).ok).toBe(true);
      expect(hardenedGitSync(tmp, ['rev-parse', '--show-toplevel'], { timeoutMs: 1000, maxBytes: 1024 }).ok).toBe(true);
    } finally { spy.mockRestore(); }
    // #7584: the first call also reads the operator's safe.directory entries (cached), so two calls spawn three times.
    expect(spawns.map(s => s.args.slice(0, 2))).toEqual([['config', '--includes'], ['--no-pager', '--no-optional-locks'], ['--no-pager', '--no-optional-locks']]);
    for (const s of spawns) {
      expect(s.command).toBe('git');
      expect(s.options).toMatchObject({ windowsHide: true, killSignal: 'SIGKILL' });
    }
  });
});
