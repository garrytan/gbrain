import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractMarkdownLinks,
  extractLinksFromFile,
  extractLinksForSlugs,
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

  it('extracts Obsidian wikilinks with aliases', () => {
    const content = 'See [[knowledge/agents/gbrain|GBrain]] and [[knowledge/agents/hermes|Hermes]].';
    const allSlugs = new Set(['knowledge/agents/gbrain', 'knowledge/agents/hermes', 'agents']);
    const links = extractLinksFromFile(content, 'agents.md', allSlugs);
    expect(links.map(l => l.to_slug)).toContain('knowledge/agents/gbrain');
    expect(links.map(l => l.to_slug)).toContain('knowledge/agents/hermes');
  });

  it('extracts Obsidian wikilinks relative to the current directory', () => {
    const content = 'Latest summary: [[weekly-2026-04-12]]';
    const allSlugs = new Set(['briefs/weekly-kaizen-2026-04-13', 'briefs/weekly-2026-04-12']);
    const links = extractLinksFromFile(content, 'briefs/weekly-kaizen-2026-04-13.md', allSlugs);
    expect(links.map(l => l.to_slug)).toContain('briefs/weekly-2026-04-12');
  });

  it('extracts Obsidian wikilinks with escaped pipe aliases', () => {
    const content = 'See [[knowledge/agents/winston\\|Winston]].';
    const allSlugs = new Set(['knowledge/agents/winston', 'agents']);
    const links = extractLinksFromFile(content, 'agents.md', allSlugs);
    expect(links.map(l => l.to_slug)).toContain('knowledge/agents/winston');
  });

  it('slugifies uppercase filenames to match imported page slugs', () => {
    const content = 'See [[knowledge/agents/gbrain|GBrain]].';
    const allSlugs = new Set(['agents', 'knowledge/agents/gbrain']);
    const links = extractLinksFromFile(content, 'AGENTS.md', allSlugs);
    expect(links.map(l => l.from_slug)).toContain('agents');
    expect(links.map(l => l.to_slug)).toContain('knowledge/agents/gbrain');
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

describe('extractLinksForSlugs', () => {
  it('finds files whose filenames differ from slug casing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-extract-'));
    mkdirSync(join(root, 'knowledge', 'agents'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), 'See [[knowledge/agents/gbrain|GBrain]].');
    writeFileSync(join(root, 'knowledge', 'agents', 'gbrain.md'), '# GBrain');

    const added: Array<{ from: string; to: string }> = [];
    const engine = {
      addLink: async (from: string, to: string) => { added.push({ from, to }); },
    } as any;

    const created = await extractLinksForSlugs(engine, root, ['agents']);
    expect(created).toBe(1);
    expect(added).toEqual([{ from: 'agents', to: 'knowledge/agents/gbrain' }]);
  });
});
