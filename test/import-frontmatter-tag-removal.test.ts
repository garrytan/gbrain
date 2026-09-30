/**
 * A14: removing a tag from a page's frontmatter removes it from the DB on the
 * next import. Tags carry provenance (`tags.tag_source`): the importer stamps
 * frontmatter tags 'frontmatter' and deletes only those rows once the tag
 * leaves the frontmatter. Tags other producers add (add_tag, enrichment, the
 * code importer) and legacy rows no import has claimed are never deleted.
 *
 * PGLite in-memory, no embeddings ($0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => { await engine.disconnect(); }, 30_000);

beforeEach(async () => { await resetPgliteState(engine); });

const page = (tags: string[], body = 'Body text for the page.') =>
  `---\ntype: concept\ntitle: Example\ntags: [${tags.join(', ')}]\n---\n${body}\n`;
const tags = async () => (await engine.getTags('concepts/example')).sort();

describe('frontmatter tag removal (A14)', () => {
  test('a tag removed from frontmatter leaves the DB; other producers keep theirs', async () => {
    await importFromContent(engine, 'concepts/example', page(['alpha', 'beta']), { noEmbed: true });
    await engine.addTag('concepts/example', 'enrichment-tag');
    await importFromContent(engine, 'concepts/example', page(['alpha'], 'Edited body.'), { noEmbed: true });
    expect(await tags()).toEqual(['alpha', 'enrichment-tag']);
  });

  test('an explicit add_tag of a frontmatter tag keeps it after the frontmatter drops it', async () => {
    await importFromContent(engine, 'concepts/example', page(['alpha', 'beta']), { noEmbed: true });
    await engine.addTag('concepts/example', 'beta');
    await importFromContent(engine, 'concepts/example', page(['alpha'], 'Edited body.'), { noEmbed: true });
    expect(await tags()).toEqual(['alpha', 'beta']);
  });

  test('legacy rows are adopted only while they appear in the frontmatter', async () => {
    await importFromContent(engine, 'concepts/example', page(['alpha', 'beta']), { noEmbed: true });
    await engine.addTag('concepts/example', 'legacy-unclaimed');
    await engine.executeRaw('UPDATE tags SET tag_source = NULL');
    await importFromContent(engine, 'concepts/example', page(['alpha', 'beta'], 'Touch.'), { noEmbed: true });
    await importFromContent(engine, 'concepts/example', page(['alpha'], 'Touch again.'), { noEmbed: true });
    expect(await tags()).toEqual(['alpha', 'legacy-unclaimed']);
  });
});
