/**
 * gbrain-evals N13-2 / N13-3, on every backend (PGLite always; Postgres
 * when a safe DATABASE_URL is set, and in the E2E lane through
 * test/e2e/code-intel-n13-postgres.test.ts).
 *
 * N13-2: the within-file resolver stamps edge_metadata.resolved_chunk_id
 * on a code_edges_symbol row, but getCallersOf / getCalleesOf /
 * getEdgesByChunk reported resolved: false because the flag came only from
 * the table the row lived in.
 *
 * N13-3: code_blast refused a Python function as unsupported_language when
 * a Go function shared its bare name — the language gate read one
 * arbitrary chunk carrying the qualified name.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { resolveSymbolEdgesIncremental } from '../../src/core/chunkers/symbol-resolver.ts';
import { runRecursiveWalk } from '../../src/core/code-intel/recursive-walk.ts';
import { handleToolCall } from '../../src/mcp/server.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

for (const kind of testBackends()) {
  describe(`code-intel edge resolution and language gate (${kind})`, () => {
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
    afterAll(async () => {
      await close?.();
    });
    beforeEach(async () => {
      await engine.executeRaw(`DELETE FROM pages WHERE slug LIKE 'src/%' OR slug LIKE 'gate/%'`);
    });

    test('N13-2: an edge the resolver resolved reports resolved: true on every read', async () => {
      await importCodeFile(engine, 'src/sample.ts',
        'export function helper(): number {\n  return 1;\n}\n\nexport function caller(): number {\n  return helper() + 1;\n}\n',
        { noEmbed: true });
      const stats = await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      expect(stats.edges_resolved).toBeGreaterThanOrEqual(1);

      const callers = await engine.getCallersOf('helper', { sourceId: 'default' });
      const edge = callers.find((e) => e.from_symbol_qualified === 'caller');
      expect(edge?.edge_metadata.resolved_chunk_id).toEqual(expect.any(Number));
      expect(edge?.resolved).toBe(true);

      const callees = await engine.getCalleesOf('caller', { sourceId: 'default' });
      expect(callees.find((e) => e.to_symbol_qualified === 'helper')?.resolved).toBe(true);

      const byChunk = await engine.getEdgesByChunk(edge!.from_chunk_id, { direction: 'out' });
      expect(byChunk.find((e) => e.to_symbol_qualified === 'helper')?.resolved).toBe(true);

      const op: any = await handleToolCall(engine, 'code_callers', { symbol: 'helper' });
      const opEdge = op.callers.find((e: any) => e.from_symbol_qualified === 'caller');
      expect(opEdge.resolved).toBe(true);
    });

    test('N13-2 control: an edge the resolver left unresolved stays resolved: false', async () => {
      await importCodeFile(engine, 'src/lonely.ts',
        'export function lonely(): number {\n  return missingThing() + 1;\n}\n', { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });
      const callees = await engine.getCalleesOf('lonely', { sourceId: 'default' });
      const edge = callees.find((e) => e.to_symbol_qualified === 'missingThing');
      expect(edge).toBeDefined();
      expect(edge?.resolved).toBe(false);
    });

    test('N13-3: a Python function sharing a Go function name walks; Go callers stay out', async () => {
      await importCodeFile(engine, 'gate/shared.go',
        'package main\n\nfunc shared_helper() int {\n\treturn 2\n}\n\nfunc go_user() int {\n\treturn shared_helper()\n}\n',
        { noEmbed: true });
      await importCodeFile(engine, 'gate/shared.py',
        'def shared_helper():\n    return 2\n\n\ndef py_user():\n    return shared_helper()\n', { noEmbed: true });
      await resolveSymbolEdgesIncremental(engine, { sourceId: 'default' });

      const r = await runRecursiveWalk(engine, 'shared_helper', { direction: 'callers', sourceId: 'default' });
      expect(r.result).toBe('ok');
      if (r.result !== 'ok') return;
      const symbols = r.depth_groups.flatMap((g) => g.nodes.map((n) => n.symbol));
      expect(symbols).toContain('py_user');
      expect(symbols).not.toContain('go_user');

      const op: any = await handleToolCall(engine, 'code_blast', { symbol: 'shared_helper' });
      expect(op.result).not.toBe('unsupported_language');
    });

    test('N13-3 control: a Go-only function is still unsupported_language', async () => {
      await importCodeFile(engine, 'gate/only.go',
        'package main\n\nfunc go_only() int {\n\treturn 3\n}\n\nfunc go_only_user() int {\n\treturn go_only()\n}\n',
        { noEmbed: true });
      const r = await runRecursiveWalk(engine, 'go_only', { direction: 'callers', sourceId: 'default' });
      expect(r.result).toBe('unsupported_language');
    });
  });
}
