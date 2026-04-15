import { describe, test, expect } from 'bun:test';
import { validateUploadPath, validatePageSlug } from '../src/core/operations.ts';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

describe('validateUploadPath', () => {
  test('allows regular files', () => {
    // These files exist in the repo
    expect(() => validateUploadPath('src/core/operations.ts')).not.toThrow();
    expect(() => validateUploadPath('package.json')).not.toThrow();
  });

  test('rejects symlinks', () => {
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
