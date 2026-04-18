import { describe, it, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractMarkdownLinks,
  extractLinksFromFile,
  extractLinksForSlugs,
  extractTimelineFromContent,
  runExtract,
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

  it('slugifies from/to paths the same way import does', () => {
    const content = 'See [Readme](README.md).';
    const allSlugs = new Set(['folder/index', 'folder/readme']);
    const links = extractLinksFromFile(content, 'Folder/INDEX.md', allSlugs);
    expect(links).toHaveLength(1);
    expect(links[0].from_slug).toBe('folder/index');
    expect(links[0].to_slug).toBe('folder/readme');
  });
});

describe('extractLinksForSlugs', () => {
  it('finds files by slugified path during sync extraction', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-extract-'));
    try {
      mkdirSync(join(dir, 'Folder'), { recursive: true });
      writeFileSync(join(dir, 'Folder', 'README.md'), '# Readme\n');
      writeFileSync(join(dir, 'Folder', 'INDEX.md'), 'See [Readme](README.md).\n');

      const links: Array<{ from: string; to: string }> = [];
      const engine = {
        addLink: async (from: string, to: string) => { links.push({ from, to }); },
      } as any;

      const created = await extractLinksForSlugs(engine, dir, ['folder/index']);
      expect(created).toBe(1);
      expect(links).toEqual([{ from: 'folder/index', to: 'folder/readme' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts a positional dir argument in runExtract', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-runextract-'));
    try {
      mkdirSync(join(dir, 'Folder'), { recursive: true });
      writeFileSync(join(dir, 'Folder', 'README.md'), '# Readme\n');
      writeFileSync(join(dir, 'Folder', 'INDEX.md'), 'See [Readme](README.md).\n');

      const links: Array<{ from: string; to: string }> = [];
      const engine = {
        listPages: async () => [],
        getLinks: async () => [],
        addLink: async (from: string, to: string) => { links.push({ from, to }); },
      } as any;

      await runExtract(engine, ['links', dir]);
      expect(links).toEqual([{ from: 'folder/index', to: 'folder/readme' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
