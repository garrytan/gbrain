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
