/**
 * test/frontmatter-validate-slug.test.ts
 *
 * Unit tests for findBrainRoot from src/commands/frontmatter.ts.
 * Uses real temp dirs with git init to exercise the .git-walk logic.
 * Zero DB, zero network.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import { findBrainRoot } from '../src/commands/frontmatter.ts';

// ─── Helpers ───────────────────────────────────────────────────────────────

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-fm-test-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('findBrainRoot', () => {
  test('git init → findBrainRoot(<tmp>/sub/dir/file.md) === <tmp>', () => {
    const root = makeTmpDir();
    execFileSync('git', ['init', root]);

    // Create a nested directory with a file.
    const subDir = join(root, 'sub', 'dir');
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, 'file.md');
    writeFileSync(filePath, '# Test\n', 'utf-8');

    expect(findBrainRoot(filePath)).toBe(root);
  });

  test('findBrainRoot(<tmp>) === <tmp> when tmp is the repo root', () => {
    const root = makeTmpDir();
    execFileSync('git', ['init', root]);

    expect(findBrainRoot(root)).toBe(root);
  });

  test('path with NO .git ancestor → falls back to the start dir (the file\'s own dir)', () => {
    const dir = makeTmpDir();
    // Do NOT git init — no .git anywhere.
    const subDir = join(dir, 'notes');
    mkdirSync(subDir, { recursive: true });
    const filePath = join(subDir, 'note.md');
    writeFileSync(filePath, '# Note\n', 'utf-8');

    // The function walks up 20 levels without finding .git, then falls back
    // to the base (the start dir). For a file, base = dirname(file).
    const result = findBrainRoot(filePath);
    expect(result).toBe(subDir);
  });

  test('git init in parent → child subdirectory file resolves to parent root', () => {
    const root = makeTmpDir();
    execFileSync('git', ['init', root]);

    const deep = join(root, 'a', 'b', 'c');
    mkdirSync(deep, { recursive: true });
    const filePath = join(deep, 'page.md');
    writeFileSync(filePath, '# Deep\n', 'utf-8');

    expect(findBrainRoot(filePath)).toBe(root);
  });
});
