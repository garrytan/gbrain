/**
 * v0.29 — LLM routing eval (Tier-2, ANTHROPIC_API_KEY gated).
 *
 * The whole point of v0.29 is the agent reaches for get_recent_salience
 * (or find_anomalies / get_recent_transcripts) instead of running query()
 * when the user asks "what's been going on with me?". This test confirms
 * the description edits actually drive that routing — without it, we ship
 * description changes and only learn from production behavior.
 *
 * Implementation: builds a tools list with the v0.29 op definitions, calls
 * Claude with a series of personal-query phrasings, asserts the chosen
 * tool is in the v0.29 set. Cost ~$0.10/CI run on Haiku.
 *
 * Skips gracefully when ANTHROPIC_API_KEY is missing.
 *
 * Replaces the discarded `skills/{salience,anomalies,transcripts}/routing-eval.jsonl`
 * fixtures (codex C1) which would have shipped fake coverage —
 * `routing-eval.ts` evaluates skill resolver triggers via substring match,
 * not MCP tool routing.
 */

import { describe, test, expect } from 'bun:test';
import {
  GET_RECENT_SALIENCE_DESCRIPTION,
  FIND_ANOMALIES_DESCRIPTION,
  GET_RECENT_TRANSCRIPTS_DESCRIPTION,
  QUERY_DESCRIPTION,
  SEARCH_DESCRIPTION,
} from '../../src/core/operations-descriptions.ts';

const SKIP = !process.env.ANTHROPIC_API_KEY;
const describeIfKey = SKIP ? describe.skip : describe;

interface ToolDef {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown> };
}

const TOOLS: ToolDef[] = [
  {
    name: 'get_recent_salience',
    description: GET_RECENT_SALIENCE_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number' },
        limit: { type: 'number' },
        slugPrefix: { type: 'string' },
      },
    },
  },
  {
    name: 'find_anomalies',
    description: FIND_ANOMALIES_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        since: { type: 'string' },
        lookback_days: { type: 'number' },
        sigma: { type: 'number' },
      },
    },
  },
  {
    name: 'get_recent_transcripts',
    description: GET_RECENT_TRANSCRIPTS_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'number' },
        summary: { type: 'boolean' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'query',
    description: QUERY_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'search',
    description: SEARCH_DESCRIPTION,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'number' },
      },
    },
  },
];

const V029_TOOLS = new Set(['get_recent_salience', 'find_anomalies', 'get_recent_transcripts']);

const PERSONAL_QUERY_PHRASINGS = [
  'anything crazy happening in my brain lately?',
  "what's been going on with me?",
  "how have I been?",
  "anything notable in my brain?",
  "what's been on my mind?",
  "what stood out this week?",
  "what's hot in my notes?",
  "anything weird going on lately?",
  "any unusual patterns?",
  "what have I been thinking about?",
  "what did I talk about yesterday?",
  "what's notable in the brain right now?",
];

interface AnthropicResponse {
  content: Array<{ type: string; name?: string }>;
  stop_reason: string;
}

async function callClaudeWithTools(prompt: string): Promise<{ tool: string | null; raw: AnthropicResponse }> {
  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      tools: TOOLS,
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as AnthropicResponse;
  const useBlock = (json.content ?? []).find(b => b.type === 'tool_use');
  return { tool: useBlock?.name ?? null, raw: json };
}

describeIfKey('v0.29 — LLM routes personal queries to v0.29 ops, not query() / search()', () => {
  for (const prompt of PERSONAL_QUERY_PHRASINGS) {
    test(`routes "${prompt}" to a v0.29 tool`, async () => {
      const { tool } = await callClaudeWithTools(prompt);
      expect(tool).not.toBeNull();
      expect(V029_TOOLS.has(tool!)).toBe(true);
    }, 30_000);
  }
});
