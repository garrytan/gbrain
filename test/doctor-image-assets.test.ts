import { describe, expect, test } from 'bun:test';
import { resolveImageAssetPath } from '../src/commands/doctor-asset-paths.ts';

describe('doctor image asset path resolution', () => {
  test('uses the owning source local_path before the global sync fallback', () => {
    expect(resolveImageAssetPath(
      'images/example.jpg',
      '/brains/default-source',
      '/brains/other-source',
    ).abs).toBe('/brains/default-source/images/example.jpg');
  });

  test('falls back to sync.repo_path for legacy rows without a source root', () => {
    expect(resolveImageAssetPath(
      'images/example.jpg',
      null,
      '/brains/fallback',
    ).abs).toBe('/brains/fallback/images/example.jpg');
  });

  test('keeps absolute storage paths unchanged', () => {
    expect(resolveImageAssetPath(
      '/var/lib/gbrain/example.jpg',
      '/brains/default-source',
      '/brains/fallback',
    ).abs).toBe('/var/lib/gbrain/example.jpg');
  });
});
