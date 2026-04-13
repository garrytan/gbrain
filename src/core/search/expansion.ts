/**
 * Multi-Query Expansion
 * Ported from production Ruby implementation (query_expansion_service.rb, 69 LOC)
 *
 * Default: Claude Haiku via Anthropic SDK.
 * When EXPANSION_PROVIDER=openai (or EXPANSION_MODEL is set without ANTHROPIC_API_KEY),
 * falls back to OpenAI-compatible API (works with DashScope, GLM, etc.):
 *   OPENAI_BASE_URL   — API endpoint
 *   EXPANSION_MODEL   — model name (e.g. qwen-plus)
 *
 * Skip queries < 3 words.
 * Generate 2 alternative phrasings.
 * Return original + alternatives (max 3 total).
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';

const MAX_QUERIES = 3;
const MIN_WORDS = 3;

const EXPANSION_PROVIDER = process.env.EXPANSION_PROVIDER ||
  (process.env.ANTHROPIC_API_KEY ? 'anthropic' : 'openai');
const EXPANSION_MODEL = process.env.EXPANSION_MODEL ||
  (EXPANSION_PROVIDER === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'qwen-plus');

let anthropicClient: Anthropic | null = null;
let openaiClient: OpenAI | null = null;

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) anthropicClient = new Anthropic();
  return anthropicClient;
}

function getOpenAIClient(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI();
  return openaiClient;
}

export async function expandQuery(query: string): Promise<string[]> {
  // CJK text is not space-delimited — count characters instead of whitespace-separated tokens
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(query);
  const wordCount = hasCJK ? query.replace(/\s/g, '').length : (query.match(/\S+/g) || []).length;
  if (wordCount < MIN_WORDS) return [query];

  try {
    const alternatives = EXPANSION_PROVIDER === 'anthropic'
      ? await callAnthropicForExpansion(query)
      : await callOpenAIForExpansion(query);
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

async function callAnthropicForExpansion(query: string): Promise<string[]> {
  const response = await getAnthropicClient().messages.create({
    model: EXPANSION_MODEL,
    max_tokens: 300,
    tools: [
      {
        name: 'expand_query',
        description: 'Generate alternative search queries',
        input_schema: {
          type: 'object' as const,
          properties: {
            alternative_queries: {
              type: 'array',
              items: { type: 'string' },
              description: '2 alternative phrasings of the query',
            },
          },
          required: ['alternative_queries'],
        },
      },
    ],
    tool_choice: { type: 'tool' as const, name: 'expand_query' },
    messages: [
      {
        role: 'user',
        content: `Generate 2 alternative search queries for the following question. Each should approach the topic from a different angle or use different terminology.

Original query: "${query}"`,
      },
    ],
  });

  for (const block of response.content) {
    if (block.type === 'tool_use' && block.name === 'expand_query') {
      const input = block.input as { alternative_queries?: unknown };
      const alts = input.alternative_queries;
      if (Array.isArray(alts)) return alts.map(String).slice(0, 2);
    }
  }
  return [];
}

async function callOpenAIForExpansion(query: string): Promise<string[]> {
  const response = await getOpenAIClient().chat.completions.create({
    model: EXPANSION_MODEL,
    max_tokens: 300,
    messages: [
      {
        role: 'user',
        content: `Generate exactly 2 alternative search queries for the following question. Each should approach the topic from a different angle or use different terminology. Return ONLY a JSON object with key "alternative_queries" containing an array of 2 strings, nothing else.

Original query: "${query}"`,
      },
    ],
    response_format: { type: 'json_object' },
  });

  const text = response.choices[0]?.message?.content?.trim() || '{}';
  try {
    const parsed = JSON.parse(text);
    const alts = parsed.alternative_queries || parsed.queries || Object.values(parsed).flat();
    if (Array.isArray(alts)) return alts.map(String).slice(0, 2);
  } catch { /* parse failure, return empty */ }
  return [];
}
