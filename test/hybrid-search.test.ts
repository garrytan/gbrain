import { describe, test, expect, mock } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { SearchResult } from '../src/core/types.ts';

mock.module('../src/core/embedding.ts', () => ({
  embed: async () => {
    throw new Error('404 page not found');
  },
}));

const { hybridSearch } = await import('../src/core/search/hybrid.ts');

function makeResult(overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    slug: 'history/claude-code',
    page_id: 1,
    title: 'Claude Code History',
    type: 'note',
    chunk_text: 'Claude Code 历史对话',
    chunk_source: 'compiled_truth',
    chunk_id: 1,
    chunk_index: 0,
    score: 0.5,
    stale: false,
    ...overrides,
  };
}

function mockEngine(overrides: Partial<Record<string, any>> = {}): BrainEngine {
  return new Proxy({} as BrainEngine, {
    get(_, prop: string) {
      if (prop in overrides) return overrides[prop];
      return () => Promise.resolve([]);
    },
  });
}

describe('hybridSearch keyword-only fallback', () => {
  test('returns keyword results when embedding provider fails', async () => {
    const keywordResults = [
      makeResult({ slug: 'history/claude-code', score: 0.6, chunk_text: 'Claude Code 历史对话与 MCP 排障' }),
      makeResult({
        slug: 'history/codex',
        page_id: 2,
        chunk_id: 2,
        score: 0.4,
        title: 'Codex History',
        chunk_text: 'Codex 历史对话',
      }),
    ];

    const engine = mockEngine({
      searchKeyword: async () => keywordResults,
      getBacklinkCounts: async () => new Map([
        ['history/claude-code', 10],
        ['history/codex', 0],
      ]),
      searchVector: async () => {
        throw new Error('searchVector should not run when embed fails');
      },
    });

    process.env.OPENAI_API_KEY = 'test-key';

    const results = await hybridSearch(engine, 'Claude Code 历史对话', { limit: 10 });

    expect(results).toHaveLength(2);
    expect(results[0].slug).toBe('history/claude-code');
    expect(results[0].score).toBeGreaterThan(0.6);
    expect(results[1].slug).toBe('history/codex');
  });

  test('skips vector path entirely when no OPENAI_API_KEY is configured', async () => {
    const engine = mockEngine({
      searchKeyword: async () => [makeResult({ slug: 'history/claude-code', score: 0.7 })],
      getBacklinkCounts: async () => new Map(),
      searchVector: async () => {
        throw new Error('searchVector should not run without OPENAI_API_KEY');
      },
    });

    delete process.env.OPENAI_API_KEY;

    const results = await hybridSearch(engine, 'Claude Code 历史对话', { limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0].slug).toBe('history/claude-code');
  });
});
