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

  it('extracts inline citation format entries', () => {
    const content = `Closed the seed round with fund-a leading. [Source: board meeting notes, 2025-04-02]`;
    const entries = extractTimelineFromContent(content, 'deals/acme-seed');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-04-02');
    expect(entries[0].source).toBe('board meeting notes');
    expect(entries[0].summary).toBe('Closed the seed round with fund-a leading.');
  });

  it('keeps commas inside the citation source', () => {
    const content = `Alice joined as CTO. [Source: email from alice-example re: offer, signed, 2025-05-10]`;
    const entries = extractTimelineFromContent(content, 'people/alice-example');
    expect(entries).toHaveLength(1);
    expect(entries[0].date).toBe('2025-05-10');
    expect(entries[0].source).toBe('email from alice-example re: offer, signed');
  });

  it('extracts one entry per citation when a line carries several', () => {
    const content = `Both sides confirmed the partnership. [Source: call with widget-co, 2025-06-01] [Source: follow-up email, 2025-06-03]`;
    const entries = extractTimelineFromContent(content, 'companies/widget-co');
    expect(entries).toHaveLength(2);
    expect(entries[0].date).toBe('2025-06-01');
    expect(entries[1].date).toBe('2025-06-03');
    expect(entries[0].summary).toBe(entries[1].summary);
  });

  it('does not double-extract a timeline bullet that carries its own citation', () => {
    const content = `- **2025-03-18** | Meeting — Discussed partnership [Source: meeting notes, 2025-03-18]`;
    const entries = extractTimelineFromContent(content, 'test');
    expect(entries).toHaveLength(1); // Format 1 only
    expect(entries[0].source).toBe('Meeting');
  });

  it('skips a bare citation with no surrounding text', () => {
    const content = `[Source: import batch, 2025-07-01]`;
    expect(extractTimelineFromContent(content, 'test')).toHaveLength(0);
  });

  it('ignores citations without a date', () => {
    const content = `Some claim here. [Source: undated memo]`;
    expect(extractTimelineFromContent(content, 'test')).toHaveLength(0);
  });

  it('strips list markers from the citation summary', () => {
    const content = `- Landed the enterprise pilot with acme-example. [Source: CRM update, 2025-08-15]`;
    const entries = extractTimelineFromContent(content, 'companies/acme-example');
    expect(entries).toHaveLength(1);
    expect(entries[0].summary).toBe('Landed the enterprise pilot with acme-example.');
  });
});

describe('walkMarkdownFiles', () => {
  it('is a function', () => {
    expect(typeof walkMarkdownFiles).toBe('function');
  });
});

describe('extractLinksFromFile — slug normalization (T-OBS-1 regression)', () => {
  // Regression coverage for the bug where CAPS-named files (ETHOS.md, AGENTS.md)
  // generated CAPS slugs from `relPath.replace('.md', '')` while the DB stores
  // pages.slug lowercase via pathToSlug() in core/sync.ts. The mismatch caused
  // INSERT ... JOIN pages ON pages.slug = v.from_slug to silently drop links.
  // Fix: extractor now uses pathToSlug() consistently for from_slug AND allSlugs.

  it('lowercases from_slug when relPath has CAPS filename', async () => {
    // Note: link targets are kept lowercase (the convention used by the
    // wikilink migration); this test focuses on from_slug derivation.
    const content = 'See [agents](agents.md) for the matrix.';
    const allSlugs = new Set(['ethos', 'agents']);
    const links = await extractLinksFromFile(content, 'ETHOS.md', allSlugs);
    expect(links.length).toBeGreaterThanOrEqual(1);
    // Critical: from_slug must be lowercase regardless of the source file casing.
    expect(links[0].from_slug).toBe('ethos');
  });

  it('lowercases from_slug for mixed-case filename', async () => {
    const content = 'Reference [hermes](hermes_nest.md).';
    const allSlugs = new Set(['hermes_nest', 'foo']);
    const links = await extractLinksFromFile(content, 'Foo.md', allSlugs);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].from_slug).toBe('foo');
  });

  it('is idempotent for already-lowercase filenames', async () => {
    const content = 'See [bar](bar.md).';
    const allSlugs = new Set(['foo', 'bar']);
    const links = await extractLinksFromFile(content, 'foo.md', allSlugs);
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].from_slug).toBe('foo');
  });

  it('lowercases nested path slug with mixed-case segment', async () => {
    // relPath has mixed-case directory + filename. Link target is in the same
    // directory (no .. traversal) so resolveSlug can hit allSlugs cleanly.
    const content = 'See [other](other.md).';
    const allSlugs = new Set(['decisions/0001-living-repo-pattern', 'decisions/other']);
    const links = await extractLinksFromFile(
      content,
      'decisions/0001-Living-Repo-Pattern.md',
      allSlugs,
    );
    expect(links.length).toBeGreaterThanOrEqual(1);
    expect(links[0].from_slug).toBe('decisions/0001-living-repo-pattern');
  });
});
