/**
 * #5186 (W14 P1.5a): `bootstrap verify`'s deny_globs check. An ownership
 * marker or bootstrap lock that is merely on disk is not a finding (a root
 * stamped before the exclude rule existed; `sources push` excludes it); one in
 * the index is, as is any untracked credential-class match, exactly as before.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDenyGlobs } from '../src/core/bootstrap/verify.ts';

let ws: string;
function git(...args: string[]): string {
  return execFileSync('git', ['-C', ws, ...args], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: process.env }).trim();
}
beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'gb-verify-deny-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'example@example.invalid');
  git('config', 'user.name', 'Example');
  writeFileSync(join(ws, 'README.md'), 'init\n');
  git('add', 'README.md');
  git('commit', '-qm', 'init');
});
afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

test('untracked markers and the bootstrap lock pass with a note; an indexed marker fails with git rm --cached', () => {
  mkdirSync(join(ws, 'brain'));
  writeFileSync(join(ws, 'brain', '.gbrain-owner.json'), '{"version":1}\n');
  writeFileSync(join(ws, `.gbrain-owner-${'0'.repeat(64)}.json`), '{"version":1}\n');
  mkdirSync(join(ws, '.gbrain-bootstrap.lock'));
  writeFileSync(join(ws, '.gbrain-bootstrap.lock', 'meta.json'), '{"pid":1}\n');
  const quiet = checkDenyGlobs(ws);
  expect(quiet.ok).toBe(true);
  expect(quiet.detail).toContain('3 untracked ownership marker/lock file(s)');

  git('add', '-f', 'brain/.gbrain-owner.json');
  const tracked = checkDenyGlobs(ws);
  expect(tracked.ok).toBe(false);
  expect(tracked.detail).toContain('brain/.gbrain-owner.json');
  expect(tracked.detail).toContain('git rm --cached');
  expect(tracked.detail).not.toContain('meta.json');
});

test('an untracked credential-class match is still a finding', () => {
  writeFileSync(join(ws, 'server.key'), 'not-a-key\n');
  const res = checkDenyGlobs(ws);
  expect(res.ok).toBe(false);
  expect(res.detail).toContain('server.key');
});
