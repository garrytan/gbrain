/**
 * #1835 — doctor image_assets: Windows drive-form storage_path under WSL.
 *
 * A brain synced from the Windows side records storage_path like
 * 'D:/brain/assets/img.png'. Under WSL (posix path semantics) that is NOT
 * absolute, so pre-fix it was joined onto repoRoot and every such asset was
 * flagged missing. resolveImageAssetPath translates drive-form paths to the
 * WSL mount (/mnt/d/...) on non-Windows platforms.
 */

import { describe, test, expect } from 'bun:test';
import { resolveImageAssetPath } from '../src/commands/doctor.ts';

describe('resolveImageAssetPath (#1835)', () => {
  test('posix absolute path passes through', () => {
    expect(resolveImageAssetPath('/data/brain/img.png', '/repo', 'linux')).toBe(
      '/data/brain/img.png',
    );
  });

  test('repo-relative path joins onto repoRoot', () => {
    expect(resolveImageAssetPath('assets/img.png', '/repo', 'linux')).toBe(
      '/repo/assets/img.png',
    );
  });

  test('Windows drive form translates to the WSL mount on Linux', () => {
    expect(resolveImageAssetPath('D:/brain/assets/img.png', '/repo', 'linux')).toBe(
      '/mnt/d/brain/assets/img.png',
    );
  });

  test('backslash Windows drive form also translates', () => {
    expect(resolveImageAssetPath('D:\\brain\\assets\\img.png', '/repo', 'linux')).toBe(
      '/mnt/d/brain/assets/img.png',
    );
  });

  test('drive letter is lowercased for the mount point', () => {
    expect(resolveImageAssetPath('C:/x/y.png', '/repo', 'linux')).toBe('/mnt/c/x/y.png');
  });

  test('non-drive relative path with a colon is NOT translated', () => {
    expect(resolveImageAssetPath('notes:today/img.png', '/repo', 'linux')).toBe(
      '/repo/notes:today/img.png',
    );
  });
});
