/**
 * Tests for storage-status formatters — step 10 of v0.22.3.
 *
 * Issue #10 + D14: split storage.ts into pure data + JSON formatter +
 * human formatter (matching orphans.ts). Formatters are now pure
 * functions; this test file pins their output contracts.
 */

import { describe, test, expect } from 'bun:test';
import {
  formatStorageStatusJson,
  formatStorageStatusHuman,
  type StorageStatusResult,
} from '../src/commands/storage.ts';

const baseResult: StorageStatusResult = {
  config: {
    db_tracked: ['people/', 'companies/'],
    db_only: ['media/x/', 'media/articles/'],
  },
  repoPath: '/data/brain',
  totalPages: 12500,
  pagesByTier: { db_tracked: 2156, db_only: 10100, unspecified: 244 },
  missingFiles: [],
  diskUsageByTier: { db_tracked: 45_200_000, db_only: 2_100_000_000, unspecified: 0 },
  warnings: [],
};

describe('formatStorageStatusJson', () => {
  test('produces parseable JSON of the StorageStatusResult shape', () => {
    const out = formatStorageStatusJson(baseResult);
    const parsed = JSON.parse(out);
    expect(parsed.repoPath).toBe('/data/brain');
    expect(parsed.totalPages).toBe(12500);
    expect(parsed.pagesByTier.db_only).toBe(10100);
    expect(parsed.config.db_tracked).toEqual(['people/', 'companies/']);
  });

  test('handles null config (no gbrain.yml present)', () => {
    const out = formatStorageStatusJson({ ...baseResult, config: null, totalPages: 5 });
    const parsed = JSON.parse(out);
    expect(parsed.config).toBeNull();
    expect(parsed.totalPages).toBe(5);
  });
});

describe('formatStorageStatusHuman', () => {
  test('shows tier counts and disk usage when config present', () => {
    const out = formatStorageStatusHuman(baseResult);
    expect(out).toContain('Storage Status');
    expect(out).toContain('Repository: /data/brain');
    expect(out).toContain('Total pages: 12500');
    expect(out).toContain('DB tracked:     2,156 pages');
    expect(out).toContain('DB only:        10,100 pages');
    expect(out).toContain('Unspecified:    244 pages');
  });

  test('shows ASCII separators only — no unicode (D10)', () => {
    const out = formatStorageStatusHuman(baseResult);
    expect(out).not.toContain('─'); // U+2500 box drawing
    expect(out).not.toContain('•'); // U+2022 bullet
    expect(out).toContain('-------------'); // ASCII fallback
  });

  test('shows fallback message when config is null', () => {
    const out = formatStorageStatusHuman({ ...baseResult, config: null });
    expect(out).toContain('No gbrain.yml configuration found.');
    expect(out).toContain('All pages are stored in git by default.');
  });

  test('shows missing-files block when list is non-empty, capped at 10', () => {
    const missing = Array.from({ length: 25 }, (_, i) => ({
      slug: `media/x/tweet-${i}`,
      expectedPath: `/data/brain/media/x/tweet-${i}.md`,
    }));
    const out = formatStorageStatusHuman({ ...baseResult, missingFiles: missing });
    expect(out).toContain('Missing Files (need restore):');
    expect(out).toContain('media/x/tweet-0');
    expect(out).toContain('media/x/tweet-9'); // 10th
    expect(out).not.toContain('media/x/tweet-10'); // 11th truncated
    expect(out).toContain('and 15 more');
    expect(out).toContain('gbrain export --restore-only --repo "/data/brain"');
  });

  test('shows configuration listing for both tiers', () => {
    const out = formatStorageStatusHuman(baseResult);
    expect(out).toContain('DB tracked directories:');
    expect(out).toContain('  - people/');
    expect(out).toContain('  - companies/');
    expect(out).toContain('DB-only directories:');
    expect(out).toContain('  - media/x/');
    expect(out).toContain('  - media/articles/');
  });

  test('shows warnings inline when present', () => {
    const out = formatStorageStatusHuman({
      ...baseResult,
      warnings: ['Directory path "people" should end with "/" for consistency'],
    });
    expect(out).toContain('Warnings:');
    expect(out).toContain('! Directory path "people"');
  });

  test('omits disk-usage block when both tiers report 0 bytes', () => {
    const out = formatStorageStatusHuman({
      ...baseResult,
      diskUsageByTier: { db_tracked: 0, db_only: 0, unspecified: 0 },
    });
    expect(out).not.toContain('Disk Usage:');
  });
});
