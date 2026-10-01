/**
 * #5749: a bare frontmatter wikilink with a unique global-basename match must
 * resolve to that page, not to whatever page the live-mode keyword search
 * ranks first. The managed stale-link sweep runs the live resolver over every
 * stale page, so before the fix a transcript that repeated the term silently
 * took over correct `related:` edges.
 *
 * Precedence mirrors the entity resolver (#5769): an exact name match (here, a
 * page whose slug basename IS the link text) wins before fuzzy or search
 * evidence about some other page.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { extractPageLinks, makeResolver } from '../src/core/link-extraction.ts';
import { withEnv } from './helpers/with-env.ts';

// A brain that boosts transcripts (GBRAIN_SOURCE_BOOST) lets a transcript that
// repeats a term clear the live keyword step's 0.8 score bar, as in the report.
const BOOSTED = { GBRAIN_SOURCE_BOOST: 'conversations/:2.5' };

let engine: PGLiteEngine;

const TRANSCRIPT = 'conversations/sessions/2026-09-01-planning-chat';
const PRODUCT = 'products/zorblax';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await importFromContent(engine, PRODUCT,
    '---\ntype: project\ntitle: Acme Gizmo Line\n---\n\nThe gizmo product line.\n', { noEmbed: true });
  await importFromContent(engine, 'analysis/quibbleton',
    '---\ntype: concept\ntitle: Market Sizing Notes\n---\n\nSizing work.\n', { noEmbed: true });
  const chatter = Array.from({ length: 60 }, () => 'zorblax zorblax quibbleton quibbleton zorblax quibbleton.').join('\n');
  await importFromContent(engine, TRANSCRIPT,
    `---\ntype: conversation\ntitle: Zorblax and quibbleton planning chat\n---\n\n${chatter}\n`, { noEmbed: true });
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

async function relatedTargets(globalBasename: boolean, mode: 'live' | 'batch'): Promise<string[]> {
  const resolver = makeResolver(engine, { mode, sourceId: 'default' });
  const { candidates } = await withEnv(BOOSTED, () => extractPageLinks(
    'wiki/overview', 'Body.', { related: ['[[zorblax]]', '[[quibbleton]]'] }, 'concept', resolver, { globalBasename },
  ));
  return candidates.filter(c => c.linkType === 'related_to').map(c => c.targetSlug).sort();
}

describe('#5749 frontmatter wikilink resolution order', () => {
  test('the live keyword search can reach the transcript (precondition)', async () => {
    const hits = await withEnv(BOOSTED, () => engine.searchKeyword('zorblax', { limit: 3, sourceId: 'default' }));
    expect(hits[0]?.slug).toBe(TRANSCRIPT);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0.8);
  });

  test('live mode with global_basename: the unique basename wins over keyword search', async () => {
    expect(await relatedTargets(true, 'live')).toEqual(['analysis/quibbleton', PRODUCT]);
  });

  test('live and batch mode agree on the same frontmatter', async () => {
    expect(await relatedTargets(true, 'live')).toEqual(await relatedTargets(true, 'batch'));
  });

  test('an ambiguous basename does not win; the later steps still decide', async () => {
    await importFromContent(engine, 'archive/zorblax',
      '---\ntype: project\ntitle: Old Gizmo Line\n---\n\nArchived.\n', { noEmbed: true });
    try {
      const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
      const { candidates } = await extractPageLinks(
        'wiki/overview', 'Body.', { related: ['[[zorblax]]'] }, 'concept', resolver, { globalBasename: true },
      );
      expect(candidates.filter(c => c.linkType === 'related_to')).toEqual([]);
    } finally {
      await engine.executeRaw(`DELETE FROM pages WHERE slug = 'archive/zorblax'`);
    }
  });

  test('without global_basename the resolver order is unchanged', async () => {
    const resolver = makeResolver(engine, { mode: 'batch', sourceId: 'default' });
    expect(await resolver.resolve('zorblax')).toBeNull();
  });

  test('a page never links to itself through its own basename', async () => {
    const resolver = makeResolver(engine, { mode: 'live', sourceId: 'default' });
    const { candidates } = await withEnv(BOOSTED, () => extractPageLinks(
      PRODUCT, 'Body.', { related: ['[[zorblax]]'] }, 'project', resolver, { globalBasename: true },
    ));
    expect(candidates.some(c => c.linkType === 'related_to' && c.targetSlug === PRODUCT)).toBe(false);
  });
});
