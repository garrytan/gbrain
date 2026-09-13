/** HTTP adapters for owner consent and hash-only confidential client credentials. */
import express, { type Express, type Request, type Response, type RequestHandler } from 'express';
import { createHmac, randomBytes } from 'node:crypto';
import { OAuthError, InvalidClientError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthTokenRevocationRequestSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { GBrainOAuthProvider } from '../core/oauth-provider.ts';
import { OAuthConsentError } from '../core/oauth-grants.ts';
import { safeHexEqual } from '../core/timing-safe.ts';
import { isRetryableError } from '../core/retry-matcher.ts';

function sendOAuthError(res: Response, error: unknown): void {
  if (error instanceof OAuthError) {
    res.status(error instanceof InvalidClientError ? 401 : 400).json(error.toResponseObject());
    return;
  }
  const retryable = isRetryableError(error);
  res.status(retryable ? 503 : 500).json({
    error: retryable ? 'temporarily_unavailable' : 'server_error',
    error_description: retryable ? 'Authorization temporarily unavailable' : 'Authorization failed',
  });
}

function confidentialCredentials(req: Request): { clientId: string; secret: string; basic: boolean } | undefined {
  const clientId = req.body?.client_id;
  const secret = req.body?.client_secret;
  const header = req.headers.authorization ?? '';
  const basic = /^Basic\b/i.test(header);
  if ((clientId !== undefined && typeof clientId !== 'string') || (secret !== undefined && typeof secret !== 'string')
    || (basic && (clientId !== undefined || secret !== undefined))) throw new InvalidRequestError('Malformed or mixed client authentication');
  if (basic) {
    try {
      const encoded = /^Basic\s+([A-Za-z0-9+/]+={0,2})$/i.exec(header)?.[1];
      if (!encoded) throw new Error();
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 1) throw new Error();
      const id = decodeURIComponent(decoded.slice(0, separator).replace(/\+/g, ' '));
      const password = decodeURIComponent(decoded.slice(separator + 1).replace(/\+/g, ' '));
      if (!password) throw new Error();
      return { clientId: id, secret: password, basic: true };
    } catch { throw new InvalidClientError('Invalid client'); }
  }
  if (typeof secret === 'string') {
    if (!clientId || !secret) throw new InvalidClientError('Invalid client');
    return { clientId, secret, basic: false };
  }
  return undefined;
}

function stringParam(req: Request, name: string, required = false): string | undefined {
  const value = req.body?.[name];
  if (value === undefined && !required) return undefined;
  if (typeof value !== 'string' || (required && !value)) throw new InvalidRequestError(`${name} must be a non-empty string`);
  return value;
}

export function mountConfidentialOAuth(app: Express, provider: GBrainOAuthProvider, rateLimiter: RequestHandler): void {
  app.post('/token', rateLimiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    try {
      const grant = stringParam(req, 'grant_type');
      const credentials = confidentialCredentials(req);
      if (!credentials) {
        if (grant === 'client_credentials') throw new InvalidClientError('Confidential client authentication required');
        return next(); // SDK public-client path; provider owns PKCE verification.
      }
      const client = await provider.verifyConfidentialClientSecret(credentials.clientId, credentials.secret);
      let resource: URL | undefined;
      const requestedResource = stringParam(req, 'resource');
      if (requestedResource !== undefined) {
        try { resource = new URL(requestedResource); } catch { throw new InvalidRequestError('Invalid resource URL'); }
      }
      const scope = stringParam(req, 'scope');
      if (grant === 'client_credentials') {
        res.json(await provider.exchangeClientCredentials(credentials.clientId, credentials.secret, scope));
      } else if (grant === 'authorization_code') {
        res.json(await provider.exchangeAuthorizationCode(client, stringParam(req, 'code', true)!, stringParam(req, 'code_verifier'), stringParam(req, 'redirect_uri'), resource));
      } else if (grant === 'refresh_token') {
        res.json(await provider.exchangeRefreshToken(client, stringParam(req, 'refresh_token', true)!, scope === undefined ? undefined : scope.split(/\s+/).filter(Boolean), resource));
      } else return next();
    } catch (error) { sendOAuthError(res, error); }
  });

  app.post('/revoke', rateLimiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const credentials = confidentialCredentials(req);
      if (!credentials) return next();
      const parsed = OAuthTokenRevocationRequestSchema.safeParse(req.body);
      if (!parsed.success || !parsed.data.token) throw new InvalidRequestError('Valid token required');
      const client = await provider.verifyConfidentialClientSecret(credentials.clientId, credentials.secret);
      await provider.revokeToken(client, parsed.data);
      res.status(200).end();
    } catch (error) {
      if (error instanceof InvalidClientError && /^Basic\b/i.test(req.headers.authorization ?? '')) res.setHeader('WWW-Authenticate', 'Basic realm="gbrain"');
      sendOAuthError(res, error);
    }
  });
}

export function mountOAuthConsent(app: Express, provider: GBrainOAuthProvider, requireAdmin: RequestHandler, rateLimiter: RequestHandler): void {
  app.use((req, res, next) => {
    if (req.path.startsWith('/admin')) {
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('X-Frame-Options', 'DENY');
    }
    next();
  });
  const csrfKey = randomBytes(32);
  const csrfFor = (req: Request, id: string): string => createHmac('sha256', csrfKey)
    .update(String(req.cookies?.gbrain_admin ?? '')).update('\0').update(id).digest('hex');
  const handleError = (res: Response, error: unknown): void => {
    if (error instanceof OAuthConsentError) {
      res.status(error.status).json({ error: error.code, message: error.message });
    } else if (error instanceof InvalidClientError) {
      res.status(409).json({ error: 'client_unavailable', message: 'This client was revoked. Restart the connection from your client.' });
    } else {
      res.status(isRetryableError(error) ? 503 : 500).json({ error: 'authorization_failed', message: 'Approval could not be completed. Restart the connection from your client.' });
    }
  };
  app.get('/admin/api/oauth-requests/:id', requireAdmin, rateLimiter, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const id = String(req.params.id);
      res.json({ ...provider.grants.details(id), csrf: csrfFor(req, id) });
    } catch (error) { handleError(res, error); }
  });
  app.post('/admin/api/oauth-requests/:id', requireAdmin, rateLimiter, express.json(), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(req.params.id);
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'decision' && key !== 'csrf')
      || (body.decision !== 'approve' && body.decision !== 'deny')
      || typeof body.csrf !== 'string' || !/^[a-f0-9]{64}$/.test(body.csrf)
      || !safeHexEqual(body.csrf, csrfFor(req, id))) {
      res.status(403).json({ error: 'invalid_consent', message: 'Reload this request and review it again before approving.' });
      return;
    }
    try {
      res.json({ redirectUrl: await provider.grants.decide(id, body.decision === 'approve') });
    } catch (error) { handleError(res, error); }
  });
}
