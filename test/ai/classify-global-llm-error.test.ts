/**
 * classifyGlobalLlmError (#3044) — whole-run LLM failure detection.
 *
 * Positive cases: auth/billing/rate-limit conditions that would fail
 * identically on every page/take in a cycle phase, expressed as numeric
 * status properties, structured message forms (`HTTP 429`, `status 429`,
 * the claude-cli `"api_error_status":429` JSON blob), or specific provider
 * phrases ("credit balance is too low", "spend limit").
 *
 * Negative cases pin the precision requirement: a bare number in prose, a
 * stray word inside a raw-output slice, or a genuinely per-item error
 * (context length, parse failure, timeout) must NOT halt the run.
 */

import { describe, test, expect } from 'bun:test';
import { classifyGlobalLlmError, AIConfigError } from '../../src/core/ai/errors.ts';

function errWithStatus(message: string, status: number): Error {
  return Object.assign(new Error(message), { status });
}

describe('classifyGlobalLlmError — positives', () => {
  test('numeric status property: 401/403 → auth', () => {
    expect(classifyGlobalLlmError(errWithStatus('nope', 401))).toBe('auth');
    expect(classifyGlobalLlmError(errWithStatus('nope', 403))).toBe('auth');
  });

  test('numeric status property: 429 → rate_limit, 402 → billing', () => {
    expect(classifyGlobalLlmError(errWithStatus('slow down', 429))).toBe('rate_limit');
    expect(classifyGlobalLlmError(errWithStatus('pay up', 402))).toBe('billing');
  });

  test('statusCode property variant is honored', () => {
    const err = Object.assign(new Error('denied'), { statusCode: 403 });
    expect(classifyGlobalLlmError(err)).toBe('auth');
  });

  test('apiErrorStatus / api_error_status property variants are honored (typed claude-cli errors)', () => {
    expect(classifyGlobalLlmError(Object.assign(new Error('request failed'), { apiErrorStatus: 429 }))).toBe('rate_limit');
    expect(classifyGlobalLlmError(Object.assign(new Error('request failed'), { api_error_status: 401 }))).toBe('auth');
  });

  test('AIConfigError classifies structurally as auth (missing-key gateway errors carry no status, no phrase)', () => {
    expect(classifyGlobalLlmError(new AIConfigError('OpenAI chat requires OPENAI_API_KEY.'))).toBe('auth');
    expect(classifyGlobalLlmError(new AIConfigError('Anthropic chat requires ANTHROPIC_API_KEY.'))).toBe('auth');
  });

  test('structured "api_error_status" form still classifies when it lands AFTER a --- raw --- marker', () => {
    const msg =
      'claude-cli JSON event array had no "result" event\n--- raw ---\n{"type":"result","api_error_status":429}';
    expect(classifyGlobalLlmError(new Error(msg))).toBe('rate_limit');
  });

  test('status on the cause chain is honored (normalizeAIError wrapping)', () => {
    const inner = errWithStatus('upstream said no', 401);
    const wrapped = new AIConfigError('[chat] upstream said no', 'check key', inner);
    expect(classifyGlobalLlmError(wrapped)).toBe('auth');
  });

  test('claude-cli JSON result blob: "api_error_status":429', () => {
    const msg =
      'claude-cli exited 1: {"type":"result","subtype":"error_during_execution","api_error_status":429,"result":"request failed"}';
    expect(classifyGlobalLlmError(new Error(msg))).toBe('rate_limit');
  });

  test('monthly spend limit message classifies as billing even at 429', () => {
    const msg =
      'claude-cli reported error: {"api_error_status":429} you have reached your monthly spend limit';
    expect(classifyGlobalLlmError(new Error(msg))).toBe('billing');
  });

  test('structured status forms in message: HTTP 429 / status 429 / status code: 401', () => {
    expect(classifyGlobalLlmError(new Error('Request failed: HTTP 429'))).toBe('rate_limit');
    expect(classifyGlobalLlmError(new Error('provider returned status 429'))).toBe('rate_limit');
    expect(classifyGlobalLlmError(new Error('Request failed with status code: 401'))).toBe('auth');
  });

  test('billing phrases: insufficient_quota / quota exceeded / credit balance too low', () => {
    expect(classifyGlobalLlmError(new Error('insufficient_quota: You exceeded your current quota'))).toBe('billing');
    expect(classifyGlobalLlmError(new Error('Your credit balance is too low to access the API'))).toBe('billing');
    expect(classifyGlobalLlmError(new Error('monthly quota exceeded for this key'))).toBe('billing');
  });

  test('auth phrases: authentication_error / invalid x-api-key', () => {
    expect(classifyGlobalLlmError(new Error('{"type":"error","error":{"type":"authentication_error"}}'))).toBe('auth');
    expect(classifyGlobalLlmError(new Error('invalid x-api-key'))).toBe('auth');
  });

  test('rate-limit phrases: rate_limit_error / too many requests', () => {
    expect(classifyGlobalLlmError(new Error('{"type":"error","error":{"type":"rate_limit_error"}}'))).toBe('rate_limit');
    expect(classifyGlobalLlmError(new Error('Too Many Requests'))).toBe('rate_limit');
  });

  test('non-Error string values still classify', () => {
    expect(classifyGlobalLlmError('provider returned status 429')).toBe('rate_limit');
  });
});

describe('classifyGlobalLlmError — negatives (per-item errors stay per-item)', () => {
  test('null for a bare number in prose ("processed 429 pages")', () => {
    expect(classifyGlobalLlmError(new Error('processed 429 pages in this batch'))).toBeNull();
  });

  test('null for a bare "billing" word inside a raw-output slice', () => {
    expect(
      classifyGlobalLlmError(new Error('claude-cli output not JSON --- raw --- notes about billing software startups')),
    ).toBeNull();
  });

  test('null for context-length 400s (genuinely per-page)', () => {
    const err = Object.assign(
      new Error("This model's maximum context length is 200000 tokens"),
      { status: 400 },
    );
    expect(classifyGlobalLlmError(err)).toBeNull();
  });

  test('null for an AIConfigError wrapping a status-400 request error (per-item, not whole-run)', () => {
    const inner = Object.assign(
      new Error("This model's maximum context length is 200000 tokens"),
      { status: 400 },
    );
    const wrapped = new AIConfigError(
      "[chat] This model's maximum context length is 200000 tokens",
      'Check your model id + provider options match the provider API.',
      inner,
    );
    expect(classifyGlobalLlmError(wrapped)).toBeNull();
  });

  test('null for phrase matches inside a --- raw --- output slice (content-dependent halts forbidden)', () => {
    expect(
      classifyGlobalLlmError(new Error(
        'claude-cli output not JSON: Unexpected token\n--- raw ---\nThe provider rate limit should increase over time',
      )),
    ).toBeNull();
    expect(
      classifyGlobalLlmError(new Error(
        'claude-cli output not JSON: Unexpected token\n--- raw ---\nan essay on authentication_error handling patterns',
      )),
    ).toBeNull();
    expect(
      classifyGlobalLlmError(new Error(
        'claude-cli output not JSON: Unexpected token\n--- raw ---\ndiscussing the monthly spend limit feature',
      )),
    ).toBeNull();
  });

  test('null for prose-shaped status forms inside a --- raw --- slice', () => {
    // The quoted `"api_error_status":NNN` JSON form scans the full message
    // (pinned above); the prose forms only scan the pre-raw slice — model
    // text quoting an HTTP status must not halt a run.
    expect(
      classifyGlobalLlmError(new Error('claude-cli exited 1\n--- raw ---\nRequest failed: HTTP 429')),
    ).toBeNull();
    expect(
      classifyGlobalLlmError(new Error('claude-cli exited 1\n--- raw ---\nthe app returned status code: 401 to the probe')),
    ).toBeNull();
  });

  test('null for timeouts / network errors / parse failures', () => {
    expect(classifyGlobalLlmError(new Error('LLM timeout'))).toBeNull();
    expect(classifyGlobalLlmError(new Error('fetch failed: ECONNRESET'))).toBeNull();
    expect(classifyGlobalLlmError(new Error('extractor output was not valid JSON'))).toBeNull();
  });

  test('null for 5xx statuses (transient, retry next item is reasonable)', () => {
    expect(classifyGlobalLlmError(errWithStatus('overloaded', 529))).toBeNull();
    expect(classifyGlobalLlmError(errWithStatus('internal error', 500))).toBeNull();
  });

  test('null for null/undefined/empty', () => {
    expect(classifyGlobalLlmError(null)).toBeNull();
    expect(classifyGlobalLlmError(undefined)).toBeNull();
    expect(classifyGlobalLlmError(new Error(''))).toBeNull();
  });
});
