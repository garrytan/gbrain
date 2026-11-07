import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { posix } from 'node:path';
import { extractMarkdownLinks, extractPageLinks, resolveMarkdownLinkSlug, type SlugResolver } from '../src/core/link-extraction.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { slugifyPath } from '../src/core/sync.ts';

const resolver: SlugResolver = { resolve: async () => null };
const page = 'library/collection/index';

describe('#6983 child-directory markdown paths', () => {
  test.each(['notes/008-first.md', 'notes/008-first.md#details', 'notes/../notes/008-first.md', 'notes/First%20Note.md'])('%s agrees with filesystem extraction and the writer validator', async href => {
    const body = `[First note](${href})`;
    const [fileRef] = extractMarkdownLinks(body);
    const expected = slugifyPath(posix.join(posix.dirname(page), fileRef.relTarget.slice(0, -3)));
    const { candidates } = await extractPageLinks(page, body, {}, 'concept', resolver, { skipFrontmatter: true });
    expect(candidates.map(c => c.targetSlug)).toEqual([expected]);
    expect(resolveMarkdownLinkSlug(page, href)).toBe(expected);
  });

  test.each([
    ['/notes/008-first.md', 'notes/008-first'],
    ['notes/008-first', 'notes/008-first'],
    ['notes/008-first#example.md', 'notes/008-first'],
    ['../notes/008-first.md', 'library/notes/008-first'],
    ['./notes/008-first.md', 'library/collection/notes/008-first'],
  ])('preserves the existing explicit path lane for %s', async (href, expected) => {
    const { candidates } = await extractPageLinks(page, `[First](${href})`, {}, 'concept', resolver, { skipFrontmatter: true });
    expect(candidates.map(c => c.targetSlug)).toEqual([expected]);
    expect(resolveMarkdownLinkSlug(page, href)).toBe(expected);
  });

  test('wikilinks retain root and source-qualified identity', async () => {
    const { candidates } = await extractPageLinks(page, '[[notes/008-first.md]] [[other:notes/008-first.md]]', {}, 'concept', resolver, { skipFrontmatter: true });
    expect(candidates.map(c => [c.targetSlug, c.targetSourceId])).toEqual([
      ['notes/008-first', 'other'], ['notes/008-first', undefined],
    ]);
  });
});

describe('#6983 database sweep preserves filesystem-derived child edges', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline) VALUES
      ('library/collection/index', 'default', 'concept', 'Index', '[First](notes/008-first.md)', ''),
      ('library/collection/notes/008-first', 'default', 'concept', 'First', 'First note', ''),
      ('notes/008-first', 'default', 'concept', 'Root decoy', 'Not the linked child', '')`);
    await engine.executeRaw(`INSERT INTO links (from_page_id, to_page_id, link_type, link_source)
      SELECT a.id, b.id, 'mentions', 'markdown' FROM pages a, pages b
      WHERE a.slug='library/collection/index' AND b.slug='library/collection/notes/008-first'`);
  }, 60_000);
  afterAll(async () => { await engine.disconnect(); });

  test('repeated stale extraction retains only the real child, not a same-named root decoy', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      await engine.executeRaw(`UPDATE pages SET links_extracted_at=NULL WHERE slug='library/collection/index'`);
      const result = await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, includeFrontmatter: false, catchUp: false });
      expect(result.pagesProcessed).toBeGreaterThan(0);
      const links = await engine.executeRaw<{ slug: string }>(`SELECT b.slug FROM links l JOIN pages a ON a.id=l.from_page_id
        JOIN pages b ON b.id=l.to_page_id WHERE a.slug='library/collection/index' AND l.link_source='markdown' ORDER BY b.slug`);
      expect(links.map(l => l.slug)).toEqual(['library/collection/notes/008-first']);
    }
  }, 60_000);
});
