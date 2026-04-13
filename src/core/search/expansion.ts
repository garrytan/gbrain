/**
 * Multi-Query Expansion via Claude Haiku or MiniMax
 * Ported from production Ruby implementation (query_expansion_service.rb, 69 LOC)
 *
 * Skip queries < 3 words.
 * Generate 2 alternative phrasings via tool use.
 * Return original + alternatives (max 3 total).
 *
 * Provider selection (in order of preference):
 *   1. Anthropic (ANTHROPIC_API_KEY) → claude-haiku-4-5-20251001
 *   2. MiniMax (MINIMAX_API_KEY)     → MiniMax-M2.7 via Anthropic-compatible API
 */

import Anthropic from '@anthropic-ai/sdk';

const MAX_QUERIES = 3;
const MIN_WORDS = 3;

const MINIMAX_BASE_URL = 'https://api.minimax.io/anthropic';
const MINIMAX_MODEL = 'MiniMax-M2.7';
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  if (!anthropicClient) {
    const minimaxApiKey = process.env.MINIMAX_API_KEY;
    if (minimaxApiKey && !process.env.ANTHROPIC_API_KEY) {
      anthropicClient = new Anthropic({
        apiKey: minimaxApiKey,
        baseURL: process.env.MINIMAX_BASE_URL ?? MINIMAX_BASE_URL,
      });
    } else {
      anthropicClient = new Anthropic();
    }
  }
  return anthropicClient;
}

function getModel(): string {
  if (process.env.MINIMAX_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    return MINIMAX_MODEL;
  }
  return DEFAULT_MODEL;
}

export async function expandQuery(query: string): Promise<string[]> {
  const wordCount = (query.match(/\S+/g) || []).length;
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
    model: getModel(),
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
