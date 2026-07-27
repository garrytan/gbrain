/**
 * v0.36.x #891 + #978 + #1078 — source-id routing regression suite.
 *
 * Locks in the behavior that `sync --source X` writes pages to source X,
 * not the silent `'default'` fallback. The original bug surfaced as
 * `gbrain sources list` reporting 0 pages for a named source while
 * `pages.source_id` was littered with `'default'` rows.
 *
 * Tested against PGLite (in-memory) so the suite runs without a Postgres
 * fixture and CI catches regressions everywhere.
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
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // Seed two named sources alongside the default.
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('work', 'work') ON CONFLICT DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('personal', 'personal') ON CONFLICT DO NOTHING`,
  );
});

describe('source-id routing (v0.36.x #891 + #978 regression)', () => {
  test('importFromContent({sourceId: "work"}) lands the page at source_id=work', async () => {
    await importFromContent(engine, 'people/alice', '---\ntype: person\ntitle: Alice\n---\n# Alice\n\nWorks at Acme.', {
      noEmbed: true,
      sourceId: 'work',
    });

    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages WHERE slug = 'people/alice'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('work');
    expect(rows[0].slug).toBe('people/alice');
  });

  test('two sources can independently hold the same slug', async () => {
    await importFromContent(engine, 'people/alice', '---\ntype: person\ntitle: Work Alice\n---\nWork persona.', {
      noEmbed: true,
      sourceId: 'work',
    });
    await importFromContent(engine, 'people/alice', '---\ntype: person\ntitle: Personal Alice\n---\nFriend persona.', {
      noEmbed: true,
      sourceId: 'personal',
    });

    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = 'people/alice' ORDER BY source_id`,
    );
    expect(rows.length).toBe(2);
    expect(rows[0].source_id).toBe('personal');
    expect(rows[0].title).toBe('Personal Alice');
    expect(rows[1].source_id).toBe('work');
    expect(rows[1].title).toBe('Work Alice');
  });

  test('omitting sourceId falls through to default (regression-guard for the legacy path)', async () => {
    await importFromContent(engine, 'people/bob', '---\ntype: person\ntitle: Bob\n---\nBob.', {
      noEmbed: true,
    });
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = 'people/bob'`,
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('default');
  });

  test('chunks land under the requested source, not default', async () => {
    await importFromContent(engine, 'people/carol', '---\ntype: person\ntitle: Carol\n---\n\nNotes about Carol.', {
      noEmbed: true,
      sourceId: 'work',
    });
    const chunks = await engine.executeRaw<{ source_id: string }>(
      `SELECT p.source_id FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = 'people/carol'`,
    );
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) expect(c.source_id).toBe('work');
  });

  test('tags land under the requested source, not default', async () => {
    await importFromContent(engine, 'people/dave', '---\ntype: person\ntitle: Dave\ntags: [investor, founder]\n---\nDave.', {
      noEmbed: true,
      sourceId: 'work',
    });
    const tags = await engine.executeRaw<{ source_id: string; tag: string }>(
      `SELECT p.source_id, t.tag FROM tags t JOIN pages p ON p.id = t.page_id WHERE p.slug = 'people/dave' ORDER BY t.tag`,
    );
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t.source_id).toBe('work');
  });
});

describe('source-id routing — FK integrity (v0.36.x #1078)', () => {
  test('writing to a registered source does NOT raise FK violations', async () => {
    // Pre-fix, multi-source brains hit FK constraint errors when the autopilot
    // cycle inserted into a source row that didn't match what other paths
    // assumed. This is the smoke test that the entire import path is FK-clean
    // for named sources.
    await expect(
      importFromContent(engine, 'people/eve', '---\ntype: person\ntitle: Eve\n---\nEve.', {
        noEmbed: true,
        sourceId: 'work',
      }),
    ).resolves.toBeTruthy();
  });
});
