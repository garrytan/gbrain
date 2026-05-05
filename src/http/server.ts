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

// Shared qmd-style search runner. Returns either the result envelope (and
// updates warm state on success) or a structured warming_up error envelope
// when every subquery dropped. Used by GET /search and POST /search/batch.
type QmdSearchInput = { lex?: string | null; vec?: string | null; hyde?: string | null; limit?: number };
type QmdSearchOutcome =
  | { ok: true; lex?: string | null; vec?: string | null; hyde?: string | null; results: SearchResult[]; degraded?: true; dropped?: { kind: string; reason: string }[] }
  | { ok: false; code: 'warming_up'; error: string; retry_after_ms: number; hint: string; dropped: { kind: string; reason: string }[] };

async function runQmdSearch(engine: BrainEngine, input: QmdSearchInput): Promise<QmdSearchOutcome> {
  const { lex, vec, hyde } = input;
  const limit = Math.min(input.limit ?? 10, 50);
  const innerOpts = { limit: Math.min(limit * 3, 50) };

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
    return {
      ok: false,
      code: 'warming_up',
      error: 'All search subqueries timed out — service may be cold-starting',
      retry_after_ms: 3000,
      hint: 'Wait ~3s and retry, or fall back to ?q=<query> for the keyword-only fast path',
      dropped,
    };
  }

  const results = rrfFusion(lists, 60, true).slice(0, limit);
  markQuerySuccess();
  const out: QmdSearchOutcome = { ok: true, lex, vec, hyde, results };
  if (dropped.length > 0) {
    (out as any).degraded = true;
    (out as any).dropped = dropped;
  }
  return out;
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
          const outcome = await runQmdSearch(engine, { lex, vec, hyde, limit });
          if (!outcome.ok) {
            return err(outcome.code, outcome.error, 503, {
              retry_after_ms: outcome.retry_after_ms,
              hint: outcome.hint,
              dropped: outcome.dropped,
            });
          }
          const { ok: _omit, ...body } = outcome;
          return ok(body, Date.now() - t0);
        }

        // Simple mode: single ?q= via keyword search (fast, no embedding)
        const q = url.searchParams.get('q');
        if (!q) return err('missing_param', 'Provide ?q=... or at least one of ?lex=, ?vec=, ?hyde=');
        const results = await searchOp.handler(ctx, { query: q, limit });
        markQuerySuccess();
        return ok({ query: q, results }, Date.now() - t0);
      }

      // ── POST /search/batch  { queries: [{lex?, vec?, hyde?, q?, limit?}, ...] } ──
      // Single round-trip for agent-driven multi-topic sweeps. Each query
      // honors per-subquery timeouts so one slow vec doesn't drag the rest.
      // Concurrency capped at 4 to be polite to the embedding provider on
      // cold-start. Returns parallel results array; per-item failures don't
      // fail the whole batch.
      if (path === '/search/batch' && req.method === 'POST') {
        let body: Record<string, unknown>;
        try { body = await req.json(); } catch { return err('invalid_json', 'Body must be JSON'); }

        const queries = body.queries;
        if (!Array.isArray(queries) || queries.length === 0) {
          return err('missing_param', 'queries must be a non-empty array');
        }
        if (queries.length > 20) {
          return err('too_large', 'queries array exceeds 20-item batch limit', 400, { hint: 'Split into multiple /search/batch calls' });
        }

        const CONCURRENCY = 4;
        const out: unknown[] = new Array(queries.length);
        let cursor = 0;
        async function worker(): Promise<void> {
          while (true) {
            const i = cursor++;
            if (i >= queries.length) return;
            const q = queries[i] as Record<string, unknown>;
            try {
              if (typeof q.q === 'string' && q.q) {
                // Simple ?q= path — keyword-only via searchOp, fast.
                const limit = Math.min(parseInt(String(q.limit ?? 10), 10), 50);
                const results = await searchOp.handler(ctx, { query: q.q, limit });
                markQuerySuccess();
                out[i] = { ok: true, query: q.q, results };
              } else {
                const outcome = await runQmdSearch(engine, {
                  lex: typeof q.lex === 'string' ? q.lex : null,
                  vec: typeof q.vec === 'string' ? q.vec : null,
                  hyde: typeof q.hyde === 'string' ? q.hyde : null,
                  limit: typeof q.limit === 'number' ? q.limit : parseInt(String(q.limit ?? 10), 10),
                });
                if (!outcome.ok) {
                  out[i] = { ok: false, code: outcome.code, error: outcome.error, retry_after_ms: outcome.retry_after_ms, dropped: outcome.dropped };
                } else {
                  const { ok: _omit, ...rest } = outcome;
                  out[i] = { ok: true, ...rest };
                }
              }
            } catch (e) {
              out[i] = { ok: false, code: 'internal_error', error: String(e).slice(0, 200) };
            }
          }
        }
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queries.length) }, worker));

        const failures = out.filter(r => (r as { ok?: boolean }).ok === false).length;
        return ok({
          results: out,
          batch_size: queries.length,
          succeeded: queries.length - failures,
          failed: failures,
        }, Date.now() - t0);
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

      // ── GET /topics — knowledge map (no-OTP-needed entry point) ───────────
      // Lets a fresh agent see what's actually in the brain before guessing
      // keywords. Returns domains (slug prefix before "/") with count + a
      // few sample slugs each, sorted by count desc.
      if (path === '/topics' && req.method === 'GET') {
        const sampleSize = Math.min(Math.max(parseInt(url.searchParams.get('samples') ?? '3', 10), 0), 10);
        const minCount = Math.max(parseInt(url.searchParams.get('min_count') ?? '1', 10), 1);

        const slugs = await engine.getAllSlugs();
        const buckets = new Map<string, string[]>();
        for (const slug of slugs) {
          const idx = slug.indexOf('/');
          const domain = idx === -1 ? '_root' : slug.slice(0, idx);
          let bucket = buckets.get(domain);
          if (!bucket) { bucket = []; buckets.set(domain, bucket); }
          bucket.push(slug);
        }

        const topics = [...buckets.entries()]
          .filter(([, list]) => list.length >= minCount)
          .map(([name, list]) => ({
            name,
            count: list.length,
            sample_slugs: list.slice(0, sampleSize),
          }))
          .sort((a, b) => b.count - a.count);

        return ok({ topics, total_pages: slugs.size }, Date.now() - t0);
      }

      // ── GET /schema — return-shape contract for agents ────────────────────
      // Static documentation of result fields + score semantics so agents
      // don't have to reverse-engineer chunk_source, score thresholds, etc.
      if (path === '/schema' && req.method === 'GET') {
        return ok({
          version: VERSION,
          search_result: {
            slug: 'string — page identifier; pass to /page?slug=… to fetch full markdown',
            page_id: 'integer — internal DB id, opaque to agents',
            title: 'string — human-readable title, often pulled from frontmatter',
            type: 'string | null — page type (concept, person, company, deal, …)',
            chunk_text: 'string — chunk content, NOT truncated; full chunks can be 500–4000 chars',
            chunk_source: '"compiled_truth" | "draft" — compiled_truth = canonical merged version, draft = raw imported source',
            chunk_id: 'integer — opaque DB id for the chunk',
            chunk_index: 'integer — position of this chunk inside the page (0 = first)',
            score: 'float — RRF or cosine score; ≥0.4 strong, 0.25–0.4 borderline, <0.25 weak. Compare relatively, not absolutely.',
            stale: 'boolean — true if the underlying page changed after this chunk was indexed; agent should re-fetch via /page',
          },
          search_response: {
            ok: 'boolean — false on error',
            took_ms: 'integer — server-side wall time',
            results: 'SearchResult[] — sorted by score desc',
            degraded: 'boolean? — present when at least one subquery (lex/vec/hyde) was dropped due to timeout',
            dropped: 'array? — when degraded:true, lists which subqueries failed and why',
            query: 'string? — present in ?q= simple mode',
            lex: 'string? — present in qmd-style mode',
            vec: 'string? — present in qmd-style mode',
            hyde: 'string? — present in qmd-style mode',
          },
          error_envelope: {
            ok: 'false',
            error: 'string — human-readable message',
            code: 'string — machine-readable; current values: otp_required, otp_invalid, unauthorized, missing_param, invalid_json, invalid_tags, too_large, not_found, warming_up',
            retry_after_ms: 'integer? — when present, agent should wait this long before retrying',
            hint: 'string? — concrete next step (e.g. "fall back to ?q=")',
            dropped: 'array? — on warming_up, lists which subqueries timed out',
          },
          search_modes: {
            simple: '?q=<query>  — keyword-only (BM25), fast, no embedding round-trip; good for known names/terms',
            qmd:    '?lex=<keywords>&vec=<question>&hyde=<hypothetical>  — any combination; results RRF-merged. lex+vec is the recommended balance.',
          },
          limits: {
            limit_max: 50,
            search_subquery_timeout_ms_lex: LEX_TIMEOUT_MS,
            search_subquery_timeout_ms_vec: VEC_TIMEOUT_MS,
            put_page_max_content_bytes: 50_000,
          },
          first_contact_flow: [
            'GET /health           → check warm:true; if false, send a cheap ?lex= probe before lex+vec',
            'GET /topics           → see what domains exist; pick relevant ones',
            'GET /search?q=<term>  → fast keyword scan to confirm topic has content',
            'GET /search?lex=…&vec=…  → precision retrieval once you know the topic',
            'GET /page?slug=<slug> → fetch full page when a chunk looks promising',
          ],
        }, Date.now() - t0);
      }

      return err('not_found', 'Unknown endpoint', 404, {
        hint: 'Available: GET /health, /topics, /schema, /search, /page, /pages, /pages/recent | POST /query | PUT /page | DELETE /page',
      });
    },
  });

  console.error(`GBrain HTTP search API v${VERSION} listening on http://${host}:${port}`);
  console.error('Auth mode:', totpSecret ? 'OTP (daily key, UTC midnight rotation)' : 'Static token');
  console.error(`Search timeouts: lex=${LEX_TIMEOUT_MS}ms, vec/hyde=${VEC_TIMEOUT_MS}ms (override via GBRAIN_LEX_TIMEOUT_MS / GBRAIN_VEC_TIMEOUT_MS)`);
  console.error('Endpoints:');
  console.error('  GET  /health                                       (warm/uptime/version, no auth)');
  console.error('  GET  /topics                                        (knowledge map: domain → count + samples)');
  console.error('  GET  /schema                                        (search-result/error contract)');
  console.error('  GET  /search?q=...&limit=10&otp=<code>              (hybridSearch)');
  console.error('  GET  /search?lex=...&vec=...&hyde=...&otp=<code>    (qmd-style multi-query)');
  console.error('  POST /query   {query, limit?, expand?}              (hybridSearch + expansion)');
  console.error('  POST /search/batch  {queries: [{lex?,vec?,hyde?,q?,limit?}, ...]}  (multi-topic sweep, max 20)');
  console.error('  GET  /page?slug=...&otp=<code>');
  console.error('  GET  /pages?domain=...&limit=20&otp=<code>');
  console.error('  PUT  /page        {content, slug?, tags?, source?}');
  console.error('  DELETE /page?slug=...&otp=<code>');
  console.error('  GET  /pages/recent?limit=50&otp=<code>');

  // keep alive
  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
}
