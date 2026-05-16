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
});
