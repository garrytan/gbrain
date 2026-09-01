/**
 * Ollama thinking-by-default headroom (companion to gbrain#4172).
 *
 * Reasoning-by-default local models (Qwen3 / qwen38, DeepSeek-R1, gpt-oss,
 * magistral, phi4-reasoning) spend output-token budget on internal reasoning
 * BEFORE emitting any answer text, and Ollama bills that reasoning against
 * `max_tokens`. Without a recipe-declared `thinking_by_default`, callers that
 * size output caps (`think`'s `maxOutputTokensFor`) hand these models the
 * conservative 4000-token default, the whole budget is consumed by reasoning,
 * and the caller gets EMPTY content back with `finish_reason: "length"`.
 *
 * Reproduced against a local Ollama daemon (qwen38-27b:latest), which reports
 * `capabilities: ["completion","vision","tools","thinking"]`:
 *
 *   max_tokens=16  -> content: "",     reasoning: 16 tokens, finish: length
 *   max_tokens=600 -> content: "PONG", reasoning present,    finish: stop
 *
 * The failure is silent: gbrain's own chat probe reports a GREEN result with
 * empty content, so the misconfiguration is invisible in `providers test`.
 *
 * Non-reasoning local models (qwen2.5-coder, llama3.x, mistral) must NOT be
 * flagged — blanket headroom would over-allocate for every local chat call.
 */

import { describe, expect, test } from 'bun:test';
import { getRecipe } from '../../src/core/ai/recipes/index.ts';
import { getProviderCapabilities } from '../../src/core/ai/capabilities.ts';

describe('recipe: ollama thinking-by-default', () => {
  test('declares thinking_by_default as a per-model predicate', () => {
    const chat = getRecipe('ollama')!.touchpoints.chat!;
    expect(typeof chat.thinking_by_default).toBe('function');
  });

  test.each([
    'ollama:qwen38-27b',
    'ollama:qwen38-27b:latest',
    'ollama:qwen3:8b',
    'ollama:deepseek-r1:14b',
    'ollama:gpt-oss:20b',
    'ollama:magistral:24b',
    'ollama:phi4-reasoning:14b',
  ])('%s is thinking-by-default', (model) => {
    expect(getProviderCapabilities(model).supportsThinking).toBe(true);
  });

  test.each([
    'ollama:qwen2.5-coder:14b',
    'ollama:llama3.2:3b',
    'ollama:mistral:7b',
    'ollama:nomic-embed-text',
  ])('%s is not thinking-by-default', (model) => {
    expect(getProviderCapabilities(model).supportsThinking).toBe(false);
  });

  test('qwen2.5 coder is not mistaken for a qwen3 reasoning tag', () => {
    // Guards the boundary the regex has to respect: the `qwen3` family match
    // must not swallow `qwen2.5-*`, and must not match a bare `qwen` prefix.
    expect(getProviderCapabilities('ollama:qwen2.5:7b').supportsThinking).toBe(false);
    expect(getProviderCapabilities('ollama:qwen:7b').supportsThinking).toBe(false);
  });

  // Review fix — predicate boundaries the first cut got wrong in both
  // directions: qwen3-coder is the INSTRUCT-only Qwen3 variant (no thinking
  // mode) and was swallowed by the `qwen3` family match; phi4-mini-reasoning
  // IS a reasoning model and was missed by `phi[0-9]+-reasoning`.
  test.each([
    'ollama:qwen3-coder:30b',
    'ollama:qwen3-coder',
    'ollama:qwen3-coder:480b-cloud',
  ])('%s (instruct-only coder variant) is NOT thinking-by-default', (model) => {
    expect(getProviderCapabilities(model).supportsThinking).toBe(false);
  });

  test.each([
    'ollama:phi4-mini-reasoning',
    'ollama:phi4-mini-reasoning:3.8b',
    'ollama:Qwen3:8B', // mixed case — Ollama tags are matched case-insensitively
    'ollama:QWEN3-30B-A3B',
  ])('%s is thinking-by-default', (model) => {
    expect(getProviderCapabilities(model).supportsThinking).toBe(true);
  });
});
