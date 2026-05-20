/**
 * Tests for src/core/skillpack/copy.ts — the shared file-copy primitive
 * for scaffold (gbrain→host) and harvest (host→gbrain).
 *
 * Pins the contract:
 *   - existing target → skipped (no overwrite, ever — user owns the file)
 *   - symlink + rejectSymlinks → CopyError BEFORE any writes
 *   - source outside confineRealpath → CopyError BEFORE any writes
 *   - atomic-refusal contract: one violation aborts the whole batch
 *   - dry-run: no writes, but outcomes still computed
 */

import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { CopyError, copyArtifacts, walkSourceDir } from '../src/core/skillpack/copy.ts';

const created: string[] = [];
afterEach(() => {
  while (created.length) {
    const p = created.pop()!;
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

describe('walkSourceDir', () => {
  it('returns mirrored {source, target} items for a flat directory', () => {
    const src = scratch('copy-src-');
    writeFileSync(join(src, 'a.txt'), 'hello a');
    writeFileSync(join(src, 'b.txt'), 'hello b');

    const items = walkSourceDir(src, '/some/dst');
    expect(items).toHaveLength(2);
    expect(items.map(i => i.target).sort()).toEqual(['/some/dst/a.txt', '/some/dst/b.txt']);
  });

  it('walks nested directories recursively, mirroring structure', () => {
    const src = scratch('copy-src-');
    mkdirSync(join(src, 'sub', 'deeper'), { recursive: true });
    writeFileSync(join(src, 'top.txt'), 't');
    writeFileSync(join(src, 'sub', 'mid.txt'), 'm');
    writeFileSync(join(src, 'sub', 'deeper', 'low.txt'), 'l');

    const items = walkSourceDir(src, '/dst');
    expect(items).toHaveLength(3);
    const targets = items.map(i => i.target).sort();
    expect(targets).toEqual(['/dst/sub/deeper/low.txt', '/dst/sub/mid.txt', '/dst/top.txt']);
  });

  it('returns empty array for a non-existent source directory', () => {
    expect(walkSourceDir('/does/not/exist/nope', '/dst')).toEqual([]);
  });

  it('returns empty array for an empty source directory', () => {
    const src = scratch('copy-src-');
    expect(walkSourceDir(src, '/dst')).toEqual([]);
  });
});

describe('copyArtifacts — happy path', () => {
  it('copies every item, returns wrote_new outcomes', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    writeFileSync(join(src, 'a.txt'), 'A');
    writeFileSync(join(src, 'b.txt'), 'B');

    const items = walkSourceDir(src, dst);
    const result = copyArtifacts(items);

    expect(result.summary.wroteNew).toBe(2);
    expect(result.summary.skippedExisting).toBe(0);
    expect(readFileSync(join(dst, 'a.txt'), 'utf-8')).toBe('A');
    expect(readFileSync(join(dst, 'b.txt'), 'utf-8')).toBe('B');
  });

  it('creates intermediate target directories as needed', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    mkdirSync(join(src, 'sub'), { recursive: true });
    writeFileSync(join(src, 'sub', 'nested.txt'), 'N');

    copyArtifacts(walkSourceDir(src, dst));

    expect(existsSync(join(dst, 'sub', 'nested.txt'))).toBe(true);
    expect(readFileSync(join(dst, 'sub', 'nested.txt'), 'utf-8')).toBe('N');
  });
});

describe('copyArtifacts — existing target = skipped (never overwrites)', () => {
  it('skips an existing target file even when the source differs', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    writeFileSync(join(src, 'a.txt'), 'gbrain version');
    writeFileSync(join(dst, 'a.txt'), 'user edits');

    const result = copyArtifacts(walkSourceDir(src, dst));

    expect(result.summary.wroteNew).toBe(0);
    expect(result.summary.skippedExisting).toBe(1);
    expect(readFileSync(join(dst, 'a.txt'), 'utf-8')).toBe('user edits');
    expect(result.files[0].outcome).toBe('skipped_existing');
  });

  it('mixed batch: writes missing, skips existing, surfaces per-file outcomes', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    writeFileSync(join(src, 'new.txt'), 'NEW');
    writeFileSync(join(src, 'existing.txt'), 'gbrain version');
    writeFileSync(join(dst, 'existing.txt'), 'user owns this');

    const result = copyArtifacts(walkSourceDir(src, dst));

    expect(result.summary.wroteNew).toBe(1);
    expect(result.summary.skippedExisting).toBe(1);
    expect(readFileSync(join(dst, 'new.txt'), 'utf-8')).toBe('NEW');
    expect(readFileSync(join(dst, 'existing.txt'), 'utf-8')).toBe('user owns this');
  });
});

describe('copyArtifacts — dry-run', () => {
  it('reports outcomes without writing anything', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    writeFileSync(join(src, 'a.txt'), 'A');

    const result = copyArtifacts(walkSourceDir(src, dst), { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.summary.wroteNew).toBe(1);
    expect(existsSync(join(dst, 'a.txt'))).toBe(false);
  });
});

describe('copyArtifacts — symlink rejection (harvest path)', () => {
  it('rejectSymlinks=true throws CopyError before any write', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    const realFile = scratch('copy-secret-');
    writeFileSync(join(realFile, 'secret.txt'), 'PRIVATE');

    writeFileSync(join(src, 'safe.txt'), 'safe');
    symlinkSync(join(realFile, 'secret.txt'), join(src, 'evil.txt'));

    expect(() => copyArtifacts(walkSourceDir(src, dst), { rejectSymlinks: true })).toThrow(
      CopyError,
    );

    // Atomic refusal: nothing was written, even the safe file.
    expect(existsSync(join(dst, 'safe.txt'))).toBe(false);
    expect(existsSync(join(dst, 'evil.txt'))).toBe(false);
  });

  it('rejectSymlinks=false (default) treats symlinks like regular files', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    const realFile = scratch('copy-target-');
    writeFileSync(join(realFile, 'data.txt'), 'real data');

    symlinkSync(join(realFile, 'data.txt'), join(src, 'link.txt'));

    const result = copyArtifacts(walkSourceDir(src, dst)); // no rejectSymlinks
    expect(result.summary.wroteNew).toBe(1);
    expect(readFileSync(join(dst, 'link.txt'), 'utf-8')).toBe('real data');
  });
});

describe('copyArtifacts — canonical-path containment (harvest path)', () => {
  it('symlink that points outside confineRealpath is rejected as path_traversal', () => {
    const harvestRoot = scratch('copy-harvest-');
    const skillDir = join(harvestRoot, 'skills', 'foo');
    mkdirSync(skillDir, { recursive: true });

    const outside = scratch('copy-outside-');
    writeFileSync(join(outside, 'leaked-secret.txt'), 'STOLEN');

    // Symlink inside the skill dir points at an outside file.
    symlinkSync(join(outside, 'leaked-secret.txt'), join(skillDir, 'innocent.txt'));

    const dst = scratch('copy-dst-');
    const items = walkSourceDir(skillDir, dst);

    expect(() => copyArtifacts(items, { confineRealpath: skillDir })).toThrow(CopyError);

    try {
      copyArtifacts(items, { confineRealpath: skillDir });
    } catch (err) {
      expect(err).toBeInstanceOf(CopyError);
      expect((err as CopyError).code).toBe('path_traversal');
    }

    // Atomic refusal: nothing written.
    expect(existsSync(join(dst, 'innocent.txt'))).toBe(false);
  });

  it('confineRealpath that does not exist throws source_missing', () => {
    expect(() => copyArtifacts([], { confineRealpath: '/no/such/dir/at/all' })).toThrow(CopyError);
  });

  it('happy path: every source canonicalizes inside the confinement root', () => {
    const harvestRoot = scratch('copy-harvest-');
    const skillDir = join(harvestRoot, 'skills', 'foo');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), 'safe');

    const dst = scratch('copy-dst-');
    const result = copyArtifacts(walkSourceDir(skillDir, dst), { confineRealpath: skillDir });
    expect(result.summary.wroteNew).toBe(1);
  });
});

describe('copyArtifacts — atomic-refusal contract', () => {
  it('a single missing source aborts the batch before any write', () => {
    const dst = scratch('copy-dst-');
    const src = scratch('copy-src-');
    writeFileSync(join(src, 'real.txt'), 'real');

    const items = [
      { source: join(src, 'real.txt'), target: join(dst, 'real.txt') },
      { source: '/missing/path.txt', target: join(dst, 'phantom.txt') },
    ];

    expect(() => copyArtifacts(items)).toThrow(CopyError);
    expect(existsSync(join(dst, 'real.txt'))).toBe(false); // safe item also blocked
  });

  it('rejectSymlinks aborts the whole batch even when the violation is the last item', () => {
    const src = scratch('copy-src-');
    const dst = scratch('copy-dst-');
    writeFileSync(join(src, 'one.txt'), '1');
    writeFileSync(join(src, 'two.txt'), '2');
    writeFileSync(join(src, 'three.txt'), '3');

    // Add a real file outside src for the symlink target.
    const outside = scratch('copy-outside-');
    writeFileSync(join(outside, 'target.txt'), 'outside');
    symlinkSync(join(outside, 'target.txt'), join(src, 'four.txt'));

    expect(() => copyArtifacts(walkSourceDir(src, dst), { rejectSymlinks: true })).toThrow(
      CopyError,
    );

    expect(existsSync(join(dst, 'one.txt'))).toBe(false);
    expect(existsSync(join(dst, 'two.txt'))).toBe(false);
    expect(existsSync(join(dst, 'three.txt'))).toBe(false);
  });
});
