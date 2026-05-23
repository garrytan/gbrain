import type { BrainEngine } from '../core/engine.ts';
import { hybridSearch, rrfFusion } from '../core/search/hybrid.ts';
import type { SearchResult } from '../core/types.ts';
import { embed } from '../core/embedding.ts';
import { operationsByName, OperationError } from '../core/operations.ts';
import { loadConfig } from '../core/config.ts';
import { importFromContent } from '../core/import-file.ts';
import { createHash, createHmac, randomBytes } from 'crypto';
import pkg from '../../package.json' with { type: 'json' };

// ── Chunked upload buffer ─────────────────────────────────────────────────────
// Three-step GET-safe upload for GET-only LLM callers (Claude crawler, etc.).
// Step 1: action=start_chunked  → upload_id
// Step 2: action=append_chunk × N (any order, idempotent)
// Step 3: action=commit_chunked → assemble + write, same path as put_page
//
// ⚠  VOLATILE: sessions live in process memory. A server restart wipes them.
//    Always supply idempotency_key so commit is re-entrant across retries.
const CHUNK_UPLOAD_TTL_MS  = 10 * 60 * 1000; // 10 min — generous for slow networks
const CHUNK_MAX_CHUNKS     = 20;              // hard ceiling even when total_chunks omitted
const CHUNK_MAX_TOTAL      = 50_000;          // same cap as put_page
const CHUNK_MAX_SINGLE     = 1_500;           // per-chunk char cap (keeps URLs under 8k)

interface ChunkUploadState {
  slug: string;
  totalChunks: number | null;    // null = auto-inferred at commit (open-ended)
  chunks: Map<number, string>;   // key = chunk_index; Map supports sparse / out-of-order
  accumulatedSize: number;       // running total chars, updated on each append
  params: Record<string, string>;
  created: number;
}

const chunkUploads = new Map<string, ChunkUploadState>();

function sweepChunkUploads(): void {
  const cutoff = Date.now() - CHUNK_UPLOAD_TTL_MS;
  for (const [id, state] of chunkUploads) {
    if (state.created < cutoff) chunkUploads.delete(id);
  }
}

/** Assemble a chunk Map into an ordered string (gaps → missing indices detected later). */
function assembleChunks(chunks: Map<number, string>): string {
  const indices = [...chunks.keys()].sort((a, b) => a - b);
  return indices.map(i => chunks.get(i)!).join('');
}

/** Return sorted list of missing indices in 0..maxIndex, given a received Map. */
function missingIndices(chunks: Map<number, string>, total: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < total; i++) { if (!chunks.has(i)) out.push(i); }
  return out;
}

// ── In-process async job tracking ─────────────────────────────────────────────
// Async is the default for PUT /page and GET /write?action=put_page. Callers
// get 202 immediately; embedding runs in background. Poll GET /job?id=... for completion. Jobs expire after
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

// In-flight idempotency: key → job_id for jobs not yet terminal.
// Cleared when job reaches completed/failed and idempotencyCache takes over.
const asyncInFlight = new Map<string, string>();

function sweepIdempotency(): void {
  const cutoff = Date.now() - ASYNC_JOB_TTL_MS;
  for (const [k, rec] of idempotencyCache) {
    if (rec.created < cutoff) idempotencyCache.delete(k);
  }
}

// ── Phase-2 embed retry helper ────────────────────────────────────────────────
// Retries the thunk up to maxRetries times with exponential backoff.
// Returns the result on success, throws on final failure.
const EMBED_MAX_RETRIES = 3;
const EMBED_RETRY_BASE_MS = 5000;

async function withEmbedRetry<T>(
  label: string,
  thunk: () => Promise<T>,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= EMBED_MAX_RETRIES; attempt++) {
    try {
      return await thunk();
    } catch (e) {
      lastError = e;
      if (attempt < EMBED_MAX_RETRIES) {
        const delay = EMBED_RETRY_BASE_MS * Math.pow(2, attempt);
        console.warn(`[gbrain] embed retry ${attempt + 1}/${EMBED_MAX_RETRIES} for ${label} in ${delay}ms: ${e instanceof Error ? e.message : String(e)}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastError;
}

// ── Write-through page cache ──────────────────────────────────────────────────
// Caches GET /page results for pages written in this process. TTL = 5 min.
// Bounded at 100 entries: evicts the oldest on overflow.
const PAGE_CACHE_TTL_MS = 5 * 60 * 1000;
const PAGE_CACHE_MAX = 100;
const pageCache = new Map<string, { page: unknown; created: number }>();

function pageCacheSet(slug: string, page: unknown): void {
  if (pageCache.size >= PAGE_CACHE_MAX) {
    pageCache.delete(pageCache.keys().next().value!);
  }
  pageCache.set(slug, { page, created: Date.now() });
}

function pageCacheGet(slug: string): unknown | undefined {
  const entry = pageCache.get(slug);
  if (!entry) return undefined;
  if (Date.now() - entry.created > PAGE_CACHE_TTL_MS) {
    pageCache.delete(slug);
    return undefined;
  }
  return entry.page;
}

// ── Pending-embed tracker ─────────────────────────────────────────────────────
// Slugs written via phase 1 (noEmbed) but not yet embedded by phase 2.
// Used by ?include_pending=1 on /search to surface just-written pages before
// their vectors land. Best-effort: cleared on phase 2 completion/failure or
// after ASYNC_JOB_TTL_MS (same window as job tracking).
const pendingEmbeds = new Set<string>();

// ── Backpressure ──────────────────────────────────────────────────────────────
// If the semaphore waiting queue exceeds ASYNC_QUEUE_MAX, new writes are
// rejected with 503 + Retry-After header so clients back off rather than
// pile up. Tune via ASYNC_QUEUE_MAX env var (default 50).
const ASYNC_QUEUE_MAX = Math.max(1, parseInt(process.env.ASYNC_QUEUE_MAX ?? '50', 10));

// ── Async concurrency semaphore ───────────────────────────────────────────────
// Limits simultaneous background embedding calls so Railway → OpenAI doesn't
// saturate. Tune via ASYNC_MAX_CONCURRENCY env var.
const ASYNC_MAX_CONCURRENCY = Math.max(1, parseInt(process.env.ASYNC_MAX_CONCURRENCY ?? '5', 10));
let asyncActiveCount = 0;
const asyncPendingQueue: Array<() => void> = [];

function acquireAsyncSlot(): Promise<void> {
  if (asyncActiveCount < ASYNC_MAX_CONCURRENCY) {
    asyncActiveCount++;
    return Promise.resolve();
  }
  return new Promise(resolve => asyncPendingQueue.push(() => { asyncActiveCount++; resolve(); }));
}

function releaseAsyncSlot(): void {
  asyncActiveCount--;
  const next = asyncPendingQueue.shift();
  if (next) next();
}

// ── IP-based auth failure rate limiter ────────────────────────────────────────
// Tracks OTP failures per IP. After MAX_AUTH_FAILURES within AUTH_WINDOW_MS,
// the IP is banned for AUTH_BAN_MS. In-process only — resets on restart, which
// is acceptable: an attacker would need to trigger a Railway restart to reset,
// which is harder than just getting blocked.
const MAX_AUTH_FAILURES = 10;
const AUTH_WINDOW_MS    = 60_000;   // 1 minute sliding window
const AUTH_BAN_MS       = 3_600_000; // 1 hour ban

interface AuthRecord { failures: number; windowStart: number; bannedUntil: number }
const authFailures = new Map<string, AuthRecord>();

function getClientIp(req: Request): string {
  return req.headers.get('cf-connecting-ip')
    ?? req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    ?? 'unknown';
}

function checkIpBanned(ip: string): boolean {
  const rec = authFailures.get(ip);
  if (!rec) return false;
  return Date.now() < rec.bannedUntil;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  let rec = authFailures.get(ip);
  if (!rec || now - rec.windowStart > AUTH_WINDOW_MS) {
    rec = { failures: 0, windowStart: now, bannedUntil: 0 };
    authFailures.set(ip, rec);
  }
  rec.failures++;
  if (rec.failures >= MAX_AUTH_FAILURES) {
    rec.bannedUntil = now + AUTH_BAN_MS;
  }
}

function recordAuthSuccess(ip: string): void {
  authFailures.delete(ip);
}

// Sweep stale entries every ~5 minutes (called on each auth attempt).
let lastAuthSweep = 0;
function sweepAuthFailures(): void {
  const now = Date.now();
  if (now - lastAuthSweep < 300_000) return;
  lastAuthSweep = now;
  for (const [ip, rec] of authFailures) {
    if (now > rec.bannedUntil && now - rec.windowStart > AUTH_WINDOW_MS) {
      authFailures.delete(ip);
    }
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

// Lex-search the pending-embed set and return results not already in mainResults.
// Each result is tagged vec_pending:true so callers know embedding is in-flight.
async function appendPendingResults(
  engine: BrainEngine,
  lexQuery: string,
  mainResults: { slug: string }[],
  limit: number,
): Promise<(SearchResult & { vec_pending: true })[]> {
  if (!lexQuery || pendingEmbeds.size === 0) return [];
  try {
    const mainSlugs = new Set(mainResults.map(r => r.slug));
    const lexHits = await engine.searchKeyword(lexQuery, { limit: limit * 2 });
    return lexHits
      .filter(r => pendingEmbeds.has(r.slug) && !mainSlugs.has(r.slug))
      .map(r => ({ ...r, vec_pending: true as const }));
  } catch {
    return [];
  }
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
      const clientIp = getClientIp(req);
      sweepAuthFailures();

      if (checkIpBanned(clientIp)) {
        return err('too_many_failures',
          'Too many failed authentication attempts. Try again in 1 hour.',
          429,
          { hint: 'Your IP has been temporarily blocked due to repeated auth failures.' }
        );
      }

      const auth = authenticate(req, url, staticToken, totpSecret);
      if (!auth.ok) {
        recordAuthFailure(clientIp);
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
      recordAuthSuccess(clientIp);

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
        const includePending = url.searchParams.get('include_pending') === '1'
          || url.searchParams.get('include_pending') === 'true';

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

          if (includePending && pendingEmbeds.size > 0) {
            const lexQuery = lex || vec || hyde || '';
            const pendingResults = await appendPendingResults(engine, lexQuery, body.results as { slug: string }[], limit);
            if (pendingResults.length > 0) {
              return ok({ ...body, results: [...(body.results as unknown[]), ...pendingResults], pending_count: pendingResults.length }, Date.now() - t0);
            }
          }

          return ok(body, Date.now() - t0);
        }

        // Simple mode: single ?q= via keyword search (fast, no embedding)
        const q = url.searchParams.get('q');
        if (!q) return err('missing_param', 'Provide ?q=... or at least one of ?lex=, ?vec=, ?hyde=');
        const results = await searchOp.handler(ctx, { query: q, limit }) as { slug: string }[];
        markQuerySuccess();

        if (includePending && pendingEmbeds.size > 0) {
          const pendingResults = await appendPendingResults(engine, q, results, limit);
          if (pendingResults.length > 0) {
            return ok({ query: q, results, pending: pendingResults, pending_count: pendingResults.length }, Date.now() - t0);
          }
        }

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

        const cached = pageCacheGet(slug);
        if (cached) return ok({ page: cached, from_cache: true }, Date.now() - t0);

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
        // Async is the default; pass sync=1 (or body sync:1) to force a blocking write.
        const syncRequested = body.sync === true || body.sync === 1 || body.sync === '1'
          || url.searchParams.get('sync') === '1';
        const asyncMode = !syncRequested;

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
          if (asyncMode) {
            const existingJobId = asyncInFlight.get(idempotencyKey);
            if (existingJobId) {
              const existingJob = asyncJobs.get(existingJobId);
              if (existingJob) {
                return Response.json(
                  { ok: true, job_id: existingJobId, slug, status: existingJob.status, idempotent: true },
                  { status: 202 },
                );
              }
              asyncInFlight.delete(idempotencyKey);
            }
          }
        }

        if (asyncMode) {
          if (asyncPendingQueue.length >= ASYNC_QUEUE_MAX) {
            return Response.json(
              { ok: false, code: 'overloaded', error: 'Embedding queue is full. Retry after a few seconds.' },
              { status: 503, headers: { 'Retry-After': '5' } },
            );
          }
          sweepJobs();
          const jobId = newJobId();
          const jobState: AsyncJobState = { status: 'pending', slug, content_hash: '', created: Date.now() };
          asyncJobs.set(jobId, jobState);
          if (idempotencyKey) asyncInFlight.set(idempotencyKey, jobId);

          // Phase 1 (sync): write page to DB immediately so keyword search works
          // before embedding completes. Runs in the request context before 202.
          try {
            const phase1 = await importFromContent(engine, slug, fullContent, { noEmbed: true });
            jobState.content_hash = phase1.content_hash ?? '';
            pendingEmbeds.add(slug);
            // Prime write-through cache so GET /page hits memory, not DB.
            void engine.getPage(slug).then(p => { if (p) pageCacheSet(slug, p); });
          } catch (e) {
            console.warn(`[gbrain] async phase1 write failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
          }

          // Phase 2 (background): embed the page so vector search works.
          // Mirror put_page op's guard: skip embedding (and hash-bypass) if no API
          // key is configured — avoids 5-retry exponential backoff on missing key.
          const canEmbed = !!process.env.OPENAI_API_KEY;
          ;(async () => {
            await acquireAsyncSlot();
            jobState.status = 'running';
            try {
              const result = await withEmbedRetry(slug, () => importFromContent(engine, slug, fullContent, {
                forceReembed: canEmbed,
                noEmbed: !canEmbed,
              })) as { content_hash?: string } & object;
              const resolvedHash = (result as { content_hash?: string }).content_hash ?? jobState.content_hash;
              jobState.status = 'completed';
              jobState.content_hash = resolvedHash;
              jobState.result = result;
              if (idempotencyKey) {
                idempotencyCache.set(idempotencyKey, { slug, content_hash: resolvedHash, result, created: Date.now() });
              }
            } catch (e) {
              jobState.status = 'failed';
              jobState.error = e instanceof Error ? e.message : String(e);
            } finally {
              pendingEmbeds.delete(slug);
              releaseAsyncSlot();
              if (idempotencyKey) asyncInFlight.delete(idempotencyKey);
            }
          })();

          return Response.json(
            {
              ok: true,
              job_id: jobId,
              slug,
              status: 'pending',
              page_committed: jobState.content_hash !== '',
              content_hash: jobState.content_hash || undefined,
            },
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
            code: 'string — machine-readable; values: otp_required, otp_invalid, unauthorized, missing_param, invalid_json, invalid_tags, too_large, not_found, warming_up, upload_not_found, incomplete_upload, chunk_index_out_of_range, chunk_too_large, total_exceeded',
            chunked_upload_codes: {
              upload_not_found:          'upload_id does not exist or session expired (TTL 10 min). Start over with action=start_chunked.',
              incomplete_upload:         'commit_chunked called before all chunks arrived. Response includes missing_indices[] and expected_total.',
              chunk_index_out_of_range:  'chunk_index is negative, ≥ CHUNK_MAX_CHUNKS (20), or ≥ declared total_chunks.',
              chunk_too_large:           'Single chunk exceeds 1 500 chars. Split further so each URL stays under 8 000 chars.',
              total_exceeded:            'Accumulated content (running total across all chunks) would exceed 50 000 chars. Reduce content or split into multiple pages.',
            },
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
              description: 'Async is now the DEFAULT. Both GET /write?action=put_page and PUT /page return 202 immediately unless you pass sync=1.',
              default_behavior: '202 returned immediately; page is written to DB before 202 (keyword-searchable at once); embedding runs in background.',
              sync_opt_out: 'Add &sync=1 (GET) or body sync:1 (PUT) to force a blocking write that waits for embedding. Useful for small test scripts; may timeout on slow networks.',
              response: '202 { ok, job_id, slug, status:"pending", page_committed:bool, content_hash:string|undefined }. content_hash is present when phase-1 DB write succeeded before 202.',
              poll: 'GET /job?id=<job_id> → { status: pending|running|completed|failed, content_hash, result?, error? }. Jobs expire after 5 min.',
              verify: 'page_committed:true in the 202 means the page is already readable via GET /page — no need for a polling round-trip to confirm landing.',
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
                params: 'slug (required), content (required, URL-encoded, ≤50k), title, type (default: concept), tags (comma-separated), source, ai_confidence, created (YYYY-MM-DD), sync (0|1, default 0 = async), idempotency_key',
                note: 'If content already has YAML frontmatter (starts with ---), it is used as-is. Otherwise frontmatter is built from the other params.',
              },
              chunked_upload: {
                description: 'Four-action GET-safe protocol for long content (> ~1 500 UTF-8 chars). Use when put_page would exceed the 8 000 char URL limit. ⚠ Sessions live in process memory — volatile across restarts. Always pass idempotency_key.',
                step1_start_chunked: 'slug (required), total_chunks 1–20 (optional — omit to auto-infer at commit), plus any put_page metadata (title, type, source, tags, ai_confidence, created, sync, idempotency_key). Returns upload_id.',
                step2_append_chunk:  'upload_id (required), chunk_index 0-based (required), content or content_b64 (required, ≤1 500 chars). Idempotent — re-send same index to overwrite. Returns received/remaining/accumulated_size.',
                step3_status_chunked: 'upload_id (required). Read-only progress query — safe to call after any timeout to see which indices arrived. Returns received_indices, missing_indices, ready_to_commit.',
                step4_commit_chunked: 'upload_id (required). Assembles chunks in index order and writes the page — produces the same content_hash as a single put_page with identical content. Same response envelope as put_page.',
                workflow: 'start_chunked → upload_id  →  append_chunk × N (any order)  →  [status_chunked to check]  →  commit_chunked',
              },
              add_tag: { params: 'slug (required), tag (required)' },
              remove_tag: { params: 'slug (required), tag (required)' },
              add_link: {
                params: 'from (required), to (required), type or link_type (default: relates_to)',
                note: 'Bidirectional — inserts from→to AND to→from. type enum: derives_from, supersedes, relates_to, example_of, contradicts, mentions. Returns neighbors: [{slug, type, title}].',
              },
              patch_page: {
                params: 'slug (required), find (required), replace (optional, default ""), sync (0|1)',
                note: 'String-replace on page body. The find string must occur exactly once (ambiguous multi-match rejected). Async by default.',
              },
              put_page_batch: {
                params: 'pages (required, JSON array of {slug, content} objects, max 10)',
                note: 'Write multiple pages in one GET request. Per-page results returned. Use for building pages + adding tags together.',
              },
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
          // Async is the default; pass sync=1 to force a blocking write.
          const writeAsync = url.searchParams.get('sync') !== '1';

          if (writeIdempotencyKey) {
            sweepIdempotency();
            const cached = idempotencyCache.get(writeIdempotencyKey);
            if (cached && cached.slug === slug) {
              return ok({ action, slug, content_hash: cached.content_hash, idempotent: true, ...cached.result }, Date.now() - t0);
            }
            if (writeAsync) {
              const existingJobId = asyncInFlight.get(writeIdempotencyKey);
              if (existingJobId) {
                const existingJob = asyncJobs.get(existingJobId);
                if (existingJob) {
                  return Response.json(
                    { ok: true, action, job_id: existingJobId, slug, status: existingJob.status, idempotent: true },
                    { status: 202 },
                  );
                }
                asyncInFlight.delete(writeIdempotencyKey);
              }
            }
          }

          if (writeAsync) {
            if (asyncPendingQueue.length >= ASYNC_QUEUE_MAX) {
              return Response.json(
                { ok: false, code: 'overloaded', error: 'Embedding queue is full. Retry after a few seconds.' },
                { status: 503, headers: { 'Retry-After': '5' } },
              );
            }
            sweepJobs();
            const jobId = newJobId();
            const jobState: AsyncJobState = { status: 'pending', slug, content_hash: '', created: Date.now() };
            asyncJobs.set(jobId, jobState);
            if (writeIdempotencyKey) asyncInFlight.set(writeIdempotencyKey, jobId);

            // Phase 1 (sync): write page to DB immediately so keyword search works
            // before embedding completes. Runs in the request context before 202.
            try {
              const phase1 = await importFromContent(engine, slug, fullContent, { noEmbed: true });
              jobState.content_hash = phase1.content_hash ?? '';
              pendingEmbeds.add(slug);
              void engine.getPage(slug).then(p => { if (p) pageCacheSet(slug, p); });
            } catch (e) {
              console.warn(`[gbrain] async phase1 write failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
            }

            // Phase 2 (background): embed the page so vector search works.
            // Mirror put_page op's guard: skip embedding (and hash-bypass) if no API
            // key is configured — avoids 5-retry exponential backoff on missing key.
            const canEmbedWrite = !!process.env.OPENAI_API_KEY;
            ;(async () => {
              await acquireAsyncSlot();
              jobState.status = 'running';
              try {
                const result = await withEmbedRetry(slug, () => importFromContent(engine, slug, fullContent, {
                  forceReembed: canEmbedWrite,
                  noEmbed: !canEmbedWrite,
                })) as { content_hash?: string } & object;
                const resolvedHash = (result as { content_hash?: string }).content_hash ?? jobState.content_hash;
                jobState.status = 'completed';
                jobState.content_hash = resolvedHash;
                jobState.result = result;
                if (writeIdempotencyKey) {
                  idempotencyCache.set(writeIdempotencyKey, { slug, content_hash: resolvedHash, result, created: Date.now() });
                }
              } catch (e) {
                jobState.status = 'failed';
                jobState.error = e instanceof Error ? e.message : String(e);
              } finally {
                pendingEmbeds.delete(slug);
                releaseAsyncSlot();
                if (writeIdempotencyKey) asyncInFlight.delete(writeIdempotencyKey);
              }
            })();
            return Response.json(
              {
                ok: true,
                action,
                job_id: jobId,
                slug,
                status: 'pending',
                page_committed: jobState.content_hash !== '',
                content_hash: jobState.content_hash || undefined,
              },
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
          // Accept 'type' (new canonical) or 'link_type' (legacy) param
          const rawType = url.searchParams.get('type') ?? url.searchParams.get('link_type') ?? 'relates_to';
          const NEURAL_LINK_TYPES = ['derives_from', 'supersedes', 'relates_to', 'example_of', 'contradicts', 'mentions'];
          if (!NEURAL_LINK_TYPES.includes(rawType)) {
            return err('invalid_param',
              `Invalid link type: "${rawType}". Valid: ${NEURAL_LINK_TYPES.join(', ')}`,
              400,
              { hint: 'Use one of the enum values — e.g. type=relates_to' },
            );
          }
          if (!from) return err('missing_param', 'from is required for add_link');
          if (!to) return err('missing_param', 'to is required for add_link');
          // Bidirectional: insert from→to and to→from in parallel
          await Promise.all([
            addLinkOp.handler(ctx, { from, to, link_type: rawType }),
            addLinkOp.handler(ctx, { from: to, to: from, link_type: rawType }),
          ]);
          // Build neighbors list for 'from' page (outgoing + incoming, deduplicated)
          const [outLinks, inLinks] = await Promise.all([
            engine.getLinks(from),
            engine.getBacklinks(from),
          ]);
          const neighborMap = new Map<string, string>(); // slug → link_type
          for (const l of outLinks) neighborMap.set(l.to_slug, l.link_type);
          for (const l of inLinks) neighborMap.set(l.from_slug, l.link_type);
          neighborMap.delete(from); // exclude self if any self-loop
          const neighbors = await Promise.all(
            [...neighborMap.entries()].slice(0, 20).map(async ([nSlug, nType]) => {
              const nPage = await engine.getPage(nSlug);
              return { slug: nSlug, type: nType, title: nPage?.title ?? nSlug };
            }),
          );
          return ok({ action, from, to, link_type: rawType, bidirectional: true, neighbors }, Date.now() - t0);
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

        // ── action=patch_page ─────────────────────────────────────────────────
        // Lightweight string-replace on a page's body — avoids re-sending the
        // entire content when fixing a small typo. The find string must occur
        // EXACTLY ONCE (ambiguous multi-match is rejected). Async by default.
        // Required: slug, find. Optional: replace (default ""), sync=1.
        if (action === 'patch_page') {
          const slug = url.searchParams.get('slug');
          const find = url.searchParams.get('find');
          const replace = url.searchParams.get('replace') ?? '';
          if (!slug) return err('missing_param', 'slug is required for patch_page');
          if (find === null) return err('missing_param', 'find is required for patch_page');

          const page = await engine.getPage(slug);
          if (!page) return err('not_found', `Page not found: ${slug}`, 404);

          const body = page.compiled_truth ?? '';
          const occurrences = body.split(find).length - 1;
          if (occurrences === 0) {
            return err('not_found', `String not found in page: "${find.slice(0, 80)}"`, 404, {
              hint: 'Match is case-sensitive and exact. Use GET /page?slug=... to inspect current content.',
            });
          }
          if (occurrences > 1) {
            return err('ambiguous_match',
              `Found ${occurrences} occurrences. Provide more context to make the match unique.`,
              400,
              { hint: 'Include surrounding text in the find parameter to narrow to exactly one occurrence.' },
            );
          }

          const patchedBody = body.replace(find, replace);

          // Reconstruct full markdown: YAML frontmatter + patched body
          const fm = (page.frontmatter as Record<string, unknown>) ?? {};
          const fmLines = ['---'];
          if (page.type) fmLines.push(`type: ${page.type}`);
          if (page.title) fmLines.push(`title: ${JSON.stringify(page.title)}`);
          for (const [k, v] of Object.entries(fm)) {
            if (['type', 'title'].includes(k) || v === null || v === undefined) continue;
            if (typeof v === 'string') {
              fmLines.push(`${k}: ${(v.includes(':') || v.includes('#') || v.includes('"')) ? JSON.stringify(v) : v}`);
            } else if (Array.isArray(v)) {
              fmLines.push(`${k}:\n${(v as unknown[]).map(i => `  - ${i}`).join('\n')}`);
            } else {
              fmLines.push(`${k}: ${JSON.stringify(v)}`);
            }
          }
          fmLines.push('---', '');
          const patchFullContent = fmLines.join('\n') + patchedBody;

          const patchAsync = url.searchParams.get('sync') !== '1';

          if (patchAsync) {
            if (asyncPendingQueue.length >= ASYNC_QUEUE_MAX) {
              return Response.json(
                { ok: false, code: 'overloaded', error: 'Embedding queue is full. Retry after a few seconds.' },
                { status: 503, headers: { 'Retry-After': '5' } },
              );
            }
            sweepJobs();
            const patchJobId = newJobId();
            const patchJobState: AsyncJobState = { status: 'pending', slug, content_hash: '', created: Date.now() };
            asyncJobs.set(patchJobId, patchJobState);
            try {
              const phase1 = await importFromContent(engine, slug, patchFullContent, { noEmbed: true });
              patchJobState.content_hash = phase1.content_hash ?? '';
              pendingEmbeds.add(slug);
              void engine.getPage(slug).then(p => { if (p) pageCacheSet(slug, p); });
            } catch (e) {
              console.warn(`[gbrain] patch_page phase1 failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
            }
            const canEmbedPatch = !!process.env.OPENAI_API_KEY;
            ;(async () => {
              await acquireAsyncSlot();
              patchJobState.status = 'running';
              try {
                const result = await withEmbedRetry(slug, () => importFromContent(engine, slug, patchFullContent, {
                  forceReembed: canEmbedPatch, noEmbed: !canEmbedPatch,
                })) as { content_hash?: string } & object;
                patchJobState.status = 'completed';
                patchJobState.content_hash = (result as { content_hash?: string }).content_hash ?? patchJobState.content_hash;
                patchJobState.result = result;
              } catch (e) {
                patchJobState.status = 'failed';
                patchJobState.error = e instanceof Error ? e.message : String(e);
              } finally {
                pendingEmbeds.delete(slug);
                releaseAsyncSlot();
              }
            })();
            return Response.json({
              ok: true, action, job_id: patchJobId, slug,
              status: 'pending',
              page_committed: patchJobState.content_hash !== '',
              content_hash: patchJobState.content_hash || undefined,
              find: find.slice(0, 80), replace: replace.slice(0, 80), occurrences_replaced: 1,
            }, { status: 202 });
          }

          const patchResult = await putPageOp.handler(ctx, { slug, content: patchFullContent }) as { content_hash?: string } & object;
          const patchHash = (patchResult as { content_hash?: string }).content_hash ?? '';
          return ok({ action, slug, find: find.slice(0, 80), replace: replace.slice(0, 80), occurrences_replaced: 1, content_hash: patchHash }, Date.now() - t0);
        }

        // ── action=put_page_batch ─────────────────────────────────────────────
        // Write multiple pages in one request. Accepts a JSON-encoded array
        // in the 'pages' URL param: pages=[{"slug":"...","content":"..."},...]
        // Max 10 pages per batch. Each page processed sequentially so failures
        // are isolated. Returns per-page results.
        if (action === 'put_page_batch') {
          const pagesParam = url.searchParams.get('pages');
          if (!pagesParam) {
            return err('missing_param', 'pages (JSON array of {slug,content} objects) is required for put_page_batch', 400, {
              hint: 'Example: pages=[{"slug":"mem/2026-05-24/note","content":"# Hello"}]',
            });
          }
          let batchInput: Array<{ slug: string; content: string; tags?: string }>;
          try { batchInput = JSON.parse(pagesParam); } catch {
            return err('invalid_json', 'pages must be a valid JSON array', 400);
          }
          if (!Array.isArray(batchInput) || batchInput.length === 0) {
            return err('invalid_param', 'pages must be a non-empty JSON array', 400);
          }
          if (batchInput.length > 10) {
            return err('too_large', `Batch size ${batchInput.length} exceeds 10-page limit`, 400, {
              hint: 'Split into multiple put_page_batch calls.',
            });
          }

          const batchResults: Array<{ slug: string; ok: boolean; content_hash?: string; error?: string }> = [];
          for (const item of batchInput) {
            if (!item.slug || !item.content) {
              batchResults.push({ slug: item.slug ?? '?', ok: false, error: 'slug and content are required' });
              continue;
            }
            if (item.content.length > 50_000) {
              batchResults.push({ slug: item.slug, ok: false, error: 'content exceeds 50k char limit' });
              continue;
            }
            try {
              const hasFm = item.content.trimStart().startsWith('---');
              const batchFullContent = hasFm ? item.content : [
                '---', 'source: agent',
                `created: ${new Date().toISOString().slice(0, 10)}`,
                '---', '', item.content,
              ].join('\n');
              const batchRes = await putPageOp.handler(ctx, { slug: item.slug, content: batchFullContent }) as { content_hash?: string };
              batchResults.push({ slug: item.slug, ok: true, content_hash: batchRes.content_hash });
            } catch (e) {
              batchResults.push({ slug: item.slug, ok: false, error: e instanceof Error ? e.message : String(e) });
            }
          }

          const batchSucceeded = batchResults.filter(r => r.ok).length;
          return ok({
            action,
            batch_size: batchInput.length,
            succeeded: batchSucceeded,
            failed: batchInput.length - batchSucceeded,
            results: batchResults,
          }, Date.now() - t0);
        }

        // ── action=append_chunks (plural) ─────────────────────────────────────
        // Multi-chunk variant of append_chunk: send multiple chunks in one GET
        // request. Required: upload_id, chunks (JSON array of {idx,content}).
        // Max 5 chunks per call to stay within URL limits. Each chunk ≤ 1 500 chars.
        // Idempotent: re-sending the same idx overwrites the previous value.
        if (action === 'append_chunks') {
          const uploadId = url.searchParams.get('upload_id');
          if (!uploadId) return err('missing_param', 'upload_id is required for append_chunks');
          const state = chunkUploads.get(uploadId);
          if (!state) {
            return err('upload_not_found', `Upload session not found or expired: ${uploadId}`, 404, {
              hint: 'Sessions expire after 10 min. Start a new upload with action=start_chunked.',
            });
          }
          const chunksParam = url.searchParams.get('chunks');
          if (!chunksParam) return err('missing_param', 'chunks (JSON array of {idx,content}) is required');
          let chunksInput: Array<{ idx: number; content?: string; content_b64?: string }>;
          try { chunksInput = JSON.parse(chunksParam); } catch {
            return err('invalid_json', 'chunks must be a valid JSON array of {idx, content} objects', 400);
          }
          if (!Array.isArray(chunksInput) || chunksInput.length === 0) {
            return err('invalid_param', 'chunks must be a non-empty array', 400);
          }
          if (chunksInput.length > 5) {
            return err('too_large', 'append_chunks is limited to 5 chunks per call', 400, {
              hint: 'Send up to 5 chunks at once; call again for more.',
            });
          }
          const multiResults: Array<{ idx: number; ok: boolean; error?: string }> = [];
          for (const item of chunksInput) {
            const chunkIndex = item.idx;
            if (!Number.isFinite(chunkIndex) || chunkIndex < 0 || chunkIndex >= CHUNK_MAX_CHUNKS) {
              multiResults.push({ idx: chunkIndex, ok: false, error: `chunk_index must be 0–${CHUNK_MAX_CHUNKS - 1}` });
              continue;
            }
            if (state.totalChunks !== null && chunkIndex >= state.totalChunks) {
              multiResults.push({ idx: chunkIndex, ok: false, error: `chunk_index ${chunkIndex} ≥ declared total_chunks ${state.totalChunks}` });
              continue;
            }
            const chunkText = item.content_b64
              ? Buffer.from(item.content_b64, 'base64').toString('utf8')
              : (item.content ?? null);
            if (!chunkText) { multiResults.push({ idx: chunkIndex, ok: false, error: 'content or content_b64 is required' }); continue; }
            if (chunkText.length > CHUNK_MAX_SINGLE) {
              multiResults.push({ idx: chunkIndex, ok: false, error: `chunk too large (${chunkText.length} > ${CHUNK_MAX_SINGLE})` });
              continue;
            }
            const oldText = state.chunks.get(chunkIndex);
            const newAccumulated = state.accumulatedSize - (oldText?.length ?? 0) + chunkText.length;
            if (newAccumulated > CHUNK_MAX_TOTAL) {
              multiResults.push({ idx: chunkIndex, ok: false, error: `accumulated size ${newAccumulated} would exceed ${CHUNK_MAX_TOTAL}` });
              continue;
            }
            state.chunks.set(chunkIndex, chunkText);
            state.accumulatedSize = newAccumulated;
            multiResults.push({ idx: chunkIndex, ok: true });
          }
          const received = state.chunks.size;
          const remaining = state.totalChunks !== null ? state.totalChunks - received : null;
          const readyToCommit = state.totalChunks !== null && remaining === 0;
          return ok({
            action, upload_id: uploadId,
            chunk_results: multiResults,
            received, remaining, ready_to_commit: readyToCommit,
            accumulated_size: state.accumulatedSize,
            next: readyToCommit ? `action=commit_chunked&upload_id=${uploadId}` : null,
          }, Date.now() - t0);
        }

        // ── action=start_chunked ──────────────────────────────────────────────
        // Initialise a chunked upload session.
        // Required: slug
        // Optional: total_chunks (1–20) — omit to let commit_chunked infer from
        //   highest received index. Useful when you don't know the count upfront.
        // Optional metadata forwarded to commit: title, type, source, tags,
        //   ai_confidence, created, sync, idempotency_key
        if (action === 'start_chunked') {
          const slug = url.searchParams.get('slug');
          if (!slug) return err('missing_param', 'slug is required for start_chunked');
          const totalChunksStr = url.searchParams.get('total_chunks');
          let totalChunks: number | null = null;
          if (totalChunksStr !== null) {
            totalChunks = parseInt(totalChunksStr, 10);
            if (!Number.isFinite(totalChunks) || totalChunks < 1 || totalChunks > CHUNK_MAX_CHUNKS) {
              return err('invalid_param', `total_chunks must be 1–${CHUNK_MAX_CHUNKS}`, 400, {
                hint: 'Omit total_chunks to let commit_chunked infer the count automatically',
              });
            }
          }
          sweepChunkUploads();
          const uploadId = randomBytes(8).toString('hex');
          const params: Record<string, string> = {};
          for (const key of ['title', 'type', 'source', 'tags', 'ai_confidence', 'created', 'sync', 'idempotency_key']) {
            const v = url.searchParams.get(key);
            if (v !== null) params[key] = v;
          }
          chunkUploads.set(uploadId, {
            slug,
            totalChunks,
            chunks: new Map(),
            accumulatedSize: 0,
            params,
            created: Date.now(),
          });
          return ok({
            action,
            upload_id: uploadId,
            slug,
            total_chunks: totalChunks ?? 'auto',
            storage: 'memory',
            volatile: true,
            volatile_note: 'Session is lost on server restart. Supply idempotency_key at start_chunked so commit_chunked can de-duplicate across retries.',
            expires_ms: CHUNK_UPLOAD_TTL_MS,
            next: `action=append_chunk&upload_id=${uploadId}&chunk_index=0&content=<url-encoded-chunk>`,
          }, Date.now() - t0);
        }

        // ── action=append_chunk ───────────────────────────────────────────────
        // Append (or overwrite) one chunk. Idempotent: re-sending the same
        // chunk_index replaces the previous value, so retries are safe.
        // Required: upload_id, chunk_index (0-based), content OR content_b64
        // Each chunk must be ≤ CHUNK_MAX_SINGLE chars. Cumulative total must
        // stay ≤ CHUNK_MAX_TOTAL; check fires early so you don't discover the
        // overflow at commit time.
        if (action === 'append_chunk') {
          const uploadId = url.searchParams.get('upload_id');
          if (!uploadId) return err('missing_param', 'upload_id is required for append_chunk');
          const state = chunkUploads.get(uploadId);
          if (!state) {
            return err('upload_not_found', `Upload session not found or expired: ${uploadId}`, 404, {
              hint: 'Sessions expire after 10 min. Start a new upload with action=start_chunked.',
            });
          }
          const chunkIndexStr = url.searchParams.get('chunk_index');
          if (chunkIndexStr === null) return err('missing_param', 'chunk_index is required for append_chunk');
          const chunkIndex = parseInt(chunkIndexStr, 10);
          if (!Number.isFinite(chunkIndex) || chunkIndex < 0 || chunkIndex >= CHUNK_MAX_CHUNKS) {
            return err('chunk_index_out_of_range',
              `chunk_index must be 0–${CHUNK_MAX_CHUNKS - 1}`,
              400,
              { hint: `Maximum ${CHUNK_MAX_CHUNKS} chunks per session (indices 0–${CHUNK_MAX_CHUNKS - 1})` }
            );
          }
          if (state.totalChunks !== null && chunkIndex >= state.totalChunks) {
            return err('chunk_index_out_of_range',
              `chunk_index ${chunkIndex} exceeds declared total_chunks ${state.totalChunks} (valid: 0–${state.totalChunks - 1})`,
              400,
            );
          }

          const contentB64 = url.searchParams.get('content_b64');
          const chunkText = contentB64
            ? Buffer.from(contentB64, 'base64').toString('utf8')
            : url.searchParams.get('content');
          if (!chunkText) return err('missing_param', 'content or content_b64 is required for append_chunk');

          // Per-chunk size guard.
          if (chunkText.length > CHUNK_MAX_SINGLE) {
            return err('chunk_too_large',
              `Chunk ${chunkIndex} is ${chunkText.length} chars; max is ${CHUNK_MAX_SINGLE}`,
              413,
              { hint: `Split this chunk further. Keep each chunk ≤ ${CHUNK_MAX_SINGLE} UTF-8 chars so the URL stays under 8 000 chars.` }
            );
          }

          // Update accumulated size (subtract old chunk if replacing).
          const oldText = state.chunks.get(chunkIndex);
          const oldSize = oldText ? oldText.length : 0;
          const newAccumulated = state.accumulatedSize - oldSize + chunkText.length;
          if (newAccumulated > CHUNK_MAX_TOTAL) {
            return err('total_exceeded',
              `Accumulated content (${newAccumulated} chars) would exceed ${CHUNK_MAX_TOTAL} char limit`,
              413,
              { hint: 'Reduce content length or split into multiple pages with an index page.' }
            );
          }
          state.chunks.set(chunkIndex, chunkText);
          state.accumulatedSize = newAccumulated;

          const received = state.chunks.size;
          const remaining = state.totalChunks !== null ? state.totalChunks - received : null;
          const readyToCommit = state.totalChunks !== null && remaining === 0;
          return ok({
            action,
            upload_id: uploadId,
            chunk_index: chunkIndex,
            received,
            remaining,          // null when total_chunks was not declared
            ready_to_commit: readyToCommit,
            accumulated_size: state.accumulatedSize,
            next: readyToCommit
              ? `action=commit_chunked&upload_id=${uploadId}`
              : `action=append_chunk&upload_id=${uploadId}&chunk_index=${chunkIndex + 1}&content=<next-chunk>`,
          }, Date.now() - t0);
        }

        // ── action=commit_chunked ─────────────────────────────────────────────
        // Assemble all chunks and write the page. Same logic as put_page.
        // Required: upload_id
        // When total_chunks was declared: verifies 0..total-1 are all present.
        // When total_chunks was omitted: infers total from max received index.
        // Session is deleted only after the async job is enqueued (or sync write
        // succeeds) so 503-overloaded retries can re-commit with the same upload_id.
        if (action === 'commit_chunked') {
          const uploadId = url.searchParams.get('upload_id');
          if (!uploadId) return err('missing_param', 'upload_id is required for commit_chunked');
          const state = chunkUploads.get(uploadId);
          if (!state) {
            return err('upload_not_found', `Upload session not found or expired: ${uploadId}`, 404, {
              hint: 'Sessions expire after 10 min. Start a new upload with action=start_chunked.',
            });
          }

          if (state.chunks.size === 0) {
            return err('incomplete_upload', 'No chunks received yet. Send at least one chunk before committing.', 400);
          }

          // Determine expected total: declared or inferred from max index.
          const maxIndex = Math.max(...state.chunks.keys());
          const expectedTotal = state.totalChunks ?? (maxIndex + 1);

          // Completeness check — list every missing index explicitly.
          const missing = missingIndices(state.chunks, expectedTotal);
          if (missing.length > 0) {
            return err('incomplete_upload',
              `Missing chunk indices: [${missing.join(', ')}]`,
              400,
              {
                missing_indices: missing,
                received: state.chunks.size,
                expected_total: expectedTotal,
                hint: `Send the missing chunk(s) with action=append_chunk&chunk_index=<index> before committing.`,
              }
            );
          }

          // Assemble in index order (same as put_page single write → same content_hash).
          const rawContent = assembleChunks(state.chunks);
          // assembleChunks already guards via accumulatedSize, but double-check here.
          if (rawContent.length > CHUNK_MAX_TOTAL) {
            chunkUploads.delete(uploadId);
            return err('total_exceeded',
              `Assembled content (${rawContent.length} chars) exceeds ${CHUNK_MAX_TOTAL} char limit`, 413,
              { hint: 'Reduce content length or split into multiple pages with an index page.' }
            );
          }

          const slug = state.slug;
          const params = state.params;

          // Build fullContent with frontmatter (same logic as put_page action).
          const hasfm = rawContent.trimStart().startsWith('---');
          let fullContent: string;
          if (hasfm) {
            fullContent = rawContent;
          } else {
            const source = params.source ?? 'agent';
            const type   = params.type   ?? 'concept';
            const title  = params.title;
            const tagsRaw = params.tags;
            const tags   = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
            const aiConf = params.ai_confidence;
            const created = params.created ?? new Date().toISOString().slice(0, 10);
            const fmLines = ['---'];
            if (title) fmLines.push(`title: ${JSON.stringify(title)}`);
            fmLines.push(`type: ${type}`, `source: ${source}`);
            if (tags.length) fmLines.push(`tags:\n${tags.map(t => `  - ${t}`).join('\n')}`);
            if (aiConf) fmLines.push(`ai_confidence: ${aiConf}`);
            fmLines.push(`created: ${created}`, '---', '', rawContent);
            fullContent = fmLines.join('\n');
          }

          const commitIdempotencyKey = params.idempotency_key ?? null;
          const commitAsync = params.sync !== '1';

          // Idempotency check — return cached result within TTL window.
          if (commitIdempotencyKey) {
            sweepIdempotency();
            const cached = idempotencyCache.get(commitIdempotencyKey);
            if (cached && cached.slug === slug) {
              return ok({ action, slug, content_hash: cached.content_hash, idempotent: true, ...cached.result }, Date.now() - t0);
            }
            if (commitAsync) {
              const existingJobId = asyncInFlight.get(commitIdempotencyKey);
              if (existingJobId) {
                const existingJob = asyncJobs.get(existingJobId);
                if (existingJob) {
                  return Response.json(
                    { ok: true, action, job_id: existingJobId, slug, status: existingJob.status, idempotent: true },
                    { status: 202 },
                  );
                }
                asyncInFlight.delete(commitIdempotencyKey);
              }
            }
          }

          if (commitAsync) {
            // Backpressure check BEFORE deleting the session so 503 is re-triable.
            if (asyncPendingQueue.length >= ASYNC_QUEUE_MAX) {
              return Response.json(
                { ok: false, code: 'overloaded', error: 'Embedding queue is full. Retry after a few seconds.' },
                { status: 503, headers: { 'Retry-After': '5' } },
              );
            }
            sweepJobs();
            const jobId = newJobId();
            const jobState: AsyncJobState = { status: 'pending', slug, content_hash: '', created: Date.now() };
            asyncJobs.set(jobId, jobState);
            if (commitIdempotencyKey) asyncInFlight.set(commitIdempotencyKey, jobId);
            // Session consumed: delete AFTER job is registered so 503 retries could re-commit.
            chunkUploads.delete(uploadId);

            // Phase 1 (sync): write without embedding so keyword search works immediately.
            try {
              const phase1 = await importFromContent(engine, slug, fullContent, { noEmbed: true });
              jobState.content_hash = phase1.content_hash ?? '';
              pendingEmbeds.add(slug);
              void engine.getPage(slug).then(p => { if (p) pageCacheSet(slug, p); });
            } catch (e) {
              console.warn(`[gbrain] chunked phase1 write failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
            }

            const canEmbedChunk = !!process.env.OPENAI_API_KEY;
            ;(async () => {
              await acquireAsyncSlot();
              jobState.status = 'running';
              try {
                const result = await withEmbedRetry(slug, () => importFromContent(engine, slug, fullContent, {
                  forceReembed: canEmbedChunk,
                  noEmbed: !canEmbedChunk,
                })) as { content_hash?: string } & object;
                const resolvedHash = (result as { content_hash?: string }).content_hash ?? jobState.content_hash;
                jobState.status = 'completed';
                jobState.content_hash = resolvedHash;
                jobState.result = result;
                if (commitIdempotencyKey) {
                  idempotencyCache.set(commitIdempotencyKey, { slug, content_hash: resolvedHash, result, created: Date.now() });
                }
              } catch (e) {
                jobState.status = 'failed';
                jobState.error = e instanceof Error ? e.message : String(e);
              } finally {
                pendingEmbeds.delete(slug);
                releaseAsyncSlot();
                if (commitIdempotencyKey) asyncInFlight.delete(commitIdempotencyKey);
              }
            })();

            return Response.json(
              {
                ok: true,
                action,
                job_id: jobId,
                slug,
                status: 'pending',
                page_committed: jobState.content_hash !== '',
                content_hash: jobState.content_hash || undefined,
              },
              { status: 202 },
            );
          }

          // Sync write — delete session only after successful write.
          const result = await putPageOp.handler(ctx, { slug, content: fullContent }) as { content_hash?: string } & object;
          chunkUploads.delete(uploadId);
          const commitHash = result.content_hash ?? '';
          if (commitIdempotencyKey) {
            sweepIdempotency();
            idempotencyCache.set(commitIdempotencyKey, { slug, content_hash: commitHash, result, created: Date.now() });
          }
          const SEARCH_INDEX_LAG_MS = 2000;
          return ok({
            action,
            slug,
            content_hash: commitHash,
            search_indexed_at: new Date(Date.now() + SEARCH_INDEX_LAG_MS).toISOString(),
            ...result,
          }, Date.now() - t0);
        }

        // ── action=status_chunked ─────────────────────────────────────────────
        // Read-only progress query. Safe to call at any time without side effects.
        // Returns the same info as append_chunk without touching state, so a
        // client that timed out mid-upload can recover without re-sending data.
        if (action === 'status_chunked') {
          const uploadId = url.searchParams.get('upload_id');
          if (!uploadId) return err('missing_param', 'upload_id is required for status_chunked');
          const state = chunkUploads.get(uploadId);
          if (!state) {
            return err('upload_not_found', `Upload session not found or expired: ${uploadId}`, 404, {
              hint: 'Sessions expire after 10 min. Start a new upload with action=start_chunked.',
            });
          }
          const received = state.chunks.size;
          const expectedTotal = state.totalChunks ?? null;
          const remaining = expectedTotal !== null ? expectedTotal - received : null;
          const maxReceivedIndex = state.chunks.size > 0 ? Math.max(...state.chunks.keys()) : -1;
          const receivedIndices = [...state.chunks.keys()].sort((a, b) => a - b);
          const missingList = expectedTotal !== null ? missingIndices(state.chunks, expectedTotal) : [];
          return ok({
            action,
            upload_id: uploadId,
            slug: state.slug,
            total_chunks: expectedTotal ?? 'auto',
            received,
            remaining,
            missing_indices: missingList,
            accumulated_size: state.accumulatedSize,
            max_received_index: maxReceivedIndex,
            received_indices: receivedIndices,
            ready_to_commit: expectedTotal !== null && remaining === 0,
            expires_at: new Date(state.created + CHUNK_UPLOAD_TTL_MS).toISOString(),
            storage: 'memory',
            volatile: true,
          }, Date.now() - t0);
        }

        return err('invalid_action', `Unknown action: ${action}`, 400, {
          hint: 'Supported actions: put_page, put_page_batch, patch_page, add_tag, remove_tag, add_link, add_timeline_entry, delete_page, start_chunked, append_chunk, append_chunks, commit_chunked, status_chunked',
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
  console.error('  PUT  /page → 202 {job_id, slug, page_committed, content_hash, status:"pending"}  (async by default; add ?sync=1 to block)');
  console.error('  GET  /job?id=<job_id>   → poll async job status');
  console.error('  DELETE /page?slug=...&otp=<code>');
  console.error('  GET  /pages/recent?limit=50&otp=<code>');
  console.error('  GET  /write?action=<action>&otp=<code>&...  (put_page|put_page_batch|patch_page|add_tag|remove_tag|add_link|add_timeline_entry|delete_page)');
  console.error('  GET  /write?action=add_link&from=...&to=...&type=derives_from|supersedes|relates_to|example_of|contradicts  (bidirectional + neighbors)');
  console.error('  GET  /write?action=patch_page&slug=...&find=...&replace=...  (single-occurrence string replace)');
  console.error('  GET  /write?action=put_page_batch&pages=[{"slug":"...","content":"..."},...]  (up to 10 pages)');
  console.error('  GET  /write?action=start_chunked&slug=...&total_chunks=N   (step 1/4 chunked upload for long content)');
  console.error('  GET  /write?action=append_chunk&upload_id=...&chunk_index=N&content=... (step 2/4, single chunk)');
  console.error('  GET  /write?action=append_chunks&upload_id=...&chunks=[{idx,content},...]  (step 2/4, multi-chunk variant, max 5)');
  console.error('  GET  /write?action=status_chunked&upload_id=...             (step 3/4 — progress check)');
  console.error('  GET  /write?action=commit_chunked&upload_id=...             (step 4/4 — assemble + write)');

  // Cron: re-embed pages whose chunks are missing embeddings (e.g. written with noEmbed=true)
  // Runs every EMBED_CRON_INTERVAL_MS (default 60s). Limit: up to 20 pages per sweep.
  const EMBED_CRON_INTERVAL_MS = Math.max(10_000, parseInt(process.env.EMBED_CRON_INTERVAL_MS ?? '60000', 10));
  const EMBED_CRON_BATCH = Math.max(1, parseInt(process.env.EMBED_CRON_BATCH ?? '20', 10));
  let embedCronRunning = false;
  const embedCronTimer = setInterval(async () => {
    if (embedCronRunning) return;
    embedCronRunning = true;
    try {
      const slugs = await engine.getUnembeddedSlugs(EMBED_CRON_BATCH);
      for (const slug of slugs) {
        if (pendingEmbeds.has(slug)) continue; // already in-flight via async write path
        try {
          const page = await engine.getPage(slug);
          if (!page) continue;
          const content = [page.compiled_truth, page.timeline].filter(Boolean).join('\n\n');
          await withEmbedRetry(slug, () => importFromContent(engine, slug, content, { forceReembed: true }));
        } catch (e) {
          console.error(`[gbrain] embed-cron failed for ${slug}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    } catch (e) {
      console.error(`[gbrain] embed-cron sweep error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      embedCronRunning = false;
    }
  }, EMBED_CRON_INTERVAL_MS);

  // keep alive
  process.on('SIGINT', () => { clearInterval(embedCronTimer); server.stop(); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(embedCronTimer); server.stop(); process.exit(0); });
}
