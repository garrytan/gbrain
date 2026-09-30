/**
 * `pushGitRoot` is a plain `git push` with no rebase-retry fallback. Once origin
 * advances between one worktree's commit and its push, that push is rejected
 * (non-fast-forward) — and every LATER push for that root fails the same way
 * too, since local is now permanently behind. Commits pile up unpushed forever
 * with nothing to reconcile them. reconcileDivergedPush() closes that gap: the
 * effect worker's unpushed-flush loop calls it (still holding the worktree
 * lock) on a `git_push_unavailable` failure, then retries the push once.
 *
 * .serial: process.env mutation (GBRAIN_GIT_ALLOW_FILE_TRANSPORT) + real git
 * subprocesses (docs/TESTING.md R1).
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pushGitRoot, reconcileDivergedPush } from '../src/core/persistence/effect-git.ts';

const roots: string[] = [];

beforeEach(() => { process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1'; });
afterEach(() => {
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function git(root: string, args: string[]) {
  return execFileSync('git', ['-C', root, '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf8' }).trim();
}

test('a push that falls behind origin keeps failing on retry until reconciled', async () => {
  const origin = mkdtempSync(join(tmpdir(), 'gbrain-effects-origin-')); roots.push(origin);
  git(origin, ['init', '--bare', '-b', 'main']);

  const root = mkdtempSync(join(tmpdir(), 'gbrain-effects-a-')); roots.push(root);
  git(root, ['clone', origin, '.']);
  git(root, ['config', 'user.name', 'A']); git(root, ['config', 'user.email', 'a@example.invalid']);
  writeFileSync(join(root, 'page.md'), 'Base'); git(root, ['add', 'page.md']); git(root, ['commit', '-m', 'Base']);
  git(root, ['push', 'origin', 'HEAD:main']);

  // A second writer pushes to origin first, so `root` is now behind.
  const other = mkdtempSync(join(tmpdir(), 'gbrain-effects-b-')); roots.push(other);
  git(other, ['clone', origin, '.']);
  git(other, ['config', 'user.name', 'B']); git(other, ['config', 'user.email', 'b@example.invalid']);
  writeFileSync(join(other, 'other.md'), 'Other'); git(other, ['add', 'other.md']); git(other, ['commit', '-m', 'Other']);
  git(other, ['push', 'origin', 'HEAD:main']);

  // `root` commits locally (as the effect worker's commit phase would have) but is now behind.
  writeFileSync(join(root, 'page.md'), 'Changed'); git(root, ['add', 'page.md']); git(root, ['commit', '-m', 'gbrain: persist canonical memory update']);

  await expect(pushGitRoot(root)).rejects.toMatchObject({ code: 'git_push_unavailable' });
  // A bare retry (no reconciliation) fails the exact same way, forever.
  await expect(pushGitRoot(root)).rejects.toMatchObject({ code: 'git_push_unavailable' });

  expect(reconcileDivergedPush(root)).toMatchObject({ status: 'advanced' });
  expect(await pushGitRoot(root)).toMatchObject({ push: 'committed' });
  expect(git(origin, ['log', '-1', '--pretty=%s'])).toBe('gbrain: persist canonical memory update');
  expect(existsSync(join(root, 'other.md'))).toBe(true);
});
