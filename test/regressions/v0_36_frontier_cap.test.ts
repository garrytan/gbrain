/**
 * T8 regression — BFS frontier cap on `traverseGraph`.
 *
 * Contracts pinned here (PGLite-only; Postgres parity is a follow-up E2E):
 *   1. Cap-unset: legacy `GraphNode[]` shape unchanged (back-compat).
 *   2. Cap-hit: result is bounded by the cap (frontier protection is the
 *      actually-useful contract; the cap can be tighter than expected
 *      because LIMIT applies before final DISTINCT, but it MUST NOT be
 *      looser — the result can never exceed the cap).
 *   3. MCP wire-shape: traverseGraph still returns an Array, NOT a struct.
 *      `traverse_graph` MCP op preserves the array wire contract.
 *   4. Concurrency: two concurrent calls on the same engine with different
 *      caps each see their own bounded result — no shared state.
 *
 * NOTE: `onTruncation` callback was designed but stripped in /review after
 * adversarial review caught false-positive + false-negative cases. See
 * TODOS.md → "T8 truncation signal" for the deferred work. This file's
 * contracts cover what's IN the shipped code; the truncation-signal
 * contracts re-land when the dedupe-then-cap SQL rewrite ships.
 *
 * PGLite-only — no DATABASE_URL needed. Hermetic.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await (engine as { db: { exec: (sql: string) => Promise<unknown> } }).db.exec(`
    TRUNCATE pages, links, content_chunks, raw_data RESTART IDENTITY CASCADE;
  `);
});

async function putPage(slug: string, title = slug) {
  await engine.putPage(slug, {
    type: 'note',
    title,
    compiled_truth: `Body of ${slug}`,
    timeline: '',
    frontmatter: {},
  });
}

async function getPageId(slug: string): Promise<number> {
  const rows = await engine.executeRaw('SELECT id FROM pages WHERE slug = $1', [slug]);
  return (rows[0] as { id: number }).id;
}

async function link(from: string, to: string) {
  const fromId = await getPageId(from);
  const toId = await getPageId(to);
  await engine.executeRaw(
    'INSERT INTO links (from_page_id, to_page_id, link_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [fromId, toId, 'references'],
  );
}

/** Build a hub-and-spokes topology: 'hub' links to N children. */
async function buildHubTopology(N: number) {
  await putPage('hub');
  for (let i = 0; i < N; i += 1) {
    const slug = `child-${String(i).padStart(3, '0')}`;
    await putPage(slug);
    await link('hub', slug);
  }
}

describe('T8: traverseGraph frontier cap (PGLite)', () => {
  test('Contract 1: cap-unset returns legacy shape', async () => {
    await buildHubTopology(10);
    const result = await engine.traverseGraph('hub', 2);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(11); // hub + 10 children
    for (const node of result) {
      expect(typeof node.slug).toBe('string');
      expect(typeof node.title).toBe('string');
      expect(typeof node.type).toBe('string');
      expect(typeof node.depth).toBe('number');
      expect(Array.isArray(node.links)).toBe(true);
    }
  }, 30000);

  test('Contract 2: cap bounds the result to <= cap + 1 (hub + capped children)', async () => {
    await buildHubTopology(20); // 20 children at depth 1
    const result = await engine.traverseGraph('hub', 2, { frontierCap: 5 });
    expect(Array.isArray(result)).toBe(true);
    // hub + up to cap children. The recursive LIMIT applies BEFORE outer
    // DISTINCT, so the visible count can be LESS than cap on diamond graphs.
    // Invariant: count NEVER exceeds cap + 1 (hub + cap). That's the actual
    // protection the cap provides — a hard upper bound on traversal output.
    expect(result.length).toBeLessThanOrEqual(6);
    expect(result.length).toBeGreaterThan(0);
    const slugs = result.map(n => n.slug);
    expect(slugs).toContain('hub');
  }, 30000);

  test('Contract 3: MCP wire-shape preserved — Array, not struct', async () => {
    await buildHubTopology(5);
    const result = await engine.traverseGraph('hub', 1);
    expect(Array.isArray(result)).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Array.prototype);
    // Negative regression — no struct fields leaked in (would break MCP wire):
    expect((result as unknown as { truncated?: unknown }).truncated).toBeUndefined();
    expect((result as unknown as { nodes?: unknown }).nodes).toBeUndefined();
  }, 30000);

  test('Contract 4: concurrent calls on same engine see independent bounded results', async () => {
    await buildHubTopology(30);
    // Two concurrent calls with different caps. Each must see its own bound.
    // If the implementation accidentally introduced shared per-engine state
    // for the cap, one call's cap could bleed into the other.
    const [a, b] = await Promise.all([
      engine.traverseGraph('hub', 1, { frontierCap: 5 }),
      engine.traverseGraph('hub', 1, { frontierCap: 10 }),
    ]);
    expect(a.length).toBeLessThanOrEqual(6);
    expect(b.length).toBeLessThanOrEqual(11);
    // Larger cap should see at least as many nodes as the smaller. PGLite is
    // deterministic enough that this invariant holds; Postgres parity is a
    // follow-up E2E (real CTE may reorder differently between iterations).
    expect(b.length).toBeGreaterThanOrEqual(a.length);
  }, 30000);
});
