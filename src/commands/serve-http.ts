/**
 * GBrain HTTP MCP server with OAuth 2.1.
 *
 * Combines:
 * - MCP SDK's mcpAuthRouter (OAuth endpoints: /authorize, /token, /register, /revoke)
 * - Custom client_credentials handler (SDK doesn't support CC grant)
 * - MCP tool calls at /mcp with bearer auth + scope enforcement
 * - Admin dashboard at /admin with cookie auth
 * - SSE live activity feed at /admin/events
 * - Health check at /health
 */

import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { randomBytes, createHash, timingSafeEqual } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { OperationContext, AuthInfo } from '../core/operations.ts';
import { GBrainOAuthProvider } from '../core/oauth-provider.ts';
import { loadConfig } from '../core/config.ts';
import { VERSION } from '../version.ts';
import * as db from '../core/db.ts';

interface ServeHttpOptions {
  port: number;
  tokenTtl: number;
  enableDcr: boolean;
  /**
   * Public URL the server is reachable at (e.g., https://brain.example.com).
   * Used as the OAuth issuer in discovery metadata. Defaults to
   * http://localhost:{port} when unset. Required for production deployments
   * behind reverse proxies, ngrok tunnels, or any non-loopback URL — the
   * issuer claim in tokens MUST match the discovery URL clients hit.
   */
  publicUrl?: string;
}

export async function runServeHttp(engine: BrainEngine, options: ServeHttpOptions) {
  const { port, tokenTtl, enableDcr, publicUrl } = options;
  const config = loadConfig() || { engine: 'pglite' as const };

  // Get raw SQL connection for OAuth provider
  const sql = db.getConnection();

  // Initialize OAuth provider
  const oauthProvider = new GBrainOAuthProvider({
    sql: sql as any,
    tokenTtl,
  });

  // Sweep expired tokens on startup (non-blocking)
  try {
    const swept = await oauthProvider.sweepExpiredTokens();
    if (swept > 0) console.error(`Swept ${swept} expired tokens`);
  } catch (e) {
    console.error('Token sweep failed (non-blocking):', e instanceof Error ? e.message : e);
  }

  // Generate bootstrap token for admin dashboard
  const bootstrapToken = randomBytes(32).toString('hex');
  const bootstrapHash = createHash('sha256').update(bootstrapToken).digest('hex');
  const adminSessions = new Map<string, number>(); // sessionId → expiresAt

  // SSE clients for live activity feed
  const sseClients = new Set<express.Response>();

  // Broadcast MCP request event to all SSE clients
  function broadcastEvent(event: Record<string, unknown>) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of sseClients) {
      try { client.write(data); } catch { sseClients.delete(client); }
    }
  }

  // Express 5 app
  const app = express();
  app.set('trust proxy', 'loopback'); // Caddy/Tailscale reverse proxy on localhost

  // ---------------------------------------------------------------------------
  // Cookie parsing — required for /admin auth (express 5 has no built-in)
  // ---------------------------------------------------------------------------
  app.use(cookieParser());

  // ---------------------------------------------------------------------------
  // CORS
  // ---------------------------------------------------------------------------
  app.use('/mcp', cors());
  app.use('/token', cors());
  app.use('/authorize', cors());
  app.use('/register', cors());
  app.use('/revoke', cors());

  // ---------------------------------------------------------------------------
  // Custom client_credentials handler (before mcpAuthRouter)
  // SDK's token handler only supports authorization_code and refresh_token
  // ---------------------------------------------------------------------------
  const ccRateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'too_many_requests', error_description: 'Rate limit exceeded. Try again in 15 minutes.' },
  });

  // Magic-link rate limiter: 10 requests/min/IP. The bootstrap token is
  // 64-char hex (unguessable) so brute-forcing is computationally
  // infeasible — but a misconfigured client looping on /admin/auth/:bad
  // could DoS the server's CPU on sha256 + the inline HTML response.
  // Defense-in-depth on the highest-privileged URL the server exposes.
  const adminAuthRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: 'Too many magic-link attempts. Wait a minute before trying again.',
  });

  app.post('/token', ccRateLimiter, express.urlencoded({ extended: false }), async (req, res, next) => {
    if (req.body?.grant_type !== 'client_credentials') {
      return next(); // Fall through to SDK's token handler
    }

    try {
      const { client_id, client_secret, scope } = req.body;
      if (!client_id || !client_secret) {
        res.status(400).json({ error: 'invalid_request', error_description: 'client_id and client_secret required' });
        return;
      }

      const tokens = await oauthProvider.exchangeClientCredentials(client_id, client_secret, scope);
      res.json(tokens);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      res.status(400).json({ error: 'invalid_grant', error_description: msg });
    }
  });

  // ---------------------------------------------------------------------------
  // MCP SDK Auth Router (OAuth endpoints)
  // ---------------------------------------------------------------------------
  // The issuer URL goes into discovery metadata + token iss claims. It MUST
  // match the URL clients actually hit, or strict OAuth clients reject tokens
  // (RFC 8414 §3.3). Honor --public-url for production deployments behind
  // reverse proxies / tunnels; default to localhost for dev.
  const issuerUrl = new URL(publicUrl || `http://localhost:${port}`);

  const authRouterOptions: any = {
    provider: oauthProvider,
    issuerUrl,
    scopesSupported: ['read', 'write', 'admin'],
    resourceName: 'GBrain MCP Server',
  };

  // Disable DCR by removing registerClient from the clients store
  if (!enableDcr) {
    // Override the provider's clientsStore to remove registerClient
    const originalStore = oauthProvider.clientsStore;
    (oauthProvider as any)._clientsStore = {
      getClient: originalStore.getClient.bind(originalStore),
      // No registerClient = DCR disabled
    };
  }

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
        return origJson(body);
      };
    }
    next();
  });

  app.use(authRouter);

  // ---------------------------------------------------------------------------
  // Health check
  // ---------------------------------------------------------------------------
  app.get('/health', async (_req, res) => {
    try {
      const stats = await engine.getStats();
      res.json({ status: 'ok', version: VERSION, engine: config.engine, ...stats });
    } catch {
      res.status(503).json({ error: 'service_unavailable', error_description: 'Database connection failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // Admin authentication (cookie-based)
  // ---------------------------------------------------------------------------
  // POST /admin/login — JSON body with token (for programmatic/UI login)
  // Constant-time hex compare. Both inputs are sha256 hex (64 chars),
  // so they're always equal length. timingSafeEqual throws on length
  // mismatch — we already short-circuit on non-string above. Catches
  // would-be timing oracles even though the inputs are pre-hashed
  // (defense-in-depth on the hash bits).
  function safeHexEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  }

  app.post('/admin/login', express.json(), (req, res) => {
    const token = req.body?.token;
    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token required' });
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (!safeHexEqual(tokenHash, bootstrapHash)) {
      res.status(401).json({ error: 'Invalid token. Check your terminal output.' });
      return;
    }

    const sessionId = randomBytes(32).toString('hex');
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
    adminSessions.set(sessionId, expiresAt);

    res.cookie('gbrain_admin', sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000,
      path: '/admin',
    });
    res.json({ status: 'authenticated' });
  });

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
  const magicLinkNonces = new Map<string, number>(); // nonce → expiresAt
  const consumedNonces = new Set<string>();
  const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  const NONCE_LRU_CAP = 1000;

  // Best-effort GC: remove expired entries on each issue/redeem call.
  function pruneExpiredNonces() {
    const now = Date.now();
    for (const [nonce, expiresAt] of magicLinkNonces) {
      if (expiresAt < now) magicLinkNonces.delete(nonce);
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
  app.post('/admin/api/issue-magic-link', express.json(), (req: Request, res: Response) => {
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
    pruneExpiredNonces();
    const nonce = randomBytes(32).toString('hex');
    magicLinkNonces.set(nonce, Date.now() + NONCE_TTL_MS);
    const baseUrl = publicUrl || `http://localhost:${port}`;
    res.json({ url: `${baseUrl}/admin/auth/${nonce}`, expires_in: NONCE_TTL_MS / 1000 });
  });

  // GET /admin/auth/:nonce — single-use magic link redemption.
  // Browser hits it, server validates the nonce (exists + unconsumed +
  // unexpired), marks consumed, sets cookie, redirects to dashboard.
  // Rate-limited at 10/min/IP to harden against DoS via bad-token loops.
  app.get('/admin/auth/:token', adminAuthRateLimiter, (req: Request, res: Response) => {
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
<div class="hint"><b>Get a fresh link from your AI agent:</b>
<div class="prompt">&ldquo;Give me the GBrain admin login link&rdquo;</div>
</div></div></body></html>`);
      return;
    }

    // Consume the nonce — it's single-use, second click will fail.
    magicLinkNonces.delete(nonce);
    consumedNonces.add(nonce);

    const sessionId = randomBytes(32).toString('hex');
    const sessionExpiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000; // 7 days for magic link
    adminSessions.set(sessionId, sessionExpiresAt);

    res.cookie('gbrain_admin', sessionId, {
      httpOnly: true,
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/admin',
    });
    res.redirect('/admin/');
  });

  // Admin auth middleware
  function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
    const sessionId = (req.cookies as Record<string, string>)?.gbrain_admin;
    if (!sessionId || !adminSessions.has(sessionId)) {
      res.status(401).json({ error: 'Admin authentication required' });
      return;
    }
    const expiresAt = adminSessions.get(sessionId)!;
    if (Date.now() > expiresAt) {
      adminSessions.delete(sessionId);
      res.status(401).json({ error: 'Session expired' });
      return;
    }
    next();
  }

  // ---------------------------------------------------------------------------
  // Admin API endpoints
  // ---------------------------------------------------------------------------

  // Sign-out-everywhere: nuke ALL active admin sessions in-memory. Every
  // browser/tab fails its next request, gets 401, redirects to login.
  // The bootstrap token itself is unaffected (still valid for new
  // magic-link mints) — this only revokes existing cookie sessions.
  app.post('/admin/api/sign-out-everywhere', requireAdmin, (_req: Request, res: Response) => {
    const count = adminSessions.size;
    adminSessions.clear();
    res.json({ revoked_sessions: count });
  });

  app.get('/admin/api/agents', requireAdmin, async (_req: Request, res: Response) => {
    try {
      // Unified view: OAuth clients + legacy API keys
      const oauthClients = await sql`
        SELECT c.client_id as id, c.client_name as name, 'oauth' as auth_type,
          c.grant_types, c.scope, c.created_at, c.token_ttl,
          CASE WHEN c.deleted_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          (SELECT max(created_at) FROM mcp_request_log WHERE token_name = c.client_id) as last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = c.client_id AND created_at > now() - interval '24 hours') as requests_today
        FROM oauth_clients c ORDER BY c.created_at DESC
      `;
      const legacyKeys = await sql`
        SELECT a.id, a.name, 'api_key' as auth_type,
          '{"bearer"}' as grant_types, 'read write admin' as scope, a.created_at, null as token_ttl,
          CASE WHEN a.revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status,
          a.last_used_at,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name) as total_requests,
          (SELECT count(*)::int FROM mcp_request_log WHERE token_name = a.name AND created_at > now() - interval '24 hours') as requests_today
        FROM access_tokens a ORDER BY a.created_at DESC
      `;
      res.json([...oauthClients, ...legacyKeys]);
    } catch (e) {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/stats', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const [clients] = await sql`SELECT count(*)::int as count FROM oauth_clients`;
      const [tokens] = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > ${Math.floor(Date.now() / 1000)}`;
      const [requests] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`;
      const [apiKeys] = await sql`SELECT count(*)::int as count FROM access_tokens WHERE revoked_at IS NULL`;
      res.json({
        connected_agents: (clients as any).count,
        active_tokens: (tokens as any).count,
        active_api_keys: (apiKeys as any).count,
        requests_today: (requests as any).count,
      });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/health-indicators', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const now = Math.floor(Date.now() / 1000);
      const [expiring] = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at BETWEEN ${now} AND ${now + 86400}`;
      const [errors] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE status != 'success' AND created_at > now() - interval '24 hours'`;
      const [total] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`;
      const errorRate = (total as any).count > 0 ? ((errors as any).count / (total as any).count * 100).toFixed(1) : '0';
      res.json({
        expiring_soon: (expiring as any).count,
        error_rate: `${errorRate}%`,
      });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/requests', requireAdmin, async (req: Request, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = 50;
      const offset = (page - 1) * limit;
      const agent = req.query.agent as string;
      const operation = req.query.operation as string;
      const status = req.query.status as string;

      // Dynamic filtering via postgres.js tagged-template fragments.
      // Each filter expands to either `AND col = $N` (parameterized) or
      // an empty fragment. `WHERE 1=1` lets us always have a WHERE clause
      // and unconditionally append AND-prefixed fragments — no string
      // interpolation, no manual escaping, no sql.unsafe.
      const agentFilter = agent && agent !== 'all' ? sql`AND token_name = ${agent}` : sql``;
      const opFilter = operation && operation !== 'all' ? sql`AND operation = ${operation}` : sql``;
      const statusFilter = status && status !== 'all' ? sql`AND status = ${status}` : sql``;

      const rows = await sql`
        SELECT id, token_name, COALESCE(agent_name, token_name) as agent_name,
               operation, latency_ms, status, params, error_message, created_at
        FROM mcp_request_log
        WHERE 1=1 ${agentFilter} ${opFilter} ${statusFilter}
        ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
      const [countResult] = await sql`
        SELECT count(*)::int as total FROM mcp_request_log
        WHERE 1=1 ${agentFilter} ${opFilter} ${statusFilter}
      `;
      res.json({ rows, total: (countResult as any).total, page, pages: Math.ceil((countResult as any).total / limit) });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // Legacy API keys (access_tokens table)
  app.get('/admin/api/api-keys', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const keys = await sql`
        SELECT id, name, created_at, last_used_at,
          CASE WHEN revoked_at IS NOT NULL THEN 'revoked' ELSE 'active' END as status
        FROM access_tokens ORDER BY created_at DESC
      `;
      res.json(keys);
    } catch (e) {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.post('/admin/api/api-keys', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      const { generateToken, hashToken } = await import('../core/utils.ts');
      const token = generateToken('gbrain_');
      const hash = hashToken(token);
      const id = (await import('crypto')).randomUUID();
      await sql`INSERT INTO access_tokens (id, name, token_hash) VALUES (${id}, ${name}, ${hash})`;
      res.json({ name, token, id });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Failed to create API key' });
    }
  });

  app.post('/admin/api/api-keys/revoke', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      await sql`UPDATE access_tokens SET revoked_at = now() WHERE name = ${name} AND revoked_at IS NULL`;
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Revoke failed' });
    }
  });

  // Register client from admin dashboard
  app.post('/admin/api/register-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name, scopes, tokenTtl } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      const result = await oauthProvider.registerClientManual(
        name, ['client_credentials'], scopes || 'read', [],
      );
      // Set per-client TTL if specified
      if (tokenTtl && Number(tokenTtl) > 0) {
        await sql`UPDATE oauth_clients SET token_ttl = ${Number(tokenTtl)} WHERE client_id = ${result.clientId}`;
      }
      res.json({ ...result, tokenTtl: tokenTtl ? Number(tokenTtl) : null });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Registration failed' });
    }
  });

  // Update client TTL
  app.post('/admin/api/update-client-ttl', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId, tokenTtl } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      const ttl = tokenTtl === null || tokenTtl === 0 ? null : Number(tokenTtl);
      await sql`UPDATE oauth_clients SET token_ttl = ${ttl} WHERE client_id = ${clientId}`;
      res.json({ updated: true, tokenTtl: ttl });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Update failed' });
    }
  });

  // Revoke OAuth client
  app.post('/admin/api/revoke-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { clientId } = req.body;
      if (!clientId) { res.status(400).json({ error: 'clientId required' }); return; }
      // Soft-delete the client
      await sql`UPDATE oauth_clients SET deleted_at = now() WHERE client_id = ${clientId} AND deleted_at IS NULL`;
      // Revoke all active tokens for this client
      await sql`DELETE FROM oauth_tokens WHERE client_id = ${clientId}`;
      res.json({ revoked: true });
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Revoke failed' });
    }
  });

  // ---------------------------------------------------------------------------
  // SSE live activity feed
  // ---------------------------------------------------------------------------
  app.get('/admin/events', requireAdmin, (req: Request, res: Response) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  // ---------------------------------------------------------------------------
  // Admin SPA static files
  // ---------------------------------------------------------------------------
  // Serve from admin/dist if it exists (development), otherwise embedded assets
  const path = await import('path');
  const fs = await import('fs');
  const adminDistPath = path.join(process.cwd(), 'admin', 'dist');
  if (fs.existsSync(adminDistPath)) {
    app.use('/admin', express.static(adminDistPath));
    // SPA fallback: serve index.html for all unmatched /admin/* routes
    app.get('/admin/{*path}', (req: Request, res: Response, next: NextFunction) => {
      // Skip API and events routes
      if (req.path.startsWith('/admin/api/') || req.path === '/admin/events' || req.path === '/admin/login') {
        return next();
      }
      res.sendFile(path.join(adminDistPath, 'index.html'));
    });
  }

  // ---------------------------------------------------------------------------
  // MCP tool calls (bearer auth + scope enforcement)
  // ---------------------------------------------------------------------------
  const mcpOperations = operations.filter(op => !op.localOnly);

  app.post('/mcp', requireBearerAuth({ verifier: oauthProvider }), async (req: Request, res: Response) => {
    const startTime = Date.now();
    const authInfo = (req as any).auth as AuthInfo;

    // Human-readable agent name is now threaded through AuthInfo by
    // verifyAccessToken (which JOINs oauth_clients in its existing token
    // SELECT). No per-request DB roundtrip needed. Falls back to clientId
    // for legacy tokens or when the JOIN row's client_name is NULL.
    const agentName = authInfo.clientName ?? authInfo.clientId;

    // Create a fresh MCP server per request (stateless)
    const server = new Server(
      { name: 'gbrain', version: VERSION },
      { capabilities: { tools: {} } },
    );

    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: mcpOperations.map(op => ({
        name: op.name,
        description: op.description,
        inputSchema: {
          type: 'object' as const,
          properties: Object.fromEntries(
            Object.entries(op.params).map(([k, v]) => [k, {
              type: v.type,
              description: v.description,
              ...(v.enum ? { enum: v.enum } : {}),
              ...(v.default !== undefined ? { default: v.default } : {}),
            }]),
          ),
          required: Object.entries(op.params).filter(([, v]) => v.required).map(([k]) => k),
        },
      })),
    }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: params } = request.params;
      const op = mcpOperations.find(o => o.name === name);
      if (!op) {
        return { content: [{ type: 'text', text: JSON.stringify({ error: 'unknown_operation', message: `Unknown: ${name}` }) }] };
      }

      // Scope enforcement
      const requiredScope = op.scope || 'read';
      if (!authInfo.scopes.includes(requiredScope)) {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              error: 'insufficient_scope',
              message: `Operation ${name} requires '${requiredScope}' scope`,
              your_scopes: authInfo.scopes,
            }),
          }],
          isError: true,
        };
      }

      const ctx: OperationContext = {
        engine,
        config,
        logger: {
          info: (msg: string) => console.error(`[INFO] ${msg}`),
          warn: (msg: string) => console.error(`[WARN] ${msg}`),
          error: (msg: string) => console.error(`[ERROR] ${msg}`),
        },
        dryRun: !!(params?.dry_run),
        auth: authInfo,
      };

      try {
        const result = await op.handler(ctx, (params || {}) as Record<string, unknown>);
        const latency = Date.now() - startTime;

        // Log request + broadcast to SSE
        const logParams = params ? JSON.stringify(params) : null;
        try {
          await sql`INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params)
                    VALUES (${authInfo.clientId}, ${agentName}, ${name}, ${latency}, ${'success'}, ${logParams})`;
        } catch { /* best effort */ }

        broadcastEvent({
          agent: agentName,
          operation: name,
          params: params || {},
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'success',
          timestamp: new Date().toISOString(),
        });

        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) {
        const latency = Date.now() - startTime;
        const error = e instanceof OperationError ? e.toJSON() : { error: 'internal_error', message: e instanceof Error ? e.message : 'Unknown error' };

        const errMsg = e instanceof Error ? e.message : 'Unknown error';
        const logParams = params ? JSON.stringify(params) : null;
        try {
          await sql`INSERT INTO mcp_request_log (token_name, agent_name, operation, latency_ms, status, params, error_message)
                    VALUES (${authInfo.clientId}, ${agentName}, ${name}, ${latency}, ${'error'}, ${logParams}, ${errMsg})`;
        } catch { /* best effort */ }

        broadcastEvent({
          agent: agentName,
          operation: name,
          params: params || {},
          latency_ms: latency,
          status: 'error',
          error: errMsg,
          timestamp: new Date().toISOString(),
        });

        return { content: [{ type: 'text', text: JSON.stringify(error) }], isError: true };
      }
    });

    // Use StreamableHTTPServerTransport for stateless request handling
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined as any });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // ---------------------------------------------------------------------------
  // Start server
  // ---------------------------------------------------------------------------
  const clientCount = await sql`SELECT count(*)::int as count FROM oauth_clients`;

  app.listen(port, () => {
    console.error(`
╔══════════════════════════════════════════════════════╗
║  GBrain MCP Server v${VERSION.padEnd(37)}║
╠══════════════════════════════════════════════════════╣
║  Port:      ${String(port).padEnd(40)}║
║  Engine:    ${(config.engine || 'pglite').padEnd(40)}║
║  Issuer:    ${issuerUrl.origin.padEnd(40)}║
║  Clients:   ${String((clientCount[0] as any).count).padEnd(40)}║
║  DCR:       ${(enableDcr ? 'enabled' : 'disabled').padEnd(40)}║
║  Token TTL: ${(tokenTtl + 's').padEnd(40)}║
╠══════════════════════════════════════════════════════╣
║  Admin:     http://localhost:${port}/admin${' '.repeat(Math.max(0, 19 - String(port).length))}║
║  MCP:       http://localhost:${port}/mcp${' '.repeat(Math.max(0, 21 - String(port).length))}║
║  Health:    http://localhost:${port}/health${' '.repeat(Math.max(0, 18 - String(port).length))}║
╠══════════════════════════════════════════════════════╣
║  Admin Token (paste into /admin login):              ║
║  ${bootstrapToken.substring(0, 50)}  ║
║  ${bootstrapToken.substring(50).padEnd(50)}  ║
╚══════════════════════════════════════════════════════╝
`);
  });
}
