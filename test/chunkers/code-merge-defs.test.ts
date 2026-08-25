/**
 * #4511 — mergeSmallSiblings must never fold a named definition into an
 * anonymous `symbolType: 'merged'` chunk: merging nulls out symbol_name, and
 * code-def resolves names against chunk rows, so a merged definition was
 * unreachable. A flat file of short top-level defs indexed to ZERO symbols in
 * every language without nested-emit chunks (protection previously happened
 * only as a side effect of hasScopedChunks).
 *
 * Also pins that the fix does NOT disable the merge pass for its stated
 * purpose: runs of imports / small constants still merge.
 */
import { describe, test, expect } from 'bun:test';
import { chunkCodeText, CHUNKER_VERSION } from '../../src/core/chunkers/code.ts';
import { DEF_TYPES, MERGE_PROTECTED_SYMBOL_TYPES } from '../../src/core/chunkers/def-types.ts';
import { DEF_TYPES as DEF_TYPES_VIA_CODE_DEF } from '../../src/commands/code-def.ts';

const symbolMap = (chunks: Awaited<ReturnType<typeof chunkCodeText>>) =>
  chunks.map((c) => `${c.metadata.symbolType}:${c.metadata.symbolName}`);

describe('#4511 — short flat definitions keep their symbol names', () => {
  test('python: two short top-level defs → two named function chunks', async () => {
    const src = 'def a(v):\n    return v+1\n\ndef b(v):\n    return v-1\n';
    const chunks = await chunkCodeText(src, 't.py');
    expect(chunks).toHaveLength(2);
    expect(symbolMap(chunks)).toEqual(['function:a', 'function:b']);
  });

  test('typescript: two short exported functions → two named chunks', async () => {
    const src = 'export function a(v: number) {\n  return v + 1;\n}\n\nexport function b(v: number) {\n  return v - 1;\n}\n';
    const chunks = await chunkCodeText(src, 't.ts');
    expect(chunks).toHaveLength(2);
    for (const c of chunks) expect(c.metadata.symbolName).not.toBeNull();
    expect(chunks.map((c) => c.metadata.symbolName)).toEqual(['a', 'b']);
  });

  test('go: two short top-level funcs → two named chunks', async () => {
    const src = 'package t\n\nfunc A(v int) int {\n\treturn v + 1\n}\n\nfunc B(v int) int {\n\treturn v - 1\n}\n';
    const chunks = await chunkCodeText(src, 't.go');
    const named = chunks.filter((c) => c.metadata.symbolName !== null);
    expect(named.map((c) => c.metadata.symbolName)).toEqual(expect.arrayContaining(['A', 'B']));
    expect(chunks.some((c) => c.metadata.symbolType === 'merged' && /func [AB]\(/.test(c.text))).toBe(false);
  });

  test('rust: two short fns → two named chunks', async () => {
    const src = 'fn a(v: i32) -> i32 {\n    v + 1\n}\n\nfn b(v: i32) -> i32 {\n    v - 1\n}\n';
    const chunks = await chunkCodeText(src, 't.rs');
    expect(chunks.map((c) => c.metadata.symbolName)).toEqual(['a', 'b']);
  });

  test('a definition sitting inside an import/const run is not folded into it', async () => {
    const src = [
      'import os',
      'import sys',
      'import json',
      '',
      'def keepme(v):',
      '    return v',
      '',
      'import re',
      'import io',
      '',
    ].join('\n');
    const chunks = await chunkCodeText(src, 'runs.py');
    const named = chunks.filter((c) => c.metadata.symbolName === 'keepme');
    expect(named).toHaveLength(1);
    expect(named[0]!.metadata.symbolType).toBe('function');
  });

  test('import runs still merge (the pass keeps its stated purpose)', async () => {
    const src = Array.from({ length: 8 }, (_, i) => `import mod_${i}`).join('\n') + '\n';
    const chunks = await chunkCodeText(src, 'imports.py');
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.metadata.symbolType).toBe('merged');
  });

  test('CHUNKER_VERSION bumped to 6 so existing indexes re-chunk', () => {
    expect(CHUNKER_VERSION).toBeGreaterThanOrEqual(6);
  });

  test('merge guard is a derived view of code-def DEF_TYPES (single shared list)', () => {
    // Same array object via both import paths — not a hand-copied duplicate.
    expect(DEF_TYPES_VIA_CODE_DEF).toBe(DEF_TYPES);
    // Core definition kinds are protected; run forms stay mergeable.
    for (const t of ['function', 'class', 'interface', 'enum', 'struct item', 'type declaration']) {
      expect(MERGE_PROTECTED_SYMBOL_TYPES.has(t)).toBe(true);
    }
    for (const t of ['lexical declaration', 'variable declaration', 'const declaration', 'local declaration']) {
      expect(MERGE_PROTECTED_SYMBOL_TYPES.has(t)).toBe(false);
    }
    // Everything protected (minus the two wrapper forms) is code-def-resolvable.
    for (const t of MERGE_PROTECTED_SYMBOL_TYPES) {
      if (t === 'export statement' || t === 'decorated definition') continue;
      expect(DEF_TYPES).toContain(t);
    }
  });
});
