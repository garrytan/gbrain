import { describe, test, expect, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeGitFixture, type GitFixture } from './git-fixture.ts';

const dirs: string[] = [];

async function makeFixture(): Promise<GitFixture> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-git-fixture-'));
  dirs.push(dir);
  return makeGitFixture(dir);
}

function head(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function status(dir: string): string {
  return execFileSync('git', ['-C', dir, 'status', '--porcelain'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('makeGitFixture', () => {
  test('creates a repo with an initial commit and a clean tree', async () => {
    const fixture = await makeFixture();
    expect(existsSync(join(fixture.dir, '.git'))).toBe(true);
    expect(head(fixture.dir)).toMatch(/^[0-9a-f]{40}$/);
    expect(status(fixture.dir)).toBe('');
  });

  test('reset removes untracked files and restores tracked content', async () => {
    const fixture = await makeFixture();
    writeFileSync(join(fixture.dir, 'a.txt'), 'v1\n');
    fixture.commitAll('add a.txt');

    writeFileSync(join(fixture.dir, 'a.txt'), 'v2-dirty\n'); // tracked, modified
    writeFileSync(join(fixture.dir, 'untracked.txt'), 'junk\n'); // untracked

    fixture.reset();

    expect(readFileSync(join(fixture.dir, 'a.txt'), 'utf8')).toBe('v1\n');
    expect(existsSync(join(fixture.dir, 'untracked.txt'))).toBe(false);
    expect(status(fixture.dir)).toBe('');
  });

  test('reset does not rewind commits: HEAD stays where commitAll left it', async () => {
    const fixture = await makeFixture();
    writeFileSync(join(fixture.dir, 'a.txt'), 'v1\n');
    fixture.commitAll('add a.txt');
    const after = head(fixture.dir);

    fixture.reset();

    expect(head(fixture.dir)).toBe(after);
    expect(readFileSync(join(fixture.dir, 'a.txt'), 'utf8')).toBe('v1\n');
  });

  test('commitAll advances HEAD and leaves a clean tree', async () => {
    const fixture = await makeFixture();
    const before = head(fixture.dir);
    writeFileSync(join(fixture.dir, 'b.txt'), 'content\n');
    fixture.commitAll('add b.txt');
    const after = head(fixture.dir);
    expect(after).not.toBe(before);
    expect(status(fixture.dir)).toBe('');
  });

  test('commitAll throws when there is nothing to commit', async () => {
    const fixture = await makeFixture();
    expect(() => fixture.commitAll('empty')).toThrow();
  });
});
