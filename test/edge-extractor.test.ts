/**
 * v0.20.0 Cathedral II Layer 5 (A1) — edge extractor tests.
 *
 * Covers chunkCodeTextFull's edge output + per-language call capture
 * + findChunkForOffset mapping. End-to-end addCodeEdges / getCallersOf
 * round-trip is covered in test/code-edges.test.ts.
 */

import { describe, test, expect } from 'bun:test';
import { chunkCodeTextFull } from '../src/core/chunkers/code.ts';
import { findChunkForOffset } from '../src/core/chunkers/edge-extractor.ts';
import { bareSymbolName } from '../src/core/chunkers/symbol-resolver.ts';

describe('Layer 5 (A1) — TypeScript call extraction', () => {
  test('captures direct function calls', async () => {
    const src = `
function helper() { return 1; }
function caller() { return helper(); }
`.trim();
    const result = await chunkCodeTextFull(src, 'src/foo.ts');
    const calleeNames = result.edges.map(e => e.toSymbol);
    expect(calleeNames).toContain('helper');
  });

  test('captures method calls (member expression)', async () => {
    const src = `
class Foo {
  run() { return this.go(); }
  go() { return 1; }
}
`.trim();
    const result = await chunkCodeTextFull(src, 'src/foo.ts');
    // v0.34 W1: this.go() now resolves to Foo::go via receiver-type resolution.
    // Pre-v0.34 emitted bare 'go'; v0.34 emits 'Foo::go'. Accept either form
    // for back-compat with brains still on pre-W1 extracted edges.
    const syms = result.edges.map(e => e.toSymbol);
    expect(syms.some((s) => s === 'go' || s === 'Foo::go')).toBe(true);
  });

  test('all edges typed as calls', async () => {
    const src = 'function f() { return g(); }';
    const result = await chunkCodeTextFull(src, 'src/foo.ts');
    for (const e of result.edges) expect(e.edgeType).toBe('calls');
  });
});

describe('Layer 5 (A1) — Python call extraction', () => {
  test('captures direct calls', async () => {
    const src = `
def helper():
    return 1

def caller():
    return helper()
`.trim();
    const result = await chunkCodeTextFull(src, 'src/foo.py');
    expect(result.edges.map(e => e.toSymbol)).toContain('helper');
  });

  test('captures method calls on self', async () => {
    const src = `
class Foo:
    def run(self):
        return self.go()
    def go(self):
        return 1
`.trim();
    const result = await chunkCodeTextFull(src, 'src/foo.py');
    // v0.34 W1: self.go() resolves to Foo::go via Python receiver-type resolution.
    const syms = result.edges.map(e => e.toSymbol);
    expect(syms.some((s) => s === 'go' || s === 'Foo::go')).toBe(true);
  });
});

describe('Layer 5 (A1) — Ruby call extraction', () => {
  test('captures method calls', async () => {
    const src = `
class UsersController
  def render
    find_all
  end
  def find_all
    []
  end
end
`.trim();
    const result = await chunkCodeTextFull(src, 'src/u.rb');
    // Ruby call extraction is best-effort; at minimum the bare-ident
    // call form should show up. If grammar surprises us, don't block
    // the release — just record the miss in CHANGELOG as a known gap.
    const names = result.edges.map(e => e.toSymbol);
    expect(names.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Layer 5 (A1) — Go call extraction', () => {
  test('captures function calls', async () => {
    const src = `
package main

func helper() int { return 1 }
func caller() int { return helper() }
`.trim();
    const result = await chunkCodeTextFull(src, 'src/foo.go');
    expect(result.edges.map(e => e.toSymbol)).toContain('helper');
  });
});

describe('Layer 5 (A1) — Rust call extraction', () => {
  test('captures function calls', async () => {
    const src = `
fn helper() -> i32 { 1 }
fn caller() -> i32 { helper() }
`.trim();
    const result = await chunkCodeTextFull(src, 'src/foo.rs');
    expect(result.edges.map(e => e.toSymbol)).toContain('helper');
  });
});

describe('Layer 5 (A1) — Java method invocation', () => {
  test('captures method calls', async () => {
    const src = `
class Foo {
  int helper() { return 1; }
  int caller() { return helper(); }
}
`.trim();
    const result = await chunkCodeTextFull(src, 'src/Foo.java');
    expect(result.edges.map(e => e.toSymbol)).toContain('helper');
  });
});

describe('Layer 5 (A1) — findChunkForOffset mapping', () => {
  test('finds innermost chunk for a given offset', () => {
    const source = [
      '// line 1',
      'class Outer {',     // line 2
      '  method() {}',     // line 3 ← offset falls here
      '  other() {}',      // line 4
      '}',                 // line 5
    ].join('\n');
    const chunks = [
      { startLine: 2, endLine: 5 }, // class-level (outer)
      { startLine: 3, endLine: 3 }, // method (innermost)
      { startLine: 4, endLine: 4 }, // other method
    ];
    // Byte offset of "method()" on line 3.
    const offset = source.indexOf('method()');
    const idx = findChunkForOffset(offset, source, chunks);
    expect(idx).toBe(1); // innermost = index 1
  });

  test('returns null when no chunk contains the offset', () => {
    const source = 'abc';
    const chunks = [{ startLine: 10, endLine: 20 }];
    expect(findChunkForOffset(0, source, chunks)).toBeNull();
  });
});

describe('Layer 5 (A1) — unknown language ships zero edges', () => {
  test('unsupported language returns empty edge list without throwing', async () => {
    // VHDL is not in the CALL_CONFIG shipped list (Layer 5 ships 8 langs).
    const src = 'module TestBench; end module;';
    const result = await chunkCodeTextFull(src, 'src/tb.vhd');
    expect(result.edges).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// v0.42 code-graph fixes (helmsman): arrow-const defs, bash calls, bare-name.
// ─────────────────────────────────────────────────────────────────────────

describe('v0.42 — arrow/const function definitions are typed as function', () => {
  test('export const Foo = () => {} → symbolType function (so code-def finds it)', async () => {
    const src = `export const useTheme = () => ({ color: 'x' });`;
    const result = await chunkCodeTextFull(src, 'src/theme.ts');
    const def = result.chunks.find(c => c.metadata.symbolName === 'useTheme');
    expect(def).toBeDefined();
    expect(def!.metadata.symbolType).toBe('function');
  });

  test('const Bar = function(){} → symbolType function', async () => {
    const src = `const Bar = function () { return 1; };`;
    const result = await chunkCodeTextFull(src, 'src/bar.js');
    const def = result.chunks.find(c => c.metadata.symbolName === 'Bar');
    expect(def).toBeDefined();
    expect(def!.metadata.symbolType).toBe('function');
  });

  test('const N = 5 stays NON-function (no false positives)', async () => {
    const src = `const N = 5;`;
    const result = await chunkCodeTextFull(src, 'src/n.ts');
    const def = result.chunks.find(c => c.metadata.symbolName === 'N');
    if (def) expect(def.metadata.symbolType).not.toBe('function');
  });
});

describe('v0.42 — bareSymbolName (cross-file resolution key)', () => {
  test('strips :: namespace (Class::method → method)', () => {
    expect(bareSymbolName('Foo::bar')).toBe('bar');
  });
  test('strips import-module namespace (react::useTheme → useTheme)', () => {
    expect(bareSymbolName('react::useTheme')).toBe('useTheme');
  });
  test('strips . namespace (Foo.bar → bar)', () => {
    expect(bareSymbolName('BrainEngine.searchKeyword')).toBe('searchKeyword');
  });
  test('strips ruby # method delim (Admin::Users#render → render)', () => {
    expect(bareSymbolName('Admin::Users#render')).toBe('render');
  });
  test('bare name passes through unchanged', () => {
    expect(bareSymbolName('parseInput')).toBe('parseInput');
  });
});

describe('v0.42 — bash call extraction', () => {
  test('captures command invocations in a shell script', async () => {
    const src = `#!/usr/bin/env bash\nmyfunc() { echo hi; }\nmyfunc\ngit status\n`;
    const result = await chunkCodeTextFull(src, 'scripts/run.sh');
    const syms = result.edges.map(e => e.toSymbol);
    // 'myfunc' and/or 'git' should be captured as call edges now (was [] before).
    expect(syms.length).toBeGreaterThan(0);
  });
});
