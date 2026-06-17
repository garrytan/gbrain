import type { FreshnessMeta, FreshnessStatus } from './types.ts';
import { computeFreshness } from './freshness.ts';

export interface FreshnessDigestItem {
  slug: string;
  title: string;
  pageType: string;
  status: FreshnessStatus;
  days_since_verified: number;
  recommended_action: string;
}

export interface FreshnessDigest {
  generated_at: string;
  stale_count: number;
  aging_count: number;
  fresh_count: number;
  items: FreshnessDigestItem[];
}

export interface DigestPage {
  slug: string;
  title: string;
  pageType: string;
  freshness: FreshnessMeta;
}

export function generateDigest(pages: DigestPage[]): FreshnessDigest {
  const items: FreshnessDigestItem[] = pages.map(page => {
    const { status, days_since_verified } = computeFreshness(page.freshness);

    let recommended_action: string;
    if (status === 'stale') {
      recommended_action = 'Review and update content, verify sources';
    } else if (status === 'aging') {
      const remaining = Math.max(0, page.freshness.stale_after_days - days_since_verified);
      const remainingDays = Math.ceil(remaining);
      recommended_action = `Schedule review within ${remainingDays} days`;
    } else {
      recommended_action = '';
    }

    return {
      slug: page.slug,
      title: page.title,
      pageType: page.pageType,
      status,
      days_since_verified,
      recommended_action,
    };
  });

  let stale_count = 0;
  let aging_count = 0;
  let fresh_count = 0;

  for (const item of items) {
    if (item.status === 'stale') stale_count++;
    else if (item.status === 'aging') aging_count++;
    else fresh_count++;
  }

  return {
    generated_at: new Date().toISOString(),
    stale_count,
    aging_count,
    fresh_count,
    items,
  };
}

export function digestToMarkdown(digest: FreshnessDigest): string {
  const total = digest.stale_count + digest.aging_count + digest.fresh_count;
  let md = `# Freshness Digest\n\n`;
  md += `**Generated:** ${digest.generated_at}\n\n`;
  md += `**Summary:** ${digest.stale_count} stale, ${digest.aging_count} aging, ${digest.fresh_count} fresh (${total} total)\n\n`;

  if (total === 0) {
    md += `No pages in digest.\n`;
    return md;
  }

  md += `| Page | Status | Days Since Verified | Recommended Action |\n`;
  md += `|------|--------|--------------------:|--------------------|\n`;

  for (const item of digest.items) {
    const days = Math.round(item.days_since_verified);
    md += `| ${item.title} (${item.slug}) | ${item.status} | ${days} | ${item.recommended_action || '—'} |\n`;
  }

  return md;
}
