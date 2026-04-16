/**
 * GBrain Remote MCP Server — Supabase Edge Function
 *
 * Exposes GBrain operations as remote MCP tools via Streamable HTTP transport.
 * Auth via bearer tokens stored in access_tokens table (SHA-256 hashed).
 *
 * Deploy: supabase functions deploy gbrain-mcp --no-verify-jwt
 * URL:    https://<project>.supabase.co/functions/v1/gbrain-mcp/mcp
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import postgres from 'postgres';
import { createHash } from 'crypto';
import { operations, OperationError, PostgresEngine, VERSION, MCP_INSTRUCTIONS } from './gbrain-core.js';
import type { OperationContext } from './gbrain-core.js';

// Operations excluded from remote (may exceed 60s Edge Function timeout)
const REMOTE_EXCLUDED = new Set(['sync_brain', 'file_upload', 'get_skillpack']);
const remoteOps = operations.filter((op: any) => !REMOTE_EXCLUDED.has(op.name));

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
async function authenticateToken(authHeader: string | null): Promise<{ valid: boolean; name?: string; error?: string; status?: number }> {
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
      SELECT name, revoked_at FROM access_tokens
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

    // Update last_used_at
    const conn2 = getDirectSql();
    await conn2`UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${hash}`;

    return { valid: true, name: rows[0].name as string };
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

// Log MCP request for auditing
async function logRequest(tokenName: string, operation: string, latencyMs: number, status: string) {
  try {
    const conn = getDirectSql();
    await conn`
      INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
      VALUES (${tokenName}, ${operation}, ${latencyMs}, ${status})
    `;
  } catch {
    // Best effort, don't crash on log failure
    console.error('[gbrain-mcp] Failed to log request');
  }
}

// Create MCP Server with tool handlers
function createMcpServer(eng: PostgresEngine): Server {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: remoteOps.map((op: any) => ({
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]: [string, any]) => [k, {
            type: v.type === 'array' ? 'array' : v.type,
            ...(v.description ? { description: v.description } : {}),
            ...(v.enum ? { enum: v.enum } : {}),
            ...(v.items ? { items: { type: v.items.type } } : {}),
          }]),
        ),
        required: Object.entries(op.params)
          .filter(([, v]: [string, any]) => v.required)
          .map(([k]: [string, any]) => k),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = remoteOps.find((o: any) => o.name === name);
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
      const result = await op.handler(ctx, params || {});
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
const app = new Hono().basePath('/gbrain-mcp');

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
  const server = createMcpServer(eng);

  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode — no sessions needed for single-user personal brain
  });

  await server.connect(transport);

  try {
    const response = await transport.handleRequest(c.req.raw);

    // Log the request (await to ensure it completes before isolate dies)
    const latency = Date.now() - startTime;
    await logRequest(auth.name || 'unknown', 'mcp_request', latency, 'success');

    return response;
  } catch (e) {
    const latency = Date.now() - startTime;
    await logRequest(auth.name || 'unknown', 'mcp_request', latency, 'error');
    throw e;
  }
});

// @ts-ignore: Deno.serve
Deno.serve(app.fetch);
