/**
 * Bug 11 — brain_score needs a breakdown + orphan_pages metric is wrong.
 *
 * Assertions:
 *   1. getHealth() returns the new *_score breakdown fields.
 *   2. Breakdown fields sum to brain_score by construction.
 *   3. orphan_pages counts islanded pages: no inbound AND no outbound live links.
 *   4. BrainHealth type now carries dead_links.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

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
  for (const t of ['links', 'content_chunks', 'timeline_entries', 'raw_data', 'tags', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

describe('Bug 11 — brain_score breakdown sums to total', () => {
  test('empty brain returns zero score with all breakdown fields present', async () => {
    const h = await engine.getHealth();
    expect(h.brain_score).toBe(0);
    expect(h.embed_coverage_score).toBe(0);
    expect(h.link_density_score).toBe(0);
    expect(h.timeline_coverage_score).toBe(0);
    expect(h.no_orphans_score).toBe(0);
    expect(h.no_dead_links_score).toBe(0);
    // dead_links is now on the type.
    expect(h.dead_links).toBe(0);
  });

  test('breakdown fields always sum to brain_score', async () => {
    // Seed a small graph — some pages, some links, some embeds.
    for (const slug of ['a', 'b', 'c']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `content of ${slug}`, frontmatter: {} });
    }
    const h = await engine.getHealth();
    const sum =
      h.embed_coverage_score +
      h.link_density_score +
      h.timeline_coverage_score +
      h.no_orphans_score +
      h.no_dead_links_score;
    expect(sum).toBe(h.brain_score);
  });

  test('brain_score caps at 100', async () => {
    const h = await engine.getHealth();
    expect(h.brain_score).toBeGreaterThanOrEqual(0);
    expect(h.brain_score).toBeLessThanOrEqual(100);
  });
});

describe('Bug 11 — orphan_pages is "islanded pages"', () => {
  test('a page with outbound-only links is NOT an orphan', async () => {
    // Hub page: links out to three others, but nothing links back to it.
    // Previous (buggy) behavior: hub counted as orphan because it had no
    // inbound links (correct) AND the old query also required no outbound.
    await engine.putPage('hub', { type: 'note', title: 'Hub', compiled_truth: 'index', frontmatter: {} });
    await engine.putPage('leaf1', { type: 'note', title: 'L1', compiled_truth: 'x', frontmatter: {} });
    await engine.putPage('leaf2', { type: 'note', title: 'L2', compiled_truth: 'y', frontmatter: {} });
    await engine.putPage('leaf3', { type: 'note', title: 'L3', compiled_truth: 'z', frontmatter: {} });

    const hubId = (await (engine as any).db.query(`SELECT id FROM pages WHERE slug='hub'`)).rows[0].id;
    for (const target of ['leaf1', 'leaf2', 'leaf3']) {
      const tid = (await (engine as any).db.query(`SELECT id FROM pages WHERE slug=$1`, [target])).rows[0].id;
      await (engine as any).db.query(
        `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`,
        [hubId, tid],
      );
    }

    const h = await engine.getHealth();
    // hub has outbound, no inbound → NOT orphan (under the fixed definition).
    // leaf1/2/3 have inbound from hub → NOT orphan.
    // So orphan_pages should be 0.
    expect(h.orphan_pages).toBe(0);
  });

  test('a page with no links at all IS an orphan', async () => {
    await engine.putPage('loner', { type: 'note', title: 'Loner', compiled_truth: 'alone', frontmatter: {} });
    const h = await engine.getHealth();
    expect(h.orphan_pages).toBe(1);
  });

  test('a page with inbound links only is NOT an orphan', async () => {
    await engine.putPage('sink', { type: 'note', title: 'Sink', compiled_truth: 'target', frontmatter: {} });
    await engine.putPage('source', { type: 'note', title: 'Source', compiled_truth: 'origin', frontmatter: {} });
    const sinkId = (await (engine as any).db.query(`SELECT id FROM pages WHERE slug='sink'`)).rows[0].id;
    const srcId = (await (engine as any).db.query(`SELECT id FROM pages WHERE slug='source'`)).rows[0].id;
    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`,
      [srcId, sinkId],
    );

    const h = await engine.getHealth();
    // sink has 1 inbound (from source) → not orphan.
    // source has no inbound (but has outbound) → not orphan under islanded definition.
    expect(h.orphan_pages).toBe(0);
  });

  test('REGRESSION: soft-deleted page with no live links does not count as a health orphan', async () => {
    await engine.putPage('deleted-loner', { type: 'note', title: 'Deleted', compiled_truth: 'gone', frontmatter: {} });
    await (engine as any).db.query(`UPDATE pages SET deleted_at = now() WHERE slug = 'deleted-loner'`);

    const h = await engine.getHealth();

    expect(h.page_count).toBe(0);
    expect(h.orphan_pages).toBe(0);
  });

  test('REGRESSION: links from soft-deleted pages do not count as live health connectivity', async () => {
    await engine.putPage('deleted-source', { type: 'note', title: 'Deleted source', compiled_truth: 'gone', frontmatter: {} });
    await engine.putPage('live-target', { type: 'note', title: 'Live target', compiled_truth: 'still here', frontmatter: {} });
    const sourceId = (await (engine as any).db.query(`SELECT id FROM pages WHERE slug='deleted-source'`)).rows[0].id;
    const targetId = (await (engine as any).db.query(`SELECT id FROM pages WHERE slug='live-target'`)).rows[0].id;
    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, 'mentions')`,
      [sourceId, targetId],
    );
    await (engine as any).db.query(`UPDATE pages SET deleted_at = now() WHERE slug = 'deleted-source'`);

    const h = await engine.getHealth();

    expect(h.page_count).toBe(1);
    expect(h.orphan_pages).toBe(1);
  });
});


describe('health stale_pages uses event dates, not extraction timestamps', () => {
  test('REGRESSION: extracted old timeline row created after page update does not mark page stale', async () => {
    await engine.putPage('account/current', {
      type: 'company',
      title: 'Current account',
      compiled_truth: 'Compiled truth already reflects the old event.',
      frontmatter: {},
    });
    await engine.addTimelineEntry('account/current', { date: '2020-01-01', summary: 'Old imported event' });

    const h = await engine.getHealth();

    expect(h.stale_pages).toBe(0);
  });

  test('REGRESSION: future scheduled timeline event does not mark page stale before event date', async () => {
    await engine.putPage('account/scheduled', {
      type: 'company',
      title: 'Scheduled account',
      compiled_truth: 'Current account read with a future meeting scheduled.',
      frontmatter: {},
    });
    await engine.addTimelineEntry('account/scheduled', { date: '2999-01-01', summary: 'Future meeting scheduled' });

    const h = await engine.getHealth();

    expect(h.stale_pages).toBe(0);
  });
});

describe('Bug 11 — doctor renders brain_score breakdown', () => {
  test('doctor source contains brain_score breakdown rendering', async () => {
    const source = await Bun.file(new URL('../src/commands/doctor.ts', import.meta.url)).text();
    expect(source).toContain('brain_score');
    expect(source).toContain('embed_coverage_score');
    expect(source).toContain('link_density_score');
    expect(source).toContain('no_orphans_score');
    expect(source).toContain('no_dead_links_score');
  });
});

describe('Bug 11 — BrainHealth type shape', () => {
  test('type includes dead_links + breakdown scores', async () => {
    const typesSource = await Bun.file(new URL('../src/core/types.ts', import.meta.url)).text();
    expect(typesSource).toContain('dead_links: number');
    expect(typesSource).toContain('embed_coverage_score: number');
    expect(typesSource).toContain('link_density_score: number');
    expect(typesSource).toContain('timeline_coverage_score: number');
    expect(typesSource).toContain('no_orphans_score: number');
    expect(typesSource).toContain('no_dead_links_score: number');
    // The stale "(0-10)" comment must be corrected to 0-100.
    expect(typesSource).toContain('0-100');
  });
});
