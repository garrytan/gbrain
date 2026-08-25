/**
 * #3800 — subagent token economy: snippet_chars param + agent.search_snippet_chars
 * config cap search/query chunk_text payloads for subagent tool loops.
 *
 * Pins: helper truncation semantics, subagent default (300), param beats
 * config, non-subagent callers keep full text, 0 = full text.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { applySnippetCap, buildSnippetMarker, DEFAULT_AGENT_SNIPPET_CHARS } from '../src/core/search/snippet-cap.ts';
import type { SearchResult } from '../src/core/types.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const searchOp = operations.find((o) => o.name === 'search')!;
const LONG_TEXT = `walrus fanfare ${'x'.repeat(600)} tail-marker-end`;

function ctxOf(overrides: Partial<OperationContext> = {}): OperationContext {
  return {
    engine: engine as never,
    config: {} as never,
    logger: console as never,
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...overrides,
  } as OperationContext;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.putPage('notes/walrus', {
    type: 'note', title: 'Walrus fanfare', compiled_truth: LONG_TEXT, frontmatter: {},
  });
  await engine.upsertChunks('notes/walrus', [
    { chunk_index: 0, chunk_text: LONG_TEXT, chunk_source: 'compiled_truth' },
  ]);
  await engine.setConfig('search.mcp_keyword_only', 'true');
  // 240s: PGLite cold init (135 migrations) regularly exceeds 60s on a
  // loaded CI box / parallel local agents; the old cap flaked this suite.
}, 240_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 240_000);

describe('applySnippetCap helper (#3800)', () => {
  test('truncates chunk_text only and appends the get_page marker', () => {
    const rows = [{ slug: 'a/b', chunk_text: '0123456789', title: 'keep-me' }];
    const out = applySnippetCap(rows, 4);
    expect(out[0].chunk_text).toBe('0123' + buildSnippetMarker('a/b', 6));
    expect(out[0].title).toBe('keep-me');
    // Non-mutating: the input object is untouched (pending cache writes may
    // still hold a reference to it).
    expect(rows[0].chunk_text).toBe('0123456789');
  });

  test('short text and cap<=0 are identity (same array back)', () => {
    const rows = [{ slug: 'a/b', chunk_text: 'short' }];
    expect(applySnippetCap(rows, 10)).toBe(rows);
    const long = [{ slug: 'a/b', chunk_text: 'x'.repeat(50) }];
    expect(applySnippetCap(long, 0)).toBe(long);
    expect(applySnippetCap(long, Number.NaN)).toBe(long);
  });
});

describe('search op snippet cap (#3800)', () => {
  test('non-subagent callers keep full text', async () => {
    const out = (await searchOp.handler(ctxOf(), { query: 'walrus fanfare' })) as SearchResult[];
    expect(out.length).toBe(1);
    expect(out[0].chunk_text).toBe(LONG_TEXT);
  });

  test('subagent callers default to the 300-char config default', async () => {
    const out = (await searchOp.handler(ctxOf({ viaSubagent: true }), { query: 'walrus fanfare' })) as SearchResult[];
    expect(out.length).toBe(1);
    expect(out[0].chunk_text!.startsWith(LONG_TEXT.slice(0, DEFAULT_AGENT_SNIPPET_CHARS))).toBe(true);
    expect(out[0].chunk_text!.length).toBeLessThan(LONG_TEXT.length);
    expect(out[0].chunk_text).toContain('get_page notes/walrus');
  });

  test('agent.search_snippet_chars config governs the subagent default', async () => {
    await engine.setConfig('agent.search_snippet_chars', '50');
    try {
      const out = (await searchOp.handler(ctxOf({ viaSubagent: true }), { query: 'walrus fanfare' })) as SearchResult[];
      expect(out[0].chunk_text!.startsWith(LONG_TEXT.slice(0, 50))).toBe(true);
      expect(out[0].chunk_text!).toContain('truncated');
    } finally {
      await engine.setConfig('agent.search_snippet_chars', '');
    }
  });

  test('explicit snippet_chars param beats the config', async () => {
    await engine.setConfig('agent.search_snippet_chars', '50');
    try {
      const out = (await searchOp.handler(ctxOf({ viaSubagent: true }), { query: 'walrus fanfare', snippet_chars: 20 })) as SearchResult[];
      expect(out[0].chunk_text!.startsWith(LONG_TEXT.slice(0, 20))).toBe(true);
      expect(out[0].chunk_text!.slice(0, 30)).not.toBe(LONG_TEXT.slice(0, 30));
    } finally {
      await engine.setConfig('agent.search_snippet_chars', '');
    }
  });

  test('snippet_chars 0 forces full text even for subagents with a config cap', async () => {
    await engine.setConfig('agent.search_snippet_chars', '50');
    try {
      const out = (await searchOp.handler(ctxOf({ viaSubagent: true }), { query: 'walrus fanfare', snippet_chars: 0 })) as SearchResult[];
      expect(out[0].chunk_text).toBe(LONG_TEXT);
    } finally {
      await engine.setConfig('agent.search_snippet_chars', '');
    }
  });

  test('param applies to non-subagent callers too (explicit ask wins)', async () => {
    const out = (await searchOp.handler(ctxOf(), { query: 'walrus fanfare', snippet_chars: 25 })) as SearchResult[];
    expect(out[0].chunk_text!.startsWith(LONG_TEXT.slice(0, 25))).toBe(true);
    expect(out[0].chunk_text!).toContain('truncated');
  });
});

describe('query op snippet cap (#3800)', () => {
  const queryOp = operations.find((o) => o.name === 'query')!;

  test('subagent default cap applies on the query op (no-provider hybrid path)', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = (await queryOp.handler(ctxOf({ viaSubagent: true }), { query: 'walrus fanfare', expand: false })) as SearchResult[];
      expect(out.length).toBe(1);
      expect(out[0].chunk_text!.length).toBeLessThan(LONG_TEXT.length);
      expect(out[0].chunk_text!).toContain('get_page notes/walrus');
    });
  });

  test('non-subagent query keeps full text', async () => {
    await withEnv({ OPENAI_API_KEY: undefined }, async () => {
      const out = (await queryOp.handler(ctxOf(), { query: 'walrus fanfare', expand: false })) as SearchResult[];
      expect(out[0].chunk_text).toBe(LONG_TEXT);
    });
  });
});
