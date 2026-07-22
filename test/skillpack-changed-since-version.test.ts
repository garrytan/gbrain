/**
 * Tests for `changedSlugsSinceVersion` in src/core/skillpack/bundle.ts —
 * the git-aware filter that backs `gbrain skillpack reference --all --since
 * <version>`. Builds a fixture git repo on the fly and tags it to exercise
 * the version-resolution + commit-walking path.
 *
 * Pins:
 *   - returns null when gbrainRoot is not a git checkout
 *   - returns null when the version tag doesn't resolve
 *   - returns empty array when no skills/ files changed since the tag
 *   - returns the affected slugs (deduped, sorted) when there are changes
 *   - accepts both 'v0.X.Y.Z' and bare '0.X.Y.Z' version strings
 *   - filters to skills/ paths only (changes elsewhere ignored)
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { changedSlugsSinceVersion } from '../src/core/skillpack/bundle.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Ensure deterministic commit metadata.
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@example.com',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@example.com',
    },
  });
}

function scratchRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'csv-bundle-'));
  created.push(root);
  git(root, 'init', '-q', '--initial-branch=main');
  git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, 'skills', 'alpha'), { recursive: true });
  writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\n');
  mkdirSync(join(root, 'skills', 'beta'), { recursive: true });
  writeFileSync(join(root, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'tag', 'v0.1.0.0');
  return root;
}

describe('changedSlugsSinceVersion', () => {
  it('returns null when gbrainRoot is not a git checkout', () => {
    const root = mkdtempSync(join(tmpdir(), 'csv-nogit-'));
    created.push(root);
    expect(changedSlugsSinceVersion(root, '0.1.0.0')).toBeNull();
  });

  it('returns null when the version tag does not resolve', () => {
    const root = scratchRepo();
    expect(changedSlugsSinceVersion(root, 'v999.999.999.0')).toBeNull();
  });

  it('returns empty array when no skills/ files changed since the tag', () => {
    const root = scratchRepo();
    // No new commits after the tag.
    expect(changedSlugsSinceVersion(root, 'v0.1.0.0')).toEqual([]);
  });

  it('returns the affected slug when one skill is modified', () => {
    const root = scratchRepo();
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\nv2\n---\n');
    git(root, 'commit', '-aq', '-m', 'tweak alpha');
    expect(changedSlugsSinceVersion(root, 'v0.1.0.0')).toEqual(['alpha']);
  });

  it('returns multiple slugs when multiple skills change, deduped + sorted', () => {
    const root = scratchRepo();
    writeFileSync(join(root, 'skills', 'beta', 'SKILL.md'), '---\nname: beta\nv2\n---\n');
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\nv2\n---\n');
    git(root, 'commit', '-aq', '-m', 'tweak both');
    // Add a third change in alpha (deduped — alpha listed once).
    writeFileSync(join(root, 'skills', 'alpha', 'extra.md'), 'extra');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'add alpha file');
    expect(changedSlugsSinceVersion(root, 'v0.1.0.0')).toEqual(['alpha', 'beta']);
  });

  it("accepts a bare '0.X.Y.Z' version string (auto-prefixes with v)", () => {
    const root = scratchRepo();
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nupdated\n---\n');
    git(root, 'commit', '-aq', '-m', 'tweak');
    expect(changedSlugsSinceVersion(root, '0.1.0.0')).toEqual(['alpha']);
  });

  it("accepts a 'v0.X.Y.Z' version string verbatim", () => {
    const root = scratchRepo();
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nupdated\n---\n');
    git(root, 'commit', '-aq', '-m', 'tweak');
    expect(changedSlugsSinceVersion(root, 'v0.1.0.0')).toEqual(['alpha']);
  });

  it('filters to skills/ paths only — changes outside skills/ are ignored', () => {
    const root = scratchRepo();
    // Change a non-skills file. Should NOT appear in the result.
    writeFileSync(join(root, 'README.md'), 'unrelated change');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'docs');
    expect(changedSlugsSinceVersion(root, 'v0.1.0.0')).toEqual([]);
  });

  it('handles a SHA prefix (commit ref instead of tag)', () => {
    const root = scratchRepo();
    const sha = execFileSync('git', ['-C', root, 'rev-parse', '--short=8', 'HEAD'], {
      encoding: 'utf-8',
    }).trim();
    writeFileSync(join(root, 'skills', 'alpha', 'SKILL.md'), '---\nupdated\n---\n');
    git(root, 'commit', '-aq', '-m', 'tweak');
    expect(changedSlugsSinceVersion(root, sha)).toEqual(['alpha']);
  });
});
