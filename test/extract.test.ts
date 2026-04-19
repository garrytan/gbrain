import { describe, it, expect } from 'bun:test';
import {
  extractMarkdownLinks,
  extractLinksFromFile,
  extractTimelineFromContent,
  walkMarkdownFiles,
} from '../src/commands/extract.ts';

describe('extractMarkdownLinks', () => {
  it('extracts relative markdown links', () => {
    const content = 'Check [Pedro](../people/pedro-franceschi.md) and [Brex](../../companies/brex.md).';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0].name).toBe('Pedro');
    expect(links[0].relTarget).toBe('../people/pedro-franceschi.md');
  });

  it('skips external URLs ending in .md', () => {
    const content = 'See [readme](https://example.com/readme.md) for details.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(0);
  });

  it('handles links with no matches', () => {
    const content = 'No links here.';
    expect(extractMarkdownLinks(content)).toHaveLength(0);
  });

  it('extracts multiple links from same line', () => {
    const content = '[A](a.md) and [B](b.md)';
    expect(extractMarkdownLinks(content)).toHaveLength(2);
  });
});

describe('extractLinksFromFile', () => {
  it('resolves relative paths to slugs', () => {
    const content = '---\ntitle: Test\n---\nSee [Pedro](../people/pedro.md).';
    const allSlugs = new Set(['people/pedro', 'deals/test-deal']);
    const links = extractLinksFromFile(content, 'deals/test-deal.md', allSlugs);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].from_slug).toBe('deals/test-deal');
    expect(links[0].to_slug).toBe('people/pedro');
  });

  it('skips links to non-existent pages', () => {
    const content = 'See [Ghost](../people/ghost.md).';
    const allSlugs = new Set(['deals/test']);
    const links = extractLinksFromFile(content, 'deals/test.md', allSlugs);
    expect(links).toHaveLength(0);
  });

  it('extracts frontmatter company links', () => {
    const content = '---\ncompany: brex\ntype: person\n---\nContent.';
    const allSlugs = new Set(['people/test']);
    const links = extractLinksFromFile(content, 'people/test.md', allSlugs);
    const companyLinks = links.filter(l => l.link_type === 'works_at');
    expect(companyLinks.length).toBeGreaterThanOrEqual(1);
    expect(companyLinks[0].to_slug).toBe('companies/brex');
  });

  it('extracts frontmatter investors array', () => {
    const content = '---\ninvestors: [yc, threshold]\ntype: deal\n---\nContent.';
    const allSlugs = new Set(['deals/seed']);
    const links = extractLinksFromFile(content, 'deals/seed.md', allSlugs);
    const investorLinks = links.filter(l => l.link_type === 'invested_in');
    expect(investorLinks).toHaveLength(2);
  });

  it('infers link type from directory structure', () => {
    const content = 'See [Brex](../companies/brex.md).';
    const allSlugs = new Set(['people/pedro', 'companies/brex']);
    const links = extractLinksFromFile(content, 'people/pedro.md', allSlugs);
    expect(links[0].link_type).toBe('works_at');
  });

  it('infers deal_for type for deals -> companies', () => {
    const content = 'See [Brex](../companies/brex.md).';
    const allSlugs = new Set(['deals/seed', 'companies/brex']);
    const links = extractLinksFromFile(content, 'deals/seed.md', allSlugs);
    expect(links[0].link_type).toBe('deal_for');
  });
});

describe('extractTimelineFromContent', () => {
  it('extracts bullet format entries', () => {
    const content = `## Timeline\n- **2025-03-18** | Meeting — Discussed partnership`;
    const entries = extractTimelineFromContent(content, 'people/test');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-03-18');
    expect(entries[0].source).toBe('Meeting');
    expect(entries[0].summary).toBe('Discussed partnership');
  });

  it('extracts header format entries', () => {
    const content = `### 2025-03-28 — Round Closed\n\nAll docs signed. Marcus joins the board.`;
    const entries = extractTimelineFromContent(content, 'deals/seed');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-03-28');
    expect(entries[0].summary).toBe('Round Closed');
    expect(entries[0].detail).toContain('Marcus joins the board');
  });

  it('returns empty for no timeline content', () => {
    const content = 'Just plain text without dates.';
    expect(extractTimelineFromContent(content, 'test')).toHaveLength(0);
  });

  it('extracts multiple bullet entries', () => {
    const content = `- **2025-01-01** | Source1 — Summary1\n- **2025-02-01** | Source2 — Summary2`;
    const entries = extractTimelineFromContent(content, 'test');
    expect(entries).toHaveLength(2);
  });

  it('handles em dash and en dash in bullet format', () => {
    const content = `- **2025-03-18** | Meeting – Discussed partnership`;
    const entries = extractTimelineFromContent(content, 'test');
    expect(entries).toHaveLength(1);
  });
});

describe('walkMarkdownFiles', () => {
  it('is a function', () => {
    expect(typeof walkMarkdownFiles).toBe('function');
  });

  it('skips _-prefixed directories, matching the _-prefixed file behavior', async () => {
    // Quarantine convention (e.g. `_pending/` for signal-detector ambient
    // captures): users extend exclusions to skip these paths on sync. The
    // walker already skipped `_foo.md` files but still recursed into
    // `_pending/originals/`, so extract counted quarantined content that
    // sync excluded (issue #202).
    const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = await import('fs');
    const { tmpdir } = await import('os');
    const { join } = await import('path');

    const root = mkdtempSync(join(tmpdir(), 'gbrain-walk-test-'));
    try {
      mkdirSync(join(root, 'concepts'));
      mkdirSync(join(root, '_pending', 'originals'), { recursive: true });
      writeFileSync(join(root, 'concepts', 'alpha.md'), '# alpha');
      writeFileSync(join(root, '_pending', 'ambient.md'), '# ambient');
      writeFileSync(join(root, '_pending', 'originals', 'buried.md'), '# buried');
      writeFileSync(join(root, '_skip-me.md'), '# file-level skip');

      const files = walkMarkdownFiles(root).map(f => f.relPath).sort();
      expect(files).toEqual(['concepts/alpha.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
