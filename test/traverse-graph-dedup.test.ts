/**
 * Bug 6/10 regression — legacy traverseGraph jsonb_agg duplicate edges.
 *
 * The links table deliberately allows multiple rows with the same
 * (from_page_id, to_page_id, link_type) when origin_page_id or link_source
 * differ. That's how markdown-body edges and frontmatter edges coexist for
 * the same pair. The duplicates should NOT surface in the legacy
 * traverseGraph() aggregated output — dedup is presentation-only in the
 * jsonb_agg step. This test seeds two such rows and asserts the aggregation
 * collapses them. It also asserts the underlying `links` table still has
 * both rows (provenance preserved).
 *
 * Runs against PGLite (unit, always). The postgres-engine path uses the
 * same SQL; an E2E test covers Postgres.
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
  for (const t of ['links', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

describe('Bug 6/10 — traverseGraph jsonb_agg DISTINCT', () => {
  test('collapses two provenance rows for the same (from,to,type) edge', async () => {
    await engine.putPage('people/alice', { type: 'person', title: 'Alice', compiled_truth: '', frontmatter: {} });
    await engine.putPage('companies/acme', { type: 'company', title: 'Acme', compiled_truth: '', frontmatter: {} });

    const alice = await (engine as any).db.query(`SELECT id FROM pages WHERE slug = 'people/alice'`);
    const acme = await (engine as any).db.query(`SELECT id FROM pages WHERE slug = 'companies/acme'`);
    const fromId = alice.rows[0].id as string;
    const toId = acme.rows[0].id as string;

    // Two rows, same (from, to, type), different provenance:
    // row 1 from markdown body (origin_page_id = from page itself, link_source 'markdown')
    // row 2 from frontmatter (origin_page_id = null, link_source 'frontmatter')
    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, origin_page_id, link_source)
       VALUES ($1, $2, 'works_at', $1, 'markdown')`,
      [fromId, toId],
    );
    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, origin_page_id, link_source)
       VALUES ($1, $2, 'works_at', NULL, 'frontmatter')`,
      [fromId, toId],
    );

    // Provenance preserved at the table level.
    const rawCount = await (engine as any).db.query(
      `SELECT count(*)::int as n FROM links WHERE from_page_id = $1 AND to_page_id = $2 AND link_type = 'works_at'`,
      [fromId, toId],
    );
    expect(rawCount.rows[0].n).toBe(2);

    // Aggregated output dedups.
    const nodes = await engine.traverseGraph('people/alice', 2);
    const alicedNode = nodes.find(n => n.slug === 'people/alice');
    expect(alicedNode).toBeDefined();

    const worksAtEdges = alicedNode!.links.filter(
      l => l.to_slug === 'companies/acme' && l.link_type === 'works_at',
    );
    expect(worksAtEdges.length).toBe(1);
  });

  test('keeps genuinely distinct link types even between same nodes', async () => {
    await engine.putPage('people/bob', { type: 'person', title: 'Bob', compiled_truth: '', frontmatter: {} });
    await engine.putPage('companies/widget', { type: 'company', title: 'Widget', compiled_truth: '', frontmatter: {} });

    const bob = await (engine as any).db.query(`SELECT id FROM pages WHERE slug = 'people/bob'`);
    const widget = await (engine as any).db.query(`SELECT id FROM pages WHERE slug = 'companies/widget'`);
    const fromId = bob.rows[0].id as string;
    const toId = widget.rows[0].id as string;

    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, origin_page_id, link_source)
       VALUES ($1, $2, 'works_at', $1, 'markdown')`,
      [fromId, toId],
    );
    await (engine as any).db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, origin_page_id, link_source)
       VALUES ($1, $2, 'founded', $1, 'markdown')`,
      [fromId, toId],
    );

    const nodes = await engine.traverseGraph('people/bob', 2);
    const bobNode = nodes.find(n => n.slug === 'people/bob');
    const edges = bobNode!.links.filter(l => l.to_slug === 'companies/widget');
    const types = edges.map(l => l.link_type).sort();
    expect(types).toEqual(['founded', 'works_at']);
  });
});
