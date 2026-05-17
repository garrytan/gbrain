/**
 * Unit tests for GBrainClient (src/http/client.ts).
 * Spins up the HTTP server with a mock engine, then exercises the client.
 */

import { describe, test, expect, beforeAll } from 'bun:test';
import { startHttpServer } from '../src/http/server.ts';
import { GBrainClient, GBrainError } from '../src/http/client.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { createHmac } from 'crypto';

// ── Mock engine ───────────────────────────────────────────────────────────────

const pages = new Map<string, { content: string; content_hash: string }>();

function makeEngine(): BrainEngine {
  return {
    kind: 'pglite',
    connect: async () => {},
    disconnect: async () => {},
    transaction: async <T>(cb: (tx: BrainEngine) => Promise<T>) => cb({
      ...makeEngine(),
      putPage: async (slug: string, data: Record<string, unknown>) => {
        pages.set(slug, { content: String(data.content ?? ''), content_hash: String(data.content_hash ?? '') });
        return { page_id: 1, slug, chunks: 1 };
      },
      createVersion: async () => {},
      getTags: async () => [],
      removeTag: async () => {},
      addTag: async () => {},
      upsertChunks: async () => {},
      deleteChunks: async () => {},
    } as unknown as BrainEngine),
    putPage: async (slug: string, data: Record<string, unknown>) => {
      pages.set(slug, { content: String(data.content ?? ''), content_hash: String(data.content_hash ?? '') });
      return { page_id: 1, slug, chunks: 1 };
    },
    getPage: async (slug: string) => {
      const p = pages.get(slug);
      if (!p) return null;
      return { slug, content: p.content, content_hash: p.content_hash, page_id: 1 };
    },
    deletePage: async (slug: string) => { pages.delete(slug); },
    listPages: async () => [],
    getAllSlugs: async () => new Set<string>(),
    getVersions: async () => [],
    revertVersion: async () => {},
    addTag: async () => {},
    removeTag: async () => {},
    getTags: async () => [],
    addLink: async () => {},
    removeLink: async () => {},
    getLinks: async () => [],
    getBacklinks: async () => [],
    traversePaths: async () => [],
    addLinksBatch: async () => ({ created: 0 }),
    addTimelineEntry: async () => ({ id: 1 }),
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

// ── Server + client setup ─────────────────────────────────────────────────────

const PORT = 14300;
const OTP_SECRET = 'client-test-secret';
const BASE = `http://localhost:${PORT}`;
const day = Math.floor(Date.now() / 86_400_000);
const TOKEN = createHmac('sha256', OTP_SECRET).update(String(day)).digest('hex').slice(0, 10);

let client: GBrainClient;

beforeAll(() => {
  process.env.GBRAIN_TOTP_SECRET = OTP_SECRET;
  startHttpServer(makeEngine(), { port: PORT });
  client = new GBrainClient({ base: BASE, token: TOKEN });
});

// ── health ────────────────────────────────────────────────────────────────────

describe('GBrainClient.health', () => {
  test('returns warm status', async () => {
    const result = await client.health();
    expect(result.ok).toBe(true);
    expect(typeof result.warm).toBe('boolean');
    expect(typeof result.version).toBe('string');
  });
});

// ── topics ────────────────────────────────────────────────────────────────────

describe('GBrainClient.topics', () => {
  test('returns topic list', async () => {
    const result = await client.topics();
    expect(Array.isArray(result.topics)).toBe(true);
    expect(typeof result.total_pages).toBe('number');
  });
});

// ── search ────────────────────────────────────────────────────────────────────

describe('GBrainClient.search', () => {
  test('returns results array', async () => {
    const result = await client.search('test query');
    expect(Array.isArray(result.results)).toBe(true);
  });
});

// ── putPage (sync) ────────────────────────────────────────────────────────────

describe('GBrainClient.putPage', () => {
  test('writes page and returns content_hash', async () => {
    const result = await client.putPage({ slug: 'wiki/client-test', content: '# Hello\n\nworld' });
    expect(result.ok).toBe(true);
    expect(result.slug).toBe('wiki/client-test');
    expect(typeof result.content_hash).toBe('string');
    expect(result.content_hash.length).toBe(64);
  });

  test('idempotencyKey produces idempotent result on retry', async () => {
    const key = GBrainClient.idempotencyKey('wiki/idem-client', '# Idem content');
    const first = await client.putPage({ slug: 'wiki/idem-client', content: '# Idem content', idempotencyKey: key });
    const second = await client.putPage({ slug: 'wiki/idem-client', content: '# Idem content', idempotencyKey: key });
    expect(second.idempotent).toBe(true);
    expect(second.content_hash).toBe(first.content_hash);
  });
});

// ── putPageAsync + pollJob ────────────────────────────────────────────────────

describe('GBrainClient.putPageAsync + pollJob', () => {
  test('returns job_id immediately and completes on poll', async () => {
    const job = await client.putPageAsync({ slug: 'wiki/async-client', content: '# Async via client' });
    expect(job.ok).toBe(true);
    expect(typeof job.job_id).toBe('string');
    expect(job.status).toBe('pending');

    const result = await client.pollJob(job.job_id, { intervalMs: 50, maxPolls: 20 });
    expect(result.status).toBe('completed');
    expect(typeof result.content_hash).toBe('string');
    expect(result.content_hash.length).toBe(64);
  });

  test('pollJob throws GBrainError on unknown job_id', async () => {
    await expect(client.pollJob('deadbeef00000000', { maxPolls: 1 })).rejects.toBeInstanceOf(GBrainError);
  });
});

// ── write (smart router) ──────────────────────────────────────────────────────

describe('GBrainClient.write', () => {
  test('short content uses sync path', async () => {
    const result = await client.write({ slug: 'wiki/write-short', content: '# Short' });
    expect(result.ok).toBe(true);
    expect(result.slug).toBe('wiki/write-short');
  });

  test('long content uses async path and verifies hash', async () => {
    const longContent = '# Long\n\n' + 'word '.repeat(500);
    const result = await client.write({
      slug: 'wiki/write-long',
      content: longContent,
      asyncThresholdChars: 100,
    });
    expect(result.ok).toBe(true);
    expect(result.content_hash.length).toBe(64);
  });
});

// ── getPage ───────────────────────────────────────────────────────────────────

describe('GBrainClient.getPage', () => {
  test('returns page after write', async () => {
    await client.putPage({ slug: 'wiki/get-test', content: '# Get me' });
    const { page } = await client.getPage('wiki/get-test');
    expect(page.slug).toBe('wiki/get-test');
  });

  test('throws GBrainError with 404 on missing page', async () => {
    const e = await client.getPage('wiki/no-such-page').catch(x => x);
    expect(e).toBeInstanceOf(GBrainError);
    expect((e as GBrainError).status).toBe(404);
    expect(['not_found', 'page_not_found']).toContain((e as GBrainError).code);
  });
});

// ── static utilities ──────────────────────────────────────────────────────────

describe('GBrainClient static utilities', () => {
  test('idempotencyKey returns 16-char hex', () => {
    const key = GBrainClient.idempotencyKey('wiki/foo', '# content');
    expect(key.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(key)).toBe(true);
  });

  test('idempotencyKey changes when content changes', () => {
    const k1 = GBrainClient.idempotencyKey('wiki/foo', '# v1');
    const k2 = GBrainClient.idempotencyKey('wiki/foo', '# v2');
    expect(k1).not.toBe(k2);
  });

  test('toBase64 round-trips CJK content', () => {
    const original = '你好世界 — 測試中文內容';
    const encoded = GBrainClient.toBase64(original);
    const decoded = Buffer.from(encoded, 'base64').toString('utf-8');
    expect(decoded).toBe(original);
  });
});
