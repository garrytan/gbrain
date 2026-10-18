/**
 * Large pages (Wave A): get_chunks pages by chunk_index.
 *
 * 1. Protects: get_chunks never returns every chunk of a large page in one
 *    call. It returns [from_index, from_index + limit) (default 0 and 50),
 *    keeps the bare-array result, and carries total_chunks / next_from_index
 *    on `_meta.pagination`; remote callers also get the model-visible
 *    `listing_truncated` notice naming the next call, are capped at 500, and
 *    the trusted local CLI gets a stderr line instead.
 * 2. Fails when: the handler reads every chunk again, a page boundary skips or
 *    repeats a chunk, total_chunks counts the wrong rows, a remote limit is
 *    not capped, or an invalid from_index / limit is answered.
 * 3. No new seam: the real handler over PGLite, the engine's getChunkPage
 *    (PGLite, and Postgres when DATABASE_URL is set), and one MCP dispatch
 *    round trip.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import type { Notice } from '../src/core/agent-output.ts';
import { dispatchToolCall, __resetBackupNoticeForTests } from '../src/mcp/dispatch.ts';
import { __resetFactsDrainNoticesForTests } from '../src/core/facts/drain.ts';
import { __resetBehaviorNoticeForTests } from '../src/core/behavior-change-notice.ts';
import { withEnv } from './helpers/with-env.ts';
import { SAFE_FENCE_CHUNKER_VERSION } from '../src/core/search/safe-chunks.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const BIG = 'notes/big-example';
const SMALL = 'notes/small-example';
const BIG_CHUNKS = 620;
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await seedChunks(engine);
}, 120_000);

async function seedChunks(e: BrainEngine): Promise<void> {
  await e.putPage(BIG, { type: 'note', title: 'Big', compiled_truth: 'big body' });
  await e.upsertChunks(BIG, Array.from({ length: BIG_CHUNKS }, (_, i) => ({ chunk_index: i, chunk_text: `chunk ${i} of alice-example notes`, chunk_source: 'compiled_truth' as const })));
  await e.putPage(SMALL, { type: 'note', title: 'Small', compiled_truth: 'small body' });
  await e.upsertChunks(SMALL, [0, 1, 2].map(i => ({ chunk_index: i, chunk_text: `small ${i}`, chunk_source: 'compiled_truth' as const })));
  // What a sealed markdown import leaves: the chunks match the current revision under the safe fence chunker.
  await e.executeRaw(`UPDATE pages SET text_projection_revision = knowledge_revision, chunker_version = ${SAFE_FENCE_CHUNKER_VERSION} WHERE slug = ANY($1::text[])`, [[BIG, SMALL]]);
}
afterAll(async () => { await engine.disconnect(); });

interface Captured { notices: Notice[]; meta: Record<string, unknown> }

function ctx(remote: boolean, captured?: Captured): OperationContext {
  return {
    engine, config: { engine: 'pglite' } as never, sourceId: 'default', remote, dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
    ...(captured ? { emitNotice: (n: Notice) => { captured.notices.push(n); }, emitResponseMeta: (k: string, v: unknown) => { captured.meta[k] = v; } } : {}),
  } as OperationContext;
}

async function chunks(remote: boolean, params: Record<string, unknown>, captured?: Captured): Promise<Array<{ chunk_index: number }>> {
  return await operationsByName.get_chunks.handler(ctx(remote, captured), params) as Array<{ chunk_index: number }>;
}

const indices = (rows: Array<{ chunk_index: number }>) => rows.map(r => r.chunk_index);
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);
const fresh = (): Captured => ({ notices: [], meta: {} });

describe('get_chunks paging', () => {
  test('default: the first 50 chunks, total_chunks and next_from_index on _meta, a notice for remote callers', async () => {
    const c = fresh();
    expect(indices(await chunks(true, { slug: BIG }, c))).toEqual(range(0, 50));
    expect(c.meta.pagination).toEqual({ from_index: 0, limit: 50, returned: 50, total_chunks: BIG_CHUNKS, next_from_index: 50 });
    expect(c.notices).toHaveLength(1);
    expect(c.notices[0].code).toBe('listing_truncated');
    expect(c.notices[0].fix?.mcp).toEqual({ tool: 'get_chunks', arguments: { slug: BIG, from_index: 50, limit: 50 } });
  });

  test('a default call on a page with more than 50 chunks marks the cut in the array itself (clients that ignore _meta)', async () => {
    for (const remote of [true, false]) {
      const rows = await chunks(remote, { slug: BIG }) as Array<{ chunk_index: number; truncated?: boolean; next_from_index?: number }>;
      expect(rows).toHaveLength(50);
      expect(rows[49]).toMatchObject({ chunk_index: 49, truncated: true, next_from_index: 50 });
      expect(rows.slice(0, 49).some(row => 'truncated' in row || 'next_from_index' in row)).toBe(false);
    }
    const whole = await chunks(true, { slug: SMALL }) as Array<Record<string, unknown>>;
    expect(whole.some(row => 'truncated' in row || 'next_from_index' in row)).toBe(false);
    const last = await chunks(true, { slug: BIG, from_index: 600, limit: 50 }) as Array<Record<string, unknown>>;
    expect(last.some(row => 'truncated' in row)).toBe(false);
  });

  test('paging boundaries: consecutive pages cover every chunk exactly once', async () => {
    const seen: number[] = [];
    let from: number | undefined = 0;
    let calls = 0;
    while (from !== undefined) {
      const c = fresh();
      seen.push(...indices(await chunks(true, { slug: BIG, from_index: from, limit: 200 }, c)));
      from = (c.meta.pagination as { next_from_index?: number }).next_from_index;
      calls++;
    }
    expect(calls).toBe(4);
    expect(seen).toEqual(range(0, BIG_CHUNKS));
  });

  test('the last page has no next_from_index and no notice', async () => {
    const c = fresh();
    expect(indices(await chunks(true, { slug: BIG, from_index: 600, limit: 50 }, c))).toEqual(range(600, BIG_CHUNKS));
    expect(c.meta.pagination).toEqual({ from_index: 600, limit: 50, returned: 20, total_chunks: BIG_CHUNKS });
    expect(c.notices).toEqual([]);
  });

  test('a page with fewer chunks than the limit returns them all, no notice', async () => {
    const c = fresh();
    expect(indices(await chunks(true, { slug: SMALL }, c))).toEqual([0, 1, 2]);
    expect(c.meta.pagination).toEqual({ from_index: 0, limit: 50, returned: 3, total_chunks: 3 });
    expect(c.notices).toEqual([]);
  });

  test('from_index past the end returns [] with total_chunks', async () => {
    const c = fresh();
    expect(await chunks(true, { slug: BIG, from_index: 5000 }, c)).toEqual([]);
    expect(c.meta.pagination).toEqual({ from_index: 5000, limit: 50, returned: 0, total_chunks: BIG_CHUNKS });
    expect(c.notices).toEqual([]);
  });

  test('a missing page reads as [] with total_chunks 0', async () => {
    const c = fresh();
    expect(await chunks(true, { slug: 'notes/missing-example' }, c)).toEqual([]);
    expect(c.meta.pagination).toEqual({ from_index: 0, limit: 50, returned: 0, total_chunks: 0 });
  });

  test('remote limit is capped at 500; trusted local honors any explicit limit', async () => {
    const c = fresh();
    expect(indices(await chunks(true, { slug: BIG, limit: 10_000 }, c))).toEqual(range(0, 500));
    expect(c.meta.pagination).toMatchObject({ limit: 500, clamped_from: 10_000, next_from_index: 500 });
    expect(c.notices[0].why).toContain('limit 10000 was capped at 500');
    expect(indices(await chunks(false, { slug: BIG, limit: 10_000 }))).toEqual(range(0, BIG_CHUNKS));
  });

  test('trusted local: default 50 plus one stderr line naming --limit/--from-index, no notice; an explicit limit is silent', async () => {
    const err = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const c = fresh();
      expect(indices(await chunks(false, { slug: BIG }, c))).toEqual(range(0, 50));
      expect(c.notices).toEqual([]);
      expect(err).toHaveBeenCalledTimes(1);
      const line = String(err.mock.calls[0][0]);
      expect(line).toContain('--limit');
      expect(line).toContain('--from-index 50');
      await chunks(false, { slug: BIG, limit: 10 });
      expect(err).toHaveBeenCalledTimes(1);
    } finally { err.mockRestore(); }
  });

  test('invalid from_index or limit is invalid_params', async () => {
    for (const from_index of [-1, 1.5, 'ten', Number.NaN]) {
      await expect(chunks(true, { slug: BIG, from_index })).rejects.toThrow('from_index must be a non-negative integer');
    }
    for (const limit of [0, -5, 2.5, 'all']) {
      await expect(chunks(true, { slug: BIG, limit })).rejects.toThrow('limit must be a positive integer');
    }
  });

  test('MCP dispatch: content[0] stays the bare array; the notice names the next call', async () => {
    __resetBackupNoticeForTests();
    __resetFactsDrainNoticesForTests();
    await engine.executeRaw('UPDATE sources SET created_at = now()');
    __resetBehaviorNoticeForTests();
    const home = mkdtempSync(join(tmpdir(), 'gbrain-get-chunks-notice-'));
    await withEnv({ GBRAIN_BACKUP_CHECK: 'off', GBRAIN_NO_ONBOARD_NUDGE: '1', GBRAIN_HOME: home }, async () => {
      const res = await dispatchToolCall(engine as never, 'get_chunks', { slug: BIG, limit: 100 }, { remote: true, transport: 'stdio', sourceId: 'default' });
      expect(res.isError).toBeUndefined();
      const body = JSON.parse(res.content[0].text);
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(100);
      expect(body[99]).toMatchObject({ chunk_index: 99, truncated: true, next_from_index: 100 });
      expect(res._meta?.pagination).toEqual({ from_index: 0, limit: 100, returned: 100, total_chunks: BIG_CHUNKS, next_from_index: 100 });
      const notice = res.content.slice(1).map(b => b.text).find(t => t.startsWith('[gbrain notice listing_truncated'));
      expect(notice).toContain(`fix: get_chunks {"slug":"${BIG}","from_index":100,"limit":100}`);
    });
  }, 30_000);
});

describe('engine getChunkPage', () => {
  test('returns the chunk_index range, the admitted count and the highest index (PGLite, and Postgres when DATABASE_URL is set)', async () => {
    const engines: Array<{ engine: BrainEngine; close?: () => Promise<void> }> = [{ engine }];
    if (process.env.DATABASE_URL) {
      const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
      await seedChunks(pg.engine);
      engines.push({ engine: pg.engine, close: pg.close });
    }
    try {
      for (const { engine: e } of engines) {
        const page = await e.getChunkPage(BIG, { sourceId: 'default', fromIndex: 10, limit: 5 });
        expect(page.chunks.map(c => c.chunk_index)).toEqual([10, 11, 12, 13, 14]);
        expect(page.total_chunks).toBe(BIG_CHUNKS);
        expect(page.max_chunk_index).toBe(BIG_CHUNKS - 1);
        expect(page.chunks[0].chunk_text).toBe('chunk 10 of alice-example notes');
        expect(await e.getChunkPage(BIG, { sourceId: 'default', fromIndex: 5000, limit: 5 })).toEqual({ chunks: [], total_chunks: BIG_CHUNKS, max_chunk_index: BIG_CHUNKS - 1 });
        expect(await e.getChunkPage('notes/missing-example', { sourceId: 'default', fromIndex: 0, limit: 5 })).toEqual({ chunks: [], total_chunks: 0, max_chunk_index: null });
      }
    } finally { for (const { close } of engines) if (close) await close(); }
  }, 120_000);
});
