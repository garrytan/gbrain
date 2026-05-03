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
import { randomBytes, createHash } from 'crypto';
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
  app.post('/admin/login', express.json(), (req, res) => {
    const token = req.body?.token;
    if (!token) {
      res.status(400).json({ error: 'Token required' });
      return;
    }

    const tokenHash = createHash('sha256').update(token).digest('hex');
    if (tokenHash !== bootstrapHash) {
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
  app.get('/admin/api/agents', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const agents = await sql`
        SELECT client_id, client_name, grant_types, scope, created_at
        FROM oauth_clients ORDER BY created_at DESC
      `;
      res.json(agents);
    } catch (e) {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  app.get('/admin/api/stats', requireAdmin, async (_req: Request, res: Response) => {
    try {
      const [clients] = await sql`SELECT count(*)::int as count FROM oauth_clients`;
      const [tokens] = await sql`SELECT count(*)::int as count FROM oauth_tokens WHERE token_type = 'access' AND expires_at > ${Math.floor(Date.now() / 1000)}`;
      const [requests] = await sql`SELECT count(*)::int as count FROM mcp_request_log WHERE created_at > now() - interval '24 hours'`;
      res.json({
        connected_agents: (clients as any).count,
        active_tokens: (tokens as any).count,
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

      let query = `SELECT * FROM mcp_request_log WHERE 1=1`;
      const params: unknown[] = [];
      let paramIdx = 1;

      if (agent && agent !== 'all') { query += ` AND token_name = $${paramIdx++}`; params.push(agent); }
      if (operation && operation !== 'all') { query += ` AND operation = $${paramIdx++}`; params.push(operation); }
      if (status && status !== 'all') { query += ` AND status = $${paramIdx++}`; params.push(status); }

      query += ` ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`;
      params.push(limit, offset);

      // Use raw query for dynamic filtering
      const rows = await sql`SELECT * FROM mcp_request_log ORDER BY created_at DESC LIMIT ${limit} OFFSET ${offset}`;
      const [countResult] = await sql`SELECT count(*)::int as total FROM mcp_request_log`;
      res.json({ rows, total: (countResult as any).total, page, pages: Math.ceil((countResult as any).total / limit) });
    } catch {
      res.status(503).json({ error: 'service_unavailable' });
    }
  });

  // Register client from admin dashboard
  app.post('/admin/api/register-client', requireAdmin, express.json(), async (req: Request, res: Response) => {
    try {
      const { name, scopes } = req.body;
      if (!name) { res.status(400).json({ error: 'Name required' }); return; }
      const result = await oauthProvider.registerClientManual(
        name, ['client_credentials'], scopes || 'read', [],
      );
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: e instanceof Error ? e.message : 'Registration failed' });
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
        try {
          await sql`INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
                    VALUES (${authInfo.clientId}, ${name}, ${latency}, ${'success'})`;
        } catch { /* best effort */ }

        broadcastEvent({
          agent: authInfo.clientId,
          operation: name,
          scopes: authInfo.scopes.join(','),
          latency_ms: latency,
          status: 'success',
          timestamp: new Date().toISOString(),
        });

        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      } catch (e) {
        const latency = Date.now() - startTime;
        const error = e instanceof OperationError ? e.toJSON() : { error: 'internal_error', message: e instanceof Error ? e.message : 'Unknown error' };

        try {
          await sql`INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
                    VALUES (${authInfo.clientId}, ${name}, ${latency}, ${'error'})`;
        } catch { /* best effort */ }

        broadcastEvent({
          agent: authInfo.clientId,
          operation: name,
          latency_ms: latency,
          status: 'error',
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
