#!/usr/bin/env bun
/**
 * GBrain remote MCP HTTP server.
 *
 * Wraps the existing operation handlers in a Streamable HTTP MCP transport
 * (the protocol Claude Desktop / Perplexity / Claude Code remote connectors speak)
 * and gates every request behind a bearer token validated against the
 * `access_tokens` table — same scheme used by `src/commands/auth.ts`.
 *
 * Endpoints:
 *   POST /mcp      MCP JSON-RPC (initialize, tools/list, tools/call)
 *   GET  /healthz  Liveness check (no auth)
 *
 * Required env:
 *   DATABASE_URL          Postgres connection string (Supabase pooler URL)
 *   PORT                  HTTP port (default 8080)
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createHash } from 'crypto';
import postgres from 'postgres';
import { createEngine } from '../src/core/engine-factory.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { loadConfig } from '../src/core/config.ts';
import { VERSION } from '../src/version.ts';

const PORT = Number(process.env.PORT) || 8080;
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 4, idle_timeout: 30 });
const engine = await createEngine({ engine: 'postgres', database_url: DATABASE_URL });
await engine.connect({ engine: 'postgres', database_url: DATABASE_URL });

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

async function validateBearerToken(authHeader: string | null): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing_auth' };
  }
  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) return { ok: false, reason: 'missing_auth' };

  const hash = hashToken(token);
  const rows = await sql<{ name: string }[]>`
    SELECT name FROM access_tokens
    WHERE token_hash = ${hash} AND revoked_at IS NULL
    LIMIT 1
  `;
  if (rows.length === 0) return { ok: false, reason: 'invalid_token' };

  // Best-effort last-used tracking; don't block the request on it.
  sql`UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${hash}`.catch(() => {});

  return { ok: true, name: rows[0].name };
}

function validateParams(op: Operation, params: Record<string, unknown>): string | null {
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && (params[key] === undefined || params[key] === null)) {
      return `Missing required parameter: ${key}`;
    }
    if (params[key] !== undefined && params[key] !== null) {
      const val = params[key];
      const expected = def.type;
      if (expected === 'string' && typeof val !== 'string') return `Parameter "${key}" must be a string`;
      if (expected === 'number' && typeof val !== 'number') return `Parameter "${key}" must be a number`;
      if (expected === 'boolean' && typeof val !== 'boolean') return `Parameter "${key}" must be a boolean`;
      if (expected === 'object' && (typeof val !== 'object' || Array.isArray(val))) return `Parameter "${key}" must be an object`;
      if (expected === 'array' && !Array.isArray(val)) return `Parameter "${key}" must be an array`;
    }
  }
  return null;
}

function buildMcpServer(clientName: string): Server {
  const server = new Server(
    { name: 'gbrain', version: VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: operations.map(op => ({
      name: op.name,
      description: op.description,
      inputSchema: {
        type: 'object' as const,
        properties: Object.fromEntries(
          Object.entries(op.params).map(([k, v]) => [k, {
            type: v.type === 'array' ? 'array' : v.type,
            ...(v.description ? { description: v.description } : {}),
            ...(v.enum ? { enum: v.enum } : {}),
            ...(v.items ? { items: { type: v.items.type } } : {}),
          }]),
        ),
        required: Object.entries(op.params).filter(([, v]) => v.required).map(([k]) => k),
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
    const { name, arguments: params } = request.params;
    const op = operations.find(o => o.name === name);
    if (!op) {
      return { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true };
    }

    const ctx: OperationContext = {
      engine,
      config: loadConfig() || { engine: 'postgres' },
      logger: {
        info: (msg: string) => console.log(`[${clientName}] ${msg}`),
        warn: (msg: string) => console.warn(`[${clientName}] ${msg}`),
        error: (msg: string) => console.error(`[${clientName}] ${msg}`),
      },
      dryRun: !!(params?.dry_run),
      remote: true,
    };

    const safeParams = params || {};
    const validationError = validateParams(op, safeParams);
    if (validationError) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'invalid_params', message: validationError }, null, 2) }], isError: true };
    }

    try {
      const result = await op.handler(ctx, safeParams);
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

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const server = Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === '/healthz') {
      return new Response(JSON.stringify({ ok: true, version: VERSION }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname !== '/mcp') {
      return jsonError(404, 'not_found', 'Use POST /mcp');
    }

    const auth = await validateBearerToken(req.headers.get('Authorization'));
    if (!auth.ok) {
      return jsonError(auth.reason === 'missing_auth' ? 401 : 403, auth.reason,
        auth.reason === 'missing_auth' ? 'Authorization: Bearer <token> required' : 'Token revoked or unknown');
    }

    // Stateless transport: each request gets a fresh transport bound to a
    // fresh Server. Keeps the wrapper safe to scale horizontally on Fly.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    const mcp = buildMcpServer(auth.name);
    await mcp.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      transport.close().catch(() => {});
    }
  },
});

console.log(`gbrain remote MCP listening on :${server.port}`);
console.log(`  POST /mcp     (Bearer auth)`);
console.log(`  GET  /healthz`);
