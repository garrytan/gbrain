/**
 * HTTP MCP server — exposes all 30+ operations over Streamable HTTP.
 *
 * Uses the MCP SDK's WebStandardStreamableHTTPServerTransport with Bun.serve().
 * Auth is a caller-provided callback, keeping this module engine-independent.
 */
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { BrainEngine } from '../core/engine.ts';
import { createMcpServer } from './server.ts';
import { VERSION } from '../version.ts';

export type TokenValidator = (token: string) => Promise<string | null>;

export interface HttpServerOptions {
  port: number;
  tokenValidator?: TokenValidator;
}

export async function startHttpMcpServer(
  engine: BrainEngine,
  opts: HttpServerOptions,
): Promise<ReturnType<typeof Bun.serve>> {
  const { port, tokenValidator } = opts;

  let httpServer: ReturnType<typeof Bun.serve>;
  try {
    httpServer = Bun.serve({
      port,
      async fetch(req: Request): Promise<Response> {
        const url = new URL(req.url);

        if (url.pathname === '/health') {
          return new Response(JSON.stringify({ status: 'ok', version: VERSION }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }

        if (url.pathname === '/mcp') {
          if (tokenValidator) {
            const authHeader = req.headers.get('Authorization');
            if (!authHeader?.startsWith('Bearer ')) {
              return new Response(JSON.stringify({ error: 'Missing Authorization header' }), {
                status: 401, headers: { 'Content-Type': 'application/json' },
              });
            }
            let tokenName: string | null;
            try {
              tokenName = await tokenValidator(authHeader.slice(7));
            } catch (e: unknown) {
              process.stderr.write(`[error] Token validation error: ${e instanceof Error ? e.message : e}\n`);
              tokenName = null;
            }
            if (!tokenName) {
              return new Response(JSON.stringify({ error: 'Invalid or revoked token' }), {
                status: 401, headers: { 'Content-Type': 'application/json' },
              });
            }
          }

          const transport = new WebStandardStreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          const mcpServer = createMcpServer(engine);
          await mcpServer.connect(transport);

          try {
            const response = await transport.handleRequest(req);
            mcpServer.close().catch(() => {});
            return response;
          } catch (e: unknown) {
            mcpServer.close().catch(() => {});
            process.stderr.write(`[error] MCP request failed: ${e instanceof Error ? e.message : e}\n`);
            return new Response(JSON.stringify({ error: 'Internal server error' }), {
              status: 500, headers: { 'Content-Type': 'application/json' },
            });
          }
        }

        return new Response('Not Found', { status: 404 });
      },
    });
  } catch (e: unknown) {
    console.error(`Failed to start HTTP server on port ${port}: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }

  console.error(`GBrain HTTP MCP server listening on http://localhost:${httpServer.port}/mcp`);
  console.error(`Health check: http://localhost:${httpServer.port}/health`);
  console.error(tokenValidator
    ? 'Auth: Bearer token required (create with: bun run src/commands/auth.ts create <name>)'
    : 'Auth: disabled (use --auth to require Bearer tokens)');

  return httpServer;
}
