/**
 * #7080: on an Elixir source, code-def, code-callers and code-callees returned nothing. tree-sitter-elixir parses every
 * construct as a `call`, so each top-level `defmodule Foo.Bar do … end` became one chunk named after its macro
 * (`defmodule`), typed `call` (not a definition type, so code-def filtered it out), with no per-function chunks and
 * no call edges. Now modules and def/defp/defmacro/defguard/defdelegate functions get named, qualified chunks
 * (`Foo.Bar.helper`), other top-level calls are module-level code, and real invocations become call edges.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { chunkCodeTextFull, chunkerStamp, GRAMMAR_REVISIONS } from '../../src/core/chunkers/code.ts';
import { grammarOnlyDrift } from '../../src/core/sync-cost-gate.ts';
import { findCodeDef } from '../../src/commands/code-def.ts';

const SOURCE = `defmodule AcmeExample.Accounts do
  @moduledoc "Accounts."
  alias AcmeExample.Repo
  use AcmeExample.Schema

  def register(attrs, opts) when is_map(attrs) do
    attrs |> normalize() |> Repo.insert()
    Enum.map(opts, fn o -> audit(o) end)
  end

  defp normalize(attrs), do: attrs
  def audit(entry), do: entry
  def ready?, do: true
  defdelegate fetch(id), to: AcmeExample.Repo

  defmodule Admin do
    def promote(user), do: AcmeExample.Accounts.normalize(user.role)
  end
end

defimpl String.Chars, for: AcmeExample.Accounts do
  def to_string(account), do: account.name
end

config :acme_example, key: compute_example()
`;

const PATH = 'lib/acme_example/accounts.ex';

describe('#7080 Elixir chunks', () => {
  test('modules and functions are named, typed and qualified definitions', async () => {
    const { chunks } = await chunkCodeTextFull(SOURCE, PATH);
    const symbols = chunks.map(c => [c.metadata.symbolName, c.metadata.symbolType, c.metadata.symbolNameQualified]);
    expect(symbols).toEqual(expect.arrayContaining([
      ['AcmeExample.Accounts', 'module', 'AcmeExample.Accounts'],
      ['register', 'function', 'AcmeExample.Accounts.register'],
      ['normalize', 'function', 'AcmeExample.Accounts.normalize'],
      ['audit', 'function', 'AcmeExample.Accounts.audit'],
      ['ready?', 'function', 'AcmeExample.Accounts.ready?'],
      ['fetch', 'function', 'AcmeExample.Accounts.fetch'],
      ['Admin', 'module', 'AcmeExample.Accounts.Admin'],
      ['promote', 'function', 'AcmeExample.Accounts.Admin.promote'],
      ['String.Chars.AcmeExample.Accounts', 'module', 'String.Chars.AcmeExample.Accounts'],
      ['to_string', 'function', 'String.Chars.AcmeExample.Accounts.to_string'],
      ['__module__', 'module', 'accounts::__module__'],
    ]));
    expect(chunks.some(c => c.metadata.symbolName === 'defmodule' || c.metadata.symbolType === 'call')).toBe(false);
  });

  test('the module chunk keeps its non-definition text and does not repeat function bodies', async () => {
    const { chunks } = await chunkCodeTextFull(SOURCE, PATH);
    const module = chunks.find(c => c.metadata.symbolName === 'AcmeExample.Accounts')!;
    expect(module.text).toContain('alias AcmeExample.Repo');
    expect(module.text).toContain('use AcmeExample.Schema');
    expect(module.text).not.toContain('Enum.map(opts');
    expect(chunks.filter(c => c.text.includes('Enum.map(opts'))).toHaveLength(1);
  });

  test('call edges are real invocations, not definition macros, heads, directives, attributes or field reads', async () => {
    const { edges } = await chunkCodeTextFull(SOURCE, PATH);
    const calls = edges.filter(e => e.edgeType === 'calls').map(e => e.toSymbol);
    expect(calls).toEqual(expect.arrayContaining(['normalize', 'insert', 'map', 'audit', 'is_map', 'config', 'compute_example']));
    for (const notACall of ['defmodule', 'def', 'defp', 'defdelegate', 'defimpl', 'alias', 'use', 'moduledoc', 'register', 'role', 'name']) {
      expect(calls).not.toContain(notACall);
    }
  });

  test('elixir carries its own grammar revision, so only Elixir files re-chunk', () => {
    expect(GRAMMAR_REVISIONS.elixir).toBe(1);
    expect(grammarOnlyDrift('8;lua=1;typescript=2;tsx=2;javascript=2;python=2;ruby=2', chunkerStamp())).toEqual(new Set(['elixir']));
  });
});

describe('#7080 code-def and callers on an imported Elixir file', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await importCodeFile(engine, PATH, SOURCE, { noEmbed: true });
  }, 60_000);

  afterAll(async () => { await engine.disconnect(); });

  test('code-def finds a module and a function', async () => {
    expect((await findCodeDef(engine, 'AcmeExample.Accounts', { allSources: true })).map(r => r.symbol_type)).toEqual(['module']);
    const normalize = await findCodeDef(engine, 'normalize', { allSources: true });
    expect(normalize.map(r => [r.symbol_type, r.start_line])).toEqual([['function', 11]]);
  });

  test('code-callers lists the functions that call a def', async () => {
    const callers = (await engine.getCallersOf('normalize', { allSources: true })).map(e => e.from_symbol_qualified).sort();
    expect(callers).toEqual(['AcmeExample.Accounts.Admin.promote', 'AcmeExample.Accounts.register']);
  });
});
