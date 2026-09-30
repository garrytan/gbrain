/**
 * OAuth surface of `gbrain serve --http`: CORS / preflight gates, the DCR TTL
 * hook, hash-only confidential client credentials, the MCP SDK auth router with
 * its discovery patches, the owner login-link handoff and owner consent.
 */
import express, { type Express, type NextFunction, type Request, type Response, type RequestHandler } from 'express';
import cors from 'cors';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { OAuthError, InvalidClientError, InvalidRequestError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { OAuthTokenRevocationRequestSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { dcrRegistrationContext, type GBrainOAuthProvider } from '../core/oauth-provider.ts';
import { OAuthConsentError } from '../core/oauth-grants.ts';
import { safeHexEqual } from '../core/timing-safe.ts';
import { isRetryableError } from '../core/retry-matcher.ts';
import { scopesSupportedForDiscovery } from '../core/scope.ts';
import { GRANT_PROFILES } from '../core/grants/model.ts';
import { publicHarnessMetadata } from '../core/harness/registry.ts';
import { mcpAdministrationGuidance } from '../mcp/capabilities.ts';
import { VERSION } from '../version.ts';
import type { ServeHttpContext } from './serve-http.ts';

/**
 * Parse `GBRAIN_HTTP_CORS_ORIGIN` into a Set of allowed origins for OAuth
 * endpoints. Mirrors `src/mcp/http-transport.ts:parseCorsAllowlist`. Single
 * env var so operators don't need to maintain two allowlists.
 *
 * Returns null when unset, empty, or whitespace-only — caller MUST treat
 * null as "deny all cross-origin" (the same posture the legacy transport
 * already takes).
 */
export function parseCorsAllowlistOAuth(): Set<string> | null {
  const v = process.env.GBRAIN_HTTP_CORS_ORIGIN;
  if (!v) return null;
  const origins = v.split(',').map(s => s.trim()).filter(Boolean);
  return origins.length === 0 ? null : new Set(origins);
}

/**
 * Build a `cors.CorsOptions['origin']` value from the allowlist. The cors
 * package accepts:
 *   - `false` → NOT an Allow-Origin header of "none"; cors@2.8.x treats a
 *     falsy `origin` option as "no CORS gate" and simply calls `next()`
 *     without setting or short-circuiting anything (see the mismatch note on
 *     `mountOAuthCorsGate` below). We keep `false` for the null-allowlist case
 *     because the gate is enforced by `mountOAuthCorsGate`, not by cors.
 *   - `(origin, cb) => cb(null, boolean)` → dynamic per-request check
 * We use the function form when an allowlist is set so the value of the
 * Allow-Origin header echoes the request Origin (RFC 6454) instead of a
 * hardcoded string, and so the same options object covers all listed
 * origins without enumeration in the response.
 *
 * Same-origin requests (no Origin header) get `cb(null, true)` which the
 * cors package translates to "no CORS headers needed" — they're not
 * cross-origin so they don't trigger the gate.
 */
export function resolveCorsOrigin(allowlist: Set<string> | null): cors.CorsOptions['origin'] {
  if (allowlist === null) return false;
  return (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin) return cb(null, true);
    cb(null, allowlist.has(origin));
  };
}

/**
 * Wrap the OAuth `cors()` middleware so it OWNS the preflight response and a
 * denied/default-deny origin can never fall through to a downstream handler
 * that answers OPTIONS with `Access-Control-Allow-Origin: *`.
 *
 * Why this is necessary (#3845): the MCP SDK's `mcpAuthRouter` mounts a bare
 * `cors()` (origin `*`) as the FIRST middleware on `/token`, `/revoke`, and
 * `/register` (see @modelcontextprotocol/sdk auth/handlers/{token,revoke,
 * register}). Our gate at `app.use('/token', cors(oauthOptions))` runs first,
 * but when the origin is denied — either the allowlist is unset (origin
 * `false`) or the request Origin is not on the allowlist — cors@2.8.x does NOT
 * emit a header and does NOT short-circuit; it just calls `next()`. Control
 * then reaches the SDK's bare `cors()`, which answers the OPTIONS preflight
 * with `*`, leaking the endpoint surface + methods to any web origin and
 * contradicting the documented default-deny posture.
 *
 * The wrapper closes that gap: cors() only reaches our callback when it did
 * NOT short-circuit the preflight itself (i.e. the origin was denied or the
 * request is a real, non-OPTIONS request). For a denied OPTIONS we terminate
 * with a header-free 204 so the SDK's cors never runs; real requests fall
 * through unchanged. Allowed origins are still short-circuited by cors() with
 * the reflected Origin, exactly as before.
 */
export function mountOAuthCorsGate(options: cors.CorsOptions): RequestHandler {
  const corsMiddleware = cors(options);
  return (req: Request, res: Response, next: NextFunction) => {
    corsMiddleware(req, res, (err?: unknown) => {
      if (err) return next(err as Error);
      if (req.method === 'OPTIONS') {
        // Default-deny preflight: no Allow-Origin header, no fall-through.
        res.statusCode = 204;
        res.setHeader('Content-Length', '0');
        return res.end();
      }
      return next();
    });
  };
}

/** Global OAuth wiring, in registration order: CORS gates, DCR TTL hook, /token + /revoke, SDK auth router, discovery. */
export function mountOAuth(app: Express, ctx: ServeHttpContext): void {
  const { bind, enableDcr, oauthProvider, ccRateLimiter, issuerUrl, mcpResourceUrl, resourceMetadataUrl } = ctx;
  // ---------------------------------------------------------------------------
  // CORS (v0.41.3, T7 — default-deny on every OAuth endpoint)
  // ---------------------------------------------------------------------------
  // Pre-v0.41.3 every OAuth endpoint used bare `cors()` which defaults to
  // `Access-Control-Allow-Origin: *` — any web origin could complete a token
  // exchange from a logged-in operator's browser. The fix parses
  // GBRAIN_HTTP_CORS_ORIGIN the same way the legacy transport already does
  // (src/mcp/http-transport.ts:parseCorsAllowlist) and gates every OAuth
  // surface behind the allowlist. When the env var is unset the OAuth
  // endpoints reject all cross-origin requests (default deny). Same-origin
  // requests are unaffected because browsers send no Origin header for them.
  //
  // The /admin SPA is the one cross-origin caller we expect on a personal
  // laptop install; it ships co-located with the brain and uses
  // same-origin XHR, so the lockdown doesn't break it.
  const corsAllowlistOAuth = parseCorsAllowlistOAuth();
  if (!corsAllowlistOAuth && bind === '0.0.0.0') {
    console.error(
      '[serve-http] WARNING: --bind 0.0.0.0 is set but GBRAIN_HTTP_CORS_ORIGIN is unset. OAuth endpoints will reject ALL cross-origin requests until you set the env var (comma-separated origins).',
    );
  }
  const corsOAuthOptions: cors.CorsOptions = {
    origin: resolveCorsOrigin(corsAllowlistOAuth),
    credentials: false,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  };
  app.use('/mcp', cors(corsOAuthOptions));
  app.use('/authorize', cors(corsOAuthOptions));
  // /token, /revoke and /register are shadowed by the MCP SDK's own bare
  // `cors()` (origin `*`) mounted inside mcpAuthRouter. A denied preflight must
  // be terminated here — a plain `cors(corsOAuthOptions)` would fall through to
  // the SDK's `*` (#3845). /mcp and /authorize are not shadowed (no downstream
  // cors), so they keep the plain gate.
  app.use('/token', mountOAuthCorsGate(corsOAuthOptions));
  app.use('/register', mountOAuthCorsGate(corsOAuthOptions));
  app.use('/revoke', mountOAuthCorsGate(corsOAuthOptions));

  // #2179: capture the optional `token_ttl_seconds` DCR extension field
  // BEFORE the SDK's /register handler runs — its request schema strips
  // unknown body members, so the value would never reach registerClient.
  // The rest of the chain runs inside dcrRegistrationContext; the clients
  // store clamps + persists it. Malformed values are ignored (fail-safe:
  // absent → server default; out-of-range → clamped downstream; a TTL hint
  // never rejects a registration). express.json() here is idempotent with
  // the SDK router's own body parser.
  app.use('/register', express.json(), (req: Request, _res: Response, next: NextFunction) => {
    const raw = (req.body as Record<string, unknown> | null | undefined)?.token_ttl_seconds;
    const tokenTtlSeconds = typeof raw === 'number' && Number.isFinite(raw) ? raw : undefined;
    dcrRegistrationContext.run({ tokenTtlSeconds }, next);
  });

  // ---------------------------------------------------------------------------
  // Custom client_credentials handler (before mcpAuthRouter)
  // SDK's token handler only supports authorization_code and refresh_token
  // ---------------------------------------------------------------------------
  mountConfidentialOAuth(app, oauthProvider, ccRateLimiter);

  // ---------------------------------------------------------------------------
  // MCP SDK Auth Router (OAuth endpoints)
  // ---------------------------------------------------------------------------
  const authRouterOptions: any = {
    provider: oauthProvider,
    issuerUrl,
    scopesSupported: scopesSupportedForDiscovery({ enableDcr }),
    resourceName: 'GBrain MCP Server',
    // Advertise /mcp as the protected resource (see mcpResourceUrl above).
    resourceServerUrl: mcpResourceUrl,
  };

  // F12: DCR disable lives on the provider's constructor option (buildServeHttpApp). The
  // SDK's mcpAuthRouter reads provider.clientsStore once and only wires up
  // /register when the store exposes registerClient — so passing dcrDisabled
  // to the constructor is sufficient. No monkey-patching here.

  const authRouter = mcpAuthRouter(authRouterOptions);

  // Patch the SDK's OAuth metadata to include client_credentials grant type.
  // The SDK hardcodes ['authorization_code', 'refresh_token'] — we intercept
  // the response and add client_credentials before it reaches the client.
  app.use((req, res, next) => {
    if (req.path === '/.well-known/oauth-authorization-server' && req.method === 'GET') {
      const origJson = res.json.bind(res);
      (res as any).json = (body: any) => {
        if (body?.grant_types_supported && !body.grant_types_supported.includes('client_credentials')) {
          body.grant_types_supported.push('client_credentials');
        }
        if (body?.token_endpoint_auth_methods_supported) {
          for (const method of ['client_secret_basic', 'none']) {
            if (!body.token_endpoint_auth_methods_supported.includes(method)) {
              body.token_endpoint_auth_methods_supported.push(method);
            }
          }
        }
        if (body?.revocation_endpoint_auth_methods_supported && !body.revocation_endpoint_auth_methods_supported.includes('client_secret_basic')) {
          body.revocation_endpoint_auth_methods_supported.push('client_secret_basic');
        }
        return origJson(body);
      };
    }
    next();
  });

  // Back-compat alias: with resourceServerUrl set the SDK mounts the PRM only
  // at the path-based URL, so clients that still probe the bare root (what
  // gbrain advertised before) would 404 mid-flight. Rewrite the root onto the
  // SDK's own handler — one document, same cors()/allowedMethods, no copy.
  const legacyPrmPath = '/.well-known/oauth-protected-resource';
  app.all(legacyPrmPath, (req: Request, _res: Response, next: NextFunction) => {
    req.url = new URL(resourceMetadataUrl).pathname;
    next();
  });

  app.use(authRouter);
  app.get('/.well-known/gbrain', (_req, res) => {
    res.json({ version: VERSION, protocol: 'mcp', endpoint: mcpResourceUrl.toString(), profiles: GRANT_PROFILES,
      adapters: publicHarnessMetadata(), administration: mcpAdministrationGuidance(mcpResourceUrl.toString()), documentation: 'https://github.com/garrytan/gbrain/blob/master/docs/mcp/README.md' });
  });
}

/** Owner login links: bootstrap-credential mint (POST /admin/api/issue-magic-link) and single-use redemption. */
export function mountOwnerLoginLinks(app: Express, ctx: ServeHttpContext): void {
  const { adminLimits, bootstrapHash, oauthProvider, issuerUrl, mcpResourceUrl, adminSessions, adminCookie, magicLinkNonces, consumedNonces } = ctx;
  // ---------------------------------------------------------------------------
  // Magic-link nonce store (single-use) — D11 + D12
  //
  // Trust model (codex review pushback resolved this):
  //   - Bootstrap token is the long-term server admin secret. Printed to
  //     stderr at startup; lives in operator's terminal scrollback only.
  //   - Magic-link URLs use one-time NONCES (not the bootstrap token).
  //     Agent calls POST /admin/api/issue-magic-link with the bootstrap
  //     token in Authorization: Bearer to mint a nonce. Nonce expires in
  //     5 minutes if unredeemed; consumed on first redemption.
  //   - Bootstrap token never appears in a URL → no leakage via browser
  //     history, proxy access logs, or Referer headers.
  //   - Cookie sessions are HttpOnly + SameSite=Strict, but the bootstrap
  //     token itself is never client-side-readable JS state (no
  //     localStorage/sessionStorage cache — D12).
  //
  // Memory bound: nonces auto-purged on expiry sweep + LRU cap of 1000
  // entries (an attacker minting millions can't OOM the server).
  // ---------------------------------------------------------------------------
  const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const NONCE_LRU_CAP = 1000;

  // Best-effort GC: remove expired entries on each issue/redeem call.
  function pruneExpiredNonces() {
    const now = Date.now();
    for (const [nonce, expiresAt] of magicLinkNonces) {
      if (expiresAt < now) magicLinkNonces.delete(nonce);
    }
    // F10: bound the live-nonce store too. An attacker with the bootstrap
    // token (or a misbehaving agent) could mint nonces faster than they
    // expire. Map iteration order is insertion order, so dropping from the
    // front gives a simple FIFO eviction matching the consumedNonces pattern.
    if (magicLinkNonces.size > NONCE_LRU_CAP) {
      const drop = magicLinkNonces.size - NONCE_LRU_CAP;
      const it = magicLinkNonces.keys();
      for (let i = 0; i < drop; i++) magicLinkNonces.delete(it.next().value as string);
    }
    // Cap consumedNonces growth — drop oldest entries past the LRU cap.
    if (consumedNonces.size > NONCE_LRU_CAP) {
      const drop = consumedNonces.size - NONCE_LRU_CAP;
      const it = consumedNonces.values();
      for (let i = 0; i < drop; i++) consumedNonces.delete(it.next().value as string);
    }
  }

  // POST /admin/api/issue-magic-link — agent-callable mint endpoint.
  // Auth: Authorization: Bearer <bootstrapToken>. Returns one-time nonce.
  // Credential verification shares the authentication limits, never the consent bucket.
  app.post('/admin/api/issue-magic-link', adminLimits.total, adminLimits.failures, express.json(), (req: Request, res: Response) => {
    const auth = (req.headers.authorization || '') as string;
    const m = auth.match(/^Bearer\s+(\S+)$/i);
    if (!m) {
      res.status(401).json({ error: 'Authorization: Bearer <bootstrap-token> required' });
      return;
    }
    const tokenHash = createHash('sha256').update(m[1]).digest('hex');
    if (!safeHexEqual(tokenHash, bootstrapHash)) {
      res.status(401).json({ error: 'Invalid bootstrap token' });
      return;
    }
    res.locals.ownerAuthenticated = true;
    const pendingId = req.body?.oauth_request;
    if (pendingId !== undefined && !oauthProvider.grants.hasPending(pendingId)) {
      res.status(410).json({ error: 'authorization_unavailable', stage: 'consent', outcome: 'failed',
        message: 'This OAuth request expired, completed, or the server restarted.',
        next_action: 'Restart authorization in the native client, then request an owner login link with the new pending-request ID.' });
      return;
    }
    pruneExpiredNonces();
    const nonce = randomBytes(32).toString('hex');
    magicLinkNonces.set(nonce, Date.now() + NONCE_TTL_MS);
    const link = new URL(`/admin/auth/${nonce}`, issuerUrl);
    if (pendingId !== undefined) link.searchParams.set('oauth_request', pendingId);
    res.json({ url: link.toString(), expires_in: NONCE_TTL_MS / 1000 });
  });

  // GET /admin/auth/:nonce — single-use magic link redemption.
  // Browser hits it, server validates the nonce (exists + unconsumed +
  // unexpired), marks consumed, sets cookie, redirects to dashboard.
  // Successful nonce verification does not consume the failed-auth allowance.
  app.get('/admin/auth/:token', adminLimits.total, adminLimits.failures, (req: Request, res: Response) => {
    const nonce = String(req.params.token ?? '');
    pruneExpiredNonces();

    const expiresAt = magicLinkNonces.get(nonce);
    const isValid = !!nonce && !!expiresAt && expiresAt > Date.now() && !consumedNonces.has(nonce);

    if (!isValid) {
      res.status(401).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>GBrain</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.box{max-width:400px;padding:32px;text-align:left}
.logo{font-size:28px;font-weight:600;margin-bottom:24px}
.msg{color:#888;font-size:14px;line-height:1.6;margin-bottom:20px}
.hint{background:rgba(136,170,255,0.08);border:1px solid rgba(136,170,255,0.2);border-radius:8px;padding:14px 16px;font-size:13px;line-height:1.5;color:#888}
.hint b{color:#e0e0e0}
.prompt{background:rgba(0,0,0,0.3);border-radius:6px;padding:8px 12px;margin-top:8px;font-family:monospace;font-size:12px;color:#88aaff}
</style></head><body><div class="box">
<div class="logo">GBrain</div>
<div class="msg">⚠️ This admin link has expired, was already used, or the server has restarted.</div>
<div class="hint"><b>Ask the server administrator or the harness hosting this server for a fresh link:</b>
<div class="prompt">Run gbrain mcp admin login-link --url ${mcpResourceUrl.toString().replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))} using the protected owner credential. If connecting OAuth, restart authorization in the native client and include its new --oauth-request ID.</div>
</div></div></body></html>`);
      return;
    }

    res.locals.ownerAuthenticated = true;
    // Consume the nonce — it's single-use, second click will fail.
    magicLinkNonces.delete(nonce);
    consumedNonces.add(nonce);

    res.locals.ownerAuthenticated = true;
    const sessionId = randomBytes(32).toString('hex');
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days for magic link
    adminSessions.set(sessionId, sessionExpiresAt);

    res.cookie('gbrain_admin', sessionId, adminCookie(req, 7 * 24 * 60 * 60 * 1000));
    const pendingId = req.query.oauth_request;
    if (pendingId !== undefined && !oauthProvider.grants.hasPending(pendingId)) {
      res.status(410).send('This OAuth request expired, completed, or the server restarted. Restart authorization in the native client and ask the server administrator for a new login link with the new pending-request ID.');
      return;
    }
    res.redirect(oauthProvider.grants.hasPending(pendingId)
      ? `/admin/?oauth_request=${pendingId}#oauth-consent` : '/admin/');
  });
}

export function withBearerScopeHint(middleware: RequestHandler, scopes: readonly string[]): RequestHandler {
  const scope = scopes.join(' ');
  return async (req, res, next) => {
    const originalSet = res.set;
    res.set = function (this: Response, field: string | Record<string, string | string[]>, value?: string | string[]) {
      if (typeof field === 'string'
        && field.toLowerCase() === 'www-authenticate'
        && typeof value === 'string'
        && /^Bearer(?:\s|$)/i.test(value)
        && !/(?:^|,)\s*scope=/i.test(value)) {
        value += `, scope="${scope}"`;
      }
      if (typeof field === 'string') {
        return originalSet.call(this, field, value as string);
      }
      return originalSet.bind(this)(field);
    } as typeof res.set;
    try {
      await middleware(req, res, next);
    } finally {
      res.set = originalSet;
    }
  };
}

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
