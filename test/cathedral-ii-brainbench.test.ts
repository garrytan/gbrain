/**
 * v0.20.0 Cathedral II Layer 11 (E1) — BrainBench code sub-categories.
 *
 * Pins the retrieval-quality metrics Layer 5 + Layer 6 should keep lifting:
 *   - call_graph_recall: given a chunk that calls foo(), do we surface
 *     that caller via getCallersOf('foo') after importCodeFile?
 *   - parent_scope_coverage: do nested-method chunks carry the expected
 *     parentSymbolPath after end-to-end importCodeFile?
 *
 * doc_comment_matching is deferred with A4 full extraction to v0.20.1.
 * The FTS trigger from Layer 1b weights doc_comment 'A' as soon as the
 * chunker populates it — the column exists; the value is blank today.
 *
 * These are unit-ish end-to-end tests against a fresh PGLite. They pin
 * the retrieval-side behavior that lifts MRR on symbol queries vs
 * v0.19.0's grep-class baseline.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importCodeFile } from '../src/core/import-file.ts';

describe('Cathedral II BrainBench — call_graph_recall', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Import two related files. A calls helper; B defines helper.
    // Layer 5 edge extraction should capture the calls edge from A's
    // body to 'helper'.
    await importCodeFile(
      engine,
      'src/a.ts',
      'export function runner() { return helper(); }\n',
      { noEmbed: true },
    );
    await importCodeFile(
      engine,
      'src/b.ts',
      'export function helper() { return 42; }\n',
      { noEmbed: true },
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('getCallersOf("helper") returns runner as a caller', async () => {
    const results = await engine.getCallersOf('helper', { allSources: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const fromRunner = results.find(r => r.from_symbol_qualified === 'runner');
    expect(fromRunner).toBeDefined();
    expect(fromRunner!.edge_type).toBe('calls');
  });

  test('getCalleesOf("runner") returns helper as a callee', async () => {
    const results = await engine.getCalleesOf('runner', { allSources: true });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const toHelper = results.find(r => r.to_symbol_qualified === 'helper');
    expect(toHelper).toBeDefined();
  });

  test('re-importing the same file is idempotent (no duplicate edges)', async () => {
    const before = await engine.getCallersOf('helper', { allSources: true });
    await importCodeFile(
      engine,
      'src/a.ts',
      'export function runner() { return helper(); }\n',
      { noEmbed: true, force: true },
    );
    const after = await engine.getCallersOf('helper', { allSources: true });
    // Per-chunk invalidation wipes then re-writes, so counts should match.
    expect(after.length).toBe(before.length);
  });
});

describe('Cathedral II BrainBench — parent_scope_coverage', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // A class with 2 methods. Layer 6 A3 should emit 3 chunks: the
    // class + each method. Each method chunk should carry the
    // parentSymbolPath [ClassName].
    await importCodeFile(
      engine,
      'src/brain.ts',
      `export class BrainEngine {
  searchKeyword(q: string) { return q; }
  searchVector(emb: Float32Array) { return emb; }
}
`,
      { noEmbed: true },
    );
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('nested method chunks persist parent_symbol_path', async () => {
    const chunks = await engine.getChunks('src-brain-ts');
    expect(chunks.length).toBeGreaterThanOrEqual(3);

    const method = chunks.find(c => c.symbol_name === 'searchKeyword');
    expect(method).toBeDefined();
    expect(method!.parent_symbol_path).toEqual(['BrainEngine']);

    const klass = chunks.find(c => c.symbol_name === 'BrainEngine');
    expect(klass).toBeDefined();
    // Class-level chunk: parent_symbol_path is null / empty (top-level).
    const klassPath = klass!.parent_symbol_path as string[] | null;
    expect(klassPath == null || klassPath.length === 0).toBe(true);
  });

  test('qualified symbol name resolves for nested methods', async () => {
    const chunks = await engine.getChunks('src-brain-ts');
    const method = chunks.find(c => c.symbol_name === 'searchKeyword');
    expect(method!.symbol_name_qualified).toBe('BrainEngine.searchKeyword');
  });

  test('getCallersOf("searchKeyword") matches the bare short name', async () => {
    // Add a caller that invokes searchKeyword so we can verify the
    // short-name match path (Layer 5's unresolved capture).
    await importCodeFile(
      engine,
      'src/caller.ts',
      `import { BrainEngine } from './brain';
function demo() {
  const e = new BrainEngine();
  return e.searchKeyword('hi');
}
`,
      { noEmbed: true },
    );
    const callers = await engine.getCallersOf('searchKeyword', { allSources: true });
    expect(callers.length).toBeGreaterThanOrEqual(1);
  });
});
