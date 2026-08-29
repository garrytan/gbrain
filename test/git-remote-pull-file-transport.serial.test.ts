/**
 * #3836 — pullRepo/fetchRemote build their global git flags via
 * durableSsrfFlags() so the documented GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1
 * escape hatch reaches sync's pull. Pre-fix they hardcoded GIT_SSRF_FLAGS
 * (protocol.file.allow=never, unconditionally), so a self-hosted
 * local-filesystem remote could be CLONED (via the harden/durability paths)
 * but `gbrain sync` could never pull it again.
 *
 * Default posture stays never — asserted below.
 *
 * .serial: process.env mutation + real git subprocesses (docs/TESTING.md R1).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  pullRepo,
  fetchRemote,
  durableSsrfFlags,
  GitOperationError,
} from '../src/core/git-remote.ts';

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}

/** Bare origin + writer clone (pushes main) + a reader clone (the sync repo). */
function makeTrio(): { bare: string; writer: string; reader: string } {
  const bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const writer = mkdtempSync(join(root, 'writer-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, writer], { stdio: 'ignore' });
  git(writer, 'config', 'user.email', 't@t.t');
  git(writer, 'config', 'user.name', 'tester');
  writeFileSync(join(writer, 'README.md'), 'init\n');
  git(writer, 'add', 'README.md');
  git(writer, 'commit', '-qm', 'init');
  git(writer, 'push', '-q', 'origin', 'main');
  const reader = mkdtempSync(join(root, 'reader-'));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, reader], { stdio: 'ignore' });
  return { bare, writer, reader };
}

function pushSecondCommit(writer: string): void {
  writeFileSync(join(writer, 'NEW.md'), 'second commit\n');
  git(writer, 'add', 'NEW.md');
  git(writer, 'commit', '-qm', 'second');
  git(writer, 'push', '-q', 'origin', 'main');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gbrain-3836-'));
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
});
afterEach(() => {
  delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT;
  rmSync(root, { recursive: true, force: true });
});

describe('#3836 durableSsrfFlags env toggle (unit)', () => {
  test('default builds protocol.file.allow=never; env=1 flips it to always', () => {
    expect(durableSsrfFlags()).toContain('protocol.file.allow=never');
    process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
    expect(durableSsrfFlags()).toContain('protocol.file.allow=always');
  });
});

describe('#3836 pullRepo honors the file-transport escape hatch', () => {
  test('default posture: pull over the file transport still refuses', () => {
    const { writer, reader } = makeTrio();
    pushSecondCommit(writer);
    expect(() => pullRepo(reader)).toThrow(GitOperationError);
    expect(existsSync(join(reader, 'NEW.md'))).toBe(false);
  });

  test('GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1: sync-style pull succeeds and lands the new commit', () => {
    const { writer, reader } = makeTrio();
    pushSecondCommit(writer);
    process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
    pullRepo(reader);
    expect(readFileSync(join(reader, 'NEW.md'), 'utf-8')).toContain('second commit');
  });

  test('GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1: fetchRemote (cost-estimator path) succeeds too', () => {
    const { writer, reader } = makeTrio();
    pushSecondCommit(writer);
    process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1';
    fetchRemote(reader, 'main');
    const fetched = git(reader, 'rev-parse', 'FETCH_HEAD');
    const pushed = git(writer, 'rev-parse', 'HEAD');
    expect(fetched).toBe(pushed);
  });
});
