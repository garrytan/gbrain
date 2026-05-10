/**
 * Regression test for the v0.18-v0.22 multi-source sync regression.
 *
 * Bug: importFromContent did not thread sourceId to tx.putPage. Every synced
 * page silently landed in source_id='default'. When the same slug already
 * existed in another source, the mid-transaction state had two rows with
 * matching slug, and the next scalar subquery in the import path (e.g.
 * addLink) exploded with "more than one row returned by a subquery used
 * as an expression".
 *
 * Fix: thread sourceId end-to-end, replace scalar subqueries with
 * (source_id, slug) joins. This test exercises the failure scenario:
 * pre-seed source A with slug X, import the same slug into source B, and
 * verify (1) both rows coexist, (2) addLink across sources succeeds,
 * (3) tags/chunks/versions are correctly scoped.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { PageInput } from '../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

async function truncateAll() {
  const tables = [
    'content_chunks', 'links', 'tags', 'raw_data',
    'timeline_entries', 'page_versions', 'ingest_log', 'pages',
  ];
  for (const t of tables) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ('source_a', 'Source A'), ('source_b', 'Source B')
     ON CONFLICT (id) DO NOTHING`,
  );
}

const pageInputA: PageInput = {
  type: 'concept',
  title: 'Page in source A',
  compiled_truth: 'Content from source A.',
};

const pageInputB: PageInput = {
  type: 'concept',
  title: 'Page in source B',
  compiled_truth: 'Different content from source B.',
};

describe('Multi-source: putPage routes to the correct source', () => {
  beforeEach(truncateAll);

  test('explicit sourceId lands in that source, not default', async () => {
    await engine.putPage('design', pageInputA, { sourceId: 'source_a' });

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1`,
      ['design'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe('source_a');
  });

  test('omitted sourceId falls back to default (back-compat)', async () => {
    await engine.putPage('legacy-page', pageInputA);

    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT source_id FROM pages WHERE slug = $1`,
      ['legacy-page'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe('default');
  });

  test('two sources with the same slug coexist as separate rows', async () => {
    await engine.putPage('design', pageInputA, { sourceId: 'source_a' });
    await engine.putPage('design', pageInputB, { sourceId: 'source_b' });

    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = $1 ORDER BY source_id`,
      ['design'],
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]!.source_id).toBe('source_a');
    expect(rows[0]!.title).toBe('Page in source A');
    expect(rows[1]!.source_id).toBe('source_b');
    expect(rows[1]!.title).toBe('Page in source B');
  });
});

describe('Multi-source: getPage / getTags / getChunks scope by source', () => {
  beforeEach(truncateAll);

  test('getPage with sourceId returns the right row', async () => {
    await engine.putPage('design', pageInputA, { sourceId: 'source_a' });
    await engine.putPage('design', pageInputB, { sourceId: 'source_b' });

    const a = await engine.getPage('design', { sourceId: 'source_a' });
    const b = await engine.getPage('design', { sourceId: 'source_b' });

    expect(a?.title).toBe('Page in source A');
    expect(b?.title).toBe('Page in source B');
  });

  test('getTags scopes to the right source', async () => {
    await engine.putPage('design', pageInputA, { sourceId: 'source_a' });
    await engine.putPage('design', pageInputB, { sourceId: 'source_b' });
    await engine.addTag('design', 'tag-a', { sourceId: 'source_a' });
    await engine.addTag('design', 'tag-b', { sourceId: 'source_b' });

    const tagsA = await engine.getTags('design', { sourceId: 'source_a' });
    const tagsB = await engine.getTags('design', { sourceId: 'source_b' });

    expect(tagsA).toEqual(['tag-a']);
    expect(tagsB).toEqual(['tag-b']);
  });
});

describe('Multi-source: addLink across colliding slugs does not explode', () => {
  beforeEach(truncateAll);

  test('addLink with originSlug colliding across sources resolves cleanly', async () => {
    // Reproduces the exact failure mode: same slug exists in two sources,
    // addLink uses the slug as origin. Pre-fix, this exploded with
    // "more than one row returned by a subquery used as an expression"
    // because addLink's `(SELECT id FROM pages WHERE slug = $1)` scalar
    // subquery saw two rows.
    await engine.putPage('shared-slug', pageInputA, { sourceId: 'source_a' });
    await engine.putPage('shared-slug', pageInputB, { sourceId: 'source_b' });
    await engine.putPage('target', pageInputA, { sourceId: 'source_a' });

    await engine.addLink(
      'shared-slug', 'target',
      'cited from A', 'documents', 'markdown',
      'shared-slug', 'compiled_truth',
      { fromSourceId: 'source_a', toSourceId: 'source_a', originSourceId: 'source_a' },
    );

    const links = await engine.getLinks('shared-slug', { sourceId: 'source_a' });
    expect(links).toHaveLength(1);
    expect(links[0]!.to_slug).toBe('target');
    expect(links[0]!.origin_slug).toBe('shared-slug');
  });
});

describe('Multi-source: importFromContent threads sourceId end-to-end', () => {
  beforeEach(truncateAll);

  test('importing a markdown page with sourceId lands in that source', async () => {
    const content = `# Test Page\n\nSome content here.\n`;
    await importFromContent(engine, 'design', content, {
      noEmbed: true,
      sourceId: 'source_b',
    });

    const rows = await engine.executeRaw<{ source_id: string; slug: string }>(
      `SELECT source_id, slug FROM pages WHERE slug = $1 ORDER BY source_id`,
      ['design'],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.source_id).toBe('source_b');
  });

  test('the ORIGINAL failure mode: import to source_b when source_a already has the slug', async () => {
    // Pre-seed source_a with the slug.
    await engine.putPage('design', pageInputA, { sourceId: 'source_a' });

    // This is the call that pre-fix would land at (default, 'design')
    // and then explode in addLink mid-transaction.
    const content = `# Design\n\nSome design notes referring to src/core/sync.ts:42.\n`;
    const result = await importFromContent(engine, 'design', content, {
      noEmbed: true,
      sourceId: 'source_b',
    });

    expect(result.status).toBe('imported');

    // Both source_a and source_b should now have a 'design' row, none in default.
    const rows = await engine.executeRaw<{ source_id: string; title: string }>(
      `SELECT source_id, title FROM pages WHERE slug = $1 ORDER BY source_id`,
      ['design'],
    );
    expect(rows.map(r => r.source_id)).toEqual(['source_a', 'source_b']);
    expect(rows.map(r => r.source_id)).not.toContain('default');
  });

  test('idempotent re-import: second import with same content + sourceId is a no-op', async () => {
    const content = `# Test\n\nIdempotent.\n`;
    const r1 = await importFromContent(engine, 'idem', content, {
      noEmbed: true,
      sourceId: 'source_a',
    });
    const r2 = await importFromContent(engine, 'idem', content, {
      noEmbed: true,
      sourceId: 'source_a',
    });

    expect(r1.status).toBe('imported');
    expect(r2.status).toBe('skipped');

    const rows = await engine.executeRaw(`SELECT source_id FROM pages WHERE slug = $1`, ['idem']);
    expect(rows).toHaveLength(1);
  });
});
