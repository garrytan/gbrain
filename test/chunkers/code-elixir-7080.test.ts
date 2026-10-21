import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { importCodeFile } from '../../src/core/import-file.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { findCodeDef } from '../../src/commands/code-def.ts';
import { chunkCodeTextFull, chunkerStamp, GRAMMAR_REVISIONS } from '../../src/core/chunkers/code.ts';
import { DEF_TYPES } from '../../src/core/chunkers/def-types.ts';
import { findChunkForOffset } from '../../src/core/chunkers/edge-extractor.ts';
import { grammarOnlyDrift } from '../../src/core/sync-cost-gate.ts';

const source = `defmodule Foo.Bar do
  def run(x) when is_integer(x), do: helper(x)
  defp helper(x), do: Other.work!(x)
  def ready?, do: true
  defmacro wrap(x), do: build(x)
  defmacrop hidden(x), do: build(x)
  defguard valid?(x) when is_integer(x)
  defguardp private?(x) when is_atom(x)
  defdelegate fetch(x), to: Repo
  defmodule Nested do
    def go, do: helper(1)
  end
end
config :example, enabled: boot()
`;

describe('#7080 Elixir macro ASTs carry real definition identities', () => {
  test('default arguments, multiline bodies and module context survive without signature self-call edges', async () => {
    const text = 'defmodule Sample do\n  @moduledoc "Example documentation"\n  alias Other.Service\n  register()\n  def run(x \\\\ seed()) do\n    ready?(x)\n  end\nend\n';
    const { chunks, edges } = await chunkCodeTextFull(text, 'sample.exs');
    expect(chunks[0]!.text).toContain('@moduledoc "Example documentation"');
    expect(chunks[0]!.text).toContain('alias Other.Service');
    expect(chunks[0]!.text).toContain('register()');
    expect(chunks[1]!.metadata.symbolNameQualified).toBe('Sample.run');
    expect(chunks[1]!.text).toContain('ready?(x)');
    expect(edges.map(e => e.toSymbol).sort()).toEqual(['ready?', 'register', 'seed']);
  });
  test('modules, guarded heads, private defs, macros, guards, delegates and nested modules are discoverable definitions', async () => {
    const { chunks } = await chunkCodeTextFull(source, 'lib/example.ex');
    const defs = chunks.filter(c => c.metadata.symbolName !== '__module__');
    expect(defs.map(c => c.metadata.symbolNameQualified)).toEqual([
      'Foo.Bar', 'Foo.Bar.run', 'Foo.Bar.helper', 'Foo.Bar.ready?', 'Foo.Bar.wrap',
      'Foo.Bar.hidden', 'Foo.Bar.valid?', 'Foo.Bar.private?', 'Foo.Bar.fetch',
      'Foo.Bar.Nested', 'Foo.Bar.Nested.go',
    ]);
    expect(defs.every(c => DEF_TYPES.includes(c.metadata.symbolType))).toBe(true);
    expect(defs.find(c => c.metadata.symbolName === 'go')?.metadata.parentSymbolPath).toEqual(['Foo.Bar', 'Nested']);
    expect(defs.find(c => c.metadata.symbolName === 'run')?.text).toContain('when is_integer(x)');
    expect(defs.find(c => c.metadata.symbolName === 'helper')?.text).toContain('Other.work!(x)');
    expect(chunks.find(c => c.metadata.symbolName === '__module__')?.metadata.symbolNameQualified).toBe('example::__module__');
    expect(chunks.some(c => ['defmodule', 'def', 'defp', 'config'].includes(c.metadata.symbolName ?? ''))).toBe(false);
  });

  test('real call edges belong to their function or module, never declaration heads', async () => {
    const { chunks, edges } = await chunkCodeTextFull(source, 'lib/example.ex');
    const ranges = chunks.map(c => ({ startLine: c.metadata.startLine, endLine: c.metadata.endLine }));
    const attributed = edges.map(e => {
      const i = findChunkForOffset(e.callSiteByteOffset, source, ranges);
      return [e.toSymbol, i === null ? null : chunks[i]!.metadata.symbolNameQualified, e.memberCall === true];
    });
    expect(attributed).toContainEqual(['helper', 'Foo.Bar.run', false]);
    expect(attributed).toContainEqual(['work!', 'Foo.Bar.helper', true]);
    expect(attributed).toContainEqual(['helper', 'Foo.Bar.Nested.go', false]);
    expect(attributed).toContainEqual(['boot', 'example::__module__', false]);
    expect(attributed).toContainEqual(['is_integer', 'Foo.Bar.run', false]);
    expect(attributed.some(([to]) => ['defmodule', 'def', 'defp', 'defmacro', 'defguard', 'defdelegate', 'run', 'fetch', 'valid?'].includes(String(to)))).toBe(false);
    expect(attributed.every(([, from]) => from !== null)).toBe(true);
  });

  test('protocol and implementation modules retain names, without inventing a macro-name definition', async () => {
    const { chunks } = await chunkCodeTextFull(`defprotocol Renderable do\n  def render(value)\nend\ndefimpl Renderable, for: Widget do\n  def render(value), do: output(value)\nend\n`, 'render.ex');
    expect(chunks.map(c => [c.metadata.symbolType, c.metadata.symbolName])).toEqual([
      ['module', 'Renderable'], ['function', 'render'], ['module', 'Renderable'], ['function', 'render'],
    ]);
  });

  test('only Elixir code hashes are invalidated by this repair', () => {
    expect(GRAMMAR_REVISIONS.elixir).toBe(1);
    const current = chunkerStamp();
    const previous = current.split(';').filter(s => !s.startsWith('elixir=')).join(';');
    expect(grammarOnlyDrift(previous, current)).toEqual(new Set(['elixir']));
  });
});

describe('#7080 real Elixir import and stored code lookup', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await importCodeFile(engine, 'lib/example.ex', source, { noEmbed: true });
  });
  afterAll(async () => { await engine.disconnect(); });

  test('code-def finds the module and individual functions at their real lines', async () => {
    expect((await findCodeDef(engine, 'Foo.Bar', { allSources: true })).map(r => [r.language, r.symbol_type, r.start_line])).toEqual([['elixir', 'module', 1]]);
    expect((await findCodeDef(engine, 'helper', { allSources: true })).map(r => [r.symbol_type, r.start_line])).toEqual([['function', 3]]);
    expect((await findCodeDef(engine, 'ready?', { allSources: true }))).toHaveLength(1);
    expect((await findCodeDef(engine, 'defmodule', { allSources: true }))).toEqual([]);
  });

  test('callers and callees survive shared edge persistence with scoped function identities', async () => {
    expect((await engine.getCallersOf('helper', { allSources: true })).map(r => r.from_symbol_qualified).sort()).toEqual(['Foo.Bar.Nested.go', 'Foo.Bar.run']);
    expect((await engine.getCalleesOf('Foo.Bar.run', { allSources: true })).map(r => r.to_symbol_qualified).sort()).toEqual(['helper', 'is_integer']);
    expect((await engine.getCallersOf('boot', { allSources: true })).map(r => r.from_symbol_qualified)).toEqual(['example::__module__']);
    expect(await engine.getCallersOf('run', { allSources: true })).toEqual([]);
  });
});
