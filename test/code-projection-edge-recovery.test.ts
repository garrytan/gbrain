import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot } from '../src/core/page-state/projections.ts';
import { resolveSymbolEdgesIncremental } from '../src/core/chunkers/symbol-resolver.ts';
import { resolveCodeReadiness } from '../src/core/code-graph-readiness.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
describe('code projection recovery preserves graph correctness', () => {
  const engines: BrainEngine[] = [];
  let closePostgres: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    if (backends.includes('pglite')) {
      const lite = new PGLiteEngine();
      await lite.connect({});
      await lite.initSchema();
      engines.push(lite);
    }
    if (backends.includes('postgres')) {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      engines.push(pg.engine);
      closePostgres = pg.close;
    }
  }, 120_000);

  afterAll(async () => {
    await engines.find(engine => engine.kind === 'pglite')?.disconnect();
    await closePostgres?.();
  }, 30_000);

  async function seed(engine: BrainEngine, sourceId: string) {
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
    const { slug } = await importCodeFile(engine, 'example.ts',
      'export function betaExample() { return 3; }\nexport function alphaExample() { return betaExample(); }\n',
      { sourceId, noEmbed: true });
    return slug;
  }

  async function rebuild(engine: BrainEngine, slug: string, sourceId: string) {
    const snapshot = (await readProjectionSnapshot(engine, slug, sourceId))!;
    const projection = await preparePageProjection(snapshot);
    await installPageProjection(engine, snapshot, projection.chunks, { seal: true, preserveEmbeddings: true, code: projection.code });
  }

  test('unchanged target chunks retain incoming edges owned by other pages', async () => {
    for (const engine of engines) {
      const sourceId = 'incoming-edge-example';
      const targetSlug = await seed(engine, sourceId);
      const caller = await importCodeFile(engine, 'caller.ts', 'export function callerExample() { return 1; }', { sourceId, noEmbed: true });
      const [from] = await engine.getChunks(caller.slug, { sourceId });
      const target = (await engine.getChunks(targetSlug, { sourceId })).find(chunk => chunk.symbol_name === 'betaExample')!;
      await engine.addCodeEdges([{ from_chunk_id: from.id, to_chunk_id: target.id,
        from_symbol_qualified: 'callerExample', to_symbol_qualified: 'betaExample', edge_type: 'calls', source_id: sourceId }]);
      await rebuild(engine, targetSlug, sourceId);
      const edges = await engine.getCallersOf('betaExample', { sourceId });
      expect(edges.some(edge => edge.from_chunk_id === from.id && edge.to_chunk_id === target.id)).toBe(true);
      expect((await engine.getChunks(targetSlug, { sourceId })).some(chunk => chunk.id === target.id)).toBe(true);
    }
  });

  test('replaced outgoing edges invalidate the backfill watermark and resolve again', async () => {
    for (const engine of engines) {
      const sourceId = 'edge-watermark-example';
      const slug = await seed(engine, sourceId);
      expect((await resolveSymbolEdgesIncremental(engine, { sourceId })).edges_resolved).toBe(1);
      await rebuild(engine, slug, sourceId);
      expect(await resolveCodeReadiness(engine, { sourceId, kind: 'edge', count: 0, remote: false })).toMatchObject({ status: 'indexing', ready: false });
      const next = await resolveSymbolEdgesIncremental(engine, { sourceId });
      expect(next.chunks_walked).toBeGreaterThan(0);
      expect(next.edges_resolved).toBe(1);
      expect(await resolveCodeReadiness(engine, { sourceId, kind: 'edge', count: 0, remote: false })).toMatchObject({ status: 'ready', ready: true });
    }
  });

  test('recursive operations do not reuse a traversal after its source is archived', async () => {
    for (const engine of engines) {
      const sourceId = 'walk-currency-example';
      await seed(engine, sourceId);
      const ctx = { engine, sourceId, remote: false } as OperationContext;
      for (const [name, params] of [
        ['code_flow', { entry_point: 'alphaExample' }],
        ['code_blast', { symbol: 'betaExample' }],
      ] as const) {
        await engine.executeRaw('UPDATE sources SET archived=false WHERE id=$1', [sourceId]);
        const first = await operationsByName[name].handler(ctx, { ...params, source_id: sourceId }) as any;
        expect(first.result).toBe('ok');
        expect(first.depth_groups[0].nodes.length).toBeGreaterThan(0);
        await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [sourceId]);
        const second = await operationsByName[name].handler(ctx, { ...params, source_id: sourceId }) as any;
        expect(second.result).toBe('not_found');
        expect(second.ready).toBe(false);
        expect(second.did_you_mean).toEqual([]);
      }
    }
  });
});
