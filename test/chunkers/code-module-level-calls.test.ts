/**
 * #5001 — call edges inside top-level `describe` / `it` blocks (and every other top-level call statement) were dropped.
 *
 * Contract protected: a call site in a top-level expression statement (a vitest/jest/mocha `describe(...)`, an Express
 * `app.use(...)`, a Python `print(helper())`, an RSpec `RSpec.describe ... do` block) gets a `calls` edge whose
 * `from_symbol_qualified` is `<file-basename>::__module__`, from a chunk with `symbol_type = 'module'` and
 * `symbol_name = '__module__'`. Before the fix `TOP_LEVEL_TYPES` had no entry for those statements, no chunk covered
 * them, `findChunkForOffset` returned null and both edge writers skipped the edge: `code-callers helper` listed a
 * caller inside a named function and nothing from the test body that called it.
 *
 * Regression that fails it: dropping the module-statement entry for a language, emitting the chunk without the
 * file-qualified name, or merging a run of top-level statements into an anonymous `merged` chunk again.
 *
 * Why existing coverage misses it: `test/chunkers/code.test.ts` and `test/edge-extractor.test.ts` chunk definition-only
 * fixtures (every call site sits inside a named function or method), and this test also pins that their inventory is
 * unchanged: a definition-only file emits no `__module__` chunk.
 *
 * The `__module__` attribution follows the suggestion in the issue thread.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { CHUNKER_VERSION, chunkCodeTextFull, chunkerStamp, GRAMMAR_REVISIONS } from '../../src/core/chunkers/code.ts';
import { findChunkForOffset } from '../../src/core/chunkers/edge-extractor.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { grammarOnlyDrift } from '../../src/core/sync-cost-gate.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';

const tsSource = `import { describe, it, expect } from 'bun:test';
const boxByKey = (k: string) => ({ k });
export function helper(x: number) { return boxByKey(String(x)); }
describe('vat', () => {
  it('boxes', () => { expect(boxByKey('a')).toBeDefined(); helper(1); });
  it('again', () => { boxByKey('b'); });
});
const list = [1, 2].map(x => boxByKey(String(x)));
`;
const pySource = `import os
def helper(x):
    return x + 1
class Thing:
    def run(self):
        return helper(2)
print(helper(1))
`;
const rbSource = `require 'spec_helper'
def helper(x)
  x + 1
end
RSpec.describe Thing do
  it 'works' do
    expect(helper(1)).to eq(2)
  end
end
`;

/** Call edges attributed the way both edge writers do it: innermost chunk by line, dropped without a qualified name. */
async function callEdges(source: string, path: string) {
  const { chunks, edges } = await chunkCodeTextFull(source, path);
  const ranges = chunks.map(c => ({ startLine: c.metadata.startLine, endLine: c.metadata.endLine }));
  const attributed: Array<{ to: string; from: string | null }> = [];
  for (const edge of edges) {
    if (edge.edgeType !== 'calls') continue;
    const index = findChunkForOffset(edge.callSiteByteOffset, source, ranges);
    attributed.push({ to: edge.toSymbol, from: index === null ? null : chunks[index]!.metadata.symbolNameQualified ?? null });
  }
  return { chunks, attributed };
}

const moduleChunks = (chunks: Awaited<ReturnType<typeof chunkCodeTextFull>>['chunks']) =>
  chunks.filter(c => c.metadata.symbolType === 'module' && c.metadata.symbolName === '__module__');

describe('#5001 top-level call statements become __module__ chunks and keep their call edges', () => {
  test.each([['typescript', 'src/vat-review.test.ts'], ['tsx', 'src/vat-review.test.tsx']])(
    '%s: the describe block is one module chunk and its calls to helper/boxByKey are attributed to it',
    async (_language, path) => {
      const { chunks, attributed } = await callEdges(tsSource, path);
      const modules = moduleChunks(chunks);
      expect(modules).toHaveLength(1);
      expect(modules[0]!.metadata.startLine).toBe(4);
      expect(modules[0]!.metadata.endLine).toBe(7);
      expect(modules[0]!.metadata.symbolNameQualified).toBe('vat-review.test::__module__');
      expect(modules[0]!.text).toContain("it('again', () => { boxByKey('b'); });");
      // Before the fix: the two calls inside `it` bodies and the `helper(1)` call had no chunk (from === null).
      expect(attributed.filter(e => e.to === 'helper')).toEqual([{ to: 'helper', from: 'vat-review.test::__module__' }]);
      expect(attributed.filter(e => e.to === 'boxByKey').map(e => e.from).sort()).toEqual(
        ['helper', 'list', 'vat-review.test::__module__', 'vat-review.test::__module__'],
      );
      expect(attributed.some(e => e.from === null)).toBe(false);
      // The definition chunks are the same ones as before.
      expect(chunks.filter(c => c.metadata.symbolType !== 'module').map(c => c.metadata.symbolName)).toEqual(['boxByKey', 'helper', 'list']);
    },
  );

  test('python: a top-level print(helper(1)) is a module chunk; the method call stays attributed to Thing.run', async () => {
    const { chunks, attributed } = await callEdges(pySource, 'pkg/app.py');
    const modules = moduleChunks(chunks);
    expect(modules.map(c => [c.metadata.startLine, c.metadata.endLine, c.metadata.symbolNameQualified])).toEqual([[7, 7, 'app::__module__']]);
    expect(attributed.filter(e => e.to === 'helper').map(e => e.from).sort()).toEqual(['Thing.run', 'app::__module__']);
    expect(attributed.find(e => e.to === 'print')?.from).toBe('app::__module__');
  });

  test('ruby: the RSpec.describe block and the require line are module chunks', async () => {
    const { chunks, attributed } = await callEdges(rbSource, 'spec/thing_spec.rb');
    const modules = moduleChunks(chunks);
    expect(modules.map(c => [c.metadata.startLine, c.metadata.endLine])).toEqual([[1, 1], [5, 9]]);
    expect(modules.every(c => c.metadata.symbolNameQualified === 'thing_spec::__module__')).toBe(true);
    expect(attributed.find(e => e.to === 'helper')?.from).toBe('thing_spec::__module__');
    expect(attributed.find(e => e.to === 'require')?.from).toBe('thing_spec::__module__');
    expect(chunks.find(c => c.metadata.symbolName === 'helper')?.metadata.symbolType).toBe('function');
    // A Ruby `module` definition is `symbolType: 'module'` too; it keeps its own name and qualified identity.
    const { chunks: named } = await chunkCodeTextFull('module Billing\n  def self.run\n    helper(1)\n  end\nend\n', 'lib/billing.rb');
    expect(named.map(c => [c.metadata.symbolType, c.metadata.symbolName, c.metadata.symbolNameQualified])).toEqual([
      ['module', 'Billing', 'Billing'], ['function', 'run', 'Billing#run'],
    ]);
    expect(moduleChunks(named)).toHaveLength(0);
  });

  test('a top-level statement without a call is not a module chunk', async () => {
    const { chunks } = await chunkCodeTextFull('let counter = 0;\ncounter = 2;\ncounter += 1;\n`tagged`;\n', 'src/state.ts');
    expect(moduleChunks(chunks)).toHaveLength(0);
    const { chunks: py } = await chunkCodeTextFull('"""Module docstring."""\nx = 1\n', 'pkg/consts.py');
    expect(moduleChunks(py)).toHaveLength(0);
  });

  test('definition-only files keep their chunk inventory (no module chunk appears)', async () => {
    const ts = await chunkCodeTextFull('export function a() { return b(); }\nexport function b() { return 1; }\nexport class C { m() { return a(); } }\n', 'src/defs.ts');
    expect(ts.chunks.map(c => c.metadata.symbolType)).not.toContain('module');
    const py = await chunkCodeTextFull('import os\ndef a():\n    return b()\ndef b():\n    return 1\n', 'pkg/defs.py');
    expect(py.chunks.map(c => c.metadata.symbolType)).not.toContain('module');
    const go = await chunkCodeTextFull('package p\n\nfunc A() int { return B() }\nfunc B() int { return 1 }\n', 'p/defs.go');
    expect(go.chunks.map(c => c.metadata.symbolType)).not.toContain('module');
  });

  test('a run of small top-level call statements merges into one chunk that keeps the __module__ identity', async () => {
    const source = `import express from 'express';
const app = express();
app.use(cors());
app.use(json());
app.use(logger());
app.listen(3000);
export function shutdown() { return app.close(); }
`;
    const { chunks, attributed } = await callEdges(source, 'src/server.ts');
    const modules = moduleChunks(chunks);
    // The small `const app = express()` neighbour (a mergeable run type) folds into the run; a run never holds a named
    // definition (#4511), so module-level is the right identity for it and the `express` call keeps an edge.
    expect(modules).toHaveLength(1);
    expect(modules[0]!.metadata.startLine).toBe(2);
    expect(modules[0]!.metadata.endLine).toBe(6);
    expect(modules[0]!.metadata.symbolNameQualified).toBe('server::__module__');
    expect(modules[0]!.text).toContain('merged (5 siblings)');
    expect(chunks.some(c => c.metadata.symbolType === 'merged')).toBe(false);
    expect(attributed.filter(e => e.from === 'server::__module__').map(e => e.to).sort()).toEqual(['cors', 'express', 'json', 'listen', 'logger', 'use', 'use', 'use']);
    expect(chunks.find(c => c.metadata.symbolName === 'shutdown')?.metadata.symbolType).toBe('export statement');
  });

  test('an oversized describe block is split and every piece stays a file-qualified module chunk', async () => {
    const cases = Array.from({ length: 80 }, (_, i) => `  it('case ${i}', () => { expect(helper(${i})).toBe(${i + 1}); });`).join('\n');
    const source = `import { helper } from './helper.ts';\ndescribe('big', () => {\n${cases}\n});\n`;
    const { chunks } = await chunkCodeTextFull(source, 'src/big.test.ts', { maxChunkTokens: 300 });
    const modules = moduleChunks(chunks);
    expect(modules.length).toBeGreaterThan(1);
    expect(modules.every(c => c.metadata.symbolNameQualified === 'big.test::__module__')).toBe(true);
    expect(chunks.filter(c => c.metadata.symbolType !== 'module')).toHaveLength(0);
  });
});

describe('#5001 the five languages whose inventory grows re-chunk on their own, like the Lua grammar swap', () => {
  test('CHUNKER_VERSION is unchanged; typescript, tsx, javascript, python and ruby carry revision 1', () => {
    expect(CHUNKER_VERSION).toBe(8);
    for (const language of ['typescript', 'tsx', 'javascript', 'python', 'ruby'] as const) expect(GRAMMAR_REVISIONS[language]).toBe(1);
    expect(grammarOnlyDrift('8;lua=1', chunkerStamp())).toEqual(new Set(['typescript', 'tsx', 'javascript', 'python', 'ruby']));
  });
});

describe('#5001 importCodeFile persists the module-chunk edges (shared edge mapping)', () => {
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
    await resetPgliteState(engine);
  });

  test('code-callers helper lists the test body as vat-review.test::__module__', async () => {
    await importCodeFile(engine, 'src/vat-review.test.ts', tsSource, { noEmbed: true });
    const callers = await engine.getCallersOf('helper', { allSources: true });
    expect(callers.filter(c => c.from_symbol_qualified === 'vat-review.test::__module__').map(c => c.edge_type)).toEqual(['calls']);
    // Two call sites, one persisted row: code_edges_symbol is unique per (from_chunk_id, to_symbol_qualified, edge_type).
    const boxCallers = await engine.getCallersOf('boxByKey', { allSources: true });
    expect(boxCallers.map(c => c.from_symbol_qualified).sort()).toEqual(['helper', 'list', 'vat-review.test::__module__']);
    const rows = await engine.executeRaw<{ symbol_type: string | null; symbol_name: string | null; symbol_name_qualified: string | null }>(
      `SELECT symbol_type, symbol_name, symbol_name_qualified FROM content_chunks WHERE symbol_type = 'module'`,
    );
    expect(rows).toEqual([{ symbol_type: 'module', symbol_name: '__module__', symbol_name_qualified: 'vat-review.test::__module__' }]);
  });

  test('the shared mapper drops an edge whose chunk has no persisted id or qualified name', async () => {
    const { mapCodeEdges } = await import('../../src/core/code-chunks.ts');
    const source = 'a();\nb();\nc();\n';
    const edges = [
      { callSiteByteOffset: 0, toSymbol: 'a', edgeType: 'calls' as const },
      { callSiteByteOffset: 5, toSymbol: 'b', edgeType: 'calls' as const, memberCall: true as const },
      { callSiteByteOffset: 10, toSymbol: 'c', edgeType: 'calls' as const },
    ];
    const ranges = [
      { id: 1, startLine: 1, endLine: 1, symbol_name_qualified: 'f::__module__' },
      { id: 2, startLine: 2, endLine: 2, symbol_name_qualified: 'f::__module__' },
      { id: undefined, startLine: 3, endLine: 3, symbol_name_qualified: 'f::__module__' },
    ];
    expect(mapCodeEdges(edges, source, ranges, 'src1')).toEqual([
      { from_chunk_id: 1, to_chunk_id: null, from_symbol_qualified: 'f::__module__', to_symbol_qualified: 'a', edge_type: 'calls', source_id: 'src1' },
      { from_chunk_id: 2, to_chunk_id: null, from_symbol_qualified: 'f::__module__', to_symbol_qualified: 'b', edge_type: 'calls', source_id: 'src1', edge_metadata: { member_call: true } },
    ]);
    expect(mapCodeEdges(edges, source, [{ id: 1, startLine: 1, endLine: 3, symbol_name_qualified: null }], 'src1')).toEqual([]);
  });
});
