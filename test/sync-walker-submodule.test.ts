/**
 * v0.37.7.0 #1169 — sync walker skips git submodule directories.
 *
 * A submodule directory contains `.git` as a FILE (a gitfile pointer
 * into the parent's `.git/modules/...`), not a directory. Pre-fix, the
 * walker descended into submodules and indexed their markdown content
 * as if it belonged to the parent brain.
 *
 * Fix: pruneDir now accepts an optional parentDir; when set, it stats
 * `<parentDir>/<name>/.git` and skips when that's a file.
 *
 * NOTE: The companion `.gitignore`-respect feature from PR #1159 is
 * NOT in this wave (would require adding the `ignore` npm package as a
 * dep; per the plan's "no new deps" gate, deferred to a follow-up
 * wave). This file only pins submodule-skip.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { pruneDir } from '../src/core/sync.ts';
import { walkMarkdownFiles } from '../src/commands/extract.ts';

describe('pruneDir submodule detection (#1169)', () => {
  let scratch: string;
  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), 'gbrain-submodule-'));
    // Create a submodule-like directory: `.git` is a FILE inside it.
    const subDir = join(scratch, 'vendor-submodule');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, '.git'), 'gitdir: ../../.git/modules/vendor-submodule\n');
    writeFileSync(join(subDir, 'README.md'), '# Vendor README\nshould not be indexed');
    writeFileSync(join(subDir, 'doc.md'), '# Doc\nalso should not be indexed');

    // Create a normal directory: contains real markdown content.
    const normalDir = join(scratch, 'wiki');
    mkdirSync(normalDir, { recursive: true });
    writeFileSync(join(normalDir, 'page.md'), '# Page\nlegitimate content');

    // Create a normal dir whose .git is a DIRECTORY (a real nested
    // repo, not a submodule pointer). pruneDir should NOT skip this
    // unless one of the OTHER rules fires (`.git` itself is dot-prefix
    // and would be excluded if walked into directly).
    const nestedRepo = join(scratch, 'nested-repo');
    mkdirSync(join(nestedRepo, '.git'), { recursive: true });
    writeFileSync(join(nestedRepo, 'README.md'), '# nested repo');
  });
  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  test('skips a submodule directory (.git as file)', () => {
    expect(pruneDir('vendor-submodule', scratch)).toBe(false);
  });

  test('descends into a regular markdown directory', () => {
    expect(pruneDir('wiki', scratch)).toBe(true);
  });

  test('back-compat: parentDir undefined keeps the pre-v0.37.7 behavior', () => {
    // Without parentDir, the submodule check can't fire — only the
    // dot-prefix / PRUNE_DIR_NAMES / .raw / node_modules rules apply.
    expect(pruneDir('vendor-submodule')).toBe(true); // not skipped sans context
    expect(pruneDir('.git')).toBe(false); // dot-prefix still excluded
    expect(pruneDir('node_modules')).toBe(false); // explicit list
  });

  test('descends into a directory containing .git as a DIRECTORY (nested git repo, not submodule)', () => {
    // pruneDir returns true (we descend); the walker then encounters
    // the inner `.git` DIRECTORY which is itself dot-prefix → excluded.
    expect(pruneDir('nested-repo', scratch)).toBe(true);
  });

  test('walkMarkdownFiles does not return files from a submodule directory', () => {
    const files = walkMarkdownFiles(scratch);
    const paths = files.map(f => f.relPath);
    // Should include the normal page.
    expect(paths.some(p => p.endsWith('page.md'))).toBe(true);
    // Should NOT include anything from the submodule.
    expect(paths.some(p => p.includes('vendor-submodule'))).toBe(false);
  });
});
