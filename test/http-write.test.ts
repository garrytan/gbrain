/**
 * Unit tests for GET /write — the unified write endpoint.
 * Spins up the HTTP server with a mock engine on an ephemeral port.
 * All actions: put_page, add_tag, remove_tag, add_link, add_timeline_entry, delete_page.
 * Each action gets at least 1 positive + 1 negative case.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { startHttpServer } from '../src/http/server.ts';
import type { BrainEngine } from '../src/core/engine.ts';

// ── Minimal mock engine ───────────────────────────────────────────────────────

const calls: { method: string; args: unknown[] }[] = [];

function record(method: string, ...args: unknown[]): void {
  calls.push({ method, args });
}

function makeEngine(): BrainEngine {
  return {
    kind: 'pglite',
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,

    transaction: async <T>(cb: (tx: BrainEngine) => Promise<T>) => {
      return cb({
        createVersion: async () => {},
        putPage: async (slug: string) => ({ page_id: 1, slug, chunks: 1 }),
        getTags: async () => [],
        removeTag: async () => {},
        addTag: async () => {},
        upsertChunks: async () => {},
        deleteChunks: async () => {},
      } as unknown as BrainEngine);
    },
    putPage: async (slug, content) => { record('putPage', slug, content); return { page_id: 1, slug, chunks: 1 }; },
    getPage: async () => null,
    deletePage: async (slug) => { record('deletePage', slug); },
    listPages: async () => [],
    getAllSlugs: async () => new Set<string>(),
    getVersions: async () => [],
    revertVersion: async () => {},

    addTag: async (slug, tag) => { record('addTag', slug, tag); },
    removeTag: async (slug, tag) => { record('removeTag', slug, tag); },
    getTags: async () => [],

    addLink: async (from, to, context, type) => { record('addLink', from, to, context, type); },
    removeLink: async (from, to) => { record('removeLink', from, to); },
    getLinks: async () => [],
    getBacklinks: async () => [],
    traversePaths: async () => [],
    addLinksBatch: async () => ({ created: 0 }),

    addTimelineEntry: async (slug, entry) => { record('addTimelineEntry', slug, entry); return { id: 1 }; },
    getTimeline: async () => [],
    addTimelineEntriesBatch: async () => ({ created: 0 }),

    searchKeyword: async () => [],
    searchVector: async () => [],
    getChunks: async () => [],
    getEmbeddingsByChunkIds: async () => [],
    updateChunkEmbedding: async () => {},

    getRawData: async () => null,
    putRawData: async () => {},

    findOrphans: async () => [],
    getStats: async () => ({ pages: 0, chunks: 0, tags: 0, links: 0, timeline_entries: 0 }),
    getBrainScore: async () => ({ total: 100, breakdown: {} }),

    submitJob: async () => ({ job_id: 'test' }),
    getJob: async () => null,
    listJobs: async () => [],
    claimJob: async () => null,
    completeJob: async () => {},
    failJob: async () => {},
    cancelJob: async () => {},
    retryJob: async () => {},
    deleteJob: async () => {},
    pruneJobs: async () => ({ deleted: 0 }),
    getJobStats: async () => ({}),
    getJobProgress: async () => null,
    updateJobProgress: async () => {},
    pauseJob: async () => {},
    resumeJob: async () => {},
    acquireRateLease: async () => null,
    renewRateLease: async () => {},
    releaseRateLease: async () => {},
    storeSubagentMessage: async () => {},
    storeToolExecution: async () => {},
    getSubagentMessages: async () => [],
    readInbox: async () => [],
    deleteAttachment: async () => {},
    listAttachments: async () => [],
    getAttachment: async () => null,
    addAttachment: async () => {},
    listFiles: async () => [],
    getFile: async () => null,
    putFile: async () => {},
    deleteFile: async () => {},
    getIngestLog: async () => [],
    logIngest: async () => {},
    acquireCycleLock: async () => true,
    releaseCycleLock: async () => {},
    syncBrain: async () => ({ ok: true }),
  } as unknown as BrainEngine;
}

// ── Server lifecycle ──────────────────────────────────────────────────────────

const PORT = 14299;
const OTP_SECRET = 'test-secret-123';
const BASE = `http://localhost:${PORT}`;

// Daily OTP generated from the secret (matches server logic)
import { createHmac } from 'crypto';
const day = Math.floor(Date.now() / 86_400_000);
const VALID_OTP = createHmac('sha256', OTP_SECRET).update(String(day)).digest('hex').slice(0, 10);

beforeAll(() => {
  process.env.GBRAIN_TOTP_SECRET = OTP_SECRET;
  startHttpServer(makeEngine(), { port: PORT });
});

afterAll(() => {
  delete process.env.GBRAIN_TOTP_SECRET;
  calls.length = 0;
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function writeUrl(params: Record<string, string>): string {
  const sp = new URLSearchParams({ otp: VALID_OTP, ...params });
  return `${BASE}/write?${sp.toString()}`;
}

async function get(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /write — auth', () => {
  test('rejects missing OTP', async () => {
    const { status, body } = await get(`${BASE}/write?action=add_tag&slug=test&tag=x`);
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
    expect(body.code).toBe('otp_required');
  });

  test('rejects invalid OTP', async () => {
    const { status, body } = await get(`${BASE}/write?action=add_tag&slug=test&tag=x&otp=0000000000`);
    expect(status).toBe(401);
    expect(body.ok).toBe(false);
  });

  test('rejects missing action', async () => {
    const { status, body } = await get(writeUrl({}));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });

  test('rejects unknown action', async () => {
    const { status, body } = await get(writeUrl({ action: 'nuke_everything' }));
    expect(status).toBe(400);
    expect(body.code).toBe('invalid_action');
  });
});

describe('GET /write — URL length guard', () => {
  test('returns 413 when URL > 8000 chars', async () => {
    const longContent = 'x'.repeat(8000);
    const url = writeUrl({ action: 'put_page', slug: 'test/page', content: longContent });
    const { status, body } = await get(url);
    expect(status).toBe(413);
    expect(body.code).toBe('too_large');
  });
});

describe('GET /write — put_page', () => {
  test('positive: creates page with auto-frontmatter', async () => {
    const { status, body } = await get(writeUrl({
      action: 'put_page',
      slug: 'test/auto-fm',
      content: 'Hello world',
      title: 'Test Page',
      type: 'concept',
      tags: 'source:ai,project:test',
      source: 'agent',
    }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe('put_page');
    expect(body.slug).toBe('test/auto-fm');
  });

  test('positive: passes through content with existing frontmatter', async () => {
    const content = '---\ntitle: Pre-built\ntype: note\n---\n\nBody text';
    const { status, body } = await get(writeUrl({
      action: 'put_page',
      slug: 'test/pre-fm',
      content,
    }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.slug).toBe('test/pre-fm');
  });

  test('negative: missing slug', async () => {
    const { status, body } = await get(writeUrl({ action: 'put_page', content: 'Hello' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });

  test('negative: missing content', async () => {
    const { status, body } = await get(writeUrl({ action: 'put_page', slug: 'test/no-content' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });
});

describe('GET /write — add_tag', () => {
  test('positive: adds tag to page', async () => {
    const { status, body } = await get(writeUrl({
      action: 'add_tag',
      slug: 'wiki/test',
      tag: 'important',
    }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe('add_tag');
    expect(body.tag).toBe('important');
  });

  test('negative: missing slug', async () => {
    const { status, body } = await get(writeUrl({ action: 'add_tag', tag: 'foo' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });

  test('negative: missing tag', async () => {
    const { status, body } = await get(writeUrl({ action: 'add_tag', slug: 'wiki/test' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });
});

describe('GET /write — remove_tag', () => {
  test('positive: removes tag from page', async () => {
    const { status, body } = await get(writeUrl({
      action: 'remove_tag',
      slug: 'wiki/test',
      tag: 'important',
    }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.action).toBe('remove_tag');
  });

  test('negative: missing tag', async () => {
    const { status, body } = await get(writeUrl({ action: 'remove_tag', slug: 'wiki/test' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });
});

describe('GET /write — add_link', () => {
  test('positive: creates link with default link_type', async () => {
    const { status, body } = await get(writeUrl({
      action: 'add_link',
      from: 'people/alice',
      to: 'companies/acme',
    }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.link_type).toBe('mentions');
  });

  test('positive: creates link with explicit link_type', async () => {
    const { status, body } = await get(writeUrl({
      action: 'add_link',
      from: 'people/alice',
      to: 'companies/acme',
      link_type: 'works_at',
    }));
    expect(status).toBe(200);
    expect(body.link_type).toBe('works_at');
  });

  test('negative: missing from', async () => {
    const { status, body } = await get(writeUrl({ action: 'add_link', to: 'companies/acme' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });

  test('negative: missing to', async () => {
    const { status, body } = await get(writeUrl({ action: 'add_link', from: 'people/alice' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });
});

describe('GET /write — add_timeline_entry', () => {
  test('positive: adds timeline entry', async () => {
    const { status, body } = await get(writeUrl({
      action: 'add_timeline_entry',
      slug: 'companies/acme',
      date: '2026-05-16',
      description: 'Launched v1',
    }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.date).toBe('2026-05-16');
  });

  test('negative: missing date', async () => {
    const { status, body } = await get(writeUrl({
      action: 'add_timeline_entry',
      slug: 'companies/acme',
      description: 'Launched v1',
    }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });

  test('negative: missing description', async () => {
    const { status, body } = await get(writeUrl({
      action: 'add_timeline_entry',
      slug: 'companies/acme',
      date: '2026-05-16',
    }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });

  test('negative: invalid date format (caught by operation handler)', async () => {
    const { status, body } = await get(writeUrl({
      action: 'add_timeline_entry',
      slug: 'companies/acme',
      date: '16-05-2026',
      description: 'Bad date',
    }));
    expect(status).toBe(500);
    expect(body.ok).toBe(false);
  });
});

describe('GET /write — delete_page', () => {
  test('negative: missing confirm=true', async () => {
    const { status, body } = await get(writeUrl({
      action: 'delete_page',
      slug: 'test/page',
    }));
    expect(status).toBe(400);
    expect(body.code).toBe('confirm_required');
  });

  test('negative: confirm=false rejected', async () => {
    const { status, body } = await get(writeUrl({
      action: 'delete_page',
      slug: 'test/page',
      confirm: 'false',
    }));
    expect(status).toBe(400);
    expect(body.code).toBe('confirm_required');
  });

  test('positive: deletes page when confirm=true', async () => {
    const { status, body } = await get(writeUrl({
      action: 'delete_page',
      slug: 'test/page',
      confirm: 'true',
    }));
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(true);
    expect(body.slug).toBe('test/page');
  });

  test('negative: missing slug', async () => {
    const { status, body } = await get(writeUrl({ action: 'delete_page', confirm: 'true' }));
    expect(status).toBe(400);
    expect(body.code).toBe('missing_param');
  });
});

describe('GET /schema — write_endpoints block', () => {
  test('schema includes write_endpoints', async () => {
    const res = await fetch(`${BASE}/schema?otp=${VALID_OTP}`);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    const we = body.write_endpoints as Record<string, unknown>;
    expect(we).toBeDefined();
    expect((we.actions as Record<string, unknown>).put_page).toBeDefined();
    expect((we.actions as Record<string, unknown>).add_tag).toBeDefined();
    expect((we.actions as Record<string, unknown>).delete_page).toBeDefined();
  });

  test('schema includes async_write and idempotency docs', async () => {
    const res = await fetch(`${BASE}/schema?otp=${VALID_OTP}`);
    const body = await res.json() as Record<string, unknown>;
    const we = body.write_endpoints as Record<string, unknown>;
    expect(we.async_write).toBeDefined();
    expect(we.idempotency).toBeDefined();
    expect(we.content_hash).toBeDefined();
  });
});

// ── PUT /page — sync with content_hash ───────────────────────────────────────

async function putPage(body: Record<string, unknown>, queryAsync = false): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = queryAsync ? `${BASE}/page?async=1` : `${BASE}/page`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Gbrain-OTP': VALID_OTP },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

describe('PUT /page — sync', () => {
  test('returns content_hash on successful write', async () => {
    const { status, body } = await putPage({ slug: 'wiki/test-hash', content: '# Hello\n\nworld' });
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.content_hash).toBe('string');
    expect((body.content_hash as string).length).toBe(64); // SHA-256 hex
  });

  test('idempotency_key: second call with same key returns cached result', async () => {
    const key = 'test-idempotency-key-abc123';
    const first = await putPage({ slug: 'wiki/idem-test', content: '# First', idempotency_key: key });
    expect(first.status).toBe(200);
    expect(first.body.content_hash).toBeDefined();

    const second = await putPage({ slug: 'wiki/idem-test', content: '# First', idempotency_key: key });
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.content_hash).toBe(first.body.content_hash);
  });
});

// ── PUT /page?async=1 — non-blocking write ────────────────────────────────────

describe('PUT /page — async=1', () => {
  test('returns 202 with job_id immediately', async () => {
    const { status, body } = await putPage({ slug: 'wiki/async-test', content: '# Async\n\ntest content' }, true);
    expect(status).toBe(202);
    expect(body.ok).toBe(true);
    expect(typeof body.job_id).toBe('string');
    expect((body.job_id as string).length).toBe(16); // 8 bytes hex
    expect(body.status).toBe('pending');
    expect(body.slug).toBe('wiki/async-test');
  });

  test('body async field also triggers async mode', async () => {
    const { status, body } = await putPage({ slug: 'wiki/async-body', content: '# Body async', async: 1 });
    expect(status).toBe(202);
    expect(body.job_id).toBeDefined();
  });
});

// ── GET /job — async job polling ──────────────────────────────────────────────

describe('GET /job — polling', () => {
  test('returns job state after async submit', async () => {
    // Submit async write — 202 has no content_hash yet
    const { body: putBody } = await putPage({ slug: 'wiki/poll-test', content: '# Poll me' }, true);
    const jobId = putBody.job_id as string;
    expect(putBody.content_hash).toBeUndefined();

    // Poll until completed (mock engine is synchronous so it finishes fast)
    let jobBody: Record<string, unknown> = {};
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 50));
      const jobRes = await fetch(`${BASE}/job?id=${jobId}&otp=${VALID_OTP}`);
      jobBody = await jobRes.json() as Record<string, unknown>;
      if (jobBody.status === 'completed' || jobBody.status === 'failed') break;
    }

    expect(jobBody.ok).toBe(true);
    expect(jobBody.job_id).toBe(jobId);
    expect(typeof jobBody.content_hash).toBe('string');
    expect((jobBody.content_hash as string).length).toBe(64);
    expect(jobBody.status).toBe('completed');
  });

  test('returns 404 for unknown job_id', async () => {
    const res = await fetch(`${BASE}/job?id=deadbeef00000000&otp=${VALID_OTP}`);
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('not_found');
  });

  test('returns 400 when id param is missing', async () => {
    const res = await fetch(`${BASE}/job?otp=${VALID_OTP}`);
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.code).toBe('missing_param');
  });
});

// ── GET /write?action=put_page&async=1 ───────────────────────────────────────

describe('GET /write — put_page async=1', () => {
  test('returns 202 with job_id', async () => {
    const url = writeUrl({ action: 'put_page', slug: 'wiki/write-async', content: '# Via GET write', async: '1' });
    const res = await fetch(url);
    expect(res.status).toBe(202);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(true);
    expect(typeof body.job_id).toBe('string');
    expect(body.action).toBe('put_page');
    expect(body.status).toBe('pending');
    expect(body.content_hash).toBeUndefined();
  });

  test('idempotency_key on GET /write prevents duplicate on retry', async () => {
    const key = 'write-idem-key-xyz';
    const url1 = writeUrl({ action: 'put_page', slug: 'wiki/write-idem', content: '# Idem', idempotency_key: key });
    const first = await get(url1);
    expect(first.status).toBe(200);

    const url2 = writeUrl({ action: 'put_page', slug: 'wiki/write-idem', content: '# Idem', idempotency_key: key });
    const second = await get(url2);
    expect(second.status).toBe(200);
    expect(second.body.idempotent).toBe(true);
    expect(second.body.content_hash).toBe(first.body.content_hash);
  });
});

// ── IP rate limit — isolated server (port 14298) to avoid banning test localhost

describe('Auth failure rate limit', () => {
  const RATE_PORT = 14298;
  const RATE_BASE = `http://localhost:${RATE_PORT}`;
  const BAD_OTP = '0000000000';

  beforeAll(() => {
    startHttpServer(makeEngine(), { port: RATE_PORT });
  });

  test('returns 429 after 10 consecutive OTP failures from same IP', async () => {
    for (let i = 0; i < 10; i++) {
      await fetch(`${RATE_BASE}/write?action=add_tag&slug=x&tag=x&otp=${BAD_OTP}`);
    }
    const res = await fetch(`${RATE_BASE}/write?action=add_tag&slug=x&tag=x&otp=${BAD_OTP}`);
    expect(res.status).toBe(429);
    const body = await res.json() as Record<string, unknown>;
    expect(body.ok).toBe(false);
    expect(body.code).toBe('too_many_failures');
  });

  test('valid OTP from banned IP is also blocked until ban expires', async () => {
    const res = await fetch(`${RATE_BASE}/write?action=add_tag&slug=x&tag=x&otp=${VALID_OTP}`);
    expect(res.status).toBe(429);
  });
});
