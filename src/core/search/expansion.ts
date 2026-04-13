/**
 * Multi-Query Expansion via Claude Haiku
 * Ported from production Ruby implementation (query_expansion_service.rb, 69 LOC)
 *
 * Skip queries < 3 words.
 * Generate 2 alternative phrasings via tool use.
 * Return original + alternatives (max 3 total).
 */

import Anthropic from '@anthropic-ai/sdk';

const MAX_QUERIES = 3;
const MIN_WORDS = 3;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

export async function expandQuery(query: string): Promise<string[]> {
  // CJK text is not space-delimited — count characters instead of whitespace-separated tokens
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(query);
  const wordCount = hasCJK ? query.replace(/\s/g, '').length : (query.match(/\S+/g) || []).length;
  if (wordCount < MIN_WORDS) return [query];

  try {
    const alternatives = await callHaikuForExpansion(query);
    const all = [query, ...alternatives];
    // Deduplicate
    const unique = [...new Set(all.map(q => q.toLowerCase().trim()))];
    return unique.slice(0, MAX_QUERIES).map(q =>
      all.find(orig => orig.toLowerCase().trim() === q) || q,
    );
  } catch {
    return [query];
  }
}

async function callHaikuForExpansion(query: string): Promise<string[]> {
  const response = await getClient().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    tools: [
      {
        name: 'expand_query',
        description: 'Generate alternative phrasings of a search query to improve recall',
        input_schema: {
          type: 'object' as const,
          properties: {
            alternative_queries: {
              type: 'array',
              items: { type: 'string' },
              description: '2 alternative phrasings of the original query, each approaching the topic from a different angle',
            },
          },
          required: ['alternative_queries'],
        },
      },
    ],
    tool_choice: { type: 'tool', name: 'expand_query' },
    messages: [
      {
        role: 'user',
        content: `Generate 2 alternative search queries that would find relevant results for this question. Each alternative should approach the topic from a different angle or use different terminology.

Original query: "${query}"`,
      },
    ],
  });

  // Extract tool use result
  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'expand_query') {
      const input = block.input as { alternative_queries?: unknown };
      const alts = input.alternative_queries;
      if (Array.isArray(alts)) {
        return alts.map(String).slice(0, 2);
      }
    }
  }

  return [];
}
