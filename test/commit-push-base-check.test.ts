/**
 * PR B: `gbrain git commit-push --base <path>=<blob>` binds a commit to the bytes the writer read.
 *
 * Protects: a writer that read a file at blob X and commits with --base path=X is refused `commit_base_moved` when another
 * writer committed that file since (nothing staged, index unchanged, the other writer's bytes win); a matching base (and
 * `absent` for a new file) commits; a --base path that is not committed, a malformed base, and --base with --push-only
 * are refused before anything runs. Real git against a local bare remote.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitAndPush } from '../src/core/git/commit-push.ts';
import { runGit } from '../src/commands/git.ts';

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), 'gbrain-base-')); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], { encoding: 'utf-8', env: process.env }).trim();

function setup(name: string): { bare: string; a: string; b: string } {
  const bare = join(root, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const mk = (n: string) => {
    const dir = join(root, `${name}-${n}`);
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, dir], { stdio: 'ignore' });
    git(dir, 'config', 'user.email', `${n}@example.com`); git(dir, 'config', 'user.name', n);
    return dir;
  };
  const a = mk('a');
  writeFileSync(join(a, 'note.md'), 'v1\n');
  git(a, 'add', '.'); git(a, 'commit', '-qm', 'seed'); git(a, 'push', '-q', '-u', 'origin', 'main');
  return { bare, a, b: mk('b') };
}

const refusal = (fn: () => unknown) => { try { fn(); } catch (e) { return e as { code?: string; detail?: string }; } throw new Error('expected a refusal'); };

test('a base that moved at HEAD refuses commit_base_moved and stages nothing; a matching base commits', () => {
  const { a } = setup('moved');
  const read = git(a, 'rev-parse', 'HEAD:note.md');
  writeFileSync(join(a, 'note.md'), 'v2 from another writer\n');
  commitAndPush({ repo: a, cwd: a, paths: ['note.md'], message: 'other writer' });
  const moved = git(a, 'rev-parse', 'HEAD:note.md');
  writeFileSync(join(a, 'note.md'), 'v1 plus my stale edit\n');
  const err = refusal(() => commitAndPush({ repo: a, cwd: a, paths: ['note.md'], message: 'stale', bases: new Map([['note.md', read]]) }));
  expect(err.code).toBe('commit_base_moved');
  expect(JSON.parse(err.detail!)).toEqual({ path: 'note.md', base: read, head: moved });
  expect(git(a, 'rev-parse', 'HEAD:note.md')).toBe(moved);
  expect(git(a, 'diff', '--cached', '--name-only')).toBe('');
  const ok = commitAndPush({ repo: a, cwd: a, paths: ['note.md'], message: 'rebased edit', bases: new Map([['note.md', moved]]) });
  expect(ok.committed).toBeTruthy();
});

test('absent binds a new file: it commits while the path is new and refuses once another writer added it', () => {
  const { a } = setup('absent');
  writeFileSync(join(a, 'new.md'), 'mine\n');
  expect(commitAndPush({ repo: a, cwd: a, paths: ['new.md'], message: 'add', bases: new Map([['new.md', 'absent']]) }).committed).toBeTruthy();
  writeFileSync(join(a, 'new.md'), 'mine again\n');
  expect(refusal(() => commitAndPush({ repo: a, cwd: a, paths: ['new.md'], message: 'again', bases: new Map([['new.md', 'absent']]) })).code).toBe('commit_base_moved');
});

test('CLI: --base must name a committed path, take a full object id or absent, and not combine with --push-only', async () => {
  const { a } = setup('cli');
  const blob = git(a, 'rev-parse', 'HEAD:note.md');
  writeFileSync(join(a, 'note.md'), 'v2\n');
  const quiet = async (args: string[]) => { const w = process.stderr.write; const o = process.stdout.write; process.stderr.write = (() => true) as never; process.stdout.write = (() => true) as never;
    try { return await runGit(args); } finally { process.stderr.write = w; process.stdout.write = o; } };
  expect(await quiet(['commit-push', '--path', a, '--base', `other.md=${blob}`, '-m', 'x', '--', 'note.md'])).not.toBe(0);
  expect(await quiet(['commit-push', '--path', a, '--base', 'note.md=abc123', '-m', 'x', '--', 'note.md'])).not.toBe(0);
  expect(await quiet(['commit-push', '--path', a, '--base', `note.md=${blob}`, '--push-only'])).not.toBe(0);
  expect(git(a, 'rev-parse', 'HEAD:note.md')).toBe(blob);
  expect(await quiet(['commit-push', '--path', a, '--base', `note.md=${blob}`, '-m', 'bound', '--', 'note.md'])).toBe(0);
  expect(git(a, 'rev-parse', 'HEAD:note.md')).not.toBe(blob);
});
