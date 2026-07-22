/**
 * #2607 — the `sync --full` git fast path applies the same prune gate as
 * incremental sync.
 *
 * Bug class: `collectSyncableFiles` on a git work tree takes the
 * `git ls-files` fast path, which historically filtered ONLY by
 * strategy/extension + .gitignore — no `pruneDir`, so `sync --full`
 * imported (and resurrected previously-soft-deleted) pages under dot-dirs
 * and vendored trees that incremental sync's `isSyncable` excludes. The two
 * enumeration modes cycled content in and out depending on which ran last.
 *
 * Fix: `isCollectibleForWalker` (shared by the git fast path AND the FS-walk
 * emit filter) now rejects any path with a segment `pruneDir` would block —
 * the same segment rule `classifySync` applies on the incremental path.
 *
 * No PGLite needed: `collectSyncableFiles` is pure filesystem + git.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { isSyncable } from '../src/core/sync.ts';

let repo: string;

function rel(files: string[]): string[] {
  return files.map((f) => relative(repo, f));
}

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'gbrain-fastpath-'));
  execSync('git init', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
  execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });

  // Ordinary content — must be collected.
  mkdirSync(join(repo, 'notes'), { recursive: true });
  writeFileSync(join(repo, 'notes/real.md'), '---\ntitle: Real\n---\nbody\n');
  mkdirSync(join(repo, 'ops'), { recursive: true });
  writeFileSync(join(repo, 'ops/tasks.md'), '---\ntitle: Tasks\n---\nbody\n');

  // TRACKED files under excluded trees — `git ls-files` returns these, so
  // only the prune gate keeps them out (this is the #2607 divergence).
  mkdirSync(join(repo, '.obsidian'), { recursive: true });
  writeFileSync(join(repo, '.obsidian/plugin-notes.md'), 'not a page\n');
  mkdirSync(join(repo, 'vendor/pkg'), { recursive: true });
  writeFileSync(join(repo, 'vendor/pkg/notes.md'), 'vendored\n');
  mkdirSync(join(repo, 'node_modules/dep'), { recursive: true });
  writeFileSync(join(repo, 'node_modules/dep/CHANGELOG.md'), 'dep changelog\n');
  mkdirSync(join(repo, 'people/pedro.raw'), { recursive: true });
  writeFileSync(join(repo, 'people/pedro.raw/source.md'), 'raw sidecar\n');

  // Metafiles — excluded on both routes (pre-existing #345 behavior).
  writeFileSync(join(repo, 'README.md'), '# repo\n');
  writeFileSync(join(repo, 'notes/index.md'), '# index\n');

  execSync('git add -A -f && git commit -m "fixture"', { cwd: repo, stdio: 'pipe' });
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('#2607 — git fast path excludes what incremental sync excludes', () => {
  test('tracked files under pruned dirs are NOT collected', () => {
    const files = rel(collectSyncableFiles(repo, { strategy: 'markdown' }));
    expect(files).toContain('notes/real.md');
    expect(files).toContain('ops/tasks.md'); // ordinary content (#2404)
    expect(files).not.toContain('.obsidian/plugin-notes.md');
    expect(files).not.toContain('vendor/pkg/notes.md');
    expect(files).not.toContain('node_modules/dep/CHANGELOG.md');
    expect(files).not.toContain('people/pedro.raw/source.md');
    // Metafiles stay excluded too.
    expect(files).not.toContain('README.md');
    expect(files).not.toContain('notes/index.md');
  });

  test('full-sync enumeration agrees with incremental isSyncable for every collected file', () => {
    // The single-source-of-truth contract: nothing the full path collects may
    // be something the incremental path would refuse to sync.
    const files = rel(collectSyncableFiles(repo, { strategy: 'markdown' }));
    for (const f of files) {
      expect({ path: f, syncable: isSyncable(f) }).toEqual({ path: f, syncable: true });
    }
    expect(files.length).toBeGreaterThan(0);
  });
});
