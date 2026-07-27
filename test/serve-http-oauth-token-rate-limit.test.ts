/**
 * Tests for resolveOAuthTokenRateLimit() in src/commands/serve-http.ts.
 *
 * The /token client_credentials limiter should keep the historical default
 * while letting operators tune busy remote MCP hosts without patching source.
 */

import { describe, test, expect } from 'bun:test';
import { resolveOAuthTokenRateLimit } from '../src/commands/serve-http.ts';

describe('resolveOAuthTokenRateLimit', () => {
  test('unset env keeps the historical 50 requests per 15 minutes default', () => {
    expect(resolveOAuthTokenRateLimit({})).toEqual({
      windowMs: 15 * 60 * 1000,
      max: 50,
    });
  });

  test('env overrides allow a busy host to use 200 requests per minute', () => {
    expect(resolveOAuthTokenRateLimit({
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS: '60000',
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX: '200',
    })).toEqual({
      windowMs: 60_000,
      max: 200,
    });
  });

  test('blank, non-numeric, zero, and negative values fall back safely', () => {
    expect(resolveOAuthTokenRateLimit({
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS: '',
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX: 'nope',
    })).toEqual({
      windowMs: 15 * 60 * 1000,
      max: 50,
    });

    expect(resolveOAuthTokenRateLimit({
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_WINDOW_MS: '0',
      GBRAIN_OAUTH_TOKEN_RATE_LIMIT_MAX: '-10',
    })).toEqual({
      windowMs: 15 * 60 * 1000,
      max: 50,
    });
  });
});
