/**
 * #3190 — pack-aware link extraction + same-directory markdown links.
 *
 * Four gates, each dead pre-fix:
 *  1. `[Name](slug.md)` (no `/`, no scheme) produced ZERO refs on the DB
 *     path (pass 1 requires `dir/`), while the FS walker linked it. Now a
 *     `sameDir` ref resolves against the linking page's directory.
 *  2. extractPageLinks ignored the active pack — a user pack's
 *     `link_types[].inference.regex` (e.g. parent_of) typed nothing; every
 *     such edge landed as 'mentions'.
 *  3. extractFrontmatterLinks ignored pack `frontmatter_links` — a pack
 *     field like `parents:` produced 0 candidates.
 *  4. PGLite e2e: an ACTIVE custom pack (engine config `schema_pack` +
 *     locator seam) types edges through `gbrain extract --stale` end to end.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  extractEntityRefs,
  extractPageLinks,
  extractFrontmatterLinks,
  type SlugResolver,
} from '../src/core/link-extraction.ts';
import {
  parseSchemaPackManifest,
  __setPackLocatorForTests,
  _resetPackLocatorForTests,
  _resetPackCacheForTests,
} from '../src/core/schema-pack/index.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';

const nullResolver: SlugResolver = { resolve: async () => null };

const PACK = parseSchemaPackManifest({
  api_version: 'gbrain-schema-pack-v1',
  name: 'pack-3190',
  version: '0.1.0',
  extends: null,
  page_types: [],
  link_types: [
    { name: 'parent_of', inference: { regex: '\\bparent of\\b' } },
  ],
  frontmatter_links: [
    { page_type: 'concept', fields: ['parents'], link_type: 'parent_of' },
  ],
});

describe('#3190 gate 1 — same-directory markdown links', () => {
  test('extractEntityRefs surfaces [N](slug.md) as a sameDir ref', () => {
    const refs = extractEntityRefs('See [Beta Notes](beta.md) for details.');
    expect(refs).toHaveLength(1);
    expect(refs[0].name).toBe('Beta Notes');
    expect(refs[0].slug).toBe('beta');
    expect(refs[0].sameDir).toBe(true);
  });

  test('scheme/anchor/dir targets never match the sameDir pass', () => {
    expect(extractEntityRefs('[x](https://example.com/a.md)').filter(r => r.sameDir)).toEqual([]);
    expect(extractEntityRefs('[x](beta.md#section)').filter(r => r.sameDir)).toEqual([]);
    // dir-shaped targets belong to pass 1, not the sameDir pass
    const dirRefs = extractEntityRefs('[x](people/beta.md)');
    expect(dirRefs).toHaveLength(1);
    expect(dirRefs[0].sameDir).toBeUndefined();
  });

  test('extractPageLinks resolves sameDir against the linking page directory', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/notes/alpha', 'See [Beta](beta.md).', {}, 'concept', nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['wiki/notes/beta']);
    expect(candidates[0].linkSource).toBe('markdown');
  });

  test('sameDir self-loop is guarded', async () => {
    const { candidates } = await extractPageLinks(
      'wiki/notes/alpha', 'See [Alpha](alpha.md).', {}, 'concept', nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates).toEqual([]);
  });

  test('percent-encoded sameDir target slugifies through the sync grammar', async () => {
    const { candidates } = await extractPageLinks(
      'people/index', 'Met [Alice](Alice%20Chen.md).', {}, 'concept', nullResolver,
      { skipFrontmatter: true },
    );
    expect(candidates.map(c => c.targetSlug)).toEqual(['people/alice-chen']);
  });
});

describe('#3190 gate 2 — pack regex verbs in extractPageLinks', () => {
  test('pack regex types the edge (pre-fix: mentions)', async () => {
    const { candidates } = await extractPageLinks(
      'companies/acme', 'Acme is the parent of [Sub Co](companies/sub-co).',
      {}, 'company', nullResolver, { skipFrontmatter: true, pack: PACK },
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].targetSlug).toBe('companies/sub-co');
    expect(candidates[0].linkType).toBe('parent_of');
  });

  test('no pack → legacy inference unchanged', async () => {
    const { candidates } = await extractPageLinks(
      'companies/acme', 'Acme is the parent of [Sub Co](companies/sub-co).',
      {}, 'company', nullResolver, { skipFrontmatter: true },
    );
    expect(candidates[0].linkType).toBe('mentions');
  });

  test('pack miss falls through to legacy verbs', async () => {
    const { candidates } = await extractPageLinks(
      'people/carol', 'Carol founded [Anchor](companies/anchor).',
      {}, 'person', nullResolver, { skipFrontmatter: true, pack: PACK },
    );
    expect(candidates[0].linkType).toBe('founded');
  });
});

describe('#3190 gate 3 — pack frontmatter_links in extractFrontmatterLinks', () => {
  const resolver: SlugResolver = {
    resolve: async (name) => (name === 'concepts/parent-page' ? 'concepts/parent-page' : null),
  };

  test('pack field emits an outgoing typed candidate (pre-fix: 0 candidates)', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'concepts/x', 'concept' as never, { parents: ['concepts/parent-page'] },
      resolver, false, PACK,
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].fromSlug).toBe('concepts/x');
    expect(candidates[0].targetSlug).toBe('concepts/parent-page');
    expect(candidates[0].linkType).toBe('parent_of');
    expect(candidates[0].linkSource).toBe('frontmatter');
    expect(candidates[0].originField).toBe('parents');
  });

  test('pack rule scoped to its page_type', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'people/x', 'person' as never, { parents: ['concepts/parent-page'] },
      resolver, false, PACK,
    );
    expect(candidates).toEqual([]);
  });

  test('no pack → pack fields stay inert (built-in map only)', async () => {
    const { candidates } = await extractFrontmatterLinks(
      'concepts/x', 'concept' as never, { parents: ['concepts/parent-page'] },
      resolver, false,
    );
    expect(candidates).toEqual([]);
  });
});

describe('#3190 gate 4 — PGLite e2e: active pack types edges via extract --stale', () => {
  let engine: PGLiteEngine;
  let packDir: string;

  beforeAll(async () => {
    packDir = mkdtempSync(join(tmpdir(), 'gbrain-3190-pack-'));
    writeFileSync(join(packDir, 'pack.yaml'), [
      'api_version: gbrain-schema-pack-v1',
      'name: pack-3190',
      'version: 0.1.0',
      'extends: null',
      'page_types: []',
      'link_types:',
      '  - name: parent_of',
      '    inference:',
      '      regex: \\bparent of\\b',
      'frontmatter_links: []',
      '',
    ].join('\n'));
    _resetPackCacheForTests();
    __setPackLocatorForTests((name) => (name === 'pack-3190' ? join(packDir, 'pack.yaml') : null));

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.setConfig('schema_pack', 'pack-3190');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
       VALUES
         ('companies/acme', 'default', 'company', 'Acme', 'Acme is the parent of [Sub Co](companies/sub-co). Also see [Beta](sibling.md).', ''),
         ('companies/sub-co', 'default', 'company', 'Sub Co', 'x', ''),
         ('companies/sibling', 'default', 'company', 'Sibling', 'x', '')`,
    );
  }, 60_000);

  afterAll(async () => {
    _resetPackLocatorForTests();
    _resetPackCacheForTests();
    await engine.disconnect();
    rmSync(packDir, { recursive: true, force: true });
  });

  test('stale sweep produces pack-typed + same-dir edges (>0)', async () => {
    const r = await extractStaleFromDB(engine, {
      dryRun: false, jsonMode: true, includeFrontmatter: false, catchUp: false,
    });
    expect(r.pagesProcessed).toBeGreaterThan(0);

    const rows = await engine.executeRaw<{ to_slug: string; link_type: string }>(
      `SELECT pt.slug AS to_slug, l.link_type
       FROM links l
       JOIN pages pf ON pf.id = l.from_page_id AND pf.slug = 'companies/acme'
       JOIN pages pt ON pt.id = l.to_page_id`,
    );
    // Gate 2 e2e: the pack verb typed the edge.
    expect(rows.some(x => x.to_slug === 'companies/sub-co' && x.link_type === 'parent_of')).toBe(true);
    // Gate 1 e2e: the same-dir markdown link produced an edge at all.
    expect(rows.some(x => x.to_slug === 'companies/sibling')).toBe(true);
  });
});
