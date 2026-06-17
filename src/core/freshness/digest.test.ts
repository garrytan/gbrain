import { describe, test, expect } from 'bun:test';
import { generateDigest, digestToMarkdown } from './digest.ts';
import type { DigestPage } from './digest.ts';

function daysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function makePage(
  slug: string,
  title: string,
  pageType: string,
  staleAfterDays: number,
  lastVerifiedDaysAgo: number,
): DigestPage {
  return {
    slug,
    title,
    pageType,
    freshness: {
      last_verified_at: daysAgo(lastVerifiedDaysAgo),
      decay_class: 'medium',
      source_precision: 'medium',
      confidence: 0.8,
      stale_after_days: staleAfterDays,
    },
  };
}

describe('generateDigest', () => {
  test('digest with mixed pages categorizes correctly', () => {
    const pages = [
      makePage('fresh-page', 'Fresh Page', 'concept', 365, 5),
      makePage('aging-page', 'Aging Page', 'concept', 365, 200),
      makePage('stale-page', 'Stale Page', 'concept', 365, 400),
    ];

    const digest = generateDigest(pages);

    expect(digest.fresh_count).toBe(1);
    expect(digest.aging_count).toBe(1);
    expect(digest.stale_count).toBe(1);
    expect(digest.items).toHaveLength(3);
  });

  test('stale items have "Review and update" action', () => {
    const pages = [makePage('stale-page', 'Stale Page', 'concept', 30, 40)];
    const digest = generateDigest(pages);

    expect(digest.items[0].status).toBe('stale');
    expect(digest.items[0].recommended_action).toBe('Review and update content, verify sources');
  });

  test('aging items have "Schedule review" action with remaining days', () => {
    const pages = [makePage('aging-page', 'Aging Page', 'concept', 30, 20)];
    const digest = generateDigest(pages);

    expect(digest.items[0].status).toBe('aging');
    expect(digest.items[0].recommended_action).toMatch(/Schedule review within \d+ days/);
  });

  test('fresh items have no action', () => {
    const pages = [makePage('fresh-page', 'Fresh Page', 'concept', 30, 5)];
    const digest = generateDigest(pages);

    expect(digest.items[0].status).toBe('fresh');
    expect(digest.items[0].recommended_action).toBe('');
  });

  test('empty input produces empty digest with zero counts', () => {
    const digest = generateDigest([]);

    expect(digest.fresh_count).toBe(0);
    expect(digest.aging_count).toBe(0);
    expect(digest.stale_count).toBe(0);
    expect(digest.items).toHaveLength(0);
  });
});

describe('digestToMarkdown', () => {
  test('produces well-formatted output with counts header', () => {
    const pages = [
      makePage('fresh-page', 'Fresh Page', 'concept', 365, 5),
      makePage('stale-page', 'Stale Page', 'concept', 365, 400),
    ];

    const digest = generateDigest(pages);
    const md = digestToMarkdown(digest);

    expect(md).toContain('# Freshness Digest');
    expect(md).toContain('1 stale, 0 aging, 1 fresh');
    expect(md).toContain('Fresh Page');
    expect(md).toContain('Stale Page');
    expect(md).toContain('fresh');
    expect(md).toContain('stale');
  });

  test('handles empty digest', () => {
    const digest = generateDigest([]);
    const md = digestToMarkdown(digest);

    expect(md).toContain('# Freshness Digest');
    expect(md).toContain('0 stale, 0 aging, 0 fresh');
    expect(md).toContain('No pages in digest.');
  });
});
