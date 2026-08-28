/**
 * Pins `maxOutputTokensFor` — the per-model output-token budget `runThink`
 * passes to `client.create`. Thinking-by-default Claude 5 models
 * (`anthropic:claude-*-5`), OpenAI reasoning models (gpt-5 family,
 * o-series), and the Anthropic Claude 4.x deep-tier family (gbrain#4375 —
 * the default `deep` alias is anthropic:claude-opus-4-7, whose JSON envelope
 * truncated at 4000) get 16000; everything else stays 4000.
 *
 * Also pins the gbrain#4375 truncation labeling: a max_tokens-cut envelope
 * is 'output_truncated' / LLM_OUTPUT_TRUNCATED, never the generic not_json.
 */
import { afterAll, beforeAll, describe, test, expect } from 'bun:test';
import { maxOutputTokensFor, runThink, type ThinkLLMClient } from '../src/core/think/index.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';

describe('maxOutputTokensFor — thinking-default headroom', () => {
  test('Claude 5 family gets 16000', () => {
    expect(maxOutputTokensFor('anthropic:claude-sonnet-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-opus-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-fable-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-haiku-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic/claude-sonnet-5')).toBe(16000); // slash form
  });

  test('OpenAI reasoning models (gpt-5 family, o-series) get 16000', () => {
    expect(maxOutputTokensFor('openai:gpt-5')).toBe(16000);
    expect(maxOutputTokensFor('openai:gpt-5.2')).toBe(16000);
    expect(maxOutputTokensFor('openai:gpt-5.5')).toBe(16000);
    expect(maxOutputTokensFor('openai:gpt-5-mini')).toBe(16000);
    expect(maxOutputTokensFor('openai:o1')).toBe(16000);
    expect(maxOutputTokensFor('openai:o3')).toBe(16000);
    expect(maxOutputTokensFor('openai:o4-mini')).toBe(16000);
    expect(maxOutputTokensFor('openai/gpt-5.2')).toBe(16000); // slash form
  });

  test('gbrain#4375 — Anthropic Claude 4.x family gets 16000 (deep-tier truncation headroom)', () => {
    // The default deep tier (model-config.ts) is anthropic:claude-opus-4-7:
    // at 4000 the synthesis JSON envelope truncated mid-stream and was
    // mislabeled not_json. Anthropic-scoped only, so provider hard caps
    // (DeepSeek 8192, gpt-4o) are unaffected.
    expect(maxOutputTokensFor('anthropic:claude-opus-4-7')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-opus-4-8')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-haiku-4-5')).toBe(16000);
    expect(maxOutputTokensFor('anthropic:claude-sonnet-4-6')).toBe(16000);
    expect(maxOutputTokensFor('anthropic/claude-opus-4-7')).toBe(16000); // slash form
    expect(maxOutputTokensFor('claude-opus-4-7')).toBe(16000);           // bare spelling
    expect(maxOutputTokensFor('openrouter:anthropic/claude-opus-4-7')).toBe(16000);
  });

  test('non-headroom models keep 4000', () => {
    // 3.x-era Claude spellings never match the 4.x family regex.
    expect(maxOutputTokensFor('anthropic:claude-3-haiku')).toBe(4000);
    expect(maxOutputTokensFor('anthropic:claude-3-5-sonnet')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-4o')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-4o-mini')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-4.1')).toBe(4000);
    // Non-reasoning ChatGPT snapshots of the gpt-5 family stay at 4000.
    expect(maxOutputTokensFor('openai:gpt-5-chat-latest')).toBe(4000);
    expect(maxOutputTokensFor('openai:gpt-5.2-chat-latest')).toBe(4000);
    // Scope is the gpt-5 family + numbered o-series only — other OpenAI
    // reasoning-capable ids (e.g. codex-mini-latest) keep the conservative
    // default until deliberately added.
    expect(maxOutputTokensFor('openai:codex-mini-latest')).toBe(4000);
    // Version/name boundaries: `gpt-50` and `o3foo` are not gpt-5 / o3.
    expect(maxOutputTokensFor('openai:gpt-50')).toBe(4000);
    expect(maxOutputTokensFor('openai:o3foo')).toBe(4000);
    // Prefix must be the openai provider — a bare model name or another
    // provider's gpt-5 spelling doesn't match.
    expect(maxOutputTokensFor('o3')).toBe(4000);
    expect(maxOutputTokensFor('gpt-5.2')).toBe(4000);
    expect(maxOutputTokensFor('openrouter:openai/gpt-5.2')).toBe(4000);
  });

  test('gbrain#4172 — recipe-declared thinking-by-default models (DeepSeek v4) get 16000 via the capability layer', () => {
    // DeepSeek v4 thinks by default and bills reasoning against max_tokens:
    // at 4000 the whole budget is spent reasoning and think returns
    // truncated/empty JSON. Keyed on thinking_by_default (capability), not a
    // model-name regex, so provider renames keep the headroom.
    expect(maxOutputTokensFor('deepseek:deepseek-v4-flash')).toBe(16000);
    expect(maxOutputTokensFor('deepseek:deepseek-v4-pro')).toBe(16000);
    // Retired alias still routes to a thinking v4 model at the provider.
    expect(maxOutputTokensFor('deepseek:deepseek-reasoner')).toBe(16000);
    // Recipes without the capability keep the conservative default.
    expect(maxOutputTokensFor('ollama:llama3.3')).toBe(4000);
    expect(maxOutputTokensFor('groq:llama-3.3-70b-versatile')).toBe(4000);
    // Unknown provider strings fail open to the default, never throw.
    expect(maxOutputTokensFor('nonexistent-provider:whatever')).toBe(4000);
    expect(maxOutputTokensFor('voyage:voyage-4')).toBe(4000); // chat-less recipe
  });
});

describe('runThink — max_tokens truncation labeling (gbrain#4375)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await engine.putPage('notes/quokka-payments', {
      title: 'Quokka Payments',
      type: 'note',
      compiled_truth: 'The quokka payments migration finished in March with zero downtime.',
    });
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  // Same stub-message shape as auto-think-phase.test.ts so contextual typing
  // against the Anthropic Message union holds without casts.
  function clientOf(text: string, stopReason: 'end_turn' | 'max_tokens'): ThinkLLMClient {
    return {
      create: async () => ({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'anthropic:claude-opus-4-7',
        stop_reason: stopReason,
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 4000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, server_tool_use: null, service_tier: null },
        content: [{ type: 'text', text }],
      }),
    };
  }

  test('stop_reason max_tokens + unparseable envelope → output_truncated, not the generic not_json', async () => {
    const result = await runThink(engine, {
      question: 'quokka payments migration status',
      // A max_tokens cut ends the JSON envelope mid-string — unparseable.
      client: clientOf('{"answer":"The quokka payments migration finished in Mar', 'max_tokens'),
      withTrajectory: false,
    });
    expect(result.warnings).toContain('LLM_OUTPUT_TRUNCATED');
    expect(result.synthesis_status).toBe('output_truncated');
    expect(result.warnings).not.toContain('LLM_OUTPUT_NOT_JSON');
    expect(result.synthesisOk).toBe(false);
    // Extractive-fallback contract holds for truncation like any other
    // compose failure: a non-empty gather still yields digest material.
    expect(result.pagesGathered).toBeGreaterThanOrEqual(1);
    expect(result.extractive).toBeDefined();
  });

  test('non-JSON output WITHOUT truncation keeps the generic not_json labeling', async () => {
    const result = await runThink(engine, {
      question: 'quokka payments migration status',
      client: clientOf('I cannot help with that request.', 'end_turn'),
      withTrajectory: false,
    });
    expect(result.synthesis_status).toBe('not_json');
    expect(result.warnings).toContain('LLM_OUTPUT_NOT_JSON');
    expect(result.warnings).not.toContain('LLM_OUTPUT_TRUNCATED');
  });
});
