import { describe, expect, test } from 'bun:test';
import {
  parseSchemaSuggestions,
  runSuggest,
} from '../src/core/schema-pack/suggest.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';

function detectorEngine(model = 'openai:gpt-4.1-mini'): BrainEngine {
  return {
    async getConfig(key: string) {
      return key === 'models.schema_suggest' ? model : null;
    },
    async executeRaw(_sql: string, params?: unknown[]) {
      const sql = _sql.replace(/\s+/g, ' ');
      if (sql.includes('COUNT(*) FILTER')) {
        return [{ total: '12', typed: '2', untyped: '10' }];
      }
      if (sql.includes("substring(slug from")) {
        expect(params?.[0]).toBe('source-a');
        return [{ prefix: 'research/', cnt: '10', sample_types: ['note'] }];
      }
      if (sql.includes('SELECT type, COUNT(*)')) {
        return [{ type: 'note', cnt: '2' }];
      }
      return [];
    },
  } as unknown as BrainEngine;
}

function chatResult(text: string, model: string): ChatResult {
  return {
    text,
    blocks: [{ type: 'text', text }],
    stopReason: 'end',
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    },
    model,
    providerId: model.split(':')[0] ?? 'unknown',
  };
}

describe('native schema suggestion refinement', () => {
  test('parses and validates strict model JSON', () => {
    const parsed = parseSchemaSuggestions(JSON.stringify({
      suggestions: [
        {
          kind: 'add_alias',
          summary: 'Treat research notes as note aliases',
          confidence: 1.4,
          evidence: ['research/', 42],
        },
        { kind: 'invent', summary: 'invalid kind', confidence: 0.9 },
      ],
    }));
    expect(parsed).toEqual([{
      kind: 'add_alias',
      summary: 'Treat research notes as note aliases',
      confidence: 1,
      evidence: ['research/'],
    }]);
  });

  test('uses models.schema_suggest through the provider-neutral gateway', async () => {
    const seenModels: Array<string | undefined> = [];
    const result = await runSuggest(detectorEngine(), {
      sourceId: 'source-a',
      _chat: async (opts: ChatOpts) => {
        seenModels.push(opts.model);
        return chatResult(JSON.stringify({
          suggestions: [{
            kind: 'add_type',
            summary: 'Add research type for research/',
            confidence: 0.91,
            evidence: ['research/'],
          }],
        }), opts.model ?? 'unknown');
      },
    });

    expect(seenModels).toEqual(['openai:gpt-4.1-mini']);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0]?.summary).toContain('research type');
    expect(result.notes).toContain('LLM refinement completed with openai:gpt-4.1-mini.');
  });

  test('surfaces model failure and falls back to review-only heuristics', async () => {
    const result = await runSuggest(detectorEngine(), {
      sourceId: 'source-a',
      _chat: async () => { throw new Error('provider unavailable'); },
    });
    expect(result.suggestions[0]?.confidence).toBe(0.5);
    expect(result.notes.join(' ')).toContain('provider unavailable');
    expect(result.notes.join(' ')).toContain('heuristic fallback');
  });
});
