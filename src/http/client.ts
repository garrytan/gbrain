/**
 * GBrain HTTP client — thin wrapper over the gbrain HTTP API.
 *
 * No business logic, no slug conventions, no OTP management.
 * Those belong in the caller (e.g. gbrain-companion/src/brain.ts).
 *
 * Usage:
 *   const client = new GBrainClient({ base: 'http://localhost:4242', token: 'abc' });
 *   const results = await client.search('typescript patterns');
 *   const job = await client.putPageAsync({ slug: 'wiki/foo', content: '# Foo' });
 *   await client.pollJob(job.job_id);
 */

import { createHash } from 'crypto';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface GBrainClientOpts {
  /** Base URL, e.g. http://localhost:4242. No trailing slash. */
  base: string;
  /** OTP or static token. Sent as ?otp= on every request. */
  token: string;
  /** Default timeout for write operations. Default 30s. */
  writeTimeoutMs?: number;
  /** Default timeout for read operations. Default 10s. */
  readTimeoutMs?: number;
}

export interface SearchResult {
  slug: string;
  score: number;
  title?: string;
  excerpt?: string;
  [key: string]: unknown;
}

export interface Page {
  slug: string;
  content?: string;
  content_hash?: string;
  title?: string;
  tags?: string[];
  [key: string]: unknown;
}

export interface WriteResult {
  ok: true;
  slug: string;
  content_hash: string;
  search_indexed_at?: string;
  status?: 'imported' | 'skipped';
  idempotent?: boolean;
}

export interface AsyncWriteResult {
  ok: true;
  job_id: string;
  slug: string;
  status: 'pending';
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface JobResult {
  ok: boolean;
  job_id: string;
  slug: string;
  content_hash: string;
  status: JobStatus;
  result?: object;
  error?: string;
}

export interface HealthResult {
  ok: boolean;
  warm: boolean;
  version: string;
  uptime_ms: number;
}

export interface TopicEntry {
  name: string;
  count: number;
  sample_slugs: string[];
}

export class GBrainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'GBrainError';
  }
}

// ── Client ────────────────────────────────────────────────────────────────────

export class GBrainClient {
  private readonly base: string;
  private readonly token: string;
  private readonly writeTimeoutMs: number;
  private readonly readTimeoutMs: number;

  constructor(opts: GBrainClientOpts) {
    this.base = opts.base.replace(/\/$/, '');
    this.token = opts.token;
    this.writeTimeoutMs = opts.writeTimeoutMs ?? 30_000;
    this.readTimeoutMs = opts.readTimeoutMs ?? 10_000;
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  private url(path: string, params?: Record<string, string>): string {
    const sp = new URLSearchParams({ otp: this.token, ...params });
    return `${this.base}${path}?${sp.toString()}`;
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: controller.signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new GBrainError(`Request timed out after ${timeoutMs}ms`, 'timeout', 0);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }

    const body = await res.json() as Record<string, unknown>;
    if (!body.ok) {
      throw new GBrainError(
        String(body.error ?? body.message ?? 'Unknown error'),
        String(body.code ?? 'unknown'),
        res.status,
        body.hint as string | undefined,
      );
    }
    return body as T;
  }

  private get<T>(path: string, params?: Record<string, string>, timeoutMs?: number): Promise<T> {
    return this.request<T>(this.url(path, params), { method: 'GET' }, timeoutMs ?? this.readTimeoutMs);
  }

  private put<T>(path: string, body: unknown, params?: Record<string, string>, timeoutMs?: number): Promise<T> {
    return this.request<T>(
      this.url(path, params),
      { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Gbrain-OTP': this.token }, body: JSON.stringify(body) },
      timeoutMs ?? this.writeTimeoutMs,
    );
  }

  private delete<T>(path: string, params: Record<string, string>, timeoutMs?: number): Promise<T> {
    return this.request<T>(this.url(path, params), { method: 'DELETE' }, timeoutMs ?? this.writeTimeoutMs);
  }

  // ── Read operations ────────────────────────────────────────────────────────

  health(): Promise<HealthResult> {
    return this.get<HealthResult>('/health');
  }

  topics(opts?: { samples?: number; minCount?: number }): Promise<{ topics: TopicEntry[]; total_pages: number }> {
    const params: Record<string, string> = {};
    if (opts?.samples !== undefined) params.samples = String(opts.samples);
    if (opts?.minCount !== undefined) params.min_count = String(opts.minCount);
    return this.get('/topics', params);
  }

  search(query: string, limit = 10): Promise<{ results: SearchResult[] }> {
    return this.get('/search', { q: query, limit: String(Math.min(limit, 50)) });
  }

  searchHybrid(opts: { lex?: string; vec?: string; hyde?: string; limit?: number }): Promise<{ results: SearchResult[] }> {
    const params: Record<string, string> = {};
    if (opts.lex) params.lex = opts.lex;
    if (opts.vec) params.vec = opts.vec;
    if (opts.hyde) params.hyde = opts.hyde;
    if (opts.limit) params.limit = String(Math.min(opts.limit, 50));
    return this.get('/search', params);
  }

  getPage(slug: string): Promise<{ page: Page }> {
    return this.get('/page', { slug });
  }

  getJob(jobId: string): Promise<JobResult> {
    return this.get('/job', { id: jobId });
  }

  // ── Write operations ───────────────────────────────────────────────────────

  /**
   * Synchronous write. Waits for chunking + embedding to complete.
   * Suitable for content ≤ 2000 chars. Set timeout ≥ 30s.
   */
  putPage(opts: {
    slug: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<WriteResult> {
    return this.put<WriteResult>('/page', {
      slug: opts.slug,
      content: opts.content,
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
    });
  }

  /**
   * Non-blocking write. Returns 202 + job_id immediately.
   * Use pollJob() to wait for completion.
   * Suitable for content > 2000 chars or callers with short socket timeouts.
   */
  putPageAsync(opts: {
    slug: string;
    content: string;
    idempotencyKey?: string;
  }): Promise<AsyncWriteResult> {
    return this.put<AsyncWriteResult>('/page', {
      slug: opts.slug,
      content: opts.content,
      async: 1,
      ...(opts.idempotencyKey ? { idempotency_key: opts.idempotencyKey } : {}),
    });
  }

  /**
   * Poll GET /job until terminal status or timeout.
   * Does NOT throw on job failure — check result.status.
   */
  async pollJob(
    jobId: string,
    opts: { intervalMs?: number; maxPolls?: number } = {},
  ): Promise<JobResult> {
    const intervalMs = opts.intervalMs ?? 2_000;
    const maxPolls = opts.maxPolls ?? 15;

    for (let i = 0; i < maxPolls; i++) {
      if (i > 0) await sleep(intervalMs);
      const job = await this.getJob(jobId);
      if (job.status === 'completed' || job.status === 'failed') return job;
    }
    throw new GBrainError(
      `Job ${jobId} did not complete after ${maxPolls} polls`,
      'poll_timeout',
      0,
    );
  }

  /**
   * Write page and wait for completion. Chooses sync vs async based on
   * content length. Verifies content_hash after async writes.
   *
   * This is the recommended single-call write path for most callers.
   */
  async write(opts: {
    slug: string;
    content: string;
    idempotencyKey?: string;
    asyncThresholdChars?: number;
  }): Promise<WriteResult> {
    const threshold = opts.asyncThresholdChars ?? 2_000;

    if (opts.content.length <= threshold) {
      return this.putPage(opts);
    }

    const job = await this.putPageAsync(opts);
    const result = await this.pollJob(job.job_id);

    if (result.status === 'failed') {
      throw new GBrainError(
        `Async write failed: ${result.error ?? 'unknown'}`,
        'write_failed',
        0,
      );
    }

    return {
      ok: true,
      slug: opts.slug,
      content_hash: result.content_hash,
      status: 'imported',
    };
  }

  addTag(slug: string, tag: string): Promise<{ ok: true; slug: string; tag: string }> {
    return this.get('/write', { action: 'add_tag', slug, tag });
  }

  removeTag(slug: string, tag: string): Promise<{ ok: true; slug: string; tag: string }> {
    return this.get('/write', { action: 'remove_tag', slug, tag });
  }

  addLink(from: string, to: string, opts?: { linkType?: string; context?: string }): Promise<{ ok: true }> {
    return this.get('/write', {
      action: 'add_link',
      from,
      to,
      ...(opts?.linkType ? { link_type: opts.linkType } : {}),
      ...(opts?.context ? { context: opts.context } : {}),
    });
  }

  addTimelineEntry(slug: string, date: string, description: string): Promise<{ ok: true }> {
    return this.get('/write', { action: 'add_timeline_entry', slug, date, description });
  }

  deletePage(slug: string): Promise<{ ok: true; slug: string; deleted: true }> {
    return this.delete('/page', { slug });
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  /**
   * Compute a stable idempotency key for a (slug, content) pair.
   * Changes when content changes, preventing suppression of intentional rewrites.
   */
  static idempotencyKey(slug: string, content: string): string {
    return createHash('sha256').update(slug + '\0' + content).digest('hex').slice(0, 16);
  }

  /**
   * Encode content as base64 for use with GET /write?content_b64=.
   * 3× more URL-efficient than percent-encoding for CJK text.
   */
  static toBase64(content: string): string {
    return Buffer.from(content, 'utf-8').toString('base64');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
