/**
 * Tests for src/core/disk-walk.ts — single-walk filesystem scan.
 *
 * Replaces the per-page existsSync+statSync syscall storm in storage.ts
 * (Issue #14 of the v0.22.3 eng review).
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { walkBrainRepo } from '../src/core/disk-walk.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-walk-test-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(relPath: string, content: string): void {
  const full = join(tmp, relPath);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

describe('walkBrainRepo', () => {
  test('returns empty map for empty directory', () => {
    expect(walkBrainRepo(tmp).size).toBe(0);
  });

  test('returns empty map for nonexistent directory', () => {
    expect(walkBrainRepo(join(tmp, 'does-not-exist')).size).toBe(0);
  });

  test('finds top-level .md files keyed by slug (no .md suffix)', () => {
    write('alice.md', '# Alice');
    const result = walkBrainRepo(tmp);
    expect(result.has('alice')).toBe(true);
    expect(result.get('alice')!.size).toBeGreaterThan(0);
  });

  test('walks nested directories and produces slash-joined slugs', () => {
    write('people/alice.md', '# Alice');
    write('media/x/tweet-1.md', 'tweet');
    write('media/articles/post-1.md', 'post');
    const result = walkBrainRepo(tmp);
    expect(new Set(result.keys())).toEqual(
      new Set(['people/alice', 'media/x/tweet-1', 'media/articles/post-1']),
    );
  });

  test('skips dot-directories (.git, .gbrain, .vscode)', () => {
    write('.git/HEAD', 'ref: refs/heads/main');
    write('.gbrain/config.json', '{}');
    write('.vscode/settings.json', '{}');
    write('people/alice.md', '# Alice');
    const result = walkBrainRepo(tmp);
    expect(new Set(result.keys())).toEqual(new Set(['people/alice']));
  });

  test('skips node_modules', () => {
    write('node_modules/foo/bar.md', 'noise');
    write('people/alice.md', '# Alice');
    const result = walkBrainRepo(tmp);
    expect(new Set(result.keys())).toEqual(new Set(['people/alice']));
  });

  test('ignores non-.md files', () => {
    write('people/alice.md', '# Alice');
    write('people/alice.json', '{}');
    write('people/photo.png', 'binary');
    const result = walkBrainRepo(tmp);
    expect(new Set(result.keys())).toEqual(new Set(['people/alice']));
  });

  test('captures size from stat', () => {
    const content = '# Alice\n'.repeat(100);
    write('people/alice.md', content);
    const result = walkBrainRepo(tmp);
    expect(result.get('people/alice')!.size).toBe(content.length);
  });

  test('captures mtimeMs', () => {
    write('people/alice.md', '# Alice');
    const result = walkBrainRepo(tmp);
    expect(result.get('people/alice')!.mtimeMs).toBeGreaterThan(0);
  });
});
