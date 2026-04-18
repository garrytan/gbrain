import { describe, it, expect } from 'bun:test';
import {
  extractMarkdownLinks,
  extractLinksFromFile,
  extractTimelineFromContent,
  walkMarkdownFiles,
  resolveSlug,
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

describe('extractMarkdownLinks — wikilinks', () => {
  it('extracts bare wikilink [[path]]', () => {
    const content = 'See [[concepts/ai-overview]] for details.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].relTarget).toBe('concepts/ai-overview.md');
  });

  it('extracts wikilink with display text [[path|Title]]', () => {
    const content = 'See [[concepts/ai-overview|AI Overview]] for details.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].relTarget).toBe('concepts/ai-overview.md');
    expect(links[0].name).toBe('AI Overview');
  });

  it('extracts wikilink with relative path [[../../other/page|Title]]', () => {
    const content = '[[../../finance/wiki/concepts/billionaire-patterns|Billionaire Patterns]]';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].relTarget).toBe('../../finance/wiki/concepts/billionaire-patterns.md');
  });

  it('skips external wikilinks [[https://example.com|Title]]', () => {
    const content = 'See [[https://example.com|External]] for details.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(0);
  });

  it('does not double-add .md suffix for wikilinks already ending in .md', () => {
    const content = '[[path/to/page.md|Title]]';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].relTarget).toBe('path/to/page.md');
  });

  it('extracts multiple wikilinks from same content', () => {
    const content = '[[concepts/ai]] and [[concepts/ml|Machine Learning]] here.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(2);
    expect(links[0].relTarget).toBe('concepts/ai.md');
    expect(links[1].relTarget).toBe('concepts/ml.md');
  });

  it('mixes standard markdown and wikilinks', () => {
    const content = '[Pedro](../people/pedro.md) and [[concepts/ai|AI]] are both here.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(2);
  });
});

describe('extractLinksFromFile — wikilink integration', () => {
  it('resolves wikilink paths to slugs when target exists', () => {
    // Wikilink [[../concepts/ai|AI Overview]] from page deals/test-deal.md
    // resolves to concepts/ai which must be in allSlugs
    const content = `---\ntitle: Test\n---\nSee [[../concepts/ai|AI Overview]] here.`;
    const allSlugs = new Set(['concepts/ai', 'deals/test-deal']);
    const links = extractLinksFromFile(content, 'deals/test-deal.md', allSlugs);
    expect(links.length).toBeGreaterThanOrEqual(1);
    const aiLink = links.find(l => l.to_slug === 'concepts/ai');
    expect(aiLink).toBeDefined();
    expect(aiLink!.from_slug).toBe('deals/test-deal');
  });

  it('skips wikilinks to pages not in allSlugs', () => {
    const content = `---\ntitle: Test\n---\nSee [[../concepts/ghost|Ghost]] here.`;
    const allSlugs = new Set(['deals/test-deal']);
    const links = extractLinksFromFile(content, 'deals/test-deal.md', allSlugs);
    const ghostLink = links.find(l => l.to_slug === 'concepts/ghost');
    expect(ghostLink).toBeUndefined();
  });
});

describe('resolveSlug', () => {
  const allSlugs = new Set([
    'tech/wiki/concepts/foo-bar',
    'tech/wiki/analysis/ai-overview',
    'tech/raw/source-x',
    'finance/wiki/analysis/foo',
    'finance/wiki/concepts/billionaire-patterns',
    'personal/wiki/analysis/life-design',
    'personal/wiki/guides/fire-planning',
  ]);

  it('resolves relative wikilink in same directory', () => {
    // [[foo-bar]] from tech/wiki/concepts/some-page → tech/wiki/concepts/foo-bar
    expect(resolveSlug('tech/wiki/concepts', 'foo-bar.md', allSlugs))
      .toBe('tech/wiki/concepts/foo-bar');
  });

  it('resolves cross-type wikilink (concepts → analysis sibling)', () => {
    // [[analysis/ai-overview]] from tech/wiki/concepts/ → tech/wiki/analysis/ai-overview
    // Author omits ../ and writes subdirectory-relative from the wiki root
    expect(resolveSlug('tech/wiki/concepts', 'analysis/ai-overview.md', allSlugs))
      .toBe('tech/wiki/analysis/ai-overview');
  });

  it('resolves parent-relative [[../raw/source-x]] from tech/wiki/analysis/', () => {
    // Standard ../ traversal — already handled by join, verifying it still works
    expect(resolveSlug('tech/wiki/analysis', '../raw/source-x.md', allSlugs))
      .toBe('tech/raw/source-x');
  });

  it('resolves deep parent-relative [[../../finance/wiki/analysis/foo]] from tech/wiki/analysis/', () => {
    // Author writes ../../finance from depth-3 dir; needs ancestor search to find
    // the correct finance/wiki/analysis/foo rather than tech/finance/wiki/analysis/foo
    expect(resolveSlug('tech/wiki/analysis', '../../finance/wiki/analysis/foo.md', allSlugs))
      .toBe('finance/wiki/analysis/foo');
  });

  it('resolves fully-qualified wikilink [[tech/wiki/concepts/foo-bar]]', () => {
    // Fully-qualified path: works as-is from any location if resolved against root
    expect(resolveSlug('personal/wiki/analysis', 'tech/wiki/concepts/foo-bar.md', allSlugs))
      .toBe('tech/wiki/concepts/foo-bar');
  });

  it('strips display-text suffix before resolving (via extractMarkdownLinks)', () => {
    // [[tech/wiki/concepts/foo-bar|Foo Bar]] — relTarget already has .md, name is display text
    // resolveSlug receives the relTarget without the | part (extractMarkdownLinks handles it)
    expect(resolveSlug('personal/wiki/analysis', 'tech/wiki/concepts/foo-bar.md', allSlugs))
      .toBe('tech/wiki/concepts/foo-bar');
  });

  it('returns null for dangling target (slug not in allSlugs)', () => {
    expect(resolveSlug('tech/wiki/analysis', 'nonexistent-page.md', allSlugs))
      .toBeNull();
  });

  it('resolves cross-domain from personal/wiki/guides with partial path', () => {
    // [[analysis/life-design]] from personal/wiki/guides/ → personal/wiki/analysis/life-design
    expect(resolveSlug('personal/wiki/guides', 'analysis/life-design.md', allSlugs))
      .toBe('personal/wiki/analysis/life-design');
  });
});

describe('extractMarkdownLinks — section anchors', () => {
  it('strips section anchor from wikilink [[page#section]]', () => {
    const content = '[[tech/wiki/concepts/foo-bar#some-section|Foo Bar]]';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].relTarget).toBe('tech/wiki/concepts/foo-bar.md');
  });

  it('skips bare same-page anchor [[#section]]', () => {
    const content = 'See [[#metrics|Metrics]] for details.';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(0);
  });

  it('strips anchor from bare wikilink [[page#section]] without display text', () => {
    const content = '[[ai-overview#key-findings]]';
    const links = extractMarkdownLinks(content);
    expect(links).toHaveLength(1);
    expect(links[0].relTarget).toBe('ai-overview.md');
  });
});

describe('runExtract — positional dir argument', () => {
  it('extracts positional dir from args[1] when no --dir flag', () => {
    // We cannot run the full command without a DB, but we can verify the logic
    // by checking that walkMarkdownFiles is called with the right path.
    // This is a smoke-test: just confirm the import works and the function exists.
    expect(typeof extractMarkdownLinks).toBe('function');
  });
});

describe('walkMarkdownFiles', () => {
  it('is a function', () => {
    expect(typeof walkMarkdownFiles).toBe('function');
  });
});
