/**
 * v0.20.0 Cathedral II Layer 10 C1/C2 — query --lang + --symbol-kind tests.
 *
 * Wires content_chunks.language + content_chunks.symbol_type through
 * SearchOpts into searchKeyword / searchKeywordChunks / searchVector.
 * The columns existed since v0.19.0 Layer 5 (code chunker populates them);
 * Layer 10 exposes them as filters on hybrid search.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('Layer 10 C1/C2 — language + symbol-kind filters', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();

    // Three code pages in three languages, each with a 'parse' function
    // so the FTS hit overlaps but the chunk metadata differs.
    await engine.putPage('src-foo-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/foo.ts (typescript)',
      compiled_truth: 'export function parseInput() { return {}; }',
      timeline: '',
    });
    await engine.upsertChunks('src-foo-ts', [
      {
        chunk_index: 0,
        chunk_text: '// parse the input\nexport function parseInput() { return {}; }',
        chunk_source: 'compiled_truth',
        language: 'typescript',
        symbol_name: 'parseInput',
        symbol_type: 'function',
      },
    ]);

    await engine.putPage('src-bar-py', {
      type: 'code',
      page_kind: 'code',
      title: 'src/bar.py (python)',
      compiled_truth: 'def parse_input():\n    return {}',
      timeline: '',
    });
    await engine.upsertChunks('src-bar-py', [
      {
        chunk_index: 0,
        chunk_text: 'def parse_input():\n    return {}',
        chunk_source: 'compiled_truth',
        language: 'python',
        symbol_name: 'parse_input',
        symbol_type: 'function',
      },
    ]);

    // A class, same language as the first page, different symbol_type.
    await engine.putPage('src-baz-ts', {
      type: 'code',
      page_kind: 'code',
      title: 'src/baz.ts (typescript)',
      compiled_truth: 'export class ParseHelper { parse() { return {}; } }',
      timeline: '',
    });
    await engine.upsertChunks('src-baz-ts', [
      {
        chunk_index: 0,
        chunk_text: '// parse helper class\nexport class ParseHelper { run() { return {}; } }',
        chunk_source: 'compiled_truth',
        language: 'typescript',
        symbol_name: 'ParseHelper',
        symbol_type: 'class',
      },
    ]);
  });

  afterAll(async () => {
    await engine.disconnect();
  }, 30_000);

  test('no filter returns hits from all languages', async () => {
    const results = await engine.searchKeyword('parse', { limit: 10 });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('src-foo-ts');
    expect(slugs).toContain('src-bar-py');
  });

  test('language=typescript excludes python hits', async () => {
    const results = await engine.searchKeyword('parse', { limit: 10, language: 'typescript' });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('src-foo-ts');
    expect(slugs).not.toContain('src-bar-py');
  });

  test('language=python returns only python chunks', async () => {
    const results = await engine.searchKeyword('parse', { limit: 10, language: 'python' });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('src-bar-py');
    expect(slugs).not.toContain('src-foo-ts');
    expect(slugs).not.toContain('src-baz-ts');
  });

  test('symbolKind=class filters out function chunks in same language', async () => {
    const results = await engine.searchKeyword('parse', { limit: 10, symbolKind: 'class' });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('src-baz-ts');
    expect(slugs).not.toContain('src-foo-ts');
    expect(slugs).not.toContain('src-bar-py');
  });

  test('language + symbolKind compose (AND)', async () => {
    const results = await engine.searchKeyword('parse', {
      limit: 10,
      language: 'typescript',
      symbolKind: 'function',
    });
    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('src-foo-ts');
    expect(slugs).not.toContain('src-baz-ts'); // class, not function
    expect(slugs).not.toContain('src-bar-py'); // python, not typescript
  });

  test('searchKeywordChunks honors language filter', async () => {
    const results = await engine.searchKeywordChunks('parse', {
      limit: 10,
      language: 'python',
    });
    for (const r of results) {
      expect(r.slug).toBe('src-bar-py');
    }
  });

  test('unknown language returns zero results (no false positives)', async () => {
    const results = await engine.searchKeyword('parse', { limit: 10, language: 'cobol' });
    expect(results).toEqual([]);
  });

  test('unknown symbolKind returns zero results', async () => {
    const results = await engine.searchKeyword('parse', { limit: 10, symbolKind: 'macro' });
    expect(results).toEqual([]);
  });
});

describe('Layer 10 — operation schema exposes lang + symbol_kind', () => {
  test('query op params list includes lang and symbol_kind', async () => {
    const { operations } = await import('../src/core/operations.ts');
    const queryOp = operations.find(o => o.name === 'query');
    expect(queryOp).toBeDefined();
    expect(queryOp!.params.lang).toBeDefined();
    expect(queryOp!.params.lang!.type).toBe('string');
    expect(queryOp!.params.symbol_kind).toBeDefined();
    expect(queryOp!.params.symbol_kind!.type).toBe('string');
  });
});
