/**
 * #6983: a `.md` markdown link with a directory segment and no `/`, `./` or
 * `../` prefix (`[First](notes/008-first.md)` on `library-a/collection/index`)
 * resolves against the linking page's directory, the way the FS walker
 * (resolveSlug) and CommonMark readers do. Before the fix the DB path
 * (`extract links --source db`, backfill_links, put_page auto-link) resolved
 * it root-relative to `notes/008-first`, which is not a page, so the edge was
 * dropped while `--source fs` kept it. Root-relative stays the fallback when
 * no page-relative page exists, so wiki-root-relative authoring still links.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { extractPageLinks, makeResolver, pageRelativeMarkdownSlugs } from '../src/core/link-extraction.ts';
import { extractLinksFromFile } from '../src/commands/extract.ts';
import { linkValidator } from '../src/core/output/validators/link.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const PAGES = [
  'library-a/collection/index',
  'library-a/collection/notes/008-first',
  'people/alice-example',
  'wiki/concepts/x',
  'wiki/a/page',
  'meetings/2026/m1',
];

async function seed(): Promise<Set<string>> {
  for (const slug of PAGES) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: 'x', frontmatter: {} });
  }
  return new Set(PAGES);
}

const CASES: Array<{ page: string; body: string; expected: string }> = [
  { page: 'library-a/collection/index', body: '- [First note](notes/008-first.md)', expected: 'library-a/collection/notes/008-first' },
  { page: 'meetings/2026/m1', body: 'Met [Alice](people/alice-example.md).', expected: 'people/alice-example' },
  { page: 'wiki/a/page', body: 'See [X](concepts/x.md).', expected: 'wiki/concepts/x' },
];

async function dbTargets(page: string, body: string): Promise<string[]> {
  const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
  const { candidates } = await extractPageLinks(page, body, {}, 'note', resolver, { skipFrontmatter: true });
  return candidates.map(c => c.targetSlug);
}

describe('#6983 child-directory markdown links', () => {
  test('DB mode resolves a child-directory .md link against the page directory', async () => {
    await seed();
    const targets = await dbTargets(CASES[0].page, CASES[0].body);
    expect(targets).toContain('library-a/collection/notes/008-first');
    expect(targets).not.toContain('notes/008-first');
  });

  test('DB mode falls back to an ancestor, then root-relative, when the page-relative slug is not a page', async () => {
    await seed();
    expect(await dbTargets(CASES[1].page, CASES[1].body)).toContain('people/alice-example');
    expect(await dbTargets(CASES[2].page, CASES[2].body)).toContain('wiki/concepts/x');
  });

  test('FS and DB modes resolve every case to the same target', async () => {
    const allSlugs = await seed();
    for (const { page, body, expected } of CASES) {
      const fs = (await extractLinksFromFile(body, `${page}.md`, allSlugs)).map(l => l.to_slug);
      const db = (await dbTargets(page, body)).filter(t => allSlugs.has(t));
      expect(fs).toEqual([expected]);
      expect(db).toEqual([expected]);
    }
  });

  test('engine-slug links (no .md) and prefixed links keep their resolution', () => {
    expect(pageRelativeMarkdownSlugs('library-a/collection/index', 'notes/008-first')).toEqual([]);
    expect(pageRelativeMarkdownSlugs('library-a/collection/index', '/notes/008-first.md')).toEqual([]);
    expect(pageRelativeMarkdownSlugs('library-a/collection/index', '../notes/008-first.md')).toEqual([]);
    expect(pageRelativeMarkdownSlugs('index', 'notes/008-first.md')).toEqual([]);
    expect(pageRelativeMarkdownSlugs('library-a/collection/index', 'notes/008-first.md#top'))
      .toEqual(['library-a/collection/notes/008-first', 'library-a/notes/008-first']);
  });

  test('the link validator accepts the child-directory link the graph records', async () => {
    await seed();
    const findings = await linkValidator.validate({
      slug: 'library-a/collection/index', type: 'note', frontmatter: {}, engine,
      compiledTruth: CASES[0].body, timeline: '',
    });
    expect(findings).toEqual([]);
  });
});
