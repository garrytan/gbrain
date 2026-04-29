/**
 * HTTP transport for `gbrain serve --http`.
 *
 * Postgres-only. PGLite users get a clear fail-fast at startup (the access_tokens
 * table doesn't exist on PGLite per pglite-schema.ts).
 *
 * Security model:
 *   - Every request must include `Authorization: Bearer <token>` (except /health)
 *   - Tokens are validated against SHA-256 hashes in the access_tokens table
 *   - Create/manage tokens with auth.ts (gbrain auth create/list/revoke)
 *   - No open OAuth, no client_credentials, no self-service tokens
 *
 * Hardening:
 *   - CORS default-deny: allowlist via GBRAIN_HTTP_CORS_ORIGIN (comma-separated)
 *   - Rate limit: per-IP pre-auth (protects DB from brute-force load) + per-token-id post-auth
 *     (limits runaway clients). Default 30 req/min per IP, 60 req/min per token. Bounded LRU
 *     so attacker-controlled keys can't grow memory unbounded.
 *   - Body cap: 1 MiB default (GBRAIN_HTTP_MAX_BODY_BYTES). Stream-counted, not buffered —
 *     chunked transfers without Content-Length are still capped.
 *   - last_used_at debounce: only one UPDATE per token per 60s (SQL-level WHERE clause).
 *   - mcp_request_log: one row per request with token_name + operation + status + latency.
 *
 * Replaces the standalone HTTP+OAuth wrapper that was vulnerable to unauthenticated
 * client registration (see SECURITY.md).
 */

import { createHash } from 'crypto';
import type { BrainEngine } from '../core/engine.ts';
import { buildToolDefs } from './tool-defs.ts';
import { operations } from '../core/operations.ts';
import { VERSION } from '../version.ts';
import { dispatchToolCall } from './dispatch.ts';
import { buildDefaultLimiters, type RateLimiter } from './rate-limit.ts';

const DEFAULT_BODY_CAP = 1024 * 1024; // 1 MiB

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseCorsAllowlist(): Set<string> | null {
  const v = process.env.GBRAIN_HTTP_CORS_ORIGIN;
  if (!v) return null;
  return new Set(v.split(',').map(s => s.trim()).filter(Boolean));
}

interface HttpTransportOptions {
  port: number;
  engine: BrainEngine;
  /** Override limiters (for tests). Defaults to env-driven buildDefaultLimiters. */
  limiters?: { ip: RateLimiter; token: RateLimiter };
}

interface AuthResult {
  ok: boolean;
  tokenId?: string;
  tokenName?: string;
}

/** Read up to `cap` bytes off req.body. Returns null if cap exceeded. */
async function readBodyWithCap(req: Request, cap: number): Promise<string | null> {
  const cl = req.headers.get('content-length');
  if (cl) {
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n > cap) return null;
  }
  const reader = req.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      try { await reader.cancel(); } catch { /* noop */ }
      return null;
    }
    chunks.push(value);
  }
  // Concatenate without Buffer to keep this Node-vs-Bun-portable.
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}

/** Resolve client IP. Honors X-Forwarded-For only when GBRAIN_HTTP_TRUST_PROXY=1. */
function resolveClientIp(req: Request, server: { requestIP: (r: Request) => { address: string } | null }): string {
  if (process.env.GBRAIN_HTTP_TRUST_PROXY === '1') {
    const xff = req.headers.get('x-forwarded-for');
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
    const xRealIp = req.headers.get('x-real-ip');
    if (xRealIp) return xRealIp.trim();
  }
  const sock = server.requestIP(req);
  return sock?.address || 'unknown';
}

export async function startHttpTransport(opts: HttpTransportOptions) {
  const { port, engine } = opts;

  // Fail-fast: HTTP transport requires Postgres because access_tokens / mcp_request_log
  // only exist in the Postgres schema (see src/core/pglite-schema.ts:5-6).
  if ((engine as { kind?: string }).kind !== 'postgres') {
    console.error('Error: gbrain serve --http requires a Postgres engine for remote auth tokens.');
    console.error('PGLite is local-only by design (access_tokens table is Postgres-only).');
    console.error('Either:');
    console.error('  - Use stdio: gbrain serve');
    console.error('  - Migrate to Postgres: gbrain migrate --to supabase');
    process.exit(1);
  }

  const sql = (engine as unknown as { sql: any }).sql;
  if (!sql) {
    console.error('Error: Postgres engine has no .sql client. Engine may not be connected.');
    process.exit(1);
  }

  const limiters = opts.limiters || buildDefaultLimiters();
  const bodyCap = envInt('GBRAIN_HTTP_MAX_BODY_BYTES', DEFAULT_BODY_CAP);
  const corsAllowlist = parseCorsAllowlist();
  const tools = buildToolDefs(operations);

  function corsHeaders(origin: string | null, extra: Record<string, string> = {}): Record<string, string> {
    const headers: Record<string, string> = { ...extra };
    if (corsAllowlist && origin && corsAllowlist.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    return headers;
  }

  function corsPreflightHeaders(origin: string | null): Record<string, string> {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    };
    if (corsAllowlist && origin && corsAllowlist.has(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Vary'] = 'Origin';
    }
    return headers;
  }

  async function validateToken(authHeader: string | null): Promise<AuthResult> {
    if (!authHeader?.startsWith('Bearer ')) return { ok: false };
    const token = authHeader.slice(7);
    const hash = hashToken(token);
    try {
      const [row] = await sql`
        SELECT id, name FROM access_tokens
        WHERE token_hash = ${hash} AND revoked_at IS NULL
      `;
      if (!row) return { ok: false };
      // Debounced last_used_at update — only writes once per token per 60s.
      // SQL-level WHERE clause keeps this race-tolerant even under concurrent requests.
      sql`UPDATE access_tokens
          SET last_used_at = now()
          WHERE id = ${row.id}
            AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')`
        .catch(() => { /* fire-and-forget */ });
      return { ok: true, tokenId: row.id, tokenName: row.name };
    } catch {
      return { ok: false };
    }
  }

  function logRequest(tokenName: string | null, operation: string, status: string, latencyMs: number) {
    sql`INSERT INTO mcp_request_log (token_name, operation, latency_ms, status)
        VALUES (${tokenName}, ${operation}, ${latencyMs}, ${status})`
      .catch(() => { /* best-effort */ });
  }

  const server = Bun.serve({
    port,
    async fetch(req, server) {
      const startedMs = Date.now();
      const url = new URL(req.url);
      const path = url.pathname;
      const origin = req.headers.get('origin');

      // CORS preflight
      if (req.method === 'OPTIONS') {
        return new Response(null, { headers: corsPreflightHeaders(origin) });
      }

      // Health check — no auth, no rate limit. Probes the DB so orchestration
      // doesn't see "ok" while clients are getting misleading 401s during a DB outage.
      if (path === '/health') {
        try {
          await sql`SELECT 1`;
          return Response.json(
            { status: 'ok', version: VERSION, transport: 'http', db: 'ok' },
            { headers: corsHeaders(origin) },
          );
        } catch (e: any) {
          return Response.json(
            { status: 'unhealthy', version: VERSION, transport: 'http', db: 'unreachable', error: e?.message ?? 'unknown' },
            { status: 503, headers: corsHeaders(origin) },
          );
        }
      }

      if (path !== '/mcp') {
        return Response.json({ error: 'not_found' }, { status: 404, headers: corsHeaders(origin) });
      }
      if (req.method !== 'POST') {
        return Response.json({ error: 'method_not_allowed' }, { status: 405, headers: corsHeaders(origin) });
      }

      const ip = resolveClientIp(req, server);

      // Pre-auth IP rate limit. Fires BEFORE the DB lookup so we actually limit brute-force load.
      const ipCheck = limiters.ip.check(ip);
      if (!ipCheck.allowed) {
        logRequest(null, 'unknown', 'rate_limited', Date.now() - startedMs);
        return Response.json(
          { error: 'rate_limited', message: 'Too many requests' },
          {
            status: 429,
            headers: corsHeaders(origin, { 'Retry-After': String(ipCheck.retryAfter ?? 60) }),
          },
        );
      }

      // Body cap (stream-counted; chunked transfers caught here, not at req.json).
      const bodyText = await readBodyWithCap(req, bodyCap);
      if (bodyText === null) {
        logRequest(null, 'unknown', 'body_too_large', Date.now() - startedMs);
        return Response.json(
          { error: 'payload_too_large', message: `Request body exceeds ${bodyCap} bytes` },
          { status: 413, headers: corsHeaders(origin) },
        );
      }

      // Auth.
      const auth = await validateToken(req.headers.get('Authorization'));
      if (!auth.ok) {
        logRequest(null, 'unknown', 'auth_failed', Date.now() - startedMs);
        return Response.json(
          { error: 'invalid_token', message: 'Bearer token required. Create one: gbrain auth create <name>' },
          { status: 401, headers: corsHeaders(origin) },
        );
      }

      // Post-auth token-id rate limit. Limits runaway authed clients.
      const tokCheck = limiters.token.check(auth.tokenId!);
      if (!tokCheck.allowed) {
        logRequest(auth.tokenName!, 'unknown', 'rate_limited', Date.now() - startedMs);
        return Response.json(
          { error: 'rate_limited', message: 'Too many requests for this token' },
          {
            status: 429,
            headers: corsHeaders(origin, { 'Retry-After': String(tokCheck.retryAfter ?? 60) }),
          },
        );
      }

      // Parse JSON-RPC body.
      let body: { method?: string; params?: any; id?: any };
      try {
        body = JSON.parse(bodyText);
      } catch (e: any) {
        logRequest(auth.tokenName!, 'unknown', 'parse_error', Date.now() - startedMs);
        return Response.json(
          { error: 'parse_error', message: e?.message ?? 'invalid JSON' },
          { status: 400, headers: corsHeaders(origin) },
        );
      }

      const { method, params, id } = body;

      // initialize
      if (method === 'initialize') {
        logRequest(auth.tokenName!, 'initialize', 'success', Date.now() - startedMs);
        return Response.json(
          {
            result: {
              protocolVersion: '2025-03-26',
              serverInfo: { name: 'gbrain', version: VERSION },
              capabilities: { tools: {} },
            },
            jsonrpc: '2.0',
            id,
          },
          { headers: corsHeaders(origin) },
        );
      }

      // notifications/initialized — acknowledge with 204
      if (method === 'notifications/initialized') {
        return new Response(null, { status: 204, headers: corsHeaders(origin) });
      }

      // tools/list
      if (method === 'tools/list') {
        logRequest(auth.tokenName!, 'tools/list', 'success', Date.now() - startedMs);
        return Response.json(
          { result: { tools }, jsonrpc: '2.0', id },
          { headers: corsHeaders(origin) },
        );
      }

      // tools/call — dispatch through shared dispatch.ts (parity with stdio)
      if (method === 'tools/call') {
        const toolName: string = params?.name ?? 'unknown';
        const args: Record<string, unknown> = params?.arguments ?? {};
        const result = await dispatchToolCall(engine, toolName, args, { remote: true });
        const status = result.isError ? 'error' : 'success';
        logRequest(auth.tokenName!, `tools/call:${toolName}`, status, Date.now() - startedMs);
        return Response.json(
          { result, jsonrpc: '2.0', id },
          { headers: corsHeaders(origin) },
        );
      }

      logRequest(auth.tokenName!, method ?? 'unknown', 'unknown_method', Date.now() - startedMs);
      return Response.json(
        { error: 'unknown_method', message: `Unknown method: ${method}` },
        { status: 400, headers: corsHeaders(origin) },
      );
    },
  });

  console.error(`GBrain HTTP MCP server running on port ${port}`);
  console.error(`  Health: http://localhost:${port}/health`);
  console.error(`  MCP:    http://localhost:${port}/mcp`);
  console.error(`  Auth:   Bearer token required (create with: gbrain auth create <name>)`);
  if (!corsAllowlist) {
    console.error('  CORS:   default-deny. Set GBRAIN_HTTP_CORS_ORIGIN=https://your.app to allow browser clients.');
  } else {
    console.error(`  CORS:   allowlist = ${[...corsAllowlist].join(', ')}`);
  }
  console.error('');
  console.error('⚠️  Do NOT use open OAuth registration for remote MCP access.');
  console.error('   Tokens are managed via: gbrain auth create/list/revoke');

  return server;
}
