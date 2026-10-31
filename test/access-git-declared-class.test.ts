/**
 * GBRA-218: member access never decides whether a page lives in Git.
 * privacyClass judges an unwritten page with the privacy part of the remote
 * read filter over a synthetic row, which has no access columns; the full
 * filter (readers and lineage) made it throw for every derived page.
 * Repo-less PGLite.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { privacyClass } from '../src/core/persistence/git-declared.ts';

const SRC = 'git-class';
let engine: PGLiteEngine;

describe('privacyClass ignores member access (pglite, repo-less)', () => {
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
    await importFromContent(engine, 'notes/secret-origin', '---\ntype: note\ntitle: Origin\nvisibility: private\n---\nPrivate origin.', { sourceId: SRC, noEmbed: true });
    await importFromContent(engine, 'notes/readers-origin', '---\ntype: note\ntitle: Readers\nreadable_by: [alice-example]\n---\nRestricted origin.', { sourceId: SRC, noEmbed: true });
  }, 120_000);
  afterAll(async () => { await engine.disconnect(); });

  test('a derived page is judged without throwing, by privacy alone', async () => {
    expect(await privacyClass(engine, SRC, { slug: 'concepts/roadmap', type: 'concept', frontmatter: {} })).toBeNull();
    expect(await privacyClass(engine, SRC, { slug: 'notes/summary', type: 'note', frontmatter: { derived_from: ['notes/secret-origin'] } })).toBe('lineage_private');
    expect(await privacyClass(engine, SRC, { slug: 'notes/summary-2', type: 'note', frontmatter: { derived_from: ['notes/readers-origin'] } })).toBeNull();
  }, 60_000);
});
