// v0.41.37.0 #1621 — reindex / re-import must NOT wipe DB-side enrichment tags.
//
// Root cause: import-file.ts reconciled tags from frontmatter only via
// DELETE-then-INSERT. The tags table has no provenance column and frontmatter
// tags are stripped from stored frontmatter (markdown.ts:118), so every
// re-import (notably `gbrain reindex --markdown`, which re-imports with
// forceRechunk) deleted all enrichment / dream / signal-detector tags.
//
// Fix: re-import never deletes enrichment tags. Since A14 tags carry
// provenance (tags.tag_source), so removing a frontmatter tag removes only
// that frontmatter-owned row (test/import-frontmatter-tag-removal.test.ts).
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { importFromContent } from '../src/core/import-file.ts';

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

const page = (tags: string[]) =>
  `---\ntype: concept\ntitle: Xavi\ntags: [${tags.join(', ')}]\n---\nBody text for the page.\n`;

describe('#1621 add-only tag reconciliation', () => {
  test('re-import (reindex) preserves DB-side enrichment tags', async () => {
    await importFromContent(engine, 'people/xavi', page(['founder', 'yc']), { forceRechunk: true, noEmbed: true });
    // Simulate DB-side enrichment writing a tag not present in frontmatter.
    await engine.addTag('people/xavi', 'enrichment-tag');

    // Re-import the same content (what reindex --markdown does).
    await importFromContent(engine, 'people/xavi', page(['founder', 'yc']), { forceRechunk: true, noEmbed: true });

    const tags = await engine.getTags('people/xavi');
    expect(tags.sort()).toEqual(['enrichment-tag', 'founder', 'yc']);
  });

  test('frontmatter tags are still added on import', async () => {
    await importFromContent(engine, 'people/xavi', page(['founder', 'yc']), { forceRechunk: true, noEmbed: true });
    const tags = await engine.getTags('people/xavi');
    expect(tags.sort()).toEqual(['founder', 'yc']);
  });

  test('removing a frontmatter tag removes it; enrichment tags survive', async () => {
    await importFromContent(engine, 'people/xavi', page(['founder', 'yc']), { forceRechunk: true, noEmbed: true });
    await engine.addTag('people/xavi', 'enrichment-tag');

    // User removes "yc" from frontmatter and re-imports.
    await importFromContent(engine, 'people/xavi', page(['founder']), { forceRechunk: true, noEmbed: true });

    const tags = await engine.getTags('people/xavi');
    // "yc" left the frontmatter; enrichment-tag preserved; founder present.
    expect(tags.sort()).toEqual(['enrichment-tag', 'founder']);
  });

  test('adding a new frontmatter tag on re-import works (idempotent add)', async () => {
    await importFromContent(engine, 'people/xavi', page(['founder']), { forceRechunk: true, noEmbed: true });
    await engine.addTag('people/xavi', 'enrichment-tag');
    await importFromContent(engine, 'people/xavi', page(['founder', 'growth']), { forceRechunk: true, noEmbed: true });

    const tags = await engine.getTags('people/xavi');
    expect(tags.sort()).toEqual(['enrichment-tag', 'founder', 'growth']);
  });
});
