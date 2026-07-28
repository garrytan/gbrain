import { describe, expect, test } from 'bun:test';
import {
  resolveImageAssetPath,
  summarizeImageAssetPresence,
} from '../src/commands/doctor.ts';

describe('doctor image asset path resolution', () => {
  test('uses the owning source local_path before the global sync fallback', () => {
    expect(resolveImageAssetPath(
      'images/example.jpg',
      '/brains/default-source',
      '/brains/other-source',
    )).toBe('/brains/default-source/images/example.jpg');
  });

  test('falls back to sync.repo_path for legacy rows without a source root', () => {
    expect(resolveImageAssetPath(
      'images/example.jpg',
      null,
      '/brains/fallback',
    )).toBe('/brains/fallback/images/example.jpg');
  });

  test('keeps absolute storage paths unchanged', () => {
    expect(resolveImageAssetPath(
      '/var/lib/gbrain/example.jpg',
      '/brains/default-source',
      '/brains/fallback',
    )).toBe('/var/lib/gbrain/example.jpg');
  });

  test('deduplicates rows by content hash when one registered path exists', () => {
    const existing = new Set(['/brains/default/conversations/images/example.jpg']);
    const result = summarizeImageAssetPresence([
      {
        storage_path: 'example.jpg',
        content_hash: 'same-hash',
        source_id: 'default',
        source_local_path: '/brains/default',
      },
      {
        storage_path: 'conversations/images/example.jpg',
        content_hash: 'same-hash',
        source_id: 'default',
        source_local_path: '/brains/default',
      },
    ], '/brains/fallback', path => existing.has(path));

    expect(result).toEqual({ total: 1, missing: 0, missingPaths: [] });
  });

  test('reports a logical image missing only when none of its paths exist', () => {
    const result = summarizeImageAssetPresence([
      {
        storage_path: 'missing.jpg',
        content_hash: 'missing-hash',
        source_id: 'default',
        source_local_path: '/brains/default',
      },
    ], '/brains/fallback', () => false);

    expect(result).toEqual({ total: 1, missing: 1, missingPaths: ['missing.jpg'] });
  });
});
