/**
 * Unit tests for the v0.30.2 terminal-error classification of Anthropic's
 * "prompt is too long" 400 in the subagent handler.
 *
 * The handler converts these to UnrecoverableError so the worker routes the
 * job straight to `dead`, bypassing max_stalled retries (the prior 3x-retry
 * pathology that clogged the queue).
 *
 * Pure function tests of `isPromptTooLongError`. End-to-end coverage of the
 * client.create() try/catch lives in the synthesize E2E test.
 */

import { describe, test, expect } from 'bun:test';
import { isPromptTooLongError } from '../src/core/minions/handlers/subagent.ts';

describe('isPromptTooLongError', () => {
  test('matches the production message verbatim', () => {
    const err = new Error('prompt is too long: 1707509 tokens > 1000000 maximum');
    expect(isPromptTooLongError(err)).toBe(true);
  });

  test('matches case-insensitively', () => {
    expect(isPromptTooLongError(new Error('Prompt Is Too Long'))).toBe(true);
    expect(isPromptTooLongError(new Error('PROMPT IS TOO LONG'))).toBe(true);
  });

  test('matches when message is on the inner .error.message field', () => {
    // Mimic Anthropic SDK error wrapping shape.
    const err = {
      status: 400,
      error: {
        type: 'invalid_request_error',
        message: 'prompt is too long: 1234567 tokens > 1000000 maximum',
      },
      message: 'BadRequestError',
    };
    expect(isPromptTooLongError(err)).toBe(true);
  });

  test('matches 400 + invalid_request_error + "exceed" wording (defensive)', () => {
    // Defensive against future SDK message-wording changes.
    const err = {
      status: 400,
      error: { type: 'invalid_request_error', message: 'request exceeds maximum context' },
      message: 'BadRequestError',
    };
    expect(isPromptTooLongError(err)).toBe(true);
  });

  test('matches 400 + request_too_large type', () => {
    const err = {
      status: 400,
      error: { type: 'request_too_large', message: 'too long' },
      message: 'BadRequestError',
    };
    expect(isPromptTooLongError(err)).toBe(true);
  });

  test('does NOT match unrelated 400 errors', () => {
    const err = {
      status: 400,
      error: { type: 'invalid_request_error', message: 'malformed JSON' },
      message: 'BadRequestError',
    };
    expect(isPromptTooLongError(err)).toBe(false);
  });

  test('does NOT match unrelated transient errors', () => {
    expect(isPromptTooLongError(new Error('network timeout'))).toBe(false);
    expect(isPromptTooLongError(new Error('rate limit exceeded'))).toBe(false);
    expect(isPromptTooLongError({ status: 500, message: 'internal error' })).toBe(false);
    expect(isPromptTooLongError({ status: 429, message: 'overloaded' })).toBe(false);
  });

  test('does NOT match null / undefined / non-error inputs', () => {
    expect(isPromptTooLongError(null)).toBe(false);
    expect(isPromptTooLongError(undefined)).toBe(false);
    expect(isPromptTooLongError(0)).toBe(false);
    expect(isPromptTooLongError('plain string')).toBe(false);
    expect(isPromptTooLongError({})).toBe(false);
  });

  test('matches synthetic SDK shape with status 400 + message containing the phrase', () => {
    // Some SDK versions surface the phrase only on the outer .message.
    const err = {
      status: 400,
      message: 'Error: prompt is too long: 2000000 tokens > 1000000 maximum',
    };
    expect(isPromptTooLongError(err)).toBe(true);
  });
});
