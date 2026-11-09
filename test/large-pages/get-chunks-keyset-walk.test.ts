/**
 * get_chunks walks a segmented page by keyset (Wave C 1E, C4c; spec §5 "get_chunks").
 *
 * 1. Protects: walking every chunk of a 100k-chunk segmented page with next_cursor reads O(limit) rows per call
 *    after the first (which counts the page once per body generation), returns every chunk exactly once in
 *    document order (manifest byte_start, local_ordinal; chunk_index is an insertion sequence), and does so again
 *    after an early edit inserts chunks before the existing ones; a cursor from before the edit is refused with
 *    revision_changed instead of skipping or repeating chunks. The op keeps from_index, carries next_cursor on the
 *    last row, on _meta.pagination and in the listing_truncated notice's next call, and refuses a foreign cursor.
 * 2. Fails when: a call counts every chunk or computes a position over the whole page (master's row_number over
 *    every row, chunk_text included, before the window filter), the walk orders by chunk_index, or a stale cursor
 *    continues.
 * 3. Work is EXPLAIN (ANALYZE, FORMAT JSON) of each engine-sql statement on content_chunks or page_body_manifest:
 *    rows produced plus rows removed by filters, times loops, summed over plan nodes. Counts, never time. The
 *    page is built with direct inserts. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { Notice } from '../../src/core/agent-output.ts';
import type { SqlExecutor } from '../../src/core/engine-sql/executor.ts';
import { renderFragment, type SqlFragment } from '../../src/core/engine-sql/fragment.ts';
import { SEGMENTED_CHUNKER_VERSION } from '../../src/core/page-body/segment-chunks.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { segmentPage, sha256 } from '../helpers/segmented-chunks-fixture.ts';
import { testBackends } from '../helpers/test-backends.ts';

const BIG = 'notes/keyset-walk-example';
const SMALL = 'notes/keyset-small-example';
const OCCURRENCES = 2000;
const PER_OCCURRENCE = 50;
const TOTAL = OCCURRENCES * PER_OCCURRENCE;
const LIMIT = 500;
const SEGMENT = 'segment text of the alice-example log';

interface PlanNode { 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number; 'Rows Removed by Join Filter'?: number;
  'Rows Removed by Index Recheck'?: number; Plans?: PlanNode[] }

function examined(node: PlanNode): number {
  const loops = node['Actual Loops'] ?? 1;
  const own = ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Join Filter'] ?? 0)
    + (node['Rows Removed by Index Recheck'] ?? 0)) * loops;
  return own + (node.Plans ?? []).reduce((n, child) => n + examined(child), 0);
}

/** An engine-sql executor that adds the work of each statement on either table to `work.rows`. */
function measuring(exec: SqlExecutor, work: { rows: number }): SqlExecutor {
  return new Proxy(exec, { get(target, prop) {
    if (prop === 'run') return async (fragment: SqlFragment, opts?: unknown) => {
      const { text, params } = renderFragment(fragment);
      if (/content_chunks|page_body_manifest/.test(text)) {
        const { rows: [row] } = await target.query<Record<string, unknown>>(`EXPLAIN (ANALYZE, FORMAT JSON) ${text}`, params);
        const raw = Object.values(row!)[0];
        work.rows += examined(((typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>)[0]!.Plan);
      }
      return target.run(fragment, opts as never);
    };
    return Reflect.get(target, prop, target);
  } });
}

/** `engine` whose engine-sql reads (PGLite `engineSql`, Postgres `engineSqlOn(tx)`) are measured into `work`. */
function measured(engine: BrainEngine, work: { rows: number }): BrainEngine {
  const proxy: BrainEngine = new Proxy(engine, { get(target, prop) {
    if (prop === 'engineSql') return measuring(Reflect.get(target, prop, target) as SqlExecutor, work);
    if (prop === 'engineSqlOn') return (tx: unknown) => measuring((target as unknown as { engineSqlOn(tx: unknown): SqlExecutor }).engineSqlOn(tx), work);
    // A class method runs on the proxy, so its engine-sql executor is measured; own properties (a driver handle) pass through.
    const value = Reflect.get(target, prop, target);
    return typeof value === 'function' && isMethod(target, prop) ? value.bind(proxy) : value;
  } });
  return proxy;
}

/** Whether `prop` is a method of `target`'s class chain (a function value on a prototype, not an own property or a getter). */
function isMethod(target: object, prop: PropertyKey): boolean {
  if (Object.prototype.hasOwnProperty.call(target, prop)) return false;
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    if (descriptor) return typeof descriptor.value === 'function';
  }
  return false;
}

/** Occurrence j (1-based, inserted j-th) starts at byte (OCCURRENCES + 1 - j) * 1000: insertion order is reverse document order. */
async function buildBigPage(engine: BrainEngine): Promise<number> {
  const { pageId } = await segmentPage(engine, BIG, { generation: 1, occurrences: [], bodyBytes: (OCCURRENCES + 1) * 1000 });
  await engine.executeRaw(`INSERT INTO page_segment_texts (source_id, sha256, byte_len, line_count, body) VALUES ('default', $1, $2, 1, $3)
    ON CONFLICT DO NOTHING`, [sha256(SEGMENT), Buffer.byteLength(SEGMENT), Buffer.from(SEGMENT)]);
  await engine.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, seq, region, source_id, sha256,
      byte_start, byte_len, line_start, line_count, cut_kind, entry_state, static_proj_bytes, static_proj_lines, hash_state)
    SELECT $1, j, 1, $2 + 1 - j, 'truth', 'default', $3, ($2 + 1 - j) * 1000, 1000, 0, 1, 'heading', '{}'::jsonb, 1000, 1, '\\x00'::bytea
      FROM generate_series(1, $2) AS j`, [pageId, OCCURRENCES, sha256(SEGMENT)]);
  await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, token_count, occurrence_id, local_ordinal, body_generation)
    SELECT $1, (j - 1) * $3 + o, 'passage ' || o || ' of occurrence ' || j, 'compiled_truth', 4, j, o, 1
      FROM generate_series(1, $2) AS j, generate_series(0, $3 - 1) AS o`, [pageId, OCCURRENCES, PER_OCCURRENCE]);
  await seal(engine, pageId);
  return pageId;
}

const seal = (engine: BrainEngine, pageId: number) =>
  engine.executeRaw('UPDATE pages SET text_projection_revision = knowledge_revision, chunker_version = $2 WHERE id = $1', [pageId, SEGMENTED_CHUNKER_VERSION]);

/** Document order of the big page: occurrences by byte_start (j descending), each in local_ordinal order. */
function documentOrder(extra: string[] = []): string[] {
  const out = [...extra];
  for (let j = OCCURRENCES; j >= 1; j--) for (let o = 0; o < PER_OCCURRENCE; o++) out.push(`passage ${o} of occurrence ${j}`);
  return out;
}

/** Walk every chunk with next_cursor (from_index when the engine returns none); asserts the work of each call as it goes. */
async function walk(engine: BrainEngine, total: number): Promise<{ texts: string[]; calls: number; cursors: number; work: number[] }> {
  const work = { rows: 0 };
  const probe = measured(engine, work);
  const texts: string[] = [];
  const perCall: number[] = [];
  let cursor: string | undefined;
  let cursors = 0;
  let from = 0;
  for (let calls = 1; ; calls++) {
    if (cursor) cursors++;
    work.rows = 0;
    const page = await probe.getChunkPage(BIG, cursor ? { fromIndex: 0, limit: LIMIT, cursor } : { fromIndex: from, limit: LIMIT });
    perCall.push(work.rows);
    expect(page.total_chunks).toBe(total);
    // After the first call (which counts the page once per generation) a call reads in proportion to its limit.
    if (calls > 1) expect(work.rows).toBeLessThanOrEqual(12 * LIMIT);
    texts.push(...page.chunks.map(c => c.chunk_text));
    from = (page.from_index ?? from) + page.chunks.length;
    cursor = page.next_cursor;
    if (from >= total || page.chunks.length === 0) return { texts, calls, cursors, work: perCall };
  }
}

for (const kind of testBackends()) {
  describe(`get_chunks keyset walk over a segmented page (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let pageId: number;

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      pageId = await buildBigPage(engine);
      await segmentPage(engine, SMALL, {
        generation: 1,
        occurrences: [
          { id: 20, byteStart: 4096, genFrom: 1, chunks: [{ text: 'third passage', chunkIndex: 0 }, { text: 'fourth passage', chunkIndex: 1 }] },
          { id: 10, byteStart: 0, genFrom: 1, chunks: [{ text: 'first passage', chunkIndex: 2 }, { text: 'second passage', chunkIndex: 3 }] },
          { id: 30, byteStart: 8192, genFrom: 1, chunks: [{ text: 'fifth passage', chunkIndex: 4 }] },
        ],
      });
    }, 120_000);
    afterAll(async () => { await close?.(); });

    test('a 100k-chunk walk reads O(limit) rows per call and returns every chunk once in document order, also after an early edit', async () => {
      const before = await walk(engine, TOTAL);
      expect(before.calls).toBe(TOTAL / LIMIT);
      expect(before.cursors).toBe(before.calls - 1);
      expect(before.texts).toEqual(documentOrder());
      // The first call counts the page once; the whole walk stays linear in the page.
      expect(before.work.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5 * TOTAL + 12 * TOTAL);

      const midway = await engine.getChunkPage(BIG, { fromIndex: 0, limit: LIMIT });
      // An early edit: generation 2 adds an occurrence at byte 0, whose chunks have the highest chunk_index.
      const early = Array.from({ length: 10 }, (_, o) => `inserted passage ${o}`);
      await engine.executeRaw(`INSERT INTO page_body_manifest (page_id, occurrence_id, gen_from, seq, region, source_id, sha256,
          byte_start, byte_len, line_start, line_count, cut_kind, entry_state, static_proj_bytes, static_proj_lines, hash_state)
        VALUES ($1, $2, 2, 0, 'truth', 'default', $3, 0, 1000, 0, 1, 'heading', '{}'::jsonb, 1000, 1, '\\x00'::bytea)`, [pageId, OCCURRENCES + 1, sha256(SEGMENT)]);
      await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, token_count, occurrence_id, local_ordinal, body_generation)
        SELECT $1, $2 + o, 'inserted passage ' || o, 'compiled_truth', 4, $3, o, 2 FROM generate_series(0, 9) AS o`, [pageId, TOTAL, OCCURRENCES + 1]);
      await engine.executeRaw('UPDATE pages SET body_generation = 2 WHERE id = $1', [pageId]);
      await seal(engine, pageId);

      await expect(engine.getChunkPage(BIG, { fromIndex: 0, limit: LIMIT, cursor: midway.next_cursor })).rejects.toMatchObject({ code: 'invalid_params', canonical: 'revision_changed' });
      const after = await walk(engine, TOTAL + early.length);
      expect(after.texts).toEqual(documentOrder(early));
      expect(new Set(after.texts).size).toBe(TOTAL + early.length);
    }, 300_000);

    test('from_index keeps working on a segmented page and returns a cursor that continues after it', async () => {
      const page = await engine.getChunkPage(SMALL, { fromIndex: 1, limit: 2 });
      expect(page.chunks.map(c => c.chunk_text)).toEqual(['second passage', 'third passage']);
      expect(page).toMatchObject({ total_chunks: 5, max_chunk_index: 4, from_index: 1 });
      const next = await engine.getChunkPage(SMALL, { fromIndex: 0, limit: 2, cursor: page.next_cursor });
      expect(next.chunks.map(c => c.chunk_text)).toEqual(['fourth passage', 'fifth passage']);
      expect(next).toMatchObject({ from_index: 3, total_chunks: 5 });
      expect(next.next_cursor).toBeUndefined();
      expect((await engine.getChunkPage(SMALL, { fromIndex: 9, limit: 2 })).chunks).toEqual([]);
    });

    test('the op carries next_cursor on the last row, on _meta and in the notice, and refuses a foreign or malformed cursor', async () => {
      const captured: { notices: Notice[]; meta: Record<string, unknown> } = { notices: [], meta: {} };
      const ctx = {
        engine, config: { engine: engine.kind } as never, sourceId: 'default', remote: true, dryRun: false,
        logger: { info() {}, warn() {}, error() {} },
        emitNotice: (n: Notice) => { captured.notices.push(n); }, emitResponseMeta: (k: string, v: unknown) => { captured.meta[k] = v; },
      } as unknown as OperationContext;
      const get = (params: Record<string, unknown>) => operationsByName.get_chunks!.handler(ctx, params) as Promise<Array<Record<string, unknown>>>;
      const first = await get({ slug: SMALL, limit: 2 });
      expect(first.map(r => r.chunk_text)).toEqual(['first passage', 'second passage']);
      const cursor = first[1]!.next_cursor as string;
      expect(first[1]).toMatchObject({ truncated: true, next_from_index: 2, next_cursor: expect.stringMatching(/^gch1\./) });
      expect(captured.meta.pagination).toEqual({ from_index: 0, limit: 2, returned: 2, total_chunks: 5, next_from_index: 2, next_cursor: cursor });
      expect(captured.notices[0]!.fix?.mcp).toEqual({ tool: 'get_chunks', arguments: { slug: SMALL, cursor, limit: 2 } });
      const second = await get(captured.notices[0]!.fix!.mcp!.arguments as Record<string, unknown>);
      expect(second.map(r => r.chunk_text)).toEqual(['third passage', 'fourth passage']);
      expect(captured.meta.pagination).toMatchObject({ from_index: 2, returned: 2, next_from_index: 4 });
      await expect(get({ slug: BIG, cursor })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(get({ slug: SMALL, cursor: 'gch1.not-a-cursor' })).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(get({ slug: SMALL, cursor, from_index: 2 })).rejects.toMatchObject({ code: 'invalid_params' });
    });
  });
}
