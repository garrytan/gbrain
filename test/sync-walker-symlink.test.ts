/**
 * v0.31.2 walker hardening regression tests.
 *
 * Closes the bug class where `gbrain sync --strategy code` could hang on
 * repos with self-referencing symlinks (the gstack `.claude/skills/gstack
 * -> repo-root` dev pattern was the trigger). Pins:
 *
 * 1. Self-referencing symlink does not loop.
 * 2. Symlink chain through real dirs does not loop (inode-set defense).
 * 3. MAX_WALK_DEPTH=32 bailout is structural backstop.
 * 4. Strategy filter (code/markdown/auto) admits the right files.
 * 5. Dot-prefixed dirs (.git/.claude/.raw) and node_modules still skipped.
 * 6. Multimodal preservation under markdown-strategy (codex C5).
 * 7. Deterministic ordering — runImport's index-based resume depends on it
 *    (codex C8).
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { collectSyncableFiles } from '../src/commands/import.ts';
import { withEnv } from './helpers/with-env.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'gbrain-walker-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('collectSyncableFiles symlink + cycle hardening', () => {
  test('1. self-referencing symlink does not loop', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => {
      writeFileSync(join(tmp, 'README.md'), '# top\n');
      // Symlink "loop" inside tempdir pointing back to itself.
      symlinkSync(tmp, join(tmp, 'loop'));

      const t0 = Date.now();
      const files = collectSyncableFiles(tmp, { strategy: 'markdown' });
      const ms = Date.now() - t0;

      expect(ms).toBeLessThan(1000); // would hang if walker followed the loop
      expect(files).toContain(join(tmp, 'README.md'));
      expect(files.every(f => !f.includes('/loop/'))).toBe(true);
    });
  });

  test('2. symlink chain through real dirs does not loop', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => {
      // a/ contains a real subdir b/, which contains a symlink "back" -> a.
      // The lstat skip catches "back" before recursion. If somehow it
      // missed, the inode-cycle Map catches the second visit to a/.
      mkdirSync(join(tmp, 'a/b'), { recursive: true });
      writeFileSync(join(tmp, 'a/b/leaf.md'), 'leaf\n');
      symlinkSync(join(tmp, 'a'), join(tmp, 'a/b/back'));

      const t0 = Date.now();
      const files = collectSyncableFiles(tmp, { strategy: 'markdown' });
      const ms = Date.now() - t0;

      expect(ms).toBeLessThan(2000);
      expect(files).toContain(join(tmp, 'a/b/leaf.md'));
    });
  });

  test('3. max-depth bailout terminates pathological deep trees', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => {
      // Build a 40-level real directory tree. 32 is the default cap; the
      // file at the deepest level is intentionally past the bailout so we
      // can assert it is NOT collected (and the walker still terminates).
      let cur = tmp;
      for (let i = 0; i < 40; i++) {
        cur = join(cur, `d${i}`);
        mkdirSync(cur);
      }
      writeFileSync(join(cur, 'deep.md'), 'deep\n');
      writeFileSync(join(tmp, 'shallow.md'), 'shallow\n');

      const files = collectSyncableFiles(tmp, { strategy: 'markdown' });

      expect(files).toContain(join(tmp, 'shallow.md'));
      expect(files.every(f => !f.includes('/d35/'))).toBe(true); // past depth 32
    });
  });

  test('4. strategy filter admits the right files', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => {
      writeFileSync(join(tmp, 'README.md'), '# r\n');
      writeFileSync(join(tmp, 'foo.ts'), '// f\n');
      writeFileSync(join(tmp, 'bar.py'), '# b\n');

      const code = collectSyncableFiles(tmp, { strategy: 'code' });
      const markdown = collectSyncableFiles(tmp, { strategy: 'markdown' });
      const auto = collectSyncableFiles(tmp, { strategy: 'auto' });

      expect(code.map(f => f.split('/').pop()).sort()).toEqual(['bar.py', 'foo.ts']);
      expect(markdown.map(f => f.split('/').pop())).toEqual(['README.md']);
      expect(auto.map(f => f.split('/').pop()).sort()).toEqual(['README.md', 'bar.py', 'foo.ts']);
    });
  });

  test('5. dot-prefixed dirs and node_modules still skipped', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => {
      writeFileSync(join(tmp, 'real.md'), 'r\n');
      mkdirSync(join(tmp, '.git'));
      writeFileSync(join(tmp, '.git/HEAD'), 'ref: refs/heads/main\n');
      mkdirSync(join(tmp, '.claude/skills'), { recursive: true });
      writeFileSync(join(tmp, '.claude/skills/SKILL.md'), 's\n');
      mkdirSync(join(tmp, 'node_modules/foo'), { recursive: true });
      writeFileSync(join(tmp, 'node_modules/foo/index.md'), 'no\n');

      const files = collectSyncableFiles(tmp, { strategy: 'markdown' });
      const names = files.map(f => f.replace(tmp, ''));

      expect(names).toContain('/real.md');
      expect(names.every(n => !n.startsWith('/.git'))).toBe(true);
      expect(names.every(n => !n.startsWith('/.claude'))).toBe(true);
      expect(names.every(n => !n.startsWith('/node_modules'))).toBe(true);
    });
  });

  test('6. multimodal preservation under markdown strategy (codex C5)', async () => {
    writeFileSync(join(tmp, 'r.md'), 'r\n');
    writeFileSync(join(tmp, 'p.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(tmp, 'j.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

    // Off → markdown only.
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => {
      const off = collectSyncableFiles(tmp, { strategy: 'markdown' });
      expect(off.map(f => f.split('/').pop()).sort()).toEqual(['r.md']);
    });

    // On → markdown + images (preserves v0.27.1 F2 collectMarkdownFiles
    // behavior; codex C5 carve-out).
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: 'true' }, () => {
      const on = collectSyncableFiles(tmp, { strategy: 'markdown' });
      expect(on.map(f => f.split('/').pop()).sort()).toEqual(['j.jpg', 'p.png', 'r.md']);
    });
  });

  test('7. deterministic ordering — two walks return identical arrays (codex C8)', async () => {
    await withEnv({ GBRAIN_EMBEDDING_MULTIMODAL: undefined }, () => {
      // runImport's checkpoint resume at import.ts:68-74 is index-based
      // against a sorted file list. Unstable order skips the wrong files
      // on resume.
      writeFileSync(join(tmp, 'b.md'), 'b\n');
      writeFileSync(join(tmp, 'a.md'), 'a\n');
      mkdirSync(join(tmp, 'sub'));
      writeFileSync(join(tmp, 'sub/c.md'), 'c\n');

      const first = collectSyncableFiles(tmp, { strategy: 'markdown' });
      const second = collectSyncableFiles(tmp, { strategy: 'markdown' });

      expect(first).toEqual(second);
      // Sorted: a.md, b.md, sub/c.md (lexicographic on absolute paths).
      expect(first.map(f => f.replace(tmp, ''))).toEqual([
        '/a.md', '/b.md', '/sub/c.md',
      ]);
    });
  });
});
