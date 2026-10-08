/** #6210 (fix wave 12, W1.1): the filesystem-only "is this a Git checkout" classifier. */
import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGitCheckout } from '../src/core/git-checkout.ts';

const dirs: string[] = [];
const scratch = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-git-checkout-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) { try { chmodSync(dir, 0o755); } catch {} rmSync(dir, { recursive: true, force: true }); } });
const noGitDir = {} as NodeJS.ProcessEnv;

test('a plain directory with no .git at or above it is not a checkout', () => {
  expect(classifyGitCheckout(join(scratch()), noGitDir)).toBe('not_git');
});

test('a .git directory or gitdir file at or above the directory makes it a checkout, whatever it contains', () => {
  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'a', 'b'), { recursive: true });
  expect(classifyGitCheckout(join(repo, 'a', 'b'), noGitDir)).toBe('git');
  const linked = scratch();
  writeFileSync(join(linked, '.git'), 'gitdir: /nowhere\n');
  expect(classifyGitCheckout(linked, noGitDir)).toBe('git');
});

test('GIT_DIR in the environment defers to Git', () => {
  expect(classifyGitCheckout(scratch(), { GIT_DIR: '/elsewhere/.git' })).toBe('git');
});

test('a missing directory or a file is unknown, never "not a checkout"', () => {
  const dir = scratch();
  expect(classifyGitCheckout(join(dir, 'missing'), noGitDir)).toBe('unknown');
  writeFileSync(join(dir, 'file'), 'x');
  expect(classifyGitCheckout(join(dir, 'file'), noGitDir)).toBe('unknown');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable parent is unknown', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'locked', 'inner'), { recursive: true });
  chmodSync(join(dir, 'locked'), 0o000);
  try { expect(classifyGitCheckout(join(dir, 'locked', 'inner'), noGitDir)).toBe('unknown'); }
  finally { chmodSync(join(dir, 'locked'), 0o755); }
});
