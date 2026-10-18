import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A git call that did not exit 0. A null exit code is a child that ended by
 * signal or that `Bun.spawnSync` gave up on without a status: Bun 1.4.x
 * (oven-sh/bun#34069) returns one with empty output after a GC finalizer
 * ran inside an earlier sync spawn, and treating it as success turned that
 * into a bogus fixture and a `durability_not_enabled` assertion later on.
 */
function gitFailure(root: string, args: string[], exitCode: number | null, signalCode: string | null, stderr: string): Error {
  const status = `${exitCode === null ? 'no exit status' : `exit ${exitCode}`}${signalCode ? ` (signal ${signalCode})` : ''}`;
  return new Error(`git ${args.join(' ')} in ${root}: ${status}${stderr.trim() ? `\n${stderr.trim()}` : ''}`);
}

/**
 * Synchronous git for fixtures that cannot await. Prefer {@link gitAsync} in
 * test bodies: `Bun.spawnSync` is where oven-sh/bun#34069 bites (a GC
 * finalizer during the wait poisons every later sync spawn in the process).
 */
export function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { env: process.env });
  if (result.exitCode !== 0) throw gitFailure(root, args, result.exitCode, result.signalCode ?? null, result.stderr.toString());
  return result.stdout.toString();
}

/** Asynchronous git on the main event loop: no `spawnSync` window for oven-sh/bun#34069 to land in. */
export async function gitAsync(root: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn(['git', '-C', root, ...args], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) throw gitFailure(root, args, exitCode, proc.signalCode, stderr);
  return stdout;
}

/** A durability-hardened repo with no remote: Git effects publish for real and the hook is inert. */
export function durableGitRepo(root: string, committed: string[]): void {
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Example Writer');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  git(root, 'add', ...committed); git(root, 'commit', '-q', '-m', 'Initial');
  const hook = join(root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\n');
  chmodSync(hook, 0o755);
}

export interface GitFixture { home: string; root: string; requestedRoot: string; remote: string; caseInsensitive: boolean; cleanup: () => void }

function gitFixtureDirs() {
  const requestedHome = mkdtempSync(join(tmpdir(), 'gbrain-git-publication-'));
  const home = realpathSync.native(requestedHome);
  const root = join(home, 'worktree'), remote = join(home, 'remote.git');
  mkdirSync(root); mkdirSync(remote);
  return { requestedHome, home, root, remote };
}

/** The hook that marks the fixture durability-hardened (and fails loudly if a Git effect ever ran it), plus the Notes directory. */
function finishGitFixture({ requestedHome, home, root, remote }: ReturnType<typeof gitFixtureDirs>): GitFixture {
  const hook = join(root, '.git', 'hooks', 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 99\n');
  chmodSync(hook, 0o755);
  mkdirSync(join(root, 'Notes'));
  const caseInsensitive = existsSync(join(root, 'notes'));
  return { home, root, requestedRoot: join(requestedHome, 'worktree'), remote, caseInsensitive,
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function gitFixture(): GitFixture {
  const dirs = gitFixtureDirs();
  const { root, remote } = dirs;
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  git(root, 'add', 'initial.md'); git(root, 'commit', '-m', 'Initial');
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-u', 'origin', 'main');
  return finishGitFixture(dirs);
}

/** {@link gitFixture} with every git call awaited on the main loop. */
export async function gitFixtureAsync(): Promise<GitFixture> {
  const dirs = gitFixtureDirs();
  const { root, remote } = dirs;
  await gitAsync(root, 'init', '-b', 'main');
  await gitAsync(root, 'config', 'user.name', 'Example Writer');
  await gitAsync(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  await gitAsync(root, 'add', 'initial.md'); await gitAsync(root, 'commit', '-m', 'Initial');
  await gitAsync(remote, 'init', '--bare');
  await gitAsync(root, 'remote', 'add', 'origin', remote); await gitAsync(root, 'push', '-u', 'origin', 'main');
  return finishGitFixture(dirs);
}
