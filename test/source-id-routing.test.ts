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

// ---------------------------------------------------------------------------
// Unscoped-check/scoped-write pairs (five-issue fix wave, commit 4)
// ---------------------------------------------------------------------------

describe('unscoped-check/scoped-write regressions (writer + slug-registry + import-file)', () => {
  test('REGRESSION-CRITICAL: importFromContent without sourceId reads the DEFAULT row, not any-source', async () => {
    // Pre-fix: the existence check matched people/carol in 'work' while the
    // write targeted 'default' — read-A/write-B divergence. Post-fix the read
    // mirrors the write's schema default.
    await importFromContent(engine, 'people/carol', '---\ntype: person\ntitle: Work Carol\n---\nWork row.', {
      noEmbed: true,
      sourceId: 'work',
    });
    const workBefore = await engine.executeRaw<{ content_hash: string }>(
      `SELECT content_hash FROM pages WHERE slug = 'people/carol' AND source_id = 'work'`,
    );

    await importFromContent(engine, 'people/carol', '---\ntype: person\ntitle: Default Carol\n---\nDefault row.', {
      noEmbed: true,
    });

    const rows = await engine.executeRaw<{ source_id: string; title: string; content_hash: string }>(
      `SELECT source_id, title, content_hash FROM pages WHERE slug = 'people/carol' ORDER BY source_id`,
    );
    // Two independent rows: the no-sourceId import created/updated 'default'
    // and left 'work' byte-identical.
    expect(rows.length).toBe(2);
    const work = rows.find(r => r.source_id === 'work')!;
    const def = rows.find(r => r.source_id === 'default')!;
    expect(work.title).toBe('Work Carol');
    expect(work.content_hash).toBe(workBefore[0].content_hash);
    expect(def.title).toBe('Default Carol');
  });

  test('scoped BrainWriter creates the exact slug in its source even when the slug is taken elsewhere', async () => {
    const { BrainWriter } = await import('../src/core/output/writer.ts');
    // Slug exists ONLY in 'personal'.
    await importFromContent(engine, 'people/dave', '---\ntype: person\ntitle: Personal Dave\n---\nx', {
      noEmbed: true,
      sourceId: 'personal',
    });

    const writer = new BrainWriter(engine, { strictMode: 'off', sourceId: 'work' });
    const ctx = {
      engine, config: {}, requestId: 't', remote: false as const,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const { result: slug } = await writer.transaction(async (tx) => {
      return tx.createEntity({
        desiredSlug: 'people/dave',
        displayName: 'Work Dave',
        type: 'person',
        compiledTruth: 'Work dave body.',
      });
    }, ctx as never);

    // Pre-fix: the unscoped probe saw personal's row and disambiguated to
    // people/dave-2. Post-fix: exact slug, in the writer's source.
    expect(slug).toBe('people/dave');
    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = 'people/dave' ORDER BY source_id`,
    );
    expect(rows.length).toBe(2);
    expect(rows.find(r => r.source_id === 'work')?.title).toBe('Work Dave');
    expect(rows.find(r => r.source_id === 'personal')?.title).toBe('Personal Dave');
  });

  test('scoped writer setFrontmatterField edits ITS row and never the other source', async () => {
    const { BrainWriter } = await import('../src/core/output/writer.ts');
    await importFromContent(engine, 'people/erin', '---\ntype: person\ntitle: Work Erin\n---\nx', {
      noEmbed: true, sourceId: 'work',
    });
    await importFromContent(engine, 'people/erin', '---\ntype: person\ntitle: Personal Erin\n---\ny', {
      noEmbed: true, sourceId: 'personal',
    });

    const writer = new BrainWriter(engine, { strictMode: 'off', sourceId: 'work' });
    const ctx = {
      engine, config: {}, requestId: 't', remote: false as const,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    await writer.transaction(async (tx) => {
      await tx.setFrontmatterField('people/erin', 'reviewed', true);
    }, ctx as never);

    const work = await engine.getPage('people/erin', { sourceId: 'work' });
    const personal = await engine.getPage('people/erin', { sourceId: 'personal' });
    expect(work?.frontmatter?.reviewed).toBe(true);
    expect(personal?.frontmatter?.reviewed).toBeUndefined();
  });

  test('unscoped getPage on a duplicated slug is deterministic: default-source-first', async () => {
    // 'archive' sorts before 'default' — pre-fix (no ORDER BY) the winner was
    // arbitrary; plain alpha would wrongly prefer 'archive'.
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('archive', 'archive') ON CONFLICT DO NOTHING`);
    await importFromContent(engine, 'people/frank', '---\ntype: person\ntitle: Archive Frank\n---\nx', {
      noEmbed: true, sourceId: 'archive',
    });
    await importFromContent(engine, 'people/frank', '---\ntype: person\ntitle: Default Frank\n---\ny', {
      noEmbed: true,
    });

    const page = await engine.getPage('people/frank'); // gbrain-allow-unscoped-getpage: pinning the deterministic default-first tiebreak itself
    expect(page?.title).toBe('Default Frank');

    // And when only non-default sources hold the slug, the tiebreak is stable alpha.
    await engine.deletePage('people/frank', { sourceId: 'default' });
    await importFromContent(engine, 'people/frank', '---\ntype: person\ntitle: Work Frank\n---\nz', {
      noEmbed: true, sourceId: 'work',
    });
    const page2 = await engine.getPage('people/frank'); // gbrain-allow-unscoped-getpage: pinning the deterministic alpha tiebreak itself
    expect(page2?.title).toBe('Archive Frank');
  });
});
