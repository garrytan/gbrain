import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, mkdirSync, realpathSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  validateUploadPath,
  validatePageSlug,
  validateFilename,
  OperationError,
} from '../src/core/operations.ts';

// --- validateUploadPath ---

describe('validateUploadPath', () => {
  let sandbox: string;
  let root: string;
  let outside: string;

  beforeAll(() => {
    sandbox = mkdtempSync(join(tmpdir(), 'gbrain-upload-'));
    root = realpathSync(sandbox);
    outside = mkdtempSync(join(tmpdir(), 'gbrain-outside-'));
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('allows a regular file inside the confinement root', () => {
    const p = join(root, 'photo.jpg');
    writeFileSync(p, 'binary');
    expect(() => validateUploadPath(p, root)).not.toThrow();
  });

  it('allows a nested file inside the confinement root', () => {
    const sub = join(root, 'sub');
    mkdirSync(sub, { recursive: true });
    const p = join(sub, 'note.txt');
    writeFileSync(p, 'hi');
    expect(() => validateUploadPath(p, root)).not.toThrow();
  });

  it('rejects a path outside the confinement root', () => {
    const p = join(outside, 'secret.txt');
    writeFileSync(p, 'x');
    expect(() => validateUploadPath(p, root)).toThrow(OperationError);
    try { validateUploadPath(p, root); } catch (e) {
      expect((e as OperationError).code).toBe('invalid_params');
      expect((e as Error).message).toMatch(/within the working directory/i);
    }
  });

  it('rejects ../ traversal above the root', () => {
    const p = join(root, '..', 'escaped.txt');
    writeFileSync(p, 'nope');
    try {
      expect(() => validateUploadPath(p, root)).toThrow(OperationError);
    } finally {
      rmSync(p, { force: true });
    }
  });

  it('rejects /etc/passwd (absolute path outside root)', () => {
    expect(() => validateUploadPath('/etc/passwd', root)).toThrow(OperationError);
  });

  it('rejects a symlink whose final component points outside root (B5 regression)', () => {
    const target = join(outside, 'target.txt');
    writeFileSync(target, 'secret');
    const link = join(root, 'link-to-outside.txt');
    symlinkSync(target, link);
    try {
      expect(() => validateUploadPath(link, root)).toThrow(OperationError);
    } finally {
      rmSync(link, { force: true });
    }
  });

  it('rejects a symlink whose parent dir points outside root (B5 parent-symlink regression)', () => {
    const linkDir = join(root, 'link-dir');
    symlinkSync(outside, linkDir);
    const p = join(linkDir, 'secret.txt');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    try {
      expect(() => validateUploadPath(p, root)).toThrow(OperationError);
    } finally {
      rmSync(linkDir, { force: true });
      rmSync(join(outside, 'secret.txt'), { force: true });
    }
  });

  it('rejects non-existent paths with a clear error', () => {
    const p = join(root, 'never-created.txt');
    try {
      validateUploadPath(p, root);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(OperationError);
      expect((e as OperationError).code).toBe('invalid_params');
      expect((e as Error).message).toMatch(/File not found/i);
    }
  });

  it('handles relative paths via resolve', () => {
    const p = join(root, 'rel.txt');
    writeFileSync(p, 'hi');
    const prevCwd = process.cwd();
    process.chdir(root);
    try {
      expect(() => validateUploadPath('./rel.txt', root)).not.toThrow();
    } finally {
      process.chdir(prevCwd);
    }
  });
});

// --- validatePageSlug (H5 allowlist) ---

describe('validatePageSlug', () => {
  it('accepts clean slugs', () => {
    expect(() => validatePageSlug('people/alice-smith')).not.toThrow();
    expect(() => validatePageSlug('concepts/ai')).not.toThrow();
    expect(() => validatePageSlug('a')).not.toThrow();
    expect(() => validatePageSlug('a/b/c/d')).not.toThrow();
  });

  it('rejects ../ traversal', () => {
    expect(() => validatePageSlug('../etc/passwd')).toThrow(OperationError);
    expect(() => validatePageSlug('pages/../../etc')).toThrow(OperationError);
  });

  it('rejects URL-encoded traversal (not in allowlist)', () => {
    expect(() => validatePageSlug('%2e%2e%2fetc%2fpasswd')).toThrow(OperationError);
  });

  it('rejects absolute paths', () => {
    expect(() => validatePageSlug('/etc/passwd')).toThrow(OperationError);
  });

  it('rejects backslash (Windows separator)', () => {
    expect(() => validatePageSlug('people\\alice')).toThrow(OperationError);
  });

  it('rejects leading/trailing slash', () => {
    expect(() => validatePageSlug('/people/alice')).toThrow(OperationError);
    expect(() => validatePageSlug('people/alice/')).toThrow(OperationError);
  });

  it('rejects consecutive slashes', () => {
    expect(() => validatePageSlug('people//alice')).toThrow(OperationError);
  });

  it('rejects empty or too-long', () => {
    expect(() => validatePageSlug('')).toThrow(OperationError);
    expect(() => validatePageSlug('a'.repeat(256))).toThrow(OperationError);
  });

  it('rejects NUL and control chars', () => {
    expect(() => validatePageSlug('people\x00alice')).toThrow(OperationError);
    expect(() => validatePageSlug('people\nalice')).toThrow(OperationError);
  });

  it('rejects spaces', () => {
    expect(() => validatePageSlug('people/alice smith')).toThrow(OperationError);
  });
});

// --- validateFilename (M4 allowlist) ---

describe('validateFilename', () => {
  it('accepts clean filenames with extensions', () => {
    expect(() => validateFilename('photo.jpg')).not.toThrow();
    expect(() => validateFilename('report-2026.pdf')).not.toThrow();
    expect(() => validateFilename('v1.0.0_release.md')).not.toThrow();
  });

  it('rejects control chars', () => {
    expect(() => validateFilename('file\nwith\nnewlines.txt')).toThrow(OperationError);
    expect(() => validateFilename('file\x00nul.txt')).toThrow(OperationError);
  });

  it('rejects backslash', () => {
    expect(() => validateFilename('file\\win.txt')).toThrow(OperationError);
  });

  it('rejects RTL override and other Unicode injection', () => {
    expect(() => validateFilename('file\u202E.exe')).toThrow(OperationError);
  });

  it('rejects leading dash (CLI flag confusion)', () => {
    expect(() => validateFilename('-rf.txt')).toThrow(OperationError);
  });

  it('rejects leading dot (hidden files)', () => {
    expect(() => validateFilename('.htaccess')).toThrow(OperationError);
  });

  it('rejects empty and too-long', () => {
    expect(() => validateFilename('')).toThrow(OperationError);
    expect(() => validateFilename('x'.repeat(256))).toThrow(OperationError);
  });

  it('rejects path separators in filename', () => {
    expect(() => validateFilename('foo/bar.txt')).toThrow(OperationError);
  });
});
