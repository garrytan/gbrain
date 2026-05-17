import type { BrainEngine } from '../core/engine.ts';
import { hybridSearch, rrfFusion } from '../core/search/hybrid.ts';
import type { SearchResult } from '../core/types.ts';
import { embed } from '../core/embedding.ts';
import { operationsByName, OperationError } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { createHash, createHmac, randomBytes } from 'crypto';
import pkg from '../../package.json' with { type: 'json' };

// ── In-process async job tracking ─────────────────────────────────────────────
// Used by PUT /page?async=1 so callers with short socket timeouts can fire-and-
// forget the embed and poll GET /job?id=... for completion. Jobs expire after
// ASYNC_JOB_TTL_MS so the map stays bounded without a GC daemon.
const ASYNC_JOB_TTL_MS = 5 * 60 * 1000; // 5 min — matches idempotency window

interface AsyncJobState {
  status: 'pending' | 'running' | 'completed' | 'failed';
  slug: string;
  content_hash: string;
  result?: object;
  error?: string;
  created: number;
}

const asyncJobs = new Map<string, AsyncJobState>();

function newJobId(): string {
  return randomBytes(8).toString('hex');
}

// Maps OperationError codes to HTTP status codes for consistent API responses.
const OPERATION_ERROR_STATUS: Partial<Record<string, number>> = {
  page_not_found: 404,
  not_found: 404,
  permission_denied: 403,
  too_large: 413,
  invalid_slug: 400,
  invalid_frontmatter: 400,
};

function opErrToResponse(e: OperationError): Response {
  const status = OPERATION_ERROR_STATUS[e.code] ?? 400;
  return Response.json(
    { ok: false, code: e.code, error: e.message, ...(e.suggestion ? { hint: e.suggestion } : {}) },
    { status },
  );
}

function sweepJobs(): void {
  const cutoff = Date.now() - ASYNC_JOB_TTL_MS;
  for (const [id, job] of asyncJobs) {
    if (job.created < cutoff) asyncJobs.delete(id);
  }
}

// ── Idempotency cache ─────────────────────────────────────────────────────────
// Keyed by caller-supplied idempotency_key. Expires after ASYNC_JOB_TTL_MS.
interface IdempotencyRecord {
  slug: string;
  content_hash: string;
  result: object;
  created: number;
}

const idempotencyCache = new Map<string, IdempotencyRecord>();

function sweepIdempotency(): void {
  const cutoff = Date.now() - ASYNC_JOB_TTL_MS;
  for (const [k, rec] of idempotencyCache) {
    if (rec.created < cutoff) idempotencyCache.delete(k);
  }
}

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
let requestsTotal = 0;
let requestsToday = 0;
let requestsTodayDay = Math.floor(Date.now() / 86_400_000);

function markRequest(): void {
  const day = Math.floor(Date.now() / 86_400_000);
  if (day !== requestsTodayDay) { requestsTodayDay = day; requestsToday = 0; }
  requestsTotal++;
  requestsToday++;
}

function markQuerySuccess(): void {
  if (firstQueryAt === null) firstQueryAt = Date.now();
  lastQueryAt = Date.now();
}

// OTP rotation: keys flip at UTC midnight. Surface the boundary in errors
// and /health so agents can display countdown / pre-fetch the next key.
function nextOtpRotationMs(): number {
  const day = Math.floor(Date.now() / 86_400_000);
  return (day + 1) * 86_400_000;
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
  const addTagOp = operationsByName['add_tag'];
  const removeTagOp = operationsByName['remove_tag'];
  const addLinkOp = operationsByName['add_link'];
  const addTimelineEntryOp = operationsByName['add_timeline_entry'];

  const server = Bun.serve({
    port,
    hostname: host,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;
      const t0 = Date.now();
      markRequest();

      // ── health (no auth) ──────────────────────────────────────────────────
      // `warm` flips true after the first successful query (embedding pool
      // primed, DB warmed). Agents should hit /health before /search on first
      // contact — if warm:false, send a cheap ?lex= probe before lex+vec.
      if (path === '/health' && req.method === 'GET') {
        const otpInfo = totpSecret
          ? { next_rotation_at: new Date(nextOtpRotationMs()).toISOString(),
              ms_until_rotation: nextOtpRotationMs() - Date.now() }
          : null;
        return ok({
          status: 'ok',
          engine: engine.kind,
          auth: totpSecret ? 'otp' : 'token',
          version: VERSION,
          warm: firstQueryAt !== null,
          uptime_ms: Date.now() - SERVER_STARTED_AT,
          last_query_ago_ms: lastQueryAt ? Date.now() - lastQueryAt : null,
          requests_total: requestsTotal,
          requests_today: requestsToday,
          otp: otpInfo,
        }, Date.now() - t0);
      }

      // ── 認證 ─────────────────────────────────────────────────────────────
      const auth = authenticate(req, url, staticToken, totpSecret);
      if (!auth.ok) {
        if (auth.needOtp) {
          // LLM 收到這個就知道要跟你要鑰匙；附上下一把鑰匙時間方便倒數
          const rotateAt = nextOtpRotationMs();
          return err('otp_required',
            'This vault requires a one-time password. Ask the user to run: gbrain otp',
            401,
            {
              hint: 'Run `bun scripts/otp-app.ts` to get today\'s key, then retry with ?otp=<code> or X-Gbrain-OTP header',
              next_rotation_at: new Date(rotateAt).toISOString(),
              ms_until_rotation: rotateAt - Date.now(),
            }
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

      // ── GET /page?slug=...&[chunk_id=N | chunk_index=N] ───────────────────
      // Without chunk filters: returns the full page (legacy shape).
      // With ?chunk_id= or ?chunk_index=: returns ONE chunk only — saves
      // tokens on long pages where the agent already knows which chunk it
      // wants (e.g. from a prior /search hit).
      if (path === '/page' && req.method === 'GET') {
        const slug = url.searchParams.get('slug');
        if (!slug) return err('missing_param', 'slug is required');

        const chunkIdParam = url.searchParams.get('chunk_id');
        const chunkIndexParam = url.searchParams.get('chunk_index');

        if (chunkIdParam !== null || chunkIndexParam !== null) {
          // Resolve the page first so we get the canonical slug + page_id,
          // then filter chunks. Same lookup path getPageOp uses, so slug
          // aliasing/redirects still work.
          const page = await getPageOp.handler(ctx, { slug }) as { slug?: string; page_id?: number } | null;
          if (!page) return err('not_found', `Page not found: ${slug}`, 404);
          const chunks = await engine.getChunks(page.slug as string);
          let target;
          if (chunkIdParam !== null) {
            const id = parseInt(chunkIdParam, 10);
            if (!Number.isFinite(id)) return err('missing_param', 'chunk_id must be an integer');
            target = chunks.find(c => c.id === id);
          } else {
            const idx = parseInt(chunkIndexParam!, 10);
            if (!Number.isFinite(idx)) return err('missing_param', 'chunk_index must be an integer');
            target = chunks.find(c => c.chunk_index === idx);
          }
          if (!target) {
            return err('not_found',
              `Chunk not found in ${page.slug ?? slug}`,
              404,
              { hint: `Page has ${chunks.length} chunks (indexes 0..${chunks.length - 1}); call /page?slug=… without chunk filters to see them all.` }
            );
          }
          // strip embedding (large + binary)
          const { embedding: _omit, ...lean } = target as { embedding?: unknown } & Record<string, unknown>;
          return ok({ slug: page.slug ?? slug, chunk: lean, total_chunks: chunks.length }, Date.now() - t0);
        }

        let page: unknown;
        try {
          page = await getPageOp.handler(ctx, { slug });
        } catch (e) {
          if (e instanceof OperationError) return opErrToResponse(e);
          throw e;
        }
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

      // ── PUT /page  { content, slug?, tags?, source?, async?, idempotency_key? } ──
      // ?async=1  → returns 202 immediately; background task runs embed.
      //             Poll GET /job?id=<job_id> for completion.
      // idempotency_key → within a 5-min window, same key returns the first
      //             response without re-running the write. Safe to retry on timeout.
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
        const idempotencyKey = (body.idempotency_key as string | undefined) ?? null;
        const asyncMode = body.async === true || body.async === 1 || body.async === '1'
          || url.searchParams.get('async') === '1';

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

        // Idempotency check — return cached result within the TTL window.
        if (idempotencyKey) {
          sweepIdempotency();
          const cached = idempotencyCache.get(idempotencyKey);
          if (cached && cached.slug === slug) {
            return ok({ slug, content_hash: cached.content_hash, idempotent: true, ...cached.result }, Date.now() - t0);
          }
        }

        if (asyncMode) {
          sweepJobs();
          const jobId = newJobId();
          // Placeholder hash filled in once the background task resolves.
          const jobState: AsyncJobState = { status: 'pending', slug, content_hash: '', created: Date.now() };
          asyncJobs.set(jobId, jobState);

          // Fire-and-forget — never awaited here.
          (async () => {
            jobState.status = 'running';
            try {
              const result = await putPageOp.handler(ctx, { slug, content: fullContent }) as { content_hash?: string } & object;
              const resolvedHash = result.content_hash ?? '';
              jobState.status = 'completed';
              jobState.content_hash = resolvedHash;
              jobState.result = result;
              if (idempotencyKey) {
                idempotencyCache.set(idempotencyKey, { slug, content_hash: resolvedHash, result, created: Date.now() });
              }
            } catch (e) {
              jobState.status = 'failed';
              jobState.error = e instanceof Error ? e.message : String(e);
            }
          })();

          return Response.json(
            { ok: true, job_id: jobId, slug, status: 'pending' },
            { status: 202 },
          );
        }

        const result = await putPageOp.handler(ctx, { slug, content: fullContent }) as { content_hash?: string } & object;
        const contentHash = result.content_hash ?? '';
        if (idempotencyKey) {
          sweepIdempotency();
          idempotencyCache.set(idempotencyKey, { slug, content_hash: contentHash, result, created: Date.now() });
        }
        const SEARCH_INDEX_LAG_MS = 2000;
        return ok({ slug, content_hash: contentHash, search_indexed_at: new Date(Date.now() + SEARCH_INDEX_LAG_MS).toISOString(), ...result }, Date.now() - t0);
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
          write_endpoints: {
            description: 'GET /write — unified write facade for GET-only LLM platforms (Claude crawler, ChatGPT browsing, Gemini url_context). All actions require OTP auth.',
            url_limit: '8000 characters; content > 50k chars → 413; use PUT /page for large content',
            async_write: {
              description: 'Non-blocking write for callers with short socket timeouts (Genspark, ChatGPT browsing).',
              how: 'Add &async=1 to GET /write?action=put_page or ?async=1 / body async=1 to PUT /page.',
              response: '202 { ok, job_id, slug, content_hash, status:"pending" }',
              poll: 'GET /job?id=<job_id> → { status: pending|running|completed|failed, result?, error? }. Jobs expire after 5 min.',
              verify: 'After completed: GET /page?slug=<slug> and compare content_hash to confirm write landed.',
            },
            idempotency: {
              description: 'Pass idempotency_key (URL param or JSON body field) to make retries safe within a 5-min window.',
              key_format: 'Recommended: first 8 hex chars of SHA-256 of (slug + content). Changes on edit; prevents suppressing intentional re-writes.',
              behavior: 'Server returns cached first-response for same key+slug. add_link and add_timeline_entry are NOT idempotent — do not retry those blindly.',
            },
            content_hash: {
              description: 'SHA-256 hex of the full markdown (including frontmatter) returned in every PUT /page and GET /write?action=put_page response.',
              use: 'Compare against GET /page response to verify the correct version landed after a timeout.',
            },
            actions: {
              put_page: {
                params: 'slug (required), content (required, URL-encoded, ≤50k), title, type (default: concept), tags (comma-separated), source, ai_confidence, created (YYYY-MM-DD), async (0|1), idempotency_key',
                note: 'If content already has YAML frontmatter (starts with ---), it is used as-is. Otherwise frontmatter is built from the other params.',
              },
              add_tag: { params: 'slug (required), tag (required)' },
              remove_tag: { params: 'slug (required), tag (required)' },
              add_link: { params: 'from (required), to (required), link_type (default: mentions)' },
              add_timeline_entry: { params: 'slug (required), date YYYY-MM-DD (required), description (required), event_type (default: note)' },
              delete_page: { params: 'slug (required), confirm=true (required — prevents accidental deletion)' },
            },
            example: '/write?action=add_tag&slug=wiki/projects/foo&tag=important&otp=<code>',
          },
        }, Date.now() - t0);
      }

      // ── GET /write?action=<action>&otp=<key>&... ──────────────────────────
      // Unified write facade for GET-only LLM platforms (Claude crawler,
      // ChatGPT browsing, Gemini url_context). Dispatches to existing ops;
      // no new logic — just a GET-accessible surface for each write operation.
      if (path === '/write' && req.method === 'GET') {
        try {
        // Enforce URL length cap before parsing — silently truncated URLs
        // produce confusing partial-content bugs that are hard to debug.
        if (req.url.length > 8000) {
          return err('too_large', 'URL exceeds 8000 character limit', 413, {
            hint: 'Content is too long for GET /write — use PUT /page with a JSON body instead',
          });
        }

        const action = url.searchParams.get('action');
        if (!action) {
          return err('missing_param', 'action is required', 400, {
            hint: 'Supported actions: put_page, add_tag, remove_tag, add_link, add_timeline_entry, delete_page',
          });
        }

        if (action === 'put_page') {
          const slug = url.searchParams.get('slug');
          // content_b64 takes priority over content — base64 is ~3× more URL-space-
          // efficient than percent-encoding for CJK text (9 bytes/char → 3 bytes/char).
          const contentB64 = url.searchParams.get('content_b64');
          const rawContent = contentB64
            ? Buffer.from(contentB64, 'base64').toString('utf8')
            : url.searchParams.get('content');
          const content = rawContent;
          if (!slug) return err('missing_param', 'slug is required for put_page');
          if (!content) return err('missing_param', 'content or content_b64 is required for put_page');
          if (content.length > 50_000) {
            return err('too_large', 'content exceeds 50k character limit', 413, {
              hint: 'Use PUT /page with a JSON body for large content',
            });
          }

          const hasfrontmatter = content.trimStart().startsWith('---');
          let fullContent: string;
          if (hasfrontmatter) {
            fullContent = content;
          } else {
            const source = url.searchParams.get('source') ?? 'agent';
            const type = url.searchParams.get('type') ?? 'concept';
            const title = url.searchParams.get('title');
            const tagsRaw = url.searchParams.get('tags');
            const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
            const aiConf = url.searchParams.get('ai_confidence');
            const created = url.searchParams.get('created') ?? new Date().toISOString().slice(0, 10);

            const fmLines = ['---'];
            if (title) fmLines.push(`title: ${JSON.stringify(title)}`);
            fmLines.push(`type: ${type}`);
            fmLines.push(`source: ${source}`);
            if (tags.length) fmLines.push(`tags:\n${tags.map(t => `  - ${t}`).join('\n')}`);
            if (aiConf) fmLines.push(`ai_confidence: ${aiConf}`);
            fmLines.push(`created: ${created}`);
            fmLines.push('---', '', content);
            fullContent = fmLines.join('\n');
          }

          const writeIdempotencyKey = url.searchParams.get('idempotency_key');
          const writeAsync = url.searchParams.get('async') === '1';

          if (writeIdempotencyKey) {
            sweepIdempotency();
            const cached = idempotencyCache.get(writeIdempotencyKey);
            if (cached && cached.slug === slug) {
              return ok({ action, slug, content_hash: cached.content_hash, idempotent: true, ...cached.result }, Date.now() - t0);
            }
          }

          if (writeAsync) {
            sweepJobs();
            const jobId = newJobId();
            const jobState: AsyncJobState = { status: 'pending', slug, content_hash: '', created: Date.now() };
            asyncJobs.set(jobId, jobState);
            (async () => {
              jobState.status = 'running';
              try {
                const result = await putPageOp.handler(ctx, { slug, content: fullContent }) as { content_hash?: string } & object;
                const resolvedHash = result.content_hash ?? '';
                jobState.status = 'completed';
                jobState.content_hash = resolvedHash;
                jobState.result = result;
                if (writeIdempotencyKey) {
                  idempotencyCache.set(writeIdempotencyKey, { slug, content_hash: resolvedHash, result, created: Date.now() });
                }
              } catch (e) {
                jobState.status = 'failed';
                jobState.error = e instanceof Error ? e.message : String(e);
              }
            })();
            return Response.json(
              { ok: true, action, job_id: jobId, slug, status: 'pending' },
              { status: 202 },
            );
          }

          const result = await putPageOp.handler(ctx, { slug, content: fullContent }) as { content_hash?: string } & object;
          const writeContentHash = result.content_hash ?? '';
          if (writeIdempotencyKey) {
            sweepIdempotency();
            idempotencyCache.set(writeIdempotencyKey, { slug, content_hash: writeContentHash, result, created: Date.now() });
          }
          const SEARCH_INDEX_LAG_MS = 2000;
          return ok({ action, slug, content_hash: writeContentHash, search_indexed_at: new Date(Date.now() + SEARCH_INDEX_LAG_MS).toISOString(), ...result }, Date.now() - t0);
        }

        if (action === 'add_tag') {
          const slug = url.searchParams.get('slug');
          const tag = url.searchParams.get('tag');
          if (!slug) return err('missing_param', 'slug is required for add_tag');
          if (!tag) return err('missing_param', 'tag is required for add_tag');
          await addTagOp.handler(ctx, { slug, tag });
          return ok({ action, slug, tag }, Date.now() - t0);
        }

        if (action === 'remove_tag') {
          const slug = url.searchParams.get('slug');
          const tag = url.searchParams.get('tag');
          if (!slug) return err('missing_param', 'slug is required for remove_tag');
          if (!tag) return err('missing_param', 'tag is required for remove_tag');
          await removeTagOp.handler(ctx, { slug, tag });
          return ok({ action, slug, tag }, Date.now() - t0);
        }

        if (action === 'add_link') {
          const from = url.searchParams.get('from');
          const to = url.searchParams.get('to');
          const link_type = url.searchParams.get('link_type') ?? 'mentions';
          if (!from) return err('missing_param', 'from is required for add_link');
          if (!to) return err('missing_param', 'to is required for add_link');
          await addLinkOp.handler(ctx, { from, to, link_type });
          return ok({ action, from, to, link_type }, Date.now() - t0);
        }

        if (action === 'add_timeline_entry') {
          const slug = url.searchParams.get('slug');
          const date = url.searchParams.get('date');
          const description = url.searchParams.get('description');
          const event_type = url.searchParams.get('event_type') ?? 'note';
          if (!slug) return err('missing_param', 'slug is required for add_timeline_entry');
          if (!date) return err('missing_param', 'date is required for add_timeline_entry (YYYY-MM-DD)');
          if (!description) return err('missing_param', 'description is required for add_timeline_entry');
          // Date format and range validated inside the operation handler
          await addTimelineEntryOp.handler(ctx, { slug, date, summary: description, source: event_type });
          return ok({ action, slug, date }, Date.now() - t0);
        }

        if (action === 'delete_page') {
          const slug = url.searchParams.get('slug');
          const confirm = url.searchParams.get('confirm');
          if (!slug) return err('missing_param', 'slug is required for delete_page');
          if (confirm !== 'true') {
            return err('confirm_required', 'confirm=true is required to prevent accidental deletion', 400, {
              hint: 'Add &confirm=true to the URL to confirm deletion',
            });
          }
          await deletePageOp.handler(ctx, { slug });
          return ok({ action, slug, deleted: true }, Date.now() - t0);
        }

        return err('invalid_action', `Unknown action: ${action}`, 400, {
          hint: 'Supported actions: put_page, add_tag, remove_tag, add_link, add_timeline_entry, delete_page',
        });
        } catch (e) {
          return err('internal_error', String(e instanceof Error ? e.message : e).slice(0, 500), 500);
        }
      }

      // ── GET /job?id=<job_id> — poll async put_page status ────────────────────
      // Returns the current state of a job submitted via PUT /page?async=1.
      // Jobs expire after 5 minutes; a 404 means expired or never existed.
      if (path === '/job' && req.method === 'GET') {
        const jobId = url.searchParams.get('id');
        if (!jobId) return err('missing_param', 'id is required');
        const job = asyncJobs.get(jobId);
        if (!job) return err('not_found', `Job not found or expired: ${jobId}`, 404, {
          hint: 'Jobs expire after 5 minutes. If the job completed, the result is gone — re-read the page with GET /page?slug=...',
        });
        const payload: Record<string, unknown> = {
          job_id: jobId,
          slug: job.slug,
          content_hash: job.content_hash,
          status: job.status,
          created: new Date(job.created).toISOString(),
        };
        if (job.result) payload.result = job.result;
        if (job.error) payload.error = job.error;
        return ok(payload, Date.now() - t0);
      }

      return err('not_found', 'Unknown endpoint', 404, {
        hint: 'Available: GET /health, /topics, /schema, /search, /page, /pages, /pages/recent, /write, /job | POST /query, /search/batch | PUT /page | DELETE /page',
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
  console.error('  PUT  /page        {content, slug?, tags?, source?, async?, idempotency_key?}');
  console.error('  PUT  /page?async=1 → 202 {job_id, slug, content_hash, status:"pending"}  (non-blocking embed)');
  console.error('  GET  /job?id=<job_id>   → poll async job status');
  console.error('  DELETE /page?slug=...&otp=<code>');
  console.error('  GET  /pages/recent?limit=50&otp=<code>');
  console.error('  GET  /write?action=<action>&otp=<code>&...  (put_page|add_tag|remove_tag|add_link|add_timeline_entry|delete_page)');

  // keep alive
  process.on('SIGINT', () => { server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { server.stop(); process.exit(0); });
}
