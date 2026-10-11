/**
 * #5186 (W14 P1.5a): stamping or adopting an ownership marker inside a Git
 * checkout appends the marker patterns to `<gitdir>/info/exclude` once, so
 * `git add -A` and the first hardened commit never publish the ownership token.
 * The write is idempotent, resolves the exclude file through
 * `git rev-parse --git-path` (linked worktrees), and repairs a missing trailing
 * newline instead of gluing a pattern onto the last line.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  OWNERSHIP_MARKER_GLOBS, adoptTransferredRootStamp, physicalRootReservationPath, reservePhysicalRootRecord, writePhysicalRootStamp,
} from '../src/core/persistence/physical-root-record.ts';

let dir: string;
beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-marker-exclude-'))); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env }).trim();
}
function repo(name: string): string {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  git(path, 'init', '-q', '-b', 'main');
  git(path, 'config', 'user.email', 'example@example.invalid');
  git(path, 'config', 'user.name', 'Example');
  writeFileSync(join(path, 'README.md'), 'init\n');
  git(path, 'add', 'README.md');
  git(path, 'commit', '-qm', 'init');
  return path;
}
function identity() {
  return { brainId: randomUUID(), worktreeId: randomUUID(), hostId: randomUUID(), coordinationPath: join(dir, 'coordination') };
}
function excludeFile(checkout: string): string {
  return resolve(checkout, git(checkout, 'rev-parse', '--git-path', 'info/exclude'));
}
function countLines(body: string, pattern: string): number {
  return body.split('\n').filter(line => line.trim() === pattern).length;
}

test('the marker globs name the stamp, the reservation and the staged stamp, nothing else', () => {
  expect(OWNERSHIP_MARKER_GLOBS).toEqual(['.gbrain-owner.json', '.gbrain-owner-*.json', '.gbrain-owner.json.*.tmp']);
});

test('stamping a root nested in a checkout excludes the stamp and the reservation beside it', () => {
  const checkout = repo('work');
  const root = join(checkout, 'brain');
  mkdirSync(root);
  const reservation = reservePhysicalRootRecord(root, identity());
  expect(existsSync(physicalRootReservationPath(root))).toBe(true);
  writePhysicalRootStamp(root, reservation);

  const body = readFileSync(excludeFile(checkout), 'utf-8');
  for (const glob of OWNERSHIP_MARKER_GLOBS) expect(countLines(body, glob)).toBe(1);
  expect(body.endsWith('\n')).toBe(true);
  const porcelain = git(checkout, 'status', '--porcelain', '--untracked-files=all');
  expect(porcelain).not.toContain('.gbrain-owner');
  expect(git(checkout, 'check-ignore', 'brain/.gbrain-owner.json')).toBe('brain/.gbrain-owner.json');
});

test('a rerun and an adopted stamp add nothing twice; a file without a trailing newline keeps its last pattern intact', () => {
  const checkout = repo('work');
  const exclude = excludeFile(checkout);
  mkdirSync(join(checkout, '.git', 'info'), { recursive: true });
  writeFileSync(exclude, '*.log\nscratch/');
  const root = join(checkout, 'brain');
  mkdirSync(root);
  const reservation = reservePhysicalRootRecord(root, identity());
  writePhysicalRootStamp(root, reservation);
  const once = readFileSync(exclude, 'utf-8');
  expect(countLines(once, 'scratch/')).toBe(1);
  expect(once.startsWith('*.log\nscratch/\n')).toBe(true);

  rmSync(join(root, '.gbrain-owner.json'));
  writePhysicalRootStamp(root, reservation);
  adoptTransferredRootStamp(root, reservation);
  expect(readFileSync(exclude, 'utf-8')).toBe(once);
});

test('a linked worktree writes the exclude file git names for it, not <root>/.git/info/exclude', () => {
  const main = repo('main');
  const linked = join(dir, 'linked');
  git(main, 'worktree', 'add', '-q', linked, '-b', 'side');
  const reservation = reservePhysicalRootRecord(linked, identity());
  writePhysicalRootStamp(linked, reservation);

  const exclude = excludeFile(linked);
  expect(exclude.startsWith(join(main, '.git'))).toBe(true);
  const body = readFileSync(exclude, 'utf-8');
  for (const glob of OWNERSHIP_MARKER_GLOBS) expect(countLines(body, glob)).toBe(1);
  expect(existsSync(join(linked, '.git', 'info', 'exclude'))).toBe(false);
  expect(git(linked, 'status', '--porcelain', '--untracked-files=all')).not.toContain('.gbrain-owner');
});

test('a root outside any checkout stamps as before and writes no exclude file', () => {
  const root = join(dir, 'plain');
  mkdirSync(root);
  const reservation = reservePhysicalRootRecord(root, identity());
  writePhysicalRootStamp(root, reservation);
  expect(existsSync(join(root, '.gbrain-owner.json'))).toBe(true);
  expect(existsSync(join(root, '.git'))).toBe(false);
  expect(existsSync(join(dir, '.git'))).toBe(false);
});
