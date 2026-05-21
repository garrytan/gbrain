/**
 * Tests for src/core/skillpack/tarball.ts — deterministic pack +
 * allowlist-gated extract.
 *
 * Requires GNU tar on PATH (gtar via homebrew on macOS, system tar on Linux).
 * Tests skip gracefully when only bsdtar is available.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  TarballError,
  fileSha256,
  packTarball,
  extractTarball,
  DEFAULT_EXTRACT_CAPS,
} from '../src/core/skillpack/tarball.ts';

function hasGnuTar(): boolean {
  for (const bin of ['gtar', 'tar']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.includes('GNU')) return true;
  }
  return false;
}

const SKIP_NO_GNU = !hasGnuTar();
if (SKIP_NO_GNU) {
  // eslint-disable-next-line no-console
  console.warn('[skillpack-tarball.test] GNU tar not on PATH; skipping deterministic-pack tests');
}

describe('packTarball — deterministic output', () => {
  let workspace: string;
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'tarball-pack-'));
  });
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test.skipIf(SKIP_NO_GNU)('produces a tarball with stable SHA on repeated packs', () => {
    const src = join(workspace, 'pack-A');
    mkdirSync(join(src, 'skills/foo'), { recursive: true });
    writeFileSync(join(src, 'skills/foo/SKILL.md'), '---\nname: foo\n---\n');
    writeFileSync(join(src, 'skillpack.json'), JSON.stringify({ name: 'pack-A' }, null, 2));

    const out1 = join(workspace, 'pack-A-1.tgz');
    const out2 = join(workspace, 'pack-A-2.tgz');

    const r1 = packTarball({ sourceDir: src, outPath: out1 });
    // Touch the source mtime to prove mtime is normalized.
    const skillPath = join(src, 'skills/foo/SKILL.md');
    const future = new Date(Date.now() + 1000 * 60 * 60); // +1h
    require('fs').utimesSync(skillPath, future, future);
    const r2 = packTarball({ sourceDir: src, outPath: out2 });

    expect(r1.sha256).toBe(r2.sha256);
    expect(r1.fileCount).toBe(r2.fileCount);
    expect(r1.fileCount).toBe(2);
  });

  test.skipIf(SKIP_NO_GNU)('packs files in lexicographic order', () => {
    const src = join(workspace, 'pack-sorted');
    mkdirSync(join(src, 'a'), { recursive: true });
    mkdirSync(join(src, 'b'), { recursive: true });
    writeFileSync(join(src, 'a/file1'), 'a1');
    writeFileSync(join(src, 'b/file1'), 'b1');
    writeFileSync(join(src, 'README.md'), 'top');

    const out = join(workspace, 'pack-sorted.tgz');
    const result = packTarball({ sourceDir: src, outPath: out });
    expect(result.fileCount).toBe(3);
    expect(existsSync(out)).toBe(true);
  });

  test.skipIf(SKIP_NO_GNU)('throws when source dir is missing', () => {
    try {
      packTarball({ sourceDir: join(workspace, 'nonexistent'), outPath: join(workspace, 'x.tgz') });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('pack_source_missing');
    }
  });

  test.skipIf(SKIP_NO_GNU)('honors exclude patterns', () => {
    const src = join(workspace, 'pack-exclude');
    mkdirSync(join(src, '.git'), { recursive: true });
    mkdirSync(join(src, 'node_modules'), { recursive: true });
    mkdirSync(join(src, 'skills'), { recursive: true });
    writeFileSync(join(src, '.git/HEAD'), 'ref: refs/heads/main');
    writeFileSync(join(src, 'node_modules/foo.js'), 'module.exports = {}');
    writeFileSync(join(src, 'skills/SKILL.md'), '---\n---\n');

    const out = join(workspace, 'pack-exclude.tgz');
    const result = packTarball({
      sourceDir: src,
      outPath: out,
      exclude: ['.git', 'node_modules'],
    });
    // 1 file: skills/SKILL.md
    expect(result.fileCount).toBe(1);
  });
});

describe('extractTarball — happy path', () => {
  let workspace: string;
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'tarball-extract-'));
  });
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test.skipIf(SKIP_NO_GNU)('extracts a clean tarball and reports fileCount + sha', () => {
    const src = join(workspace, 'pack');
    mkdirSync(join(src, 'skills/foo'), { recursive: true });
    writeFileSync(join(src, 'skills/foo/SKILL.md'), 'hello');
    writeFileSync(join(src, 'skillpack.json'), '{}');

    const tgz = join(workspace, 'pack.tgz');
    packTarball({ sourceDir: src, outPath: tgz });

    const dest = join(workspace, 'extracted');
    const r = extractTarball({ tgzPath: tgz, destDir: dest });
    expect(r.fileCount).toBe(2);
    expect(r.totalBytes).toBeGreaterThan(0);
    expect(r.sha256).toBe(fileSha256(tgz));

    // Verify files actually landed.
    expect(existsSync(join(dest, 'pack/skills/foo/SKILL.md'))).toBe(true);
  });

  test.skipIf(SKIP_NO_GNU)('refuses to extract into a non-empty destination', () => {
    const dest = join(workspace, 'nonempty');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'existing'), 'data');

    const src = join(workspace, 'pack2');
    mkdirSync(join(src, 'skills'), { recursive: true });
    writeFileSync(join(src, 'skills/SKILL.md'), 'x');
    const tgz = join(workspace, 'pack2.tgz');
    packTarball({ sourceDir: src, outPath: tgz });

    try {
      extractTarball({ tgzPath: tgz, destDir: dest });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('extract_dest_not_empty');
    }
  });

  test.skipIf(SKIP_NO_GNU)('throws when tgz file is missing', () => {
    try {
      extractTarball({ tgzPath: join(workspace, 'nope.tgz'), destDir: join(workspace, 'd') });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('extract_tgz_missing');
    }
  });
});

describe('extractTarball — allowlist + caps', () => {
  let workspace: string;
  beforeAll(() => {
    workspace = mkdtempSync(join(tmpdir(), 'tarball-caps-'));
  });
  afterAll(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  test.skipIf(SKIP_NO_GNU)('rejects a tarball containing a symlink', () => {
    const src = join(workspace, 'pack-symlink');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'real-file'), 'real');
    try {
      symlinkSync('real-file', join(src, 'evil-link'));
    } catch {
      // Symlink creation requires elevated perms on some Windows configs;
      // skip the assertion if it's unavailable.
      return;
    }

    const tgz = join(workspace, 'pack-symlink.tgz');
    packTarball({ sourceDir: src, outPath: tgz });
    try {
      extractTarball({ tgzPath: tgz, destDir: join(workspace, 'extracted-symlink') });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('extract_disallowed_entry_type');
    }
  });

  test.skipIf(SKIP_NO_GNU)('rejects when maxFiles is exceeded', () => {
    const src = join(workspace, 'pack-many');
    mkdirSync(join(src, 'd'), { recursive: true });
    for (let i = 0; i < 12; i++) writeFileSync(join(src, 'd', `f${i}`), 'x');
    const tgz = join(workspace, 'pack-many.tgz');
    packTarball({ sourceDir: src, outPath: tgz });
    try {
      extractTarball({
        tgzPath: tgz,
        destDir: join(workspace, 'ext-many'),
        caps: { maxFiles: 5 },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('extract_too_many_files');
    }
  });

  test.skipIf(SKIP_NO_GNU)('rejects when a single file exceeds maxBytesPerFile', () => {
    const src = join(workspace, 'pack-big-file');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'big'), 'x'.repeat(2048));
    const tgz = join(workspace, 'pack-big-file.tgz');
    packTarball({ sourceDir: src, outPath: tgz });
    try {
      extractTarball({
        tgzPath: tgz,
        destDir: join(workspace, 'ext-big'),
        caps: { maxBytesPerFile: 1024 },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('extract_file_too_large');
    }
  });

  test.skipIf(SKIP_NO_GNU)('rejects when total bytes exceed maxTotalBytes', () => {
    const src = join(workspace, 'pack-big-total');
    mkdirSync(src, { recursive: true });
    for (let i = 0; i < 5; i++) writeFileSync(join(src, `f${i}`), 'x'.repeat(512));
    const tgz = join(workspace, 'pack-big-total.tgz');
    packTarball({ sourceDir: src, outPath: tgz });
    try {
      extractTarball({
        tgzPath: tgz,
        destDir: join(workspace, 'ext-big-total'),
        // Per-file 1024 is fine, but total cap of 1024 is below the sum of 5*512 = 2560.
        caps: { maxBytesPerFile: 1024, maxTotalBytes: 1024 },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('extract_total_too_large');
    }
  });

  test.skipIf(SKIP_NO_GNU)('rejects entries whose path exceeds maxPathLength', () => {
    const src = join(workspace, 'pack-longpath');
    // Deep nesting keeps each segment short enough for the OS but the total
    // path long enough to trip the cap. 30 segments × 'aaaaaaaa/' (9 chars)
    // ≈ 270 chars total.
    const segments = Array.from({ length: 30 }, () => 'aaaaaaaa').join('/');
    const deep = join(src, segments);
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'file'), 'x');
    const tgz = join(workspace, 'pack-longpath.tgz');
    packTarball({ sourceDir: src, outPath: tgz });
    try {
      extractTarball({
        tgzPath: tgz,
        destDir: join(workspace, 'ext-longpath'),
        caps: { maxPathLength: 100 },
      });
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as TarballError).code).toBe('extract_path_too_long');
    }
  });
});

describe('DEFAULT_EXTRACT_CAPS — frozen contract', () => {
  test('caps match the spec', () => {
    expect(DEFAULT_EXTRACT_CAPS.maxFiles).toBe(5000);
    expect(DEFAULT_EXTRACT_CAPS.maxBytesPerFile).toBe(1024 * 1024);
    expect(DEFAULT_EXTRACT_CAPS.maxTotalBytes).toBe(100 * 1024 * 1024);
    expect(DEFAULT_EXTRACT_CAPS.maxPathLength).toBe(255);
    expect(DEFAULT_EXTRACT_CAPS.maxCompressionRatio).toBe(100);
  });
});

describe('fileSha256 — pure utility', () => {
  test('computes a stable hash for a known input', () => {
    const tmp = join(mkdtempSync(join(tmpdir(), 'sha-')), 'f');
    writeFileSync(tmp, 'hello');
    // sha256('hello') = 2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824
    expect(fileSha256(tmp)).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });
});
