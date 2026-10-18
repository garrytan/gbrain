/**
 * #5429: `divergenceSafePull`'s documented contract is "never auto-stashes",
 * but the pull it ran honoured a repository or user `rebase.autoStash=true`,
 * so an edit made between the dirty check and the pull was stashed and
 * replayed onto the rebased tree. The pull now carries `--no-autostash` in
 * every mode. Second half: a per-source `pull_strategy: merge` for brains
 * whose intermediate snapshot commits conflict under rebase replay while a
 * merge of the two tips is clean; a merge conflict is aborted with
 * `merge --abort` and the tree is restored byte for byte.
 *
 * Local file transport is enabled via GBRAIN_GIT_ALLOW_FILE_TRANSPORT=1 (the
 * durable SSRF flags refuse it otherwise); the spy sits on node:child_process,
 * which the launch seam looks up at call time.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as childProcess from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { divergenceSafePull } from '../src/core/git-remote.ts';

const { execFileSync } = childProcess;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'protocol.file.allow=always', ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

let root: string;

/** A bare origin + a working clone with one commit on `main`. */
function makePair(): { bare: string; work: string } {
  const bare = mkdtempSync(join(root, 'origin-')) + '.git';
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { stdio: 'ignore' });
  const work = secondClone(bare, 'work-');
  writeFileSync(join(work, 'README.md'), 'init\n');
  writeFileSync(join(work, 'page.md'), 'v1\n');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'init');
  git(work, 'push', '-q', 'origin', 'main');
  return { bare, work };
}

function secondClone(bare: string, prefix = 'work2-'): string {
  const work = mkdtempSync(join(root, prefix));
  execFileSync('git', ['-c', 'protocol.file.allow=always', 'clone', '-q', bare, work], { stdio: 'ignore' });
  git(work, 'config', 'user.email', 't@t.t');
  git(work, 'config', 'user.name', 'tester');
  return work;
}

function commitFile(work: string, name: string, body: string, message: string): string {
  writeFileSync(join(work, name), body);
  git(work, 'add', name);
  git(work, 'commit', '-qm', message);
  return git(work, 'rev-parse', 'HEAD');
}

/** Every tracked and untracked file under the work tree (not .git) with its bytes: the byte-identical witness. */
function treeBytes(work: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path, `${rel}${name}/`);
      else out[`${rel}${name}`] = readFileSync(path, 'latin1');
    }
  };
  walk(work, '');
  return out;
}

/** The repo in `work` has the origin at A→B (page.md = v2) and a local A→L1 (v1b)→L2 (v2): rebase replays L1 onto B and conflicts; a merge of the tips is clean. */
function tipEquivalentDivergence(): { work: string; remoteHead: string; localHead: string } {
  const { bare, work } = makePair();
  const other = secondClone(bare);
  const remoteHead = commitFile(other, 'page.md', 'v2\n', 'remote: v2');
  git(other, 'push', '-q', 'origin', 'main');
  commitFile(work, 'page.md', 'v1b\n', 'local snapshot');
  const localHead = commitFile(work, 'page.md', 'v2\n', 'local: v2');
  return { work, remoteHead, localHead };
}

beforeAll(() => { process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT = '1'; });
afterAll(() => { delete process.env.GBRAIN_GIT_ALLOW_FILE_TRANSPORT; });
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gd-5429-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('--no-autostash (#5429, bug fix)', () => {
  test('#6530: no git pull or rebase runs; the only working-tree move is merge --ff-only with merge.autoStash=false, in rebase mode and in merge mode', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    commitFile(other, 'remote.txt', 'r\n', 'remote');
    git(other, 'push', '-q', 'origin', 'main');
    const calls: string[][] = [];
    const spy = spyOn(childProcess, 'execFileSync');
    try {
      divergenceSafePull(work, 'main');
      commitFile(other, 'remote2.txt', 'r2\n', 'remote 2');
      git(other, 'push', '-q', 'origin', 'main');
      divergenceSafePull(work, 'main', { strategy: 'merge' });
    } finally {
      for (const call of spy.mock.calls) {
        const args = call[1] as string[] | undefined;
        if (call[0] === 'git' && Array.isArray(args)) calls.push(args);
      }
      spy.mockRestore();
    }
    expect(calls.some(argv => argv.includes('pull') || argv.includes('rebase') || argv.includes('stash'))).toBe(false);
    const moves = calls.filter(argv => argv.includes('merge') && !argv.includes('merge-base') && !argv.includes('merge-tree'));
    expect(moves).toHaveLength(2);
    for (const argv of moves) {
      expect(argv.slice(argv.indexOf('merge'))).toContain('--ff-only');
      const off = argv.indexOf('merge.autoStash=false');
      expect(argv[off - 1]).toBe('-c');
      expect(off).toBeLessThan(argv.indexOf('merge'));
    }
    expect(existsSync(join(work, 'remote2.txt'))).toBe(true);
  });

  test('git itself: with rebase.autoStash=true the old argv stashes and replays a dirty edit; --no-autostash refuses and leaves the stash list empty', () => {
    for (const noAutostash of [false, true]) {
      const { bare, work } = makePair();
      const other = secondClone(bare);
      commitFile(other, 'remote.txt', 'r\n', 'remote');
      git(other, 'push', '-q', 'origin', 'main');
      git(work, 'config', 'rebase.autoStash', 'true');
      writeFileSync(join(work, 'README.md'), 'edited between the dirty check and the pull\n');
      git(work, 'fetch', '-q', 'origin', 'main');
      let exit = 0;
      try { git(work, 'pull', '--rebase', ...(noAutostash ? ['--no-autostash'] : []), 'origin', 'main'); }
      catch (error) { exit = (error as { status: number }).status; }
      expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('edited between the dirty check and the pull\n');
      expect(git(work, 'stash', 'list')).toBe('');
      if (noAutostash) {
        expect(exit).not.toBe(0);
        expect(existsSync(join(work, 'remote.txt'))).toBe(false);
      } else {
        // The hole: git stashed the edit, rebased and replayed it, so the pull "succeeded" on a dirty tree.
        expect(exit).toBe(0);
        expect(existsSync(join(work, 'remote.txt'))).toBe(true);
      }
    }
  });

  test('git itself: with merge.autoStash=true, the advance argv (-c merge.autoStash=false merge --ff-only) refuses a dirty must-change file and stashes nothing', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    commitFile(other, 'README.md', 'remote edit\n', 'remote');
    git(other, 'push', '-q', 'origin', 'main');
    git(work, 'config', 'merge.autoStash', 'true');
    writeFileSync(join(work, 'README.md'), 'in-flight local edit\n');
    git(work, 'fetch', '-q', 'origin', 'main');
    let exit = 0;
    try { git(work, '-c', 'merge.autoStash=false', 'merge', '--ff-only', '--quiet', 'origin/main'); }
    catch (error) { exit = (error as { status: number }).status; }
    expect(exit).not.toBe(0);
    expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('in-flight local edit\n');
    expect(git(work, 'stash', 'list')).toBe('');
  });

  test('a dirty tree with rebase.autoStash=true is skipped_dirty in both modes, nothing stashed', () => {
    for (const strategy of ['rebase', 'merge'] as const) {
      const { work } = makePair();
      git(work, 'config', 'rebase.autoStash', 'true');
      writeFileSync(join(work, 'README.md'), 'dirty\n');
      expect(divergenceSafePull(work, 'main', { strategy })).toEqual({ status: 'skipped_dirty' });
      expect(git(work, 'stash', 'list')).toBe('');
      expect(readFileSync(join(work, 'README.md'), 'utf8')).toBe('dirty\n');
    }
  });
});

describe('pull_strategy: merge (#5429, feature)', () => {
  test('tip-equivalent divergence: both modes merge the tips in memory (#6530; rebase replay used to conflict) with both histories as ancestors', () => {
    for (const strategy of ['rebase', 'merge'] as const) {
      const merge = tipEquivalentDivergence();
      const merged = divergenceSafePull(merge.work, 'main', { strategy });
      expect(merged.status).toBe('advanced');
      if (merged.status !== 'advanced') throw new Error('unreachable');
      expect(merged.from).toBe(merge.localHead);
      const head = git(merge.work, 'rev-parse', 'HEAD');
      expect(merged.to).toBe(head);
      expect(git(merge.work, 'merge-base', '--is-ancestor', merge.remoteHead, head)).toBe('');
      expect(git(merge.work, 'merge-base', '--is-ancestor', merge.localHead, head)).toBe('');
      expect(readFileSync(join(merge.work, 'page.md'), 'utf8')).toBe('v2\n');
      expect(existsSync(join(merge.work, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(existsSync(join(merge.work, '.git', 'rebase-merge'))).toBe(false);
    }
  });

  test('merge mode fast-forwards when the local branch is behind and reports up_to_date when level', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    const remoteHead = commitFile(other, 'remote.txt', 'r\n', 'remote');
    git(other, 'push', '-q', 'origin', 'main');
    const out = divergenceSafePull(work, 'main', { strategy: 'merge' });
    expect(out.status).toBe('advanced');
    expect(git(work, 'rev-parse', 'HEAD')).toBe(remoteHead);
    expect(divergenceSafePull(work, 'main', { strategy: 'merge' })).toEqual({ status: 'up_to_date' });
  });

  test('a real content conflict in merge mode: merge --abort, MERGE_HEAD gone, HEAD and tree byte-identical', () => {
    const { bare, work } = makePair();
    const other = secondClone(bare);
    commitFile(other, 'page.md', 'remote line\n', 'remote');
    git(other, 'push', '-q', 'origin', 'main');
    const head = commitFile(work, 'page.md', 'local line\n', 'local');
    const before = treeBytes(work);
    const out = divergenceSafePull(work, 'main', { strategy: 'merge' });
    expect(out.status).toBe('conflict_aborted');
    if (out.status !== 'conflict_aborted') throw new Error('unreachable');
    expect(out.detail).toContain('merge');
    expect(existsSync(join(work, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(existsSync(join(work, '.git', 'MERGE_MSG'))).toBe(false);
    expect(existsSync(join(work, '.git', 'rebase-merge'))).toBe(false);
    expect(git(work, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(work, 'status', '--porcelain')).toBe('');
    expect(treeBytes(work)).toEqual(before);
  });
});
