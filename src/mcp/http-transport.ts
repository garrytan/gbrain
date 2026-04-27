/**
 * HTTP transport for gbrain MCP server.
 *
 * `gbrain serve --http` starts an HTTP server on --port (default 8787)
 * with bearer token authentication via the existing `access_tokens` table.
 *
 * Security model:
 *   - Every request must include `Authorization: Bearer <token>`
 *   - Tokens are validated against SHA-256 hashes in the `access_tokens` table
 *   - Create tokens with `gbrain auth create <name>`
 *   - No open OAuth registration, no client_credentials flow, no self-service tokens
 *
 * This replaces the need for a standalone HTTP+OAuth wrapper, which was
 * vulnerable to unauthenticated client registration (see SECURITY.md).
 */

import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import { operations, OperationError } from '../core/operations.ts';
import type { OperationContext } from '../core/operations.ts';
import { buildToolDefs } from './tool-defs.ts';
import { VERSION } from '../version.ts';

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

interface HttpTransportOptions {
  port: number;
  engine: BrainEngine;
}

export async function startHttpTransport(opts: HttpTransportOptions) {
  const { port, engine } = opts;
  const ctx: OperationContext = { engine, remote: true };
  const tools = buildToolDefs(operations);

  async function validateToken(authHeader: string | null): Promise<boolean> {
    if (!authHeader?.startsWith('Bearer ')) return false;
    const token = authHeader.slice(7);
    const hash = hashToken(token);
    try {
      const sql = (engine as any).sql; // internal pool
      const [row] = await sql`
        SELECT id FROM access_tokens
        WHERE token_hash = ${hash} AND revoked_at IS NULL
      `;
      if (row) {
        // Update last_used_at (fire-and-forget)
        sql`UPDATE access_tokens SET last_used_at = now() WHERE id = ${row.id}`.catch(() => {});
      }
      return !!row;
    } catch {
      return false;
    }
  }

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, {
          headers: {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
          },
        });
      }

      // Health check — no auth required, no sensitive data
      if (path === '/health') {
        return Response.json({ status: 'ok', version: VERSION, transport: 'http' });
      }

      // All other endpoints require auth
      const authHeader = req.headers.get('Authorization');
      if (!(await validateToken(authHeader))) {
        return Response.json(
          { error: 'invalid_token', message: 'Bearer token required. Create one: gbrain auth create <name>' },
          { status: 401 },
        );
      }

      // MCP JSON-RPC endpoint
      if (path === '/mcp' && req.method === 'POST') {
        try {
          const body = await req.json();
          const { method, params, id } = body;

          // tools/list
          if (method === 'tools/list') {
            return sseResponse({ result: { tools }, jsonrpc: '2.0', id });
          }

          // initialize
          if (method === 'initialize') {
            return sseResponse({
              result: {
                protocolVersion: '2025-03-26',
                serverInfo: { name: 'gbrain', version: VERSION },
                capabilities: { tools: {} },
              },
              jsonrpc: '2.0',
              id,
            });
          }

          // notifications/initialized — acknowledge
          if (method === 'notifications/initialized') {
            return new Response(null, { status: 204 });
          }

          // tools/call
          if (method === 'tools/call') {
            const { name, arguments: args } = params || {};
            const op = operations.find(o => o.name === name);
            if (!op) {
              return sseResponse({
                result: { content: [{ type: 'text', text: `Error: Unknown tool: ${name}` }], isError: true },
                jsonrpc: '2.0',
                id,
              });
            }

            try {
              const result = await op.handler(args || {}, ctx);
              const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
              return sseResponse({
                result: { content: [{ type: 'text', text }] },
                jsonrpc: '2.0',
                id,
              });
            } catch (e: any) {
              const msg = e instanceof OperationError ? e.message : `Internal error: ${e.message}`;
              return sseResponse({
                result: { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true },
                jsonrpc: '2.0',
                id,
              });
            }
          }

          return Response.json({ error: 'unknown_method', message: `Unknown method: ${method}` }, { status: 400 });
        } catch (e: any) {
          return Response.json({ error: 'parse_error', message: e.message }, { status: 400 });
        }
      }

      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  });

  console.error(`GBrain HTTP MCP server running on port ${port}`);
  console.error(`  Health: http://localhost:${port}/health`);
  console.error(`  MCP:    http://localhost:${port}/mcp`);
  console.error(`  Auth:   Bearer token required (create with: gbrain auth create <name>)`);
  console.error('');
  console.error('⚠️  Do NOT use open OAuth registration for remote MCP access.');
  console.error('   Tokens are managed via: gbrain auth create/list/revoke');

  return server;
}

function sseResponse(data: any): Response {
  const body = `event: message\ndata: ${JSON.stringify(data)}\n\n`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
