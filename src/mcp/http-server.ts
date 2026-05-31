import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import postgres from 'postgres';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { BrainEngine } from '../core/engine.ts';
import type { MBrainConfig } from '../core/config.ts';
import type { Operation } from '../core/operations.ts';
import { createMcpServer, createMcpToolExecutionLimiter } from './server.ts';

const MAX_MCP_HTTP_BODY_BYTES = 1_048_576;

export interface McpHttpAuthSuccess {
  ok: true;
  tokenName: string;
}

export interface McpHttpAuthFailure {
  ok: false;
  status: number;
  body: Record<string, unknown>;
}

export type McpHttpAuthResult = McpHttpAuthSuccess | McpHttpAuthFailure;

export interface McpHttpHandlerOptions {
  engine: BrainEngine | Promise<BrainEngine>;
  config: MBrainConfig;
  operations?: Operation[];
  authenticate?: (request: Request) => Promise<McpHttpAuthResult>;
  logRequest?: (entry: McpHttpRequestLogEntry) => Promise<void>;
}

export interface McpHttpRequestLogEntry {
  tokenName: string;
  operation: string;
  latencyMs: number;
  status: 'success' | 'error';
}

export interface StartMcpHttpServerOptions extends McpHttpHandlerOptions {
  host: string;
  port: number;
}

export function createMcpHttpHandler(options: McpHttpHandlerOptions): (request: Request) => Promise<Response> {
  const enginePromise = Promise.resolve(options.engine);
  const authenticate = options.authenticate ?? ((request: Request) => authenticateMcpHttpRequest(options.config, request));
  const toolExecutionLimiter = createMcpToolExecutionLimiter();

  return async function handleMcpHttpRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (url.pathname === '/health') {
      return handleHealth(enginePromise);
    }

    if (url.pathname !== '/mcp') {
      return jsonResponse({ error: 'not_found' }, 404);
    }

    const boundedRequest = await boundMcpRequestBody(request);
    if (!boundedRequest.ok) {
      return jsonResponse(boundedRequest.body, 413);
    }
    request = boundedRequest.request;

    const auth = await authenticate(request);
    if (!auth.ok) {
      return jsonResponse(auth.body, auth.status);
    }

    const operation = await inferMcpHttpOperation(request);
    const startTime = Date.now();
    const transport = new WebStandardStreamableHTTPServerTransport();
    const { server } = createMcpServer(enginePromise, {
      operations: options.operations,
      config: options.config,
      toolExecutionLimiter,
      logger: {
        info: (msg: string) => process.stderr.write(`[info] ${msg}\n`),
        warn: (msg: string) => process.stderr.write(`[warn] ${msg}\n`),
        error: (msg: string) => process.stderr.write(`[error] ${msg}\n`),
      },
    });
    await server.connect(transport);

    try {
      const response = await transport.handleRequest(request);
      const status = await classifyMcpHttpResponseStatus(request, response);
      await logRequest(options, {
        tokenName: auth.tokenName,
        operation,
        latencyMs: Date.now() - startTime,
        status,
      });
      return withCors(response);
    } catch (error) {
      await logRequest(options, {
        tokenName: auth.tokenName,
        operation,
        latencyMs: Date.now() - startTime,
        status: 'error',
      });
      throw error;
    }
  };
}

async function inferMcpHttpOperation(request: Request): Promise<string> {
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

async function classifyMcpHttpResponseStatus(request: Request, response: Response): Promise<'success' | 'error'> {
  if (response.status >= 400) return 'error';
  if (request.method !== 'POST') return 'success';

  try {
    const text = await response.clone().text();
    return text.includes('"isError":true') || text.includes('"error":{')
      ? 'error'
      : 'success';
  } catch {
    return 'success';
  }
}

export function startMcpHttpServer(options: StartMcpHttpServerOptions): ReturnType<typeof Bun.serve> {
  const handler = createMcpHttpHandler(options);
  return Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch: handler,
  });
}

async function authenticateMcpHttpRequest(
  config: MBrainConfig,
  request: Request,
): Promise<McpHttpAuthResult> {
  const authHeader = request.headers.get('Authorization');
  const token = parseBearerToken(authHeader);
  if (!token) {
    return {
      ok: false,
      status: 401,
      body: {
        error: 'missing_auth',
        message: "Authorization header required. Use 'Bearer <token>' format.",
        docs: 'docs/mcp/DEPLOY.md#remote-setup',
      },
    };
  }

  const tokenHash = createHash('sha256').update(token).digest('hex');

  try {
    const row = await findAccessToken(config, tokenHash);
    if (!row) {
      return {
        ok: false,
        status: 401,
        body: {
          error: 'invalid_token',
          message: "Token not recognized. Run 'bun run src/commands/auth.ts create <name>' to create one.",
          docs: 'docs/mcp/DEPLOY.md#troubleshooting',
        },
      };
    }

    if (row.revoked_at) {
      return {
        ok: false,
        status: 403,
        body: {
          error: 'token_revoked',
          message: 'This token was revoked. Create a new token before connecting.',
          docs: 'docs/mcp/DEPLOY.md#troubleshooting',
        },
      };
    }

    const tokenName = row.name.length > 0
      ? row.name
      : 'unknown';
    await markAccessTokenUsed(config, tokenHash);
    return { ok: true, tokenName };
  } catch {
    return {
      ok: false,
      status: 503,
      body: {
        error: 'service_unavailable',
        message: 'Could not validate the MCP access token against the configured brain.',
        docs: 'docs/mcp/DEPLOY.md#troubleshooting',
      },
    };
  }
}

async function findAccessToken(
  config: MBrainConfig,
  tokenHash: string,
): Promise<{ name: string; revoked_at: unknown } | null> {
  switch (config.engine) {
    case 'postgres': {
      if (!config.database_url) throw new Error('Missing database_url');
      const sql = postgres(config.database_url, { max: 1 });
      try {
        const rows = await sql`
          SELECT name, revoked_at FROM access_tokens
          WHERE token_hash = ${tokenHash}
        `;
        const row = rows[0];
        return row ? { name: String(row.name ?? ''), revoked_at: row.revoked_at } : null;
      } finally {
        await sql.end();
      }
    }
    case 'sqlite': {
      if (!config.database_path) throw new Error('Missing database_path');
      const db = new Database(config.database_path);
      try {
        const row = db
          .query('SELECT name, revoked_at FROM access_tokens WHERE token_hash = ?')
          .get(tokenHash) as { name?: unknown; revoked_at?: unknown } | null;
        return row ? { name: String(row.name ?? ''), revoked_at: row.revoked_at } : null;
      } finally {
        db.close();
      }
    }
    case 'pglite':
      throw new Error('HTTP bearer auth is not supported for pglite');
  }
}

async function markAccessTokenUsed(config: MBrainConfig, tokenHash: string): Promise<void> {
  switch (config.engine) {
    case 'postgres': {
      if (!config.database_url) throw new Error('Missing database_url');
      const sql = postgres(config.database_url, { max: 1 });
      try {
        await sql`UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${tokenHash}`;
      } finally {
        await sql.end();
      }
      return;
    }
    case 'sqlite': {
      if (!config.database_path) throw new Error('Missing database_path');
      const db = new Database(config.database_path);
      try {
        db.query('UPDATE access_tokens SET last_used_at = ? WHERE token_hash = ?')
          .run(new Date().toISOString(), tokenHash);
      } finally {
        db.close();
      }
      return;
    }
    case 'pglite':
      throw new Error('HTTP bearer auth is not supported for pglite');
  }
}

async function handleHealth(enginePromise: Promise<BrainEngine>): Promise<Response> {
  try {
    await enginePromise;
    return jsonResponse({
      status: 'ok',
      transport: 'http',
    }, 200);
  } catch {
    return jsonResponse({
      status: 'error',
      transport: 'http',
    }, 503);
  }
}

type BoundedMcpRequest =
  | { ok: true; request: Request }
  | { ok: false; body: Record<string, unknown> };

async function boundMcpRequestBody(request: Request): Promise<BoundedMcpRequest> {
  const contentLength = request.headers.get('content-length');
  if (contentLength) {
    const bodyBytes = Number(contentLength);
    if (Number.isFinite(bodyBytes) && bodyBytes > MAX_MCP_HTTP_BODY_BYTES) {
      return mcpRequestTooLarge();
    }
    return { ok: true, request };
  }

  if (request.method !== 'POST' || !request.body) {
    return { ok: true, request };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > MAX_MCP_HTTP_BODY_BYTES) {
      await reader.cancel();
      return mcpRequestTooLarge();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return {
    ok: true,
    request: new Request(request.url, {
      method: request.method,
      headers: new Headers(request.headers),
      body,
      signal: request.signal,
    }),
  };
}

function mcpRequestTooLarge(): BoundedMcpRequest {
  return {
    ok: false,
    body: {
      error: 'request_too_large',
      message: `MCP HTTP request bodies must be ${MAX_MCP_HTTP_BODY_BYTES} bytes or smaller.`,
    },
  };
}

function parseBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

async function logRequest(options: McpHttpHandlerOptions, entry: McpHttpRequestLogEntry): Promise<void> {
  try {
    if (options.logRequest) {
      await options.logRequest(entry);
      return;
    }
    await logMcpHttpRequest(options.config, entry);
  } catch {
    process.stderr.write('[warn] failed to log MCP HTTP request\n');
  }
}

async function logMcpHttpRequest(config: MBrainConfig, entry: McpHttpRequestLogEntry): Promise<void> {
  switch (config.engine) {
    case 'postgres': {
      if (!config.database_url) throw new Error('Missing database_url');
      const sql = postgres(config.database_url, { max: 1 });
      try {
        await sql`
          INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
          VALUES (${entry.tokenName}, ${entry.operation}, ${entry.latencyMs}, ${entry.status})
        `;
      } finally {
        await sql.end();
      }
      return;
    }
    case 'sqlite': {
      if (!config.database_path) throw new Error('Missing database_path');
      const db = new Database(config.database_path);
      try {
        db.query(`
          INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
          VALUES (?, ?, ?, ?)
        `).run(entry.tokenName, entry.operation, entry.latencyMs, entry.status);
      } finally {
        db.close();
      }
      return;
    }
    case 'pglite':
      throw new Error('HTTP request logging is not supported for pglite');
  }
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(),
    },
  });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders())) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id',
  };
}
