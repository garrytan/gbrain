/**
 * Shared ingress guards for the OAuth Streamable HTTP MCP route.
 *
 * Keep these outside serve-http.ts: body parsing, pre-auth IP throttling, and
 * post-auth client throttling are one transport boundary, not application
 * routing. The legacy bearer transport applies the same default cap and the
 * same RateLimiter implementation.
 */

import express from 'express';
import type { Request, RequestHandler } from 'express';
import type { AuthInfo } from '../core/operations.ts';
import { buildDefaultLimiters, type RateLimiter } from './rate-limit.ts';

export const DEFAULT_MCP_BODY_CAP = 12 * 1024 * 1024;

export function resolveMcpBodyCap(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number.parseInt(env.GBRAIN_HTTP_MAX_BODY_BYTES ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MCP_BODY_CAP;
}

export function buildMcpIngressGuards(options: {
  env?: NodeJS.ProcessEnv;
  limiters?: { ip: RateLimiter; token: RateLimiter };
} = {}): {
  preAuth: RequestHandler;
  parseJson: RequestHandler;
  postAuth: RequestHandler;
  bodyCap: number;
} {
  const bodyCap = resolveMcpBodyCap(options.env);
  const limiters = options.limiters ?? buildDefaultLimiters();
  const jsonParser = express.json({ limit: bodyCap, type: ['application/json', 'application/*+json'] });

  const preAuth: RequestHandler = (req, res, next) => {
    const rate = limiters.ip.check(req.ip || req.socket.remoteAddress || 'unknown');
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.retryAfter ?? 60));
      res.status(429).json({ error: 'rate_limited', message: 'Too many MCP requests' });
      return;
    }
    const declared = Number(req.get('content-length'));
    if (Number.isFinite(declared) && declared > bodyCap) {
      res.status(413).json({ error: 'payload_too_large', message: `Request body exceeds ${bodyCap} bytes` });
      return;
    }
    next();
  };

  const parseJson: RequestHandler = (req, res, next) => {
    jsonParser(req, res, (err?: unknown) => {
      if (!err) return next();
      const status = (err as { status?: number }).status === 413 ? 413 : 400;
      res.status(status).json({
        jsonrpc: '2.0',
        error: {
          code: status === 413 ? -32001 : -32700,
          message: status === 413 ? `Request body exceeds ${bodyCap} bytes` : 'Invalid JSON request body',
        },
        id: null,
      });
    });
  };

  const postAuth: RequestHandler = (req, res, next) => {
    const authInfo = (req as Request & { auth?: AuthInfo }).auth;
    const rate = limiters.token.check(authInfo?.clientId ?? 'unknown');
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.retryAfter ?? 60));
      res.status(429).json({ error: 'rate_limited', message: 'Too many MCP requests for this client' });
      return;
    }
    next();
  };

  return { preAuth, parseJson, postAuth, bodyCap };
}
