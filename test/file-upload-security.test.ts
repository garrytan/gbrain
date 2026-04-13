import { describe, test, expect } from 'bun:test';
import { validateUploadPath, validatePageSlug } from '../src/core/operations.ts';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('validateUploadPath', () => {
  test('allows files within the working directory', () => {
    // These files exist in the repo and are within cwd
    expect(() => validateUploadPath('src/core/operations.ts')).not.toThrow();
    expect(() => validateUploadPath('package.json')).not.toThrow();
  });

  test('rejects paths outside the working directory', () => {
    expect(() => validateUploadPath('/tmp/outside-file')).toThrow('must be within the working directory');
  });

  test('rejects traversal attempts', () => {
    expect(() => validateUploadPath('../../.ssh/id_rsa')).toThrow('must be within the working directory');
  });

  test('rejects symlinks inside the working directory', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'upload-test-'));
    const target = join(tmpDir, 'secret.txt');
    writeFileSync(target, 'secret data');
    const link = join(process.cwd(), '.test-symlink-upload');
    try {
      symlinkSync(target, link);
      expect(() => validateUploadPath('.test-symlink-upload')).toThrow('rejects symlinks');
    } finally {
      try { rmSync(link); } catch {}
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('validatePageSlug', () => {
  test('allows clean slugs', () => {
    expect(() => validatePageSlug('people/elon')).not.toThrow();
    expect(() => validatePageSlug('notes/2026-04-13')).not.toThrow();
    expect(() => validatePageSlug('simple')).not.toThrow();
  });

  test('rejects traversal in slug', () => {
    expect(() => validatePageSlug('../../uploads/evil')).toThrow('path traversal');
    expect(() => validatePageSlug('../escape')).toThrow('path traversal');
  });
});
