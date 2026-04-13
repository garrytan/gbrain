/**
 * Multi-Query Expansion via OpenAI-compat JSON mode.
 *
 * Patched for gbrain Phase B (2026-04-13, Patch 4): swapped Anthropic SDK
 * for OpenAI-compat so expansion can route through OpenRouter (Qwen3) or
 * local Ollama. JSON mode is used instead of Anthropic-style tool use for
 * portability across providers.
 *
 * Skip queries < 3 words.
 * Generate 2 alternative phrasings via the configured model.
 * Return original + alternatives (max 3 total).
 *
 * Env vars:
 *   GBRAIN_EXPANSION_BASE_URL  — OpenAI-compat base URL (OpenRouter, Ollama, etc)
 *   GBRAIN_EXPANSION_MODEL     — model name in provider's namespace
 *   OPENROUTER_API_KEY         — auth for OpenRouter (fallback: OPENAI_API_KEY)
 */

import OpenAI from 'openai';

const MAX_QUERIES = 3;
const MIN_WORDS = 3;

let openaiClient: OpenAI | null = null;

function getClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey:
        process.env.OPENROUTER_API_KEY ||
        process.env.OPENAI_API_KEY ||
        'local-ollama-no-key-needed',
      baseURL: process.env.GBRAIN_EXPANSION_BASE_URL || process.env.OPENAI_BASE_URL,
    });
  }
  return openaiClient;
}

export async function expandQuery(query: string): Promise<string[]> {
  // CJK text is not space-delimited — count characters instead of whitespace-separated tokens
  const hasCJK = /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/.test(query);
  const wordCount = hasCJK ? query.replace(/\s/g, '').length : (query.match(/\S+/g) || []).length;
  if (wordCount < MIN_WORDS) return [query];

  try {
    const alternatives = await callExpansionModel(query);
    const all = [query, ...alternatives];
    // Deduplicate (case-insensitive, trimmed)
    const unique = [...new Set(all.map(q => q.toLowerCase().trim()))];
    return unique.slice(0, MAX_QUERIES).map(q =>
      all.find(orig => orig.toLowerCase().trim() === q) || q,
    );
  } catch {
    return [query];
  }
}

async function callExpansionModel(query: string): Promise<string[]> {
  // Default is local Ollama gemma4 for zero-dependency stability.
  // Override GBRAIN_EXPANSION_MODEL + GBRAIN_EXPANSION_BASE_URL to use OpenRouter etc.
  const model = process.env.GBRAIN_EXPANSION_MODEL || 'gemma4:latest';

  const response = await getClient().chat.completions.create({
    model,
    max_tokens: 300,
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content:
          'You generate alternative search queries to improve recall. ' +
          'Always return valid JSON matching this exact schema: ' +
          '{"alternatives": ["query1", "query2"]}. ' +
          'Each alternative should approach the topic from a different angle or ' +
          'use different terminology than the original.',
      },
      {
        role: 'user',
        content: `Generate 2 alternative phrasings for this search query. Return only JSON in the format {"alternatives": ["q1", "q2"]}.

Original query: "${query}"`,
      },
    ],
  });

  const content = response.choices[0]?.message?.content;
  if (!content) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }

  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    'alternatives' in parsed &&
    Array.isArray((parsed as { alternatives: unknown }).alternatives)
  ) {
    return (parsed as { alternatives: unknown[] }).alternatives
      .map(String)
      .slice(0, 2);
  }

  return [];
}
