/**
 * Dart semantic chunking — regression guard for the ABI-15/13-14 mismatch.
 *
 * The bundled tree-sitter-dart.wasm used to be ABI 15 while the pinned
 * web-tree-sitter runtime accepts only 13-14, so `parser.setLanguage()` threw,
 * a bare `catch` swallowed it, and EVERY .dart file degraded to text chunks
 * with symbolName = null. code-def/code-callers/code-callees then returned 0
 * for every Dart symbol, silently, on a green index.
 */

import { describe, test, expect } from 'bun:test';
import { join } from 'node:path';
import { chunkCodeText, resetChunkerWarnings } from '../../src/core/chunkers/code.ts';
import { DEF_TYPES } from '../../src/commands/code-def.ts';

const ASSETS = join(import.meta.dir, '../../src/assets/wasm');

// mergeSmallSiblings folds any chunk under 15% of the chunk target into an
// anonymous "merged" chunk with symbolName = null, which would erase the
// per-symbol metadata this suite is about. Pin chunkSizeTokens so the fixture
// does not have to be padded past a default that may change; 40 puts the
// merge threshold at 6 tokens, below every declaration below. It does NOT
// affect splitting — largeChunkThresholdTokens is a separate knob (1000).
const OPTS = { chunkSizeTokens: 40 };
const DART_SRC = `class Greeter {
  final String name;
  const Greeter(this.name);
  String hi() => 'hello ' + name + ', welcome to the show tonight';
}

enum RatingUnit {
  outOfFive,
  outOfTen,
  percent,
  stars,
}

mixin Loud {
  void shout(String what) {
    print(what.toUpperCase() + '!!! ' + what.toUpperCase());
  }
}

extension Padded on String {
  String get padded => '  ' + this + '  ';
  int get visualLength => padded.length + 2;
}

typedef IntList = List<int>;

int clampNameSlot(int want, int min, int max) {
  final lower = want < min ? min : want;
  final upper = lower > max ? max : lower;
  return upper;
}
`;

describe('chunkCodeText — Dart', () => {
  test('the bundled Dart grammar is an ABI the pinned runtime accepts', async () => {
    const mod: any = await import('web-tree-sitter');
    const P = mod.default || mod;
    await P.init({ locateFile: () => join(ASSETS, 'tree-sitter.wasm') });
    const grammar = await P.Language.load(join(ASSETS, 'grammars/tree-sitter-dart.wasm'));
    // web-tree-sitter@0.22.x supports ABI 13-14. A grammar rebuilt at 15 loads
    // fine and only fails at setLanguage — which is what made this invisible.
    expect(grammar.version).toBeLessThanOrEqual(14);
    const parser = new P();
    expect(() => parser.setLanguage(grammar)).not.toThrow();
  });

  test('extracts every top-level declaration kind with its symbol name', async () => {
    const chunks = await chunkCodeText(DART_SRC, 'lib/sample.dart', OPTS);
    const byName = new Map(
      chunks
        .filter(c => c.metadata.symbolName)
        .map(c => [c.metadata.symbolName as string, c.metadata]),
    );

    for (const lang of chunks.map(c => c.metadata.language)) expect(lang).toBe('dart');

    expect(byName.get('Greeter')?.symbolType).toBe('class');
    expect(byName.get('RatingUnit')?.symbolType).toBe('enum');
    expect(byName.get('Loud')?.symbolType).toBe('mixin declaration');
    expect(byName.get('Padded')?.symbolType).toBe('extension declaration');
    expect(byName.get('IntList')?.symbolType).toBe('type');
    expect(byName.get('clampNameSlot')?.symbolType).toBe('function');
  });

  test('a top-level function chunk carries its BODY, not just the signature', async () => {
    // Dart is the only grammar gbrain ships that makes `function_body` a
    // SIBLING of the signature rather than a child. Chunks are built solely
    // from semantic nodes and uncovered source is never emitted, so without
    // the absorption step this chunk would read exactly `int clampNameSlot(
    // int want, int min, int max)` and the body would be absent from the
    // index — while the symbol count stayed identical, which is why this
    // asserts on the text and not on the count.
    const chunks = await chunkCodeText(DART_SRC, 'lib/sample.dart', OPTS);
    const fn = chunks.find(c => c.metadata.symbolName === 'clampNameSlot');
    expect(fn).toBeDefined();
    expect(fn!.text).toContain('final lower = want < min ? min : want');
    expect(fn!.text).toContain('return upper;');
    expect(fn!.metadata.endLine - fn!.metadata.startLine).toBeGreaterThanOrEqual(4);
  });

  test('every Dart symbol type the chunker emits is one code-def can find', async () => {
    // The two halves live in different files and neither fails without the
    // other: the chunker can emit "mixin declaration" forever while code-def's
    // DEF_TYPES omits it, and the SQL query would simply never match. That is
    // the shape the original bug had — a green pipeline returning 0 rows.
    const chunks = await chunkCodeText(DART_SRC, 'lib/sample.dart', OPTS);
    const emitted = [...new Set(
      chunks.map(c => c.metadata.symbolType).filter((t): t is string => Boolean(t)),
    )];
    expect(emitted.length).toBeGreaterThan(0);
    for (const t of emitted) expect(DEF_TYPES).toContain(t);
  });
});

describe('chunker fallback is no longer silent', () => {
  test('warns once per language when a grammar cannot be used', async () => {
    // elm and ql still fail to LOAD under the pinned runtime today, which is
    // the same silent shape Dart had. One warning per language, not per file.
    resetChunkerWarnings();
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { seen.push(String(args[0])); };
    try {
      await chunkCodeText('type alias A = { b : Int }\n', 'a.elm');
      await chunkCodeText('type alias B = { c : Int }\n', 'b.elm');
    } finally {
      console.warn = original;
    }
    const elm = seen.filter(l => l.includes('[gbrain chunker] elm'));
    expect(elm.length).toBe(1);
    expect(elm[0]).toContain('semantic parsing unavailable');
  });
});
