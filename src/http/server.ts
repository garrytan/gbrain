import type { BrainEngine } from '../core/engine.ts';
import { hybridSearch, rrfFusion } from '../core/search/hybrid.ts';
import type { SearchResult } from '../core/types.ts';
import { embed } from '../core/embedding.ts';
import { operationsByName } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { createHmac, randomBytes } from 'crypto';
import pkg from '../../package.json' with { type: 'json' };

const ALLOWED_TAGS = ['preference', 'fact', 'method', 'project', 'person', 'decision'] as const;
const VERSION = pkg.version as string;

// Per-subquery timeout budget. Tunable via env so Railway cold-starts don't
// nuke the whole request: lex (BM25) is fast, vec/hyde do an OpenAI embedding
// call so they get a wider window.
const LEX_TIMEOUT_MS  = parseInt(process.env.GBRAIN_LEX_TIMEOUT_MS  || '3000', 10);
const VEC_TIMEOUT_MS  = parseInt(process.env.GBRAIN_VEC_TIMEOUT_MS  || '8000', 10);

// Warm-state tracking. Module-level so /health can report whether the
// instance has serviced at least one successful query (i.e. embeddings warmed,
// DB pool primed). Cheap and accurate enough for cold-start detection.
const SERVER_STARTED_AT = Date.now();
let firstQueryAt: number | null = null;
let lastQueryAt: number | null = null;

function markQuerySuccess(): void {
  if (firstQueryAt === null) firstQueryAt = Date.now();
  lastQueryAt = Date.now();
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}_timeout_${ms}ms`)), ms);
  });
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    timeout,
  ]);
}

export interface HttpServeOptions {
  port?: number;
  host?: string;
  /** Bearer token for auth. Falls back to GBRAIN_HTTP_TOKEN env var. */
  token?: string;
}

function ok(data: unknown, took_ms: number): Response {
  return Response.json({ ok: true, took_ms, ...data as object });
}

function err(code: string, message: string, status = 400, extra?: object): Response {
  return Response.json({ ok: false, error: message, code, ...extra }, { status });
}

// ── 靜態 token 驗證 ────────────────────────────────────────────────────────────
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

// ── 每日鑰匙（每天換一把，用一整天）──────────────────────────────────────────
function generateOtp(secret: string, windowOffset = 0): string {
  const day = Math.floor(Date.now() / 86_400_000) + windowOffset; // 86400秒 = 1天
  return createHmac('sha256', secret).update(String(day)).digest('hex').slice(0, 10);
}

function verifyOtp(secret: string, provided: string): boolean {
  if (!provided || provided.length !== 10) return false;
  // 接受今天 + 昨天（跨日容錯）
  for (const offset of [0, -1]) {
    const expected = generateOtp(secret, offset);
    if (provided === expected) return true;
  }
  return false;
}

// ── 認證：OTP 優先，否則 fallback 靜態 token ───────────────────────────────────
// OTP 來源優先順序：?otp= → X-Gbrain-OTP header → Authorization: OTP <code>
// header 路徑避免把 OTP 寫進 access logs / 瀏覽歷史。
function authenticate(
  req: Request,
  url: URL,
  staticToken: string | undefined,
  totpSecret: string | undefined
): { ok: true } | { ok: false; needOtp: boolean } {
  const queryOtp = url.searchParams.get('otp');
  const headerOtp = req.headers.get('X-Gbrain-OTP');
  const queryToken = url.searchParams.get('token');
  const authHeader = req.headers.get('Authorization');

  // OTP 模式（當 GBRAIN_TOTP_SECRET 設定時）
  if (totpSecret) {
    const otpProvided =
      queryOtp ??
      headerOtp ??
      (authHeader?.startsWith('OTP ') ? authHeader.slice(4).trim() : null);
    if (!otpProvided) return { ok: false, needOtp: true };
    return verifyOtp(totpSecret, otpProvided) ? { ok: true } : { ok: false, needOtp: true };
  }

  // fallback：靜態 token
  return verifyToken(staticToken, authHeader, queryToken) ? { ok: true } : { ok: false, needOtp: false };
}

function makeCtx(engine: BrainEngine) {
  return { engine, config: loadConfig() || { engine: 'postgres' }, remote: true as const };
}

export function startHttpServer(engine: BrainEngine, opts: HttpServeOptions = {}): void {
  const port = opts.port ?? 4242;
  const host = opts.host ?? '0.0.0.0';
  const staticToken = opts.token ?? process.env.GBRAIN_HTTP_TOKEN;
  const totpSecret = process.env.GBRAIN_TOTP_SECRET;

  if (totpSecret) {
    console.error('GBrain HTTP: OTP mode enabled (GBRAIN_TOTP_SECRET is set)');
  } else if (!staticToken) {
    console.error('WARNING: GBRAIN_HTTP_TOKEN is not set — API is open to anyone');
  }

  const searchOp = operationsByName['search'];
  const getPageOp = operationsByName['get_page'];
  const listPagesOp = operationsByName['list_pages'];
  const putPageOp = operationsByName['put_page'];
  const deletePageOp = operationsByName['delete_page'];

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const t0 = Date.now();

      // ── health (no auth) ──────────────────────────────────────────────────
      // `warm` flips true after the first successful query (embedding pool
      // primed, DB warmed). Agents should hit /health before /search on first
      // contact — if warm:false, send a cheap ?lex= probe before lex+vec.
      if (path === '/health' && req.method === 'GET') {
        return ok({
          status: 'ok',
          engine: engine.kind,
          auth: totpSecret ? 'otp' : 'token',
          version: VERSION,
          warm: firstQueryAt !== null,
          uptime_ms: Date.now() - SERVER_STARTED_AT,
          last_query_ago_ms: lastQueryAt ? Date.now() - lastQueryAt : null,
        }, Date.now() - t0);
      }

      // ── 認證 ─────────────────────────────────────────────────────────────
      const auth = authenticate(req, url, staticToken, totpSecret);
      if (!auth.ok) {
        if (auth.needOtp) {
          // LLM 收到這個就知道要跟你要鑰匙
          return err('otp_required',
            'This vault requires a one-time password. Ask the user to run: gbrain otp',
            401,
            { hint: 'Run `bun scripts/otp-app.ts` to get today\'s key, then retry with ?otp=<code>' }
          );
        }
        return err('unauthorized', 'Valid Bearer token required', 401);
      }

      const ctx = makeCtx(engine);

      // ── GET /search ───────────────────────────────────────────────────────
      // Supports two modes:
      // 1. qmd-style: ?lex=keywords&vec=semantic+question&hyde=hypothetical+doc
      //    Runs each typed sub-query independently and RRF-merges results.
      //    Any combination of lex/vec/hyde works; first-listed gets 2x weight via RRF.
      // 2. Simple: ?q=query (hybridSearch with optional ?expand=1)
      if (path === '/search' && req.method === 'GET') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '10', 10), 50);
        const innerOpts = { limit: Math.min(limit * 3, 50) };

        const lex  = url.searchParams.get('lex');
        const vec  = url.searchParams.get('vec');
        const hyde = url.searchParams.get('hyde');

        if (lex || vec || hyde) {
          // Multi-typed mode: run sub-queries in parallel under per-task
          // timeout budgets, RRF-merge whatever survived. If lex completes
          // but vec times out, return lex results with `degraded:true` instead
          // of failing the whole request — strictly better than the prior
          // "all-or-nothing Promise.allSettled" path on cold Railway boots.
          const taskMeta: { kind: 'lex' | 'vec' | 'hyde'; promise: Promise<SearchResult[]> }[] = [];
          if (lex)  taskMeta.push({ kind: 'lex',  promise: withTimeout(engine.searchKeyword(lex, innerOpts), LEX_TIMEOUT_MS, 'lex') });
          if (vec)  taskMeta.push({ kind: 'vec',  promise: withTimeout(embed(vec).then(emb => engine.searchVector(emb, innerOpts)), VEC_TIMEOUT_MS, 'vec') });
          if (hyde) taskMeta.push({ kind: 'hyde', promise: withTimeout(embed(hyde).then(emb => engine.searchVector(emb, innerOpts)), VEC_TIMEOUT_MS, 'hyde') });

          const settled = await Promise.allSettled(taskMeta.map(t => t.promise));
          const lists: SearchResult[][] = [];
          const dropped: { kind: string; reason: string }[] = [];
          settled.forEach((r, i) => {
            if (r.status === 'fulfilled') lists.push(r.value);
            else dropped.push({ kind: taskMeta[i].kind, reason: String((r as PromiseRejectedResult).reason).slice(0, 200) });
          });

          if (lists.length === 0) {
            // Every subquery failed — almost certainly a cold start.
            return err('warming_up',
              'All search subqueries timed out — service may be cold-starting',
              503,
              {
                retry_after_ms: 3000,
                hint: 'Wait ~3s and retry, or fall back to ?q=<query> for the keyword-only fast path',
                dropped,
              }
            );
          }

          const results = rrfFusion(lists, 60, true).slice(0, limit);
          markQuerySuccess();
          const body: Record<string, unknown> = { lex, vec, hyde, results };
          if (dropped.length > 0) {
            body.degraded = true;
            body.dropped = dropped;
          }
          return ok(body, Date.now() - t0);
        }

        // Simple mode: single ?q= via keyword search (fast, no embedding)
        const q = url.searchParams.get('q');
        if (!q) return err('missing_param', 'Provide ?q=... or at least one of ?lex=, ?vec=, ?hyde=');
        const results = await searchOp.handler(ctx, { query: q, limit });
        markQuerySuccess();
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
        markQuerySuccess();
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

      // ── PUT /page  { content, slug?, tags?, source? } ────────────────────
      if (path === '/page' && req.method === 'PUT') {
        let body: Record<string, unknown>;
        try { body = await req.json(); } catch { return err('invalid_json', 'Body must be JSON'); }

        const content = body.content as string;
        if (!content || typeof content !== 'string') return err('missing_param', 'content is required');
        if (content.length > 50_000) return err('too_large', 'content exceeds 50k character limit');

        const tags = (body.tags as string[] | undefined) ?? [];
        const invalid = tags.filter(t => !(ALLOWED_TAGS as readonly string[]).includes(t));
        if (invalid.length) return err('invalid_tags', `Invalid tags: ${invalid.join(', ')}. Allowed: ${ALLOWED_TAGS.join(', ')}`);

        const source = (body.source as string | undefined) ?? 'agent';
        const slug = (body.slug as string | undefined) || `mem/${new Date().toISOString().slice(0, 10)}/${randomBytes(3).toString('hex')}`;

        // Prepend frontmatter unless content already has it
        const hasfrontmatter = content.trimStart().startsWith('---');
        const fullContent = hasfrontmatter ? content : [
          '---',
          `source: ${source}`,
          tags.length ? `tags: [${tags.join(', ')}]` : null,
          `created: ${new Date().toISOString()}`,
          '---',
          '',
          content,
        ].filter(l => l !== null).join('\n');

        const result = await putPageOp.handler(ctx, { slug, content: fullContent });
        return ok({ slug, ...(result as object) }, Date.now() - t0);
      }

      // ── DELETE /page?slug=... ─────────────────────────────────────────────
      if (path === '/page' && req.method === 'DELETE') {
        const slug = url.searchParams.get('slug');
        if (!slug) return err('missing_param', 'slug is required');
        await deletePageOp.handler(ctx, { slug });
        return ok({ slug, deleted: true }, Date.now() - t0);
      }

      // ── GET /pages/recent?limit=N ─────────────────────────────────────────
      if (path === '/pages/recent' && req.method === 'GET') {
        const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
        const pages = await listPagesOp.handler(ctx, { domain: 'mem', limit });
        return ok({ pages }, Date.now() - t0);
      }

      return err('not_found', 'Unknown endpoint', 404);
    },
  });

  console.error(`GBrain HTTP search API v${VERSION} listening on http://${host}:${port}`);
  console.error('Auth mode:', totpSecret ? 'OTP (daily key, UTC midnight rotation)' : 'Static token');
  console.error(`Search timeouts: lex=${LEX_TIMEOUT_MS}ms, vec/hyde=${VEC_TIMEOUT_MS}ms (override via GBRAIN_LEX_TIMEOUT_MS / GBRAIN_VEC_TIMEOUT_MS)`);
  console.error('Endpoints:');
  console.error('  GET  /health                                       (warm/uptime/version, no auth)');
  console.error('  GET  /search?q=...&limit=10&otp=<code>              (hybridSearch)');
  console.error('  GET  /search?lex=...&vec=...&hyde=...&otp=<code>    (qmd-style multi-query)');
  console.error('  POST /query   {query, limit?, expand?}              (hybridSearch + expansion)');
  console.error('  GET  /page?slug=...&otp=<code>');
  console.error('  GET  /pages?domain=...&limit=20&otp=<code>');
  console.error('  PUT  /page        {content, slug?, tags?, source?}');
  console.error('  DELETE /page?slug=...&otp=<code>');
  console.error('  GET  /pages/recent?limit=50&otp=<code>');

  // keep alive
  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
}
