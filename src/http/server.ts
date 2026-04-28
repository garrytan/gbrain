import type { BrainEngine } from '../core/engine.ts';
import { hybridSearch } from '../core/search/hybrid.ts';
import { operationsByName } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';

export interface HttpServeOptions {
  port?: number;
  host?: string;
  /** Bearer token for auth. Falls back to GBRAIN_HTTP_TOKEN env var. */
  token?: string;
}

function ok(data: unknown, took_ms: number): Response {
  return Response.json({ ok: true, took_ms, ...data as object });
}

function err(code: string, message: string, status = 400): Response {
  return Response.json({ ok: false, error: message, code }, { status });
}

function verifyToken(expected: string | undefined, authHeader: string | null, queryToken?: string | null): boolean {
  if (!expected) return true; // no token configured = open (dev mode)
  const provided = queryToken?.trim() || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');
  if (!provided) return false;
  // constant-time comparison
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function makeCtx(engine: BrainEngine) {
  return { engine, config: loadConfig() || { engine: 'postgres' }, remote: true as const };
}

export function startHttpServer(engine: BrainEngine, opts: HttpServeOptions = {}): void {
  const port = opts.port ?? 4242;
  const host = opts.host ?? '0.0.0.0';
  const expectedToken = opts.token ?? process.env.GBRAIN_HTTP_TOKEN;

  if (!expectedToken) {
    console.error('WARNING: GBRAIN_HTTP_TOKEN is not set — API is open to anyone');
  }

  const searchOp = operationsByName['search'];
  const getPageOp = operationsByName['get_page'];
  const listPagesOp = operationsByName['list_pages'];

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const t0 = Date.now();

      // ── health (no auth) ──────────────────────────────────────────────────
      if (path === '/health' && req.method === 'GET') {
        return ok({ status: 'ok', engine: engine.kind }, Date.now() - t0);
      }

      // ── all other routes require auth ─────────────────────────────────────
      if (!verifyToken(expectedToken, req.headers.get('Authorization'), url.searchParams.get('token'))) {
        return err('unauthorized', 'Valid Bearer token required', 401);
      }

      const ctx = makeCtx(engine);

      // ── GET /search?q=...&limit=N ─────────────────────────────────────────
      if (path === '/search' && req.method === 'GET') {
        const q = url.searchParams.get('q');
        if (!q) return err('missing_param', 'q is required');
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);
        const results = await searchOp.handler(ctx, { query: q, limit });
        return ok({ query: q, results }, Date.now() - t0);
      }

      // ── POST /query  { query, limit?, expand? } ───────────────────────────
      if (path === '/query' && req.method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await req.json(); } catch { return err('invalid_json', 'Body must be JSON'); }
        const q = body.query as string;
        if (!q) return err('missing_param', 'query is required');
        const limit = Math.min(parseInt(String(body.limit ?? 10), 10), 50);
        const expand = body.expand !== false;
        const results = await hybridSearch(engine, q, { limit, expand });
        return ok({ query: q, results }, Date.now() - t0);
      }

      // ── GET /page?slug=... ────────────────────────────────────────────────
      if (path === '/page' && req.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) return err('missing_param', 'slug is required');
        const page = await getPageOp.handler(ctx, { slug });
        if (!page) return err('not_found', `Page not found: ${slug}`, 404);
        return ok({ page }, Date.now() - t0);
      }

      // ── GET /pages?domain=...&limit=N ────────────────────────────────────
      if (path === '/pages' && req.method === 'GET') {
        const domain = url.searchParams.get('domain') ?? undefined;
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '20', 10), 100);
        const cursor = url.searchParams.get('cursor') ?? undefined;
        const pages = await listPagesOp.handler(ctx, { domain, limit, cursor });
        return ok({ pages }, Date.now() - t0);
      }

      return err('not_found', 'Unknown endpoint', 404);
    },
  });

  console.error(`GBrain HTTP search API listening on http://${host}:${port}`);
  console.error('Endpoints:');
  console.error('  GET  /health');
  console.error('  GET  /search?q=...&limit=10            (Bearer token)');
  console.error('  POST /query   {query, limit?, expand?} (Bearer token)');
  console.error('  GET  /page?slug=...                    (Bearer token)');
  console.error('  GET  /pages?domain=...&limit=20        (Bearer token)');

  // keep alive
  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
}
