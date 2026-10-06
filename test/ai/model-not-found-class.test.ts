/**
 * B-N7 (#5394 triage): a provider 404 ("model does not exist or you do not
 * have access") was normalized to AIConfigError and classified `auth`, so
 * `(cause=AIConfigError auth)` sent operators to debug a valid key. It is now
 * its own whole-run class, `model_not_found`, with a fix naming the model,
 * the provider, `gbrain models`, and a known rename when there is one.
 */
import { describe, test, expect } from 'bun:test';
import {
  AIConfigError,
  classifyGlobalLlmError,
  createGlobalLlmHaltTracker,
  normalizeAIError,
} from '../../src/core/ai/errors.ts';
import { FactsExtractionError } from '../../src/core/facts/extract.ts';

const openai404 = () => Object.assign(
  new Error('The model `gpt-5.6-terra` does not exist or you do not have access to it.'),
  { statusCode: 404 },
);

describe('model_not_found class (B-N7)', () => {
  test('401 and 403 stay auth', () => {
    expect(classifyGlobalLlmError(normalizeAIError(Object.assign(new Error('bad key'), { statusCode: 401 }), 'chat(openai:gpt-5.6-terra)'))).toBe('auth');
    expect(classifyGlobalLlmError(normalizeAIError(Object.assign(new Error('forbidden'), { statusCode: 403 }), 'chat(openai:gpt-5.6-terra)'))).toBe('auth');
  });

  test('a 404 is model_not_found, through normalizeAIError and on a claude-cli apiErrorStatus', () => {
    expect(classifyGlobalLlmError(normalizeAIError(openai404(), 'chat(openai:gpt-5.6-terra)'))).toBe('model_not_found');
    expect(classifyGlobalLlmError(Object.assign(new Error('claude-cli API error 404'), { apiErrorStatus: 404 }))).toBe('model_not_found');
  });

  test('a status-less AIConfigError naming a missing model is model_not_found; a missing key stays auth', () => {
    expect(classifyGlobalLlmError(new AIConfigError('[chat(openai:gpt-x)] model_not_found: The model gpt-x does not exist or you do not have access to it.'))).toBe('model_not_found');
    expect(classifyGlobalLlmError(new AIConfigError('OpenAI chat requires OPENAI_API_KEY.'))).toBe('auth');
  });

  test('the 404 fix names the model, the provider and gbrain models', () => {
    const err = normalizeAIError(openai404(), 'chat(openai:gpt-5.6-terra)');
    expect(err).toBeInstanceOf(AIConfigError);
    const fix = (err as AIConfigError).fix!;
    expect(fix).toContain('openai:gpt-5.6-terra');
    expect(fix).toContain('the openai provider does not serve openai:gpt-5.6-terra');
    expect(fix).toContain('`gbrain models`');
    expect(fix).not.toContain('renamed');
  });

  test('a known rename is suggested', () => {
    const err = normalizeAIError(Object.assign(new Error('Model Not Exist'), { status: 404 }), 'chat(deepseek:deepseek-v4-flash)');
    expect((err as AIConfigError).fix).toContain('deepseek:deepseek-v4-flash was renamed: use deepseek:deepseek-flash.');
  });

  test('model_not_found halts the phase on the first hit', () => {
    const tracker = createGlobalLlmHaltTracker();
    expect(tracker.observe(normalizeAIError(openai404(), 'chat(openai:gpt-5.6-terra)'))).toBe('halt-model_not_found');
  });

  test('the facts extraction breadcrumb labels the cause model_not_found, not auth', () => {
    const err = new FactsExtractionError('provider_error', 'openai:gpt-5.6-terra', normalizeAIError(openai404(), 'chat(openai:gpt-5.6-terra)'));
    expect(err.message).toContain('(cause=AIConfigError model_not_found)');
    expect(err.message).not.toContain('auth');
  });
});
