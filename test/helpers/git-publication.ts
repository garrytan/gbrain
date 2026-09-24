import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', '-C', root, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}

export function gitFixture() {
  const requestedHome = mkdtempSync(join(tmpdir(), 'gbrain-git-publication-'));
  const home = realpathSync.native(requestedHome);
  const root = join(home, 'worktree'), remote = join(home, 'remote.git');
  mkdirSync(root); mkdirSync(remote);
  git(root, 'init', '-b', 'main');
  git(root, 'config', 'user.name', 'Example Writer');
  git(root, 'config', 'user.email', 'writer@example.invalid');
  writeFileSync(join(root, 'initial.md'), 'Initial\n');
  git(root, 'add', 'initial.md'); git(root, 'commit', '-m', 'Initial');
  git(remote, 'init', '--bare');
  git(root, 'remote', 'add', 'origin', remote); git(root, 'push', '-u', 'origin', 'main');
  const hooks = join(root, '.git', 'hooks');
  const hook = join(hooks, 'post-commit');
  writeFileSync(hook, '#!/bin/sh\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 99\n');
  chmodSync(hook, 0o755);
  mkdirSync(join(root, 'Notes'));
  const caseInsensitive = existsSync(join(root, 'notes'));
  return { home, root, requestedRoot: join(requestedHome, 'worktree'), remote, caseInsensitive,
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}
