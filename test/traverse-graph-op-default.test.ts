/**
 * #4666 — MCP traverse_graph defaults must not hide inbound-only edges.
 *
 * The engine's legacy GraphNode traversal is outgoing-only. That remains fine
 * for trusted local compatibility (`gbrain graph`), but the remote/default
 * operation call should surface explicit edges from both directions so an
 * inbound-only graph does not read as nodes=1/links=0 (indistinguishable
 * from edge absence). An explicit `direction` param still wins for callers
 * that want outbound-only.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  for (const t of ['content_chunks', 'links', 'tags', 'raw_data', 'timeline_entries', 'page_versions', 'ingest_log', 'pages']) {
    await (engine as any).db.exec(`DELETE FROM ${t}`);
  }
});

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    remote: true,
    config: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    dryRun: false,
    sourceId: 'default',
    ...overrides,
  } as unknown as OperationContext;
}

async function seedInboundOnlyTarget() {
  await engine.putPage('notes/evidence-a', {
    type: 'note',
    title: 'Evidence A',
    compiled_truth: 'supports the target',
    timeline: '',
    frontmatter: {},
  });
  await engine.putPage('knowledge/kcs/target', {
    type: 'concept',
    title: 'Target',
    compiled_truth: 'target page',
    timeline: '',
    frontmatter: {},
  });
  // Direct engine write: an inbound typed edge INTO the target.
  await engine.addLink(
    'notes/evidence-a',
    'knowledge/kcs/target',
    'evidence supports target',
    'supports',
    'manual',
  );
}

describe('#4666 traverse_graph operation defaults', () => {
  test('remote default returns inbound typed edges as explicit GraphPath rows', async () => {
    await seedInboundOnlyTarget();

    const result = await operationsByName.traverse_graph.handler(ctx(), {
      slug: 'knowledge/kcs/target',
      depth: 2,
    });

    expect(result).toContainEqual(expect.objectContaining({
      from_slug: 'notes/evidence-a',
      to_slug: 'knowledge/kcs/target',
      link_type: 'supports',
      depth: 1,
    }));
  });

  test('an explicit direction=out still wins for remote callers', async () => {
    await seedInboundOnlyTarget();

    const result = await operationsByName.traverse_graph.handler(ctx(), {
      slug: 'knowledge/kcs/target',
      depth: 2,
      direction: 'out',
    }) as Array<{ from_slug: string; to_slug: string }>;

    // The target has no OUTBOUND edges — an explicit outbound-only request
    // honestly returns nothing.
    expect(result).toEqual([]);
  });

  test('trusted local no-filter calls keep the legacy outgoing-node shape', async () => {
    await seedInboundOnlyTarget();

    const result = await operationsByName.traverse_graph.handler(ctx({ remote: false }), {
      slug: 'knowledge/kcs/target',
      depth: 2,
    }) as Array<{ slug: string; links: Array<{ to_slug: string }> }>;

    expect(result).toEqual([
      expect.objectContaining({
        slug: 'knowledge/kcs/target',
        links: [],
      }),
    ]);
  });
});

/**
 * Ship-review follow-up to #4666: the remote no-direction call is
 * bidirectional AND traversePaths' `both` branch is an uncapped
 * path-enumerating recursive CTE, so the legacy depth-5 default was
 * combinatorial on entity hubs. When BOTH direction and depth are defaulted
 * for a remote caller the walk stops at depth 2; an explicit depth is still
 * honored (up to the cap); and an omitted `remote` key is fail-closed remote.
 */
async function seedInboundChain() {
  // e3 → e2 → e1 → target: three inbound hops into the start node.
  for (const slug of ['knowledge/kcs/target', 'notes/e1', 'notes/e2', 'notes/e3']) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '', frontmatter: {} });
  }
  await engine.addLink('notes/e1', 'knowledge/kcs/target', '', 'supports', 'manual');
  await engine.addLink('notes/e2', 'notes/e1', '', 'supports', 'manual');
  await engine.addLink('notes/e3', 'notes/e2', '', 'supports', 'manual');
}

type Edge = { from_slug: string; to_slug: string; depth: number };

describe('remote traverse_graph default depth follows the bidirectional default', () => {
  test('remote no-filter default returns inbound edges at depth <= 2 only', async () => {
    await seedInboundChain();

    const result = await operationsByName.traverse_graph.handler(ctx(), {
      slug: 'knowledge/kcs/target',
    }) as Edge[];

    expect(result).toContainEqual(expect.objectContaining({
      from_slug: 'notes/e1', to_slug: 'knowledge/kcs/target', depth: 1,
    }));
    expect(result).toContainEqual(expect.objectContaining({
      from_slug: 'notes/e2', to_slug: 'notes/e1', depth: 2,
    }));
    // The depth-3 hop is beyond the conservative remote default.
    expect(result.some(e => e.from_slug === 'notes/e3')).toBe(false);
    expect(Math.max(...result.map(e => e.depth))).toBeLessThanOrEqual(2);
  });

  test('an explicit depth is honored past the remote default (depth 4 reaches the third hop)', async () => {
    await seedInboundChain();

    const result = await operationsByName.traverse_graph.handler(ctx(), {
      slug: 'knowledge/kcs/target',
      depth: 4,
    }) as Edge[];

    expect(result).toContainEqual(expect.objectContaining({
      from_slug: 'notes/e3', to_slug: 'notes/e2', depth: 3,
    }));
  });

  test('an omitted `remote` key is fail-closed remote: GraphPath[] with the inbound edge, depth <= 2', async () => {
    await seedInboundChain();

    const noRemoteKey = ctx();
    delete (noRemoteKey as { remote?: boolean }).remote;
    const result = await operationsByName.traverse_graph.handler(noRemoteKey, {
      slug: 'knowledge/kcs/target',
    }) as Edge[];

    // Edge shape (not the legacy GraphNode shape) …
    expect(result.length).toBeGreaterThan(0);
    expect(result.every(e => typeof e.from_slug === 'string' && typeof e.to_slug === 'string')).toBe(true);
    expect(result).toContainEqual(expect.objectContaining({
      from_slug: 'notes/e1', to_slug: 'knowledge/kcs/target', depth: 1,
    }));
    // … at the conservative bidirectional default depth.
    expect(result.some(e => e.from_slug === 'notes/e3')).toBe(false);
  });

  test('a trusted local no-filter call keeps the legacy depth-5 node walk', async () => {
    await seedInboundChain();
    // Outbound chain so the legacy outgoing-node walk has something to follow
    // past depth 2: target → o1 → o2 → o3.
    for (const slug of ['notes/o1', 'notes/o2', 'notes/o3']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug, timeline: '', frontmatter: {} });
    }
    await engine.addLink('knowledge/kcs/target', 'notes/o1', '', 'mentions', 'manual');
    await engine.addLink('notes/o1', 'notes/o2', '', 'mentions', 'manual');
    await engine.addLink('notes/o2', 'notes/o3', '', 'mentions', 'manual');

    const nodes = await operationsByName.traverse_graph.handler(ctx({ remote: false }), {
      slug: 'knowledge/kcs/target',
    }) as Array<{ slug: string }>;

    expect(nodes.map(n => n.slug)).toContain('notes/o3');
  });
});

/**
 * #4666/#4704 ship-review gap: the bidirectional default keys on the
 * DIRECTION being omitted, not on "no filter at all". A remote caller that
 * passes `link_type` (a per-edge filter) but no `direction` must still get
 * both directions at the conservative depth-2 default — pre-fix that call
 * took the legacy outgoing-only path and an inbound-only typed edge read as
 * absent.
 */
describe('remote link_type filter without direction keeps the bidirectional depth-2 default', () => {
  test('inbound-only `supports` edges come back as GraphPath rows at depth <= 2, other types filtered', async () => {
    await seedInboundChain();
    // An inbound edge of ANOTHER type: the link_type filter must still apply.
    await engine.putPage('notes/m1', { type: 'note', title: 'm1', compiled_truth: 'm1', timeline: '', frontmatter: {} });
    await engine.addLink('notes/m1', 'knowledge/kcs/target', '', 'mentions', 'manual');

    const result = await operationsByName.traverse_graph.handler(ctx(), {
      slug: 'knowledge/kcs/target',
      link_type: 'supports',
    }) as Array<Edge & { link_type: string }>;

    // Inbound rows are present (direction defaulted to 'both', not 'out')...
    expect(result).toContainEqual(expect.objectContaining({
      from_slug: 'notes/e1', to_slug: 'knowledge/kcs/target', link_type: 'supports', depth: 1,
    }));
    expect(result).toContainEqual(expect.objectContaining({
      from_slug: 'notes/e2', to_slug: 'notes/e1', link_type: 'supports', depth: 2,
    }));
    // ...at the remote bidirectional default depth (2), not the legacy 5...
    expect(result.some(e => e.from_slug === 'notes/e3')).toBe(false);
    expect(Math.max(...result.map(e => e.depth))).toBeLessThanOrEqual(2);
    // ...and the per-edge filter still excludes the `mentions` edge.
    expect(result.some(e => e.from_slug === 'notes/m1')).toBe(false);
    expect(result.every(e => e.link_type === 'supports')).toBe(true);
  });

  test('link_type + an explicit direction=out still honors the caller (no outbound `supports` edges → [])', async () => {
    await seedInboundChain();

    const result = await operationsByName.traverse_graph.handler(ctx(), {
      slug: 'knowledge/kcs/target',
      link_type: 'supports',
      direction: 'out',
    });

    expect(result).toEqual([]);
  });
});
