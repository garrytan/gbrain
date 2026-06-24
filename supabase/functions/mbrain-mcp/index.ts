/**
 * MBrain Remote MCP Server — Supabase Edge Function
 *
 * Exposes MBrain operations as remote MCP tools via Streamable HTTP transport.
 * Auth via bearer tokens stored in access_tokens table (SHA-256 hashed).
 *
 * Deploy: supabase functions deploy mbrain-mcp --no-verify-jwt
 * URL:    https://<project>.supabase.co/functions/v1/mbrain-mcp/mcp
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import postgres from 'postgres';
import { createHash } from 'crypto';
import {
  dispatchOperation,
  operations,
  operationToMcpTool,
  OperationError,
  PostgresEngine,
  VERSION,
  MCP_INSTRUCTIONS,
  assertToolCallableInSurfaceProfile,
  isToolVisibleInSurfaceProfile,
  resolveMcpSurfaceProfile,
  surfaceTokenCapabilitiesFromScopes,
} from './mbrain-core.js';
import type { OperationContext } from './mbrain-core.js';

function assertRemotePutPagePrecondition(toolName: string, rawParams: unknown): void {
  if (toolName !== 'put_page') return;
  const params = isRecord(rawParams) ? rawParams : {};
  const hasPrecondition = Object.prototype.hasOwnProperty.call(params, 'expected_content_hash')
    && params.expected_content_hash !== undefined;
  if (!hasPrecondition) {
    throw new OperationError(
      'invalid_params',
      'route_first: put_page must observe the target before writing - supply expected_content_hash (null asserts the page is absent, a content hash drives an update). memory_session_id alone is not a route-first write grant.',
      'Call route_memory_writeback and pass canonical_write_requirements.expected_content_hash, or call get_page for the current content_hash before retrying put_page. Offline repair can use local admin_put_page.',
    );
  }
}

function prepareRemoteToolParams(_toolName: string, rawParams: unknown): Record<string, unknown> {
  const params = isRecord(rawParams) ? { ...rawParams } : {};
  return params;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Database connection (lazy, one per isolate)
let engine: PostgresEngine | null = null;
let sql: ReturnType<typeof postgres> | null = null;

function getDbUrl(): string {
  // @ts-ignore: Deno env
  return Deno.env.get('SUPABASE_DB_URL') || Deno.env.get('DATABASE_URL') || '';
}

function getOpenAiKey(): string {
  // @ts-ignore: Deno env
  return Deno.env.get('OPENAI_API_KEY') || '';
}

function getRemoteToolTierSelection(): string | null {
  // @ts-ignore: Deno env
  return Deno.env.get('MBRAIN_MCP_TOOL_TIER') || null;
}

function getEdgeSurfaceProfile() {
  return resolveMcpSurfaceProfile('edge_remote', { toolTierSelection: getRemoteToolTierSelection() });
}

async function getEngine(): Promise<PostgresEngine> {
  if (!engine) {
    engine = new PostgresEngine();
    await engine.connect({ database_url: getDbUrl(), poolSize: 1 });
  }
  return engine;
}

function getDirectSql(): ReturnType<typeof postgres> {
  if (!sql) {
    sql = postgres(getDbUrl(), { max: 1 });
  }
  return sql;
}

// Auth: check bearer token against access_tokens table
async function authenticateToken(authHeader: string | null): Promise<{ valid: boolean; name?: string; scopes?: string[]; error?: string; status?: number }> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      valid: false,
      error: JSON.stringify({
        error: 'missing_auth',
        message: "Authorization header required. Use 'Bearer <token>' format.",
        docs: 'docs/mcp/DEPLOY.md#authentication',
      }),
      status: 401,
    };
  }

  const token = authHeader.slice(7);
  const hash = createHash('sha256').update(token).digest('hex');

  try {
    const conn = getDirectSql();
    const rows = await conn`
      SELECT name, revoked_at, scopes FROM access_tokens
      WHERE token_hash = ${hash}
    `;

    if (rows.length === 0) {
      return {
        valid: false,
        error: JSON.stringify({
          error: 'invalid_token',
          message: "Token not recognized. Run 'bun run src/commands/auth.ts list' to see active tokens.",
          docs: 'docs/mcp/DEPLOY.md#troubleshooting',
        }),
        status: 401,
      };
    }

    if (rows[0].revoked_at) {
      const revokedDate = new Date(rows[0].revoked_at as string).toISOString().slice(0, 10);
      return {
        valid: false,
        error: JSON.stringify({
          error: 'token_revoked',
          message: `This token was revoked on ${revokedDate}. Create a new one with 'bun run src/commands/auth.ts create <name>'.`,
          docs: 'docs/mcp/DEPLOY.md#token-management',
        }),
        status: 403,
      };
    }

    const scopes = parseAccessTokenScopes(rows[0].scopes);
    if (accessTokenExpired(scopes)) {
      return {
        valid: false,
        error: JSON.stringify({
          error: 'token_expired',
          message: 'This OAuth access token expired. Use the OAuth refresh token or reconnect.',
          docs: 'docs/mcp/CHATGPT.md',
        }),
        status: 401,
      };
    }

    // Update last_used_at
    const conn2 = getDirectSql();
    await conn2`UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${hash}`;

    return {
      valid: true,
      name: rows[0].name as string,
      scopes,
    };
  } catch {
    return {
      valid: false,
      error: JSON.stringify({
        error: 'service_unavailable',
        message: 'Database connection failed. Check Supabase dashboard for status.',
        docs: 'docs/mcp/DEPLOY.md#troubleshooting',
      }),
      status: 503,
    };
  }
}

function parseAccessTokenScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === 'string');
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return value.split(',').map(entry => entry.trim()).filter(Boolean);
  }
}

function accessTokenExpired(scopes: string[]): boolean {
  const expiresAt = scopes
    .map(scope => scope.startsWith('oauth_exp:') ? Number(scope.slice('oauth_exp:'.length)) : null)
    .find((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return expiresAt !== undefined && expiresAt <= Math.floor(Date.now() / 1000);
}

// Log MCP request for auditing
async function logRequest(
  tokenName: string,
  operation: string,
  latencyMs: number,
  status: string,
  details: { errorCode?: string; errorReason?: string; surfaceProfile?: string } = {},
) {
  try {
    const conn = getDirectSql();
    await conn`
      INSERT INTO mcp_request_log (token_name, operation, latency_ms, status, error_code, error_reason, surface_profile)
      VALUES (${tokenName}, ${operation}, ${latencyMs}, ${status}, ${details.errorCode ?? null}, ${details.errorReason ?? null}, ${details.surfaceProfile ?? null})
    `;
  } catch {
    // Best effort, don't crash on log failure
    console.error('[mbrain-mcp] Failed to log request');
  }
}

async function inferMcpOperation(request: Request): Promise<string> {
  if (request.method !== 'POST') return request.method.toLowerCase();
  try {
    const body = await request.clone().json() as unknown;
    if (Array.isArray(body)) return 'batch';
    if (!isRecord(body)) return 'mcp_request';
    if (body.method === 'tools/call' && isRecord(body.params) && typeof body.params.name === 'string') {
      return body.params.name;
    }
    return typeof body.method === 'string' ? body.method : 'mcp_request';
  } catch {
    return 'mcp_request';
  }
}

async function classifyMcpResponse(request: Request, response: Response): Promise<{ status: 'success' | 'error'; errorCode?: string; errorReason?: string }> {
  if (response.status >= 400) return { status: 'error', errorCode: `http_${response.status}` };
  if (request.method !== 'POST') return { status: 'success' };
  try {
    const text = await response.clone().text();
    const details = extractMcpResponseErrorDetails(text);
    return details ? { status: 'error', ...details } : { status: 'success' };
  } catch {
    return { status: 'success' };
  }
}

function extractMcpResponseErrorDetails(text: string): { errorCode?: string; errorReason?: string } | null {
  const payloadTexts = extractMcpResponsePayloadTexts(text);
  if (payloadTexts.length === 0) return text.includes('"isError":true') || text.includes('"error":{') ? {} : null;
  for (const payloadText of payloadTexts) {
    const details = extractMcpResponsePayloadErrorDetails(payloadText);
    if (details) return details;
  }
  return text.includes('"isError":true') || text.includes('"error":{') ? {} : null;
}

function extractMcpResponsePayloadTexts(text: string): string[] {
  const dataLines = text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .filter(Boolean);
  return dataLines.length > 0 ? dataLines : [text].filter(Boolean);
}

function extractMcpResponsePayloadErrorDetails(payloadText: string): { errorCode?: string; errorReason?: string } | null {
  try {
    const payload = JSON.parse(payloadText) as unknown;
    if (Array.isArray(payload)) {
      for (const item of payload) {
        const details = extractMcpResponseObjectErrorDetails(item);
        if (details) return details;
      }
      return null;
    }
    return extractMcpResponseObjectErrorDetails(payload);
  } catch {
    return payloadText.includes('"isError":true') || payloadText.includes('"error":{') ? {} : null;
  }
}

function extractMcpResponseObjectErrorDetails(payload: unknown): { errorCode?: string; errorReason?: string } | null {
  if (!isRecord(payload)) return null;
  if (isRecord(payload.error)) {
    return {
      errorCode: payload.error.code !== undefined ? String(payload.error.code) : undefined,
      errorReason: typeof payload.error.message === 'string' ? payload.error.message : undefined,
    };
  }
  if (!isRecord(payload.result) || payload.result.isError !== true) return null;
  const content = Array.isArray(payload.result.content) ? payload.result.content : [];
  const textItem = content.find((item): item is { text: string } => isRecord(item) && typeof item.text === 'string');
  if (!textItem) return {};
  try {
    const parsedText = JSON.parse(textItem.text) as unknown;
    if (!isRecord(parsedText)) return {};
    return {
      errorCode: typeof parsedText.error === 'string' ? parsedText.error : undefined,
      errorReason: typeof parsedText.message === 'string' ? parsedText.message : undefined,
    };
  } catch {
    return { errorReason: textItem.text };
  }
}

// Create MCP Server with tool handlers
function createMcpServer(eng: PostgresEngine, tokenScopes: string[] = []): Server {
  const server = new Server(
    { name: 'mbrain', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const surfaceProfile = getEdgeSurfaceProfile();
    const listedRemoteOps = operations.filter((op: any) => isToolVisibleInSurfaceProfile(op, surfaceProfile));
    return {
      tools: listedRemoteOps.map(operationToMcpTool),
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const surfaceProfile = getEdgeSurfaceProfile();
    const op = operations.find((o: any) => o.name === name);
    if (!op) {
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
    }

    const ctx: OperationContext = {
      engine: eng,
      config: {
        engine: 'postgres',
        database_url: getDbUrl(),
        openai_api_key: getOpenAiKey(),
      },
      logger: {
        info: (msg: string) => console.log(`[info] ${msg}`),
        warn: (msg: string) => console.warn(`[warn] ${msg}`),
        error: (msg: string) => console.error(`[error] ${msg}`),
      },
      dryRun: !!(params?.dry_run),
    };

    try {
      assertToolCallableInSurfaceProfile(op, surfaceProfile, {
        tokenCapabilities: surfaceTokenCapabilitiesFromScopes(tokenScopes),
      });
      assertRemotePutPagePrecondition(name, params);
      const result = await dispatchOperation(ctx, op, prepareRemoteToolParams(name, params));
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    } catch (e: unknown) {
      if (e instanceof OperationError) {
        return { content: [{ type: 'text', text: JSON.stringify(e.toJSON(), null, 2) }], isError: true };
      }
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
    }
  });

  return server;
}

// Hono app — routes: /mcp (MCP transport), /health (monitoring)
const app = new Hono().basePath('/mbrain-mcp');

app.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
  exposeHeaders: ['Mcp-Session-Id'],
}));

// Health check
app.get('/health', async (c) => {
  const authHeader = c.req.header('Authorization');

  // Unauth: minimal response
  if (!authHeader) {
    try {
      const conn = getDirectSql();
      await conn`SELECT 1`;
      return c.json({ status: 'ok', version: VERSION });
    } catch {
      return c.json({ status: 'error' }, 503);
    }
  }

  // Auth: detailed checks
  const auth = await authenticateToken(authHeader);
  if (!auth.valid) return c.json({ status: 'error' }, auth.status);

  const checks: Record<string, string> = {};
  try {
    const conn = getDirectSql();
    await conn`SELECT 1`;
    checks.postgres = 'ok';
  } catch {
    checks.postgres = 'error';
  }

  try {
    const conn = getDirectSql();
    const ext = await conn`SELECT extname FROM pg_extension WHERE extname = 'vector'`;
    checks.pgvector = ext.length > 0 ? 'ok' : 'missing';
  } catch {
    checks.pgvector = 'error';
  }

  checks.openai = getOpenAiKey() ? 'configured' : 'missing';

  const status = Object.values(checks).every(v => v === 'ok' || v === 'configured') ? 'ok' : 'degraded';
  return c.json({ status, version: VERSION, checks });
});

// MCP endpoint
app.all('/mcp', async (c) => {
  // Auth check
  const auth = await authenticateToken(c.req.header('Authorization') || null);
  if (!auth.valid) {
    return new Response(auth.error, {
      status: auth.status || 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const startTime = Date.now();
  const eng = await getEngine();
  const server = createMcpServer(eng, auth.scopes ?? []);
  const operation = await inferMcpOperation(c.req.raw);

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — no sessions needed for single-user personal brain
  });

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(c.req.raw);

    // Log the request (await to ensure it completes before isolate dies)
    const latency = Date.now() - startTime;
    const responseClassification = await classifyMcpResponse(c.req.raw, response);
    await logRequest(auth.name || 'unknown', operation, latency, responseClassification.status, {
      surfaceProfile: 'edge_remote',
      ...(responseClassification.errorCode ? { errorCode: responseClassification.errorCode } : {}),
      ...(responseClassification.errorReason ? { errorReason: responseClassification.errorReason } : {}),
    });

    return response;
  } catch (e) {
    const latency = Date.now() - startTime;
    await logRequest(auth.name || 'unknown', operation, latency, 'error', {
      errorCode: 'transport_exception',
      errorReason: e instanceof Error ? e.message : String(e),
      surfaceProfile: 'edge_remote',
    });
    throw e;
  }
});

// @ts-ignore: Deno.serve
Deno.serve(app.fetch);
