/**
 * #5439 item 3 (wave 15 P7.8): the recursive walk (code_blast / code_flow)
 * follows the symbol resolver's outcome instead of re-matching bare names.
 *
 * Two files each define a top-level `helper` (qualified name `helper` in
 * both — chunkers/qualified-names.ts gives a top-level function its bare
 * name). The resolver stamps each in-file call with resolved_chunk_id.
 * Before: the walk stepped by `to_symbol_qualified`, so a_caller → helper
 * fanned into BOTH helpers' callees at hop 2, and every node was labelled
 * with the edge's from_chunk_id even on a callee hop.
 * After: a resolved edge steps to that chunk (source-scoped chunk identity
 * keys the frontier/visited set), the next hop reads edges by that chunk,
 * and node chunk ids are directional (callee hop: the callee's chunk;
 * caller hop: the caller's chunk). Names remain the key for unresolved edges.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../../src/core/chunkers/symbol-resolver.ts';
import { runRecursiveWalk } from '../../src/core/code-intel/recursive-walk.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const A = 'export function a_leaf(): number {\n  return 1;\n}\n\n'
  + 'export function helper(): number {\n  return a_leaf() + 1;\n}\n\n'
  + 'export function a_caller(): number {\n  return helper() + 1;\n}\n';
const B = 'export function b_leaf(): number {\n  return 2;\n}\n\n'
  + 'export function helper(): number {\n  return b_leaf() + 2;\n}\n\n'
  + 'export function b_caller(): number {\n  return helper() + 2;\n}\n';

for (const kind of testBackends()) {
  describe(`recursive walk follows resolved chunk identity (${kind}, #5439)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
        close = () => pglite.disconnect();
      }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'twins-%'`);
      await importCodeFile(engine, 'twins/a.ts', A, { noEmbed: true });
      await importCodeFile(engine, 'twins/b.ts', B, { noEmbed: true });
      const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      expect(stats.edges_resolved).toBeGreaterThanOrEqual(4);
    });

    // importCodeFile slugifies the path: twins/a.ts is stored as twins-a-ts.
    const chunkIdOf = async (slug: string, symbol: string): Promise<number> => {
      const rows = await engine.executeRaw<{ id: number }>(
        `SELECT c.id FROM content_chunks c JOIN pages p ON p.id = c.page_id WHERE p.slug = $1 AND c.symbol_name = $2`,
        [slug, symbol],
      );
      expect(rows).toHaveLength(1);
      return Number(rows[0]!.id);
    };
    const groups = (r: Awaited<ReturnType<typeof runRecursiveWalk>>) => {
      expect(r.result).toBe('ok');
      if (r.result !== 'ok') throw new Error('unreachable');
      return r.depth_groups;
    };

    test('code_flow from a_caller: hop 1 is the same-file helper chunk, hop 2 only its callee', async () => {
      const aHelper = await chunkIdOf('twins-a-ts', 'helper');
      const aLeaf = await chunkIdOf('twins-a-ts', 'a_leaf');
      const g = groups(await runRecursiveWalk(engine, 'a_caller', { direction: 'callees', sourceId: 'default', depth: 3 }));
      expect(g.map((x) => x.depth)).toEqual([1, 2]);
      // The `number` return type is a `references` edge the walk has always
      // followed; it is unresolved, so it stays a name node without a chunk id.
      expect(g[0]!.nodes.map((n) => n.symbol).sort()).toEqual(['helper', 'number']);
      expect(g[0]!.nodes.find((n) => n.symbol === 'helper')).toEqual({ symbol: 'helper', chunk_id: aHelper });
      expect(g[0]!.nodes.find((n) => n.symbol === 'number')).toEqual({ symbol: 'number' });
      expect(g[1]!.nodes).toEqual([{ symbol: 'a_leaf', chunk_id: aLeaf }]);
    });

    test('code_flow from b_caller mirrors it: never a_leaf', async () => {
      const bHelper = await chunkIdOf('twins-b-ts', 'helper');
      const g = groups(await runRecursiveWalk(engine, 'b_caller', { direction: 'callees', sourceId: 'default', depth: 3 }));
      expect(g[0]!.nodes.find((n) => n.symbol === 'helper')).toEqual({ symbol: 'helper', chunk_id: bHelper });
      expect(g[1]!.nodes.map((n) => n.symbol)).toEqual(['b_leaf']);
    });

    test('code_blast from a_leaf: hop 1 is the same-file helper chunk, hop 2 only a_caller', async () => {
      const aHelper = await chunkIdOf('twins-a-ts', 'helper');
      const aCaller = await chunkIdOf('twins-a-ts', 'a_caller');
      const g = groups(await runRecursiveWalk(engine, 'a_leaf', { direction: 'callers', sourceId: 'default', depth: 3 }));
      expect(g.map((x) => x.depth)).toEqual([1, 2]);
      expect(g[0]!.nodes).toEqual([{ symbol: 'helper', chunk_id: aHelper }]);
      expect(g[1]!.nodes).toEqual([{ symbol: 'a_caller', chunk_id: aCaller }]);
    });

    test('code_blast from b_leaf mirrors it: never a_caller', async () => {
      const g = groups(await runRecursiveWalk(engine, 'b_leaf', { direction: 'callers', sourceId: 'default', depth: 3 }));
      expect(g[1]!.nodes.map((n) => n.symbol)).toEqual(['b_caller']);
    });

    test('starting at the shared name itself still reaches both files (the start is a name, not a chunk)', async () => {
      const g = groups(await runRecursiveWalk(engine, 'helper', { direction: 'callers', sourceId: 'default', depth: 1 }));
      expect(g[0]!.nodes.map((n) => n.symbol).sort()).toEqual(['a_caller', 'b_caller']);
    });

    test('an unresolved callee stays a name hop and carries no chunk id', async () => {
      await importCodeFile(engine, 'twins/c.ts',
        'export function c_caller(): number {\n  return missingThing() + 1;\n}\n', { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      const g = groups(await runRecursiveWalk(engine, 'c_caller', { direction: 'callees', sourceId: 'default' }));
      expect(g[0]!.nodes.find((n) => n.symbol === 'missingThing')).toEqual({ symbol: 'missingThing' });
    });

    test('the chunk-identity reads are source-scoped: another source sees no edges for the same chunk id', async () => {
      const aHelper = await chunkIdOf('twins-a-ts', 'helper');
      expect((await engine.getCallersOf('helper', { sourceId: 'default', chunkId: aHelper })).map((e) => e.from_symbol_qualified)).toEqual(['a_caller']);
      expect((await engine.getCalleesOf('helper', { sourceId: 'default', chunkId: aHelper })).map((e) => e.to_symbol_qualified).sort()).toEqual(['a_leaf', 'number']);
      expect(await engine.getCallersOf('helper', { sourceId: 'elsewhere', chunkId: aHelper })).toHaveLength(0);
      expect(await engine.getCalleesOf('helper', { sourceId: 'elsewhere', chunkId: aHelper })).toHaveLength(0);
    });
  });
}
