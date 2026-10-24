/**
 * Tests for resolveOAuthTokenRateLimit() in src/commands/serve-http.ts and
 * createOAuthTokenRateLimiter() in src/commands/serve-http-oauth.ts.
 *
 * The /token client_credentials limiter should keep the historical default
 * while letting operators tune busy remote MCP hosts without patching source,
 * and should count failed authentications only (createOAuthTokenRateLimiter).
 */

import { describe, test, expect } from 'bun:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { resolveOAuthTokenRateLimit } from '../src/commands/serve-http.ts';
import { createOAuthTokenRateLimiter } from '../src/commands/serve-http-oauth.ts';

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

describe('createOAuthTokenRateLimiter', () => {
  // A brute-force guard: successful client_credentials mints must not count,
  // or a thin client that mints per CLI call locks itself out (#2463).
  test('successful mints do not count; failed authentications do', async () => {
    const app = express();
    app.post('/token', createOAuthTokenRateLimiter({ windowMs: 60_000, max: 5 }), express.urlencoded({ extended: false }), (req, res) => {
      if (req.body?.client_secret === 'right') {
        res.json({ access_token: 'tok', token_type: 'bearer', expires_in: 3600 });
        return;
      }
      res.status(400).json({ error: 'invalid_grant', error_description: 'Invalid client credentials' });
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', () => resolve()));
    const { port } = server.address() as AddressInfo;
    const mint = async (secret: string) => {
      const res = await fetch(`http://127.0.0.1:${port}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'cid', client_secret: secret }),
      });
      await res.arrayBuffer();
      return res.status;
    };
    try {
      // Sequential: the skip is applied as each response finishes.
      for (let i = 0; i < 12; i++) expect(await mint('right')).toBe(200);
      for (let i = 0; i < 5; i++) expect(await mint('wrong')).toBe(400);
      expect(await mint('wrong')).toBe(429);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
