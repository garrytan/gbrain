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
  it('resolves relative paths to slugs', async () => {
    const content = '---\ntitle: Test\n---\nSee [Pedro](../people/pedro.md).';
    const allSlugs = new Set(['people/pedro', 'deals/test-deal']);
    const links = await extractLinksFromFile(content, 'deals/test-deal.md', allSlugs);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].from_slug).toBe('deals/test-deal');
    expect(links[0].to_slug).toBe('people/pedro');
  });

  it('skips links to non-existent pages', async () => {
    const content = 'See [Ghost](../people/ghost.md).';
    const allSlugs = new Set(['deals/test']);
    const links = await extractLinksFromFile(content, 'deals/test.md', allSlugs);
    expect(links).toHaveLength(0);
  });

  it('extracts frontmatter company links (v0.13, includeFrontmatter opt-in)', async () => {
    const content = '---\ncompany: brex\ntype: person\n---\nContent.';
    // v0.13 canonical: person page with company: X → person → company works_at (outgoing).
    // Resolver needs companies/brex to exist in allSlugs to emit the edge.
    const allSlugs = new Set(['people/test', 'companies/brex']);
    const links = await extractLinksFromFile(content, 'people/test.md', allSlugs, { includeFrontmatter: true });
    const companyLinks = links.filter(l => l.link_type === 'works_at');
    expect(companyLinks.length).toBeGreaterThanOrEqual(1);
    expect(companyLinks[0].from_slug).toBe('people/test');
    expect(companyLinks[0].to_slug).toBe('companies/brex');
  });

  it('extracts frontmatter investors array (v0.13: incoming direction)', async () => {
    // v0.13: deal page with investors:[yc, threshold] emits INCOMING edges:
    // companies/yc → deals/seed invested_in and same for threshold.
    const content = '---\ninvestors: [yc, threshold]\ntype: deal\n---\nContent.';
    const allSlugs = new Set(['deals/seed', 'companies/yc', 'companies/threshold']);
    const links = await extractLinksFromFile(content, 'deals/seed.md', allSlugs, { includeFrontmatter: true });
    const investorLinks = links.filter(l => l.link_type === 'invested_in');
    expect(investorLinks).toHaveLength(2);
    // Incoming: from = resolved investor, to = deal page.
    for (const l of investorLinks) {
      expect(l.to_slug).toBe('deals/seed');
      expect(l.from_slug).toMatch(/^companies\/(yc|threshold)$/);
    }
  });

  it('frontmatter extraction is default OFF (back-compat)', async () => {
    // Without includeFrontmatter, fs-source no longer auto-extracts frontmatter.
    // Matches db-source behavior. User opts in with --include-frontmatter flag.
    const content = '---\ncompany: brex\ntype: person\n---\nContent.';
    const allSlugs = new Set(['people/test', 'companies/brex']);
    const links = await extractLinksFromFile(content, 'people/test.md', allSlugs);
    expect(links).toEqual([]);
  });

  it('infers link type from directory structure', async () => {
    const content = 'See [Brex](../companies/brex.md).';
    const allSlugs = new Set(['people/pedro', 'companies/brex']);
    const links = await extractLinksFromFile(content, 'people/pedro.md', allSlugs);
    expect(links[0].link_type).toBe('works_at');
  });

  it('infers deal_for type for deals -> companies', async () => {
    const content = 'See [Brex](../companies/brex.md).';
    const allSlugs = new Set(['deals/seed', 'companies/brex']);
    const links = await extractLinksFromFile(content, 'deals/seed.md', allSlugs);
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
});
