/**
 * v0.42.42.0 (#2139) — computeSyncDelta unit coverage.
 *
 * The shared diff/manifest helper that BOTH the sync executor and the inline
 * cost estimator route through (so the gate's dollar figure can't drift from
 * what the sync imports). Real temp git repos; no PGLite, no env writes
 * (R1/R2-clean). The git-runner seam drives the unavailable branches.
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, renameSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  computeSyncDelta,
  buildDetachedWorkingTreeManifest,
  _setGitRunnerForTests,
} from '../src/core/sync-delta.ts';

let repo: string;

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: repo, stdio: 'pipe' }).toString().trim();
}
function commitAll(msg: string): string {
  execSync('git add -A', { cwd: repo, stdio: 'pipe' });
  execSync(`git commit -m "${msg}"`, { cwd: repo, stdio: 'pipe' });
  return git('rev-parse HEAD');
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'gbrain-delta-'));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.com"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
  mkdirSync(join(repo, 'topics'), { recursive: true });
});

afterEach(() => {
  _setGitRunnerForTests(null);
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('computeSyncDelta — commit diff', () => {
  test('A/M/D classified; only committed changes in the manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    writeFileSync(join(repo, 'topics/b.md'), 'b');
    const base = commitAll('base');
    writeFileSync(join(repo, 'topics/a.md'), 'a-edited'); // modify
    writeFileSync(join(repo, 'topics/c.md'), 'c');         // add
    rmSync(join(repo, 'topics/b.md'));                      // delete
    const head = commitAll('change');

    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.modified).toContain('topics/a.md');
    expect(r.manifest.added).toContain('topics/c.md');
    expect(r.manifest.deleted).toContain('topics/b.md');
  });

  test('rename → destination path on the renamed list', () => {
    writeFileSync(join(repo, 'topics/old.md'), 'x'.repeat(200));
    const base = commitAll('base');
    renameSync(join(repo, 'topics/old.md'), join(repo, 'topics/new.md'));
    const head = commitAll('rename');

    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.renamed.map(x => x.to)).toContain('topics/new.md');
  });

  test('[D2A] attached HEAD: dirty tracked + untracked files are NOT in the manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    const head = git('rev-parse HEAD'); // HEAD == base, no new commits
    // Dirty the tree: an uncommitted edit + an untracked scratch file.
    writeFileSync(join(repo, 'topics/a.md'), 'uncommitted edit');
    writeFileSync(join(repo, 'scratch.tmp'), 'untracked');

    const r = computeSyncDelta(repo, base, head); // not detached → commit diff only
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.added).toHaveLength(0);
    expect(r.manifest.modified).toHaveLength(0);
    expect(r.manifest.deleted).toHaveLength(0);
  });
});

describe('computeSyncDelta — detached HEAD merges the working-tree manifest', () => {
  test('detached + working-tree changes → merged into the manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    // Detach HEAD and dirty the tree.
    execSync(`git checkout --detach ${base}`, { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'topics/a.md'), 'detached edit'); // tracked modify
    writeFileSync(join(repo, 'topics/new.md'), 'new');          // untracked add

    const r = computeSyncDelta(repo, base, base, { detached: true });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.manifest.modified).toContain('topics/a.md');
    expect(r.manifest.added).toContain('topics/new.md'); // untracked picked up on detached
  });

  test('buildDetachedWorkingTreeManifest: clean detached tree → empty manifest', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    execSync(`git checkout --detach ${base}`, { cwd: repo, stdio: 'pipe' });
    const m = buildDetachedWorkingTreeManifest(repo);
    expect(m.added).toHaveLength(0);
    expect(m.modified).toHaveLength(0);
  });
});

describe('computeSyncDelta — fail-open ladder', () => {
  test('bogus anchor SHA → unavailable: anchor_missing', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const head = commitAll('base');
    const r = computeSyncDelta(repo, 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', head);
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toBe('anchor_missing');
  });

  test('non-ancestor anchor still diffs (the #1970 property)', () => {
    // git diff A..B is endpoint-tree, no ancestry requirement.
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    // Rewrite history: amend creates a new commit not descended from `base`,
    // but `base` is still on disk (reflog) → diffable.
    writeFileSync(join(repo, 'topics/a.md'), 'rewritten');
    execSync('git add -A && git commit --amend -m rewritten', { cwd: repo, stdio: 'pipe' });
    const head = git('rev-parse HEAD');
    expect(head).not.toBe(base);

    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('ok'); // orphaned-but-present anchor is still diffable
  });

  test('injected git failure on the diff → unavailable: diff_failed', () => {
    writeFileSync(join(repo, 'topics/a.md'), 'a');
    const base = commitAll('base');
    const head = git('rev-parse HEAD');
    _setGitRunnerForTests((_repo, args) => {
      if (args[0] === 'cat-file') return 'commit'; // anchor reachable
      if (args[0] === 'diff') throw new Error('simulated oversized diff / timeout');
      return '';
    });
    const r = computeSyncDelta(repo, base, head);
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.reason).toBe('diff_failed');
  });
});
