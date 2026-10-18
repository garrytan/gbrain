/**
 * GBRA-75 wave 10: the doctor-run git memo (src/core/git-visible-files.ts).
 *
 * Protects: inside one `withGitListingCache` run a directory git reported
 * outside any repository is not probed again (`git ls-files`, `discoverGitRoot`
 * and the census HEAD probe share the verdict), and the memo never hides a
 * change: a git command that changes a repository (sync-git.ts) or an explicit
 * `invalidateGitListingCache()` drops it, so a file added mid-run is listed by
 * the next listing; and nothing outlives the run.
 * Fails when: a listing or verdict survives an in-run sync-git write or invalidation, the
 * memo leaks past its scope, or a non-repository directory is probed more than
 * once per run.
 * Temp directories and the system git ($0); synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectGitVisibleFiles, invalidateGitListingCache, withGitListingCache } from '../src/core/git-visible-files.ts';
import { discoverGitRoot, git } from '../src/core/sync-git.ts';

const root = mkdtempSync(join(tmpdir(), 'gbrain-git-memo-'));
const log = join(root, 'git.log');
const ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: root };
const saved: Record<string, string | undefined> = {};
let n = 0;

const all = () => true;
const names = (dir: string) => collectGitVisibleFiles(dir, all)?.map(p => p.slice(dir.length + 1)) ?? null;
const spawns = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0);
function freshDir(repo: boolean): string {
  const dir = join(root, `d${n++}`);
  mkdirSync(dir);
  writeFileSync(join(dir, 'a.md'), 'a\n');
  if (repo) {
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    execFileSync('git', ['-C', dir, 'add', 'a.md'], { stdio: 'ignore' });
  }
  return dir;
}

beforeAll(() => {
  // A git shim on PATH counts every spawn this process makes.
  const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(bin, 'git'), 0o755);
  for (const [k, v] of Object.entries({ ...ENV, PATH: `${bin}:${process.env.PATH}` })) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('withGitListingCache memo', () => {
  test('a non-repository directory is probed once per run by listings, discoverGitRoot and repeats', async () => {
    const dir = freshDir(false);
    const before = spawns();
    await withGitListingCache(async () => {
      expect(names(dir)).toBeNull();
      expect(() => discoverGitRoot(dir)).toThrow(`Not inside a git repository: ${dir}`);
      expect(names(dir)).toBeNull();
      expect(() => discoverGitRoot(dir)).toThrow(`Not inside a git repository: ${dir}`);
    });
    expect(spawns() - before).toBe(1);
    // Outside a run every call spawns, as before.
    expect(names(dir)).toBeNull();
    expect(() => discoverGitRoot(dir)).toThrow(`Not inside a git repository: ${dir}`);
    expect(spawns() - before).toBe(3);
  });

  test('a file added mid-run through a sync-git write is listed by the next listing', async () => {
    const dir = freshDir(true);
    await withGitListingCache(async () => {
      expect(names(dir)).toEqual(['a.md']);
      writeFileSync(join(dir, 'b.md'), 'b\n');
      git(dir, ['add', 'b.md']);
      expect(names(dir)).toEqual(['a.md', 'b.md']);
    });
  });

  test('a file written mid-run is listed after invalidateGitListingCache', async () => {
    const dir = freshDir(true);
    await withGitListingCache(async () => {
      expect(names(dir)).toEqual(['a.md']);
      writeFileSync(join(dir, 'c.md'), 'c\n');
      invalidateGitListingCache();
      expect(names(dir)).toEqual(['a.md', 'c.md']);
    });
  });

  test('nothing outlives the run: a repository created after it is seen at once', async () => {
    const dir = freshDir(false);
    await withGitListingCache(async () => { expect(names(dir)).toBeNull(); });
    execFileSync('git', ['-C', dir, 'init', '-q'], { stdio: 'ignore' });
    expect(names(dir)).toEqual(['a.md']);
    await withGitListingCache(async () => { expect(names(dir)).toEqual(['a.md']); });
  });
});
