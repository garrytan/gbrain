import { describe, expect, test } from 'bun:test';
import { storagePathCandidates } from '../src/core/path-resolve.ts';

describe('storagePathCandidates', () => {
  test('adds WSL mount candidate for Windows drive paths on non-Windows platforms', () => {
    expect(storagePathCandidates('D:/vault/image.jpg', 'linux')).toEqual([
      'D:/vault/image.jpg',
      '/mnt/d/vault/image.jpg',
    ]);
    expect(storagePathCandidates('D:\\vault\\nested image.jpg', 'linux')).toEqual([
      'D:\\vault\\nested image.jpg',
      '/mnt/d/vault/nested image.jpg',
    ]);
  });

  test('does not add WSL candidates on Windows', () => {
    expect(storagePathCandidates('D:/vault/image.jpg', 'win32')).toEqual(['D:/vault/image.jpg']);
  });

  test('leaves native paths unchanged', () => {
    expect(storagePathCandidates('/mnt/d/vault/image.jpg', 'linux')).toEqual(['/mnt/d/vault/image.jpg']);
    expect(storagePathCandidates('relative/image.jpg', 'linux')).toEqual(['relative/image.jpg']);
  });
});
