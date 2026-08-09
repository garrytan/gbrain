/**
 * Tests for resolveOAuthTokenRateLimit() in src/commands/serve-http.ts.
 *
 * The /token client_credentials limiter should keep the historical default
 * while letting operators tune busy remote MCP hosts without patching source.
 */

import { describe, test, expect } from 'bun:test';
import { once } from 'node:events';
import express from 'express';
import {
  createOAuthTokenRateLimiter,
  isLoopbackClientIp,
  resolveOAuthTokenRateLimit,
} from '../src/commands/serve-http.ts';

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

describe('isLoopbackClientIp', () => {
  test('accepts IPv4, IPv6, expanded IPv6, and IPv4-mapped loopback clients', () => {
    expect(isLoopbackClientIp('127.0.0.1')).toBe(true);
    expect(isLoopbackClientIp('127.255.255.254')).toBe(true);
    expect(isLoopbackClientIp('::1')).toBe(true);
    expect(isLoopbackClientIp('0:0:0:0:0:0:0:1')).toBe(true);
    expect(isLoopbackClientIp('::ffff:127.0.0.1')).toBe(true);
  });

  test('rejects public, private-LAN, malformed, and missing client addresses', () => {
    expect(isLoopbackClientIp('203.0.113.10')).toBe(false);
    expect(isLoopbackClientIp('192.168.1.10')).toBe(false);
    expect(isLoopbackClientIp('::ffff:203.0.113.10')).toBe(false);
    expect(isLoopbackClientIp('not-an-ip')).toBe(false);
    expect(isLoopbackClientIp(undefined)).toBe(false);
  });
});

describe('createOAuthTokenRateLimiter', () => {
  test('bypasses direct loopback traffic while limiting public and spoofed-loopback forwarding', async () => {
    const app = express();
    app.set('trust proxy', 'loopback');
    app.post(
      '/token',
      createOAuthTokenRateLimiter({ windowMs: 60_000, max: 2 }),
      (_req, res) => res.status(204).end(),
    );
    app.post(
      '/forwarded-token',
      createOAuthTokenRateLimiter({ windowMs: 60_000, max: 2 }),
      (_req, res) => res.status(204).end(),
    );
    app.post(
      '/public-token',
      createOAuthTokenRateLimiter(
        { windowMs: 60_000, max: 2 },
        { allowLoopbackBypass: false },
      ),
      (_req, res) => res.status(204).end(),
    );
    app.post(
      '/browser-origin-token',
      createOAuthTokenRateLimiter({ windowMs: 60_000, max: 2 }),
      (_req, res) => res.status(204).end(),
    );
    app.post(
      '/browser-fetch-token',
      createOAuthTokenRateLimiter({ windowMs: 60_000, max: 2 }),
      (_req, res) => res.status(204).end(),
    );

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP test server');
    const tokenUrl = `http://127.0.0.1:${address.port}/token`;

    try {
      const directStatuses = await Promise.all(
        Array.from({ length: 3 }, async () => (await fetch(tokenUrl, { method: 'POST' })).status),
      );
      expect(directStatuses).toEqual([204, 204, 204]);

      const proxiedStatuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        proxiedStatuses.push((await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'X-Forwarded-For': '203.0.113.10' },
        })).status);
      }
      expect(proxiedStatuses).toEqual([204, 204, 429]);

      const spoofedLoopbackStatuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        spoofedLoopbackStatuses.push((await fetch(tokenUrl, {
          method: 'POST',
          headers: { 'X-Forwarded-For': '127.0.0.1' },
        })).status);
      }
      expect(spoofedLoopbackStatuses).toEqual([204, 204, 429]);

      const forwardedStatuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        forwardedStatuses.push((await fetch(`${tokenUrl.replace('/token', '/forwarded-token')}`, {
          method: 'POST',
          headers: { Forwarded: 'for=203.0.113.10;proto=https' },
        })).status);
      }
      expect(forwardedStatuses).toEqual([204, 204, 429]);

      const browserOriginStatuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        browserOriginStatuses.push((await fetch(tokenUrl.replace('/token', '/browser-origin-token'), {
          method: 'POST',
          headers: { Origin: 'https://attacker.example' },
        })).status);
      }
      expect(browserOriginStatuses).toEqual([204, 204, 429]);

      const browserFetchStatuses: number[] = [];
      for (let i = 0; i < 3; i++) {
        browserFetchStatuses.push((await fetch(tokenUrl.replace('/token', '/browser-fetch-token'), {
          method: 'POST',
          headers: { 'Sec-Fetch-Site': 'cross-site' },
        })).status);
      }
      expect(browserFetchStatuses).toEqual([204, 204, 429]);

      const publicDeploymentStatuses = await Promise.all(
        Array.from({ length: 3 }, async () => (await fetch(
          tokenUrl.replace('/token', '/public-token'),
          { method: 'POST' },
        )).status),
      );
      expect(publicDeploymentStatuses).toEqual([204, 204, 429]);
    } finally {
      server.close();
      await once(server, 'close');
    }
  });
});
