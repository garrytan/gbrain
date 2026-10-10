/** #6210 (fix wave 12, W1.1): the filesystem-only "is this a Git checkout" classifier. */
import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyGitCheckout } from '../src/core/git-checkout.ts';
import { withEnv } from './helpers/with-env.ts';

const dirs: string[] = [];
const scratch = () => { const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'gbrain-git-checkout-'))); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) { try { chmodSync(dir, 0o755); } catch {} rmSync(dir, { recursive: true, force: true }); } });

test('a plain directory with no .git at or above it is not a checkout', () => {
  expect(classifyGitCheckout(join(scratch()))).toBe('not_git');
});

test('a .git directory or gitdir file at or above the directory makes it a checkout, whatever it contains', () => {
  const repo = scratch();
  mkdirSync(join(repo, '.git'));
  mkdirSync(join(repo, 'a', 'b'), { recursive: true });
  expect(classifyGitCheckout(join(repo, 'a', 'b'))).toBe('git');
  const linked = scratch();
  writeFileSync(join(linked, '.git'), 'gitdir: /nowhere\n');
  expect(classifyGitCheckout(linked)).toBe('git');
});

test('CSO G4: an inherited GIT_DIR does not make a plain directory a checkout', async () => {
  const other = scratch();
  mkdirSync(join(other, '.git'));
  const plain = scratch();
  await withEnv({ GIT_DIR: join(other, '.git') }, async () => { expect(classifyGitCheckout(plain)).toBe('not_git'); });
});

test.skipIf(process.platform === 'win32')('CSO G3: discovery stops at a world-writable ancestor owned by someone else', () => {
  const shared = scratch();
  mkdirSync(join(shared, '.git'));
  mkdirSync(join(shared, 'brain', 'notes'), { recursive: true });
  const foreign = (path: string) => {
    const real = statSync(path);
    return path === shared ? { uid: real.uid + 1, mode: real.mode | 0o1777, isDirectory: () => true } : real;
  };
  expect(classifyGitCheckout(join(shared, 'brain', 'notes'), foreign)).toBe('not_git');
  const sharedSameOwner = (path: string) => {
    const real = statSync(path);
    return path === shared ? { uid: real.uid, mode: real.mode | 0o1777, isDirectory: () => true } : real;
  };
  expect(classifyGitCheckout(join(shared, 'brain', 'notes'), sharedSameOwner)).toBe('git');
  const foreignNotWritable = (path: string) => {
    const real = statSync(path);
    return path === shared ? { uid: real.uid + 1, mode: (real.mode & ~0o002) | 0o755, isDirectory: () => true } : real;
  };
  expect(classifyGitCheckout(join(shared, 'brain', 'notes'), foreignNotWritable)).toBe('git');
  expect(classifyGitCheckout(join(shared, 'brain', 'notes'))).toBe('git');
});

const sudo = process.platform !== 'win32' && process.getuid?.() !== 0 && spawnSync('sudo', ['-n', 'true']).status === 0;
test.skipIf(!sudo)('CSO G3 on the real filesystem: a root-owned .git in a 1777 directory above a user directory is not this checkout', () => {
  const user = scratch();
  const shared = join(user, 'shared');
  mkdirSync(shared);
  try {
    expect(spawnSync('sudo', ['-n', 'sh', '-c', `mkdir "${shared}/.git" && chown root:root "${shared}" "${shared}/.git" && chmod 1777 "${shared}"`]).status).toBe(0);
    const brain = join(shared, 'brain');
    mkdirSync(brain);
    expect(classifyGitCheckout(brain)).toBe('not_git');
  } finally { spawnSync('sudo', ['-n', 'rm', '-rf', shared]); }
});

test('a missing directory or a file is unknown, never "not a checkout"', () => {
  const dir = scratch();
  expect(classifyGitCheckout(join(dir, 'missing'))).toBe('unknown');
  writeFileSync(join(dir, 'file'), 'x');
  expect(classifyGitCheckout(join(dir, 'file'))).toBe('unknown');
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('an unreadable parent is unknown', () => {
  const dir = scratch();
  mkdirSync(join(dir, 'locked', 'inner'), { recursive: true });
  chmodSync(join(dir, 'locked'), 0o000);
  try { expect(classifyGitCheckout(join(dir, 'locked', 'inner'))).toBe('unknown'); }
  finally { chmodSync(join(dir, 'locked'), 0o755); }
});
