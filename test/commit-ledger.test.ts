/**
 * PR B Part 3: the commit ledger at <git common dir>/gbrain/commit-ledger.jsonl. Real git repositories in temp dirs.
 */
import { afterAll, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LEDGER_ROTATE_BYTES, ledgerFiles, messageDigest, readLedger, recordCommit, recordIntent } from '../src/core/git/commit-ledger.ts';
import { commitPathsLocked } from '../src/core/git/commit-push.ts';

const dir = mkdtempSync(join(tmpdir(), 'gbrain-commit-ledger-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
}
let n = 0;
function repo(): string {
  const root = join(dir, `repo-${n++}`);
  mkdirSync(root);
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'alice-example@example.invalid']);
  git(root, ['config', 'user.name', 'Alice Example']);
  writeFileSync(join(root, 'seed.md'), 'seed\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'seed']);
  return root;
}

test('the first append writes a start line, then one JSON line per record under 1 KiB', () => {
  const root = repo();
  const head = git(root, ['rev-parse', 'HEAD']);
  mkdirSync(join(root, 'notes'));
  recordCommit(join(root, 'notes'), { sha: head, writer: 'door', request_id: null });
  recordIntent(root, { writer: 'commit_push', head_before: head, message: 'subject\n\nbody' });
  const records = readLedger(join(root, '.git'));
  expect(records.map(r => r.e)).toEqual(['start', 'commit', 'intent']);
  const commit = records[1]!;
  expect(commit).toMatchObject({ v: 1, e: 'commit', sha: head, writer: 'door', ref: 'refs/heads/main', worktree: git(root, ['rev-parse', '--show-toplevel']), pid: process.pid });
  for (const line of readFileSync(ledgerFiles(join(root, '.git')).current, 'utf8').split('\n').filter(Boolean)) expect(Buffer.byteLength(line)).toBeLessThan(1024);
});

test('a linked worktree appends to the one ledger in the common dir', () => {
  const root = repo();
  const linked = join(dir, `linked-${n++}`);
  git(root, ['worktree', 'add', '-q', '-b', 'side', linked]);
  recordCommit(linked, { sha: git(linked, ['rev-parse', 'HEAD']), writer: 'effect' });
  const records = readLedger(join(root, '.git'));
  expect(records.find(r => r.e === 'commit')).toMatchObject({ writer: 'effect', ref: 'refs/heads/side' });
  expect(existsSync(join(root, '.git', 'worktrees'))).toBe(true);
});

test('at 4 MiB the ledger rotates to commit-ledger.1.jsonl without a new start line; both files are read', () => {
  const root = repo();
  const files = ledgerFiles(join(root, '.git'));
  recordCommit(root, { sha: 'a'.repeat(40), writer: 'door' });
  const filler = `${JSON.stringify({ v: 1, e: 'commit', t: new Date().toISOString(), sha: 'b'.repeat(40), writer: 'door' })}\n`;
  writeFileSync(files.current, readFileSync(files.current, 'utf8') + filler.repeat(Math.ceil(LEDGER_ROTATE_BYTES / filler.length)));
  recordCommit(root, { sha: 'c'.repeat(40), writer: 'merge' });
  expect(existsSync(files.rotated)).toBe(true);
  expect(statSync(files.current).size).toBeLessThan(1024);
  const current = readFileSync(files.current, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  expect(current.map(r => r.e)).toEqual(['commit']);
  const all = readLedger(join(root, '.git'));
  expect(all[0]!.e).toBe('start');
  expect(all.at(-1)).toMatchObject({ sha: 'c'.repeat(40), writer: 'merge' });
});

test('a directory outside git records nothing and never throws', () => {
  const plain = mkdtempSync(join(dir, 'plain-'));
  expect(() => recordCommit(plain, { sha: 'a'.repeat(40), writer: 'bootstrap' })).not.toThrow();
  expect(existsSync(join(plain, '.git'))).toBe(false);
});

test('a failed append never fails the commit (commit-push still commits)', () => {
  const root = repo();
  writeFileSync(join(root, '.git', 'gbrain'), 'not a directory');
  writeFileSync(join(root, 'page.md'), 'page\n');
  const sha = commitPathsLocked(root, ['page.md'], 'add page', { lockWaitMs: 1000 });
  expect(sha).toBe(git(root, ['rev-parse', 'HEAD']));
});

test('commit-push records an intent with head_before and the message digest, then the commit', () => {
  const root = repo();
  const before = git(root, ['rev-parse', 'HEAD']);
  writeFileSync(join(root, 'page.md'), 'page\n');
  const sha = commitPathsLocked(root, ['page.md'], 'add page', { lockWaitMs: 1000 })!;
  const records = readLedger(join(root, '.git'));
  const intent = records.find(r => r.e === 'intent');
  expect(intent).toMatchObject({ writer: 'commit_push', head_before: before, msg_sha256: messageDigest(git(root, ['log', '-1', '--format=%B', sha])) });
  expect(records.find(r => r.e === 'commit')).toMatchObject({ writer: 'commit_push', sha });
});

test('messageDigest applies git whitespace cleanup', () => {
  expect(messageDigest('subject  \n\n\n\nbody\n\n')).toBe(messageDigest('subject\n\nbody'));
  expect(messageDigest('a')).not.toBe(messageDigest('b'));
});

test('GST-1623: a ledger that exists but cannot be read throws instead of reading as empty; a missing one is empty', () => {
  const root = repo();
  expect(readLedger(join(root, '.git'))).toEqual([]);
  const files = ledgerFiles(join(root, '.git'));
  mkdirSync(files.current, { recursive: true });
  expect(() => readLedger(join(root, '.git'))).toThrow();
});

