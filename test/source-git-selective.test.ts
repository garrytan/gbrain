import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { initializeSourceGit, commitSourceGit } from '../src/core/source-git.ts';
import { commitSyncedSourceFiles } from '../src/core/pmbrain-adapters/synced-git.ts';

const roots: string[] = [];
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function repo() {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-selective-git-'));
  roots.push(root);
  initializeSourceGit(root);
  writeFileSync(join(root, 'good.md'), 'old');
  writeFileSync(join(root, 'other.md'), 'old');
  commitSourceGit(root, 'initial');
  return root;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

test('commits only synchronized bytes, preserves other staged changes, and is repeatable', async () => {
  const root = repo();
  writeFileSync(join(root, 'good.md'), 'synced');
  writeFileSync(join(root, 'other.md'), 'user staged');
  git(root, 'add', 'other.md');
  const result = await commitSyncedSourceFiles(root, [{ path: 'good.md', hash: hash('synced') }]);
  expect(result.committed).toBe(true);
  expect(git(root, 'show', 'HEAD:good.md')).toBe('synced');
  expect(git(root, 'show', 'HEAD:other.md')).toBe('old');
  expect(git(root, 'show', ':other.md')).toBe('user staged');
  expect(git(root, 'diff', '--cached', '--name-only')).toBe('other.md');
  expect((await commitSyncedSourceFiles(root, [{ path: 'good.md', hash: hash('synced') }])).committed).toBe(false);
}, 30_000);

test('refuses changed bytes and staged versions of synchronized files', async () => {
  const root = repo(), before = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'good.md'), 'changed after sync');
  const changed = await commitSyncedSourceFiles(root, [{ path: 'good.md', hash: hash('synced') }]);
  expect(changed.pending[0].reason).toContain('改变');
  writeFileSync(join(root, 'good.md'), 'synced');
  git(root, 'add', 'good.md');
  const index = readFileSync(join(root, '.git', 'index'));
  const staged = await commitSyncedSourceFiles(root, [{ path: 'good.md', hash: hash('synced') }]);
  expect(staged.pending[0].reason).toContain('暂存');
  expect(readFileSync(join(root, '.git', 'index')).equals(index)).toBe(true);
  expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
}, 30_000);

test('records a successful deletion and Chinese additions without running hooks', async () => {
  const root = repo();
  rmSync(join(root, 'good.md'));
  writeFileSync(join(root, '中文.md'), 'new');
  writeFileSync(join(root, '.git', 'hooks', 'post-commit'), '#!/bin/sh\ntouch forbidden-push\n');
  const result = await commitSyncedSourceFiles(root, [{ path: 'good.md', deleted: true }, { path: '中文.md', hash: hash('new') }]);
  expect(result.files).toEqual(['good.md', '中文.md']);
  expect(git(root, 'ls-tree', '--name-only', 'HEAD')).not.toContain('good.md');
  expect(git(root, 'show', 'HEAD:中文.md')).toBe('new');
  expect(() => readFileSync(join(root, 'forbidden-push'))).toThrow();
}, 30_000);

test('ordinary folders stay ordinary and unsafe paths cannot enter the commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-no-git-')); roots.push(root);
  expect((await commitSyncedSourceFiles(root, [])).repository).toBe(false);
  const initialized = repo();
  expect((await commitSyncedSourceFiles(initialized, [{ path: '../outside.md', hash: hash('x') }])).pending).toHaveLength(1);
  expect((await commitSyncedSourceFiles(initialized, [{ path: '.GiT/config', hash: hash(readFileSync(join(initialized, '.git', 'config'), 'utf8')) }])).pending[0].reason).toContain('路径');
});

test('cancellation before publishing preserves HEAD and the user index', async () => {
  const root = repo(), before = git(root, 'rev-parse', 'HEAD');
  const index = readFileSync(join(root, '.git', 'index'));
  writeFileSync(join(root, 'good.md'), 'synced');
  const controller = new AbortController();
  await expect(commitSyncedSourceFiles(root, [{ path: 'good.md', hash: hash('synced') }], {
    signal: controller.signal, beforeCommit: async () => { controller.abort(); },
  })).rejects.toThrow();
  expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
  expect(readFileSync(join(root, '.git', 'index')).equals(index)).toBe(true);
  expect(() => readFileSync(join(root, '.git', 'index.lock'))).toThrow();
}, 30_000);

test('an initialized empty repository can record its first synchronized file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pmbrain-first-commit-')); roots.push(root);
  initializeSourceGit(root); writeFileSync(join(root, 'first.md'), 'synced');
  const result = await commitSyncedSourceFiles(root, [{ path: 'first.md', hash: hash('synced') }]);
  expect(result.committed).toBe(true);
  expect(result.previousCommit).toBeNull();
  expect(git(root, 'show', 'HEAD:first.md')).toBe('synced');
}, 30_000);
