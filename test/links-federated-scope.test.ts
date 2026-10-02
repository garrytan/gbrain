/**
 * #5827: unqualified graph reads must see the transport-computed federated set,
 * just like get_page/search, without exposing non-federated endpoints/origins.
 * Reverting the link scope resolver or traversal wiring makes these reads empty.
 * Existing grant/default-direction suites do not cover no-grant federation.
 * Uses real PGLite storage and operation handlers; no new production seam.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { localFederatedSourceIds } from '../src/core/source-resolver.ts';

let engine: PGLiteEngine;
let federated: string[] | undefined;

function ctx(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine, remote: true, config: {}, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    localFederatedSourceIds: federated,
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES
    ('business', 'Business', '{"federated":true}'::jsonb),
    ('personal', 'Personal', '{"federated":false}'::jsonb)`);
  // Empty default plus two non-default sources: the reported topology.
  for (const [slug, sourceId] of [
    ['notes/root', 'business'], ['notes/peer', 'business'],
    ['notes/foreign', 'personal'], ['notes/origin', 'personal'],
    ['notes/root', 'personal'], ['notes/peer', 'personal'],
  ]) {
    await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: slug }, { sourceId });
  }
  await engine.addLink('notes/root', 'notes/peer', 'visible', 'supports', 'manual', undefined, undefined,
    { fromSourceId: 'business', toSourceId: 'business' });
  await engine.addLink('notes/root', 'notes/foreign', 'foreign endpoint', 'supports', 'manual', undefined, undefined,
    { fromSourceId: 'business', toSourceId: 'personal' });
  await engine.addLink('notes/foreign', 'notes/root', 'foreign inbound', 'supports', 'manual', undefined, undefined,
    { fromSourceId: 'personal', toSourceId: 'business' });
  await engine.addLink('notes/root', 'notes/peer', 'foreign origin', 'supports', 'mentions', 'notes/origin', undefined,
    { fromSourceId: 'business', toSourceId: 'business', originSourceId: 'personal' });
  await engine.addLink('notes/root', 'notes/peer', 'isolated duplicate slugs', 'supports', 'manual', undefined, undefined,
    { fromSourceId: 'personal', toSourceId: 'personal' });
  federated = await localFederatedSourceIds(engine, 'default', 'seed_default');
  expect(federated).toEqual(['default', 'business']);
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
});

describe('no-grant graph federation (#5827)', () => {
  test('get_backlinks finds the federated referrer, not duplicate slugs in a non-federated source', async () => {
    const rows = await operationsByName.get_backlinks.handler(ctx(), { slug: 'notes/peer' });
    expect(rows).toEqual([
      expect.objectContaining({ from_slug: 'notes/root', from_source_id: 'business', context: 'visible' }),
      expect.objectContaining({ from_slug: 'notes/root', from_source_id: 'business', origin_slug: null }),
    ]);
  });

  test('traverse_graph follows federated edges without entering a non-federated source', async () => {
    const rows = await operationsByName.traverse_graph.handler(ctx(), { slug: 'notes/root', direction: 'out', depth: 2 });
    expect(rows).toEqual([expect.objectContaining({ from_slug: 'notes/root', to_slug: 'notes/peer', depth: 1 })]);
  });

  test('get_links reads federated edges while excluding foreign endpoints and redacting foreign origins', async () => {
    const rows = await operationsByName.get_links.handler(ctx(), { slug: 'notes/root' });
    expect(rows).toEqual([
      expect.objectContaining({ to_slug: 'notes/peer', context: 'visible' }),
      expect.objectContaining({ to_slug: 'notes/peer', context: 'foreign origin', origin_slug: null, origin_source_id: null }),
    ]);
  });

  test('inbound and default bidirectional traversal find the same federated edge', async () => {
    for (const direction of ['in', undefined]) {
      const rows = await operationsByName.traverse_graph.handler(ctx(), { slug: 'notes/peer', direction, depth: 1 });
      expect(rows).toEqual([expect.objectContaining({ from_slug: 'notes/root', to_slug: 'notes/peer', depth: 1 })]);
    }
  });

  test('trusted unqualified local traversal retains its node shape across federation', async () => {
    const rows = await operationsByName.traverse_graph.handler(ctx({ remote: false }), { slug: 'notes/root', depth: 2 }) as Array<{ slug: string }>;
    expect(rows.map(row => row.slug).sort()).toEqual(['notes/peer', 'notes/root']);
  });

  const reads = [
    ['get_links', { slug: 'notes/root' }],
    ['get_backlinks', { slug: 'notes/peer' }],
    ['traverse_graph', { slug: 'notes/root', direction: 'out', depth: 2 }],
  ] as const;
  for (const [name, params] of reads) {
    test(`${name} does not widen a missing transport set or an explicit empty/default grant`, async () => {
      for (const overrides of [
        { localFederatedSourceIds: undefined },
        { auth: { allowedSources: [] } },
        { auth: { allowedSources: ['default'] } },
      ]) {
        expect(await operationsByName[name].handler(ctx(overrides as Partial<OperationContext>), params)).toEqual([]);
      }
    });

    test(`${name} honors a real grant instead of widening to the transport set`, async () => {
      const rows = await operationsByName[name].handler(ctx({ auth: { allowedSources: ['personal'] } as OperationContext['auth'] }), params);
      expect(rows).toEqual([expect.objectContaining(name === 'traverse_graph'
        ? { from_slug: 'notes/root', to_slug: 'notes/peer' }
        : { context: 'isolated duplicate slugs', from_source_id: 'personal', to_source_id: 'personal' })]);
    });

    test(`${name} keeps an explicit scalar selection when the transport suppresses federation`, async () => {
      const rows = await operationsByName[name].handler(ctx({ sourceId: 'personal', localFederatedSourceIds: undefined }), params);
      expect(rows).toEqual([expect.objectContaining(name === 'traverse_graph'
        ? { from_slug: 'notes/root', to_slug: 'notes/peer' }
        : { context: 'isolated duplicate slugs' })]);
    });
  }
});
