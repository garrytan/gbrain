/**
 * Chunk retirement plan cost (Wave B PR 2, lane I): the projection's retirement of stale chunk rows
 * (page-body/projection.ts retireStaleChunks, hasStaleChunks) and its occurrencesWithoutChunks probe.
 *
 * 1. Protects: on an unsealed segmented page whose replace deferred its retirement, every statement the
 *    projection rebuild issues against content_chunks examines rows in proportion to the rows it retires plus
 *    the page's occurrences, never to its chunk rows times anything; the probe after retirement (nothing stale
 *    left) examines a bounded number of rows per occurrence. It still deletes exactly the rows the live
 *    generation does not hold: rows of closed occurrences, a promotion's inline rows, older duplicates of a
 *    live occurrence, and never a row staged above the live generation.
 * 2. Fails when: the stale-row test is a per-row subquery for a newer duplicate (it read every newer chunk row
 *    of the page, or every row of the occurrence, for each row: a 26 MB page half rewritten by a replace read
 *    2.2M buffers in one retire batch), the batch delete hash-joins a scan of the whole content_chunks table,
 *    or occurrencesWithoutChunks scans the page's chunk rows.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. Work is EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
 *    of each statement as issued (a DELETE inside a savepoint rolled back before the real statement runs):
 *    rows produced plus rows removed by filters, times loops, summed over plan nodes. Two page sizes, 4x apart.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { buildSegmentedProjection, hasStaleChunks } from '../../src/core/page-body/projection.ts';
import { flipInput, publishSegmentedPage, segmentText, stageGeneration } from '../helpers/page-body-fixtures.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

interface PlanNode { 'Actual Rows'?: number; 'Actual Loops'?: number; 'Rows Removed by Filter'?: number;
  'Rows Removed by Index Recheck'?: number; 'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; Plans?: PlanNode[] }
interface StatementWork { sql: string; rows: number; buffers: number }

function rowsExamined(node: PlanNode): number {
  const loops = node['Actual Loops'] ?? 1;
  const own = ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0) + (node['Rows Removed by Index Recheck'] ?? 0)) * loops;
  return own + (node.Plans ?? []).reduce((n, child) => n + rowsExamined(child), 0);
}

/** `engine` with every content_chunks statement it (or a transaction it opens) issues measured first. */
function measured(engine: BrainEngine, log: StatementWork[], inTx = false): BrainEngine {
  const explain = async (exec: BrainEngine, sql: string, params?: unknown[]) => {
    const [row] = await exec.executeRaw<Record<string, unknown>>(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
    const raw = Object.values(row!)[0];
    const plan = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<{ Plan: PlanNode }>;
    log.push({ sql, rows: rowsExamined(plan[0]!.Plan), buffers: (plan[0]!.Plan['Shared Hit Blocks'] ?? 0) + (plan[0]!.Plan['Shared Read Blocks'] ?? 0) });
  };
  return new Proxy(engine, {
    get(target, prop) {
      if (prop === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (/content_chunks/.test(sql)) {
            if (!/^\s*DELETE/i.test(sql)) await explain(target, sql, params);
            else if (inTx) {
              await target.executeRaw('SAVEPOINT plan_probe');
              await explain(target, sql, params);
              await target.executeRaw('ROLLBACK TO SAVEPOINT plan_probe');
            } else throw new Error(`unmeasured DELETE outside a transaction: ${sql.slice(0, 80)}`);
          }
          return target.executeRaw(sql, params);
        };
      }
      if (prop === 'transaction') return (fn: (tx: BrainEngine) => Promise<unknown>) => target.transaction(tx => fn(measured(tx, log, true)));
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

interface ChunkRow { id: number; occurrence_id: number | null; body_generation: number | null }

/** The rows the live generation does not hold, by the retirement's definition (projection.ts STALE_CHUNKS_SQL). */
function expectedStale(rows: readonly ChunkRow[], generation: number, live: ReadonlySet<number>): number[] {
  const latest = new Map<number, number>();
  for (const r of rows) {
    if (r.occurrence_id === null || r.body_generation === null || r.body_generation > generation) continue;
    latest.set(r.occurrence_id, Math.max(latest.get(r.occurrence_id) ?? -Infinity, r.body_generation));
  }
  return rows.filter(r => r.body_generation === null || (r.occurrence_id !== null && r.body_generation <= generation
    && (!live.has(r.occurrence_id) || r.body_generation < latest.get(r.occurrence_id)!))).map(r => r.id).sort((a, b) => a - b);
}

/**
 * A segmented page at generation 2 left unsealed by a replace that deferred its retirement: `half` occurrences kept
 * from generation 1, `half` closed and replaced by new ones, `perOccurrence` chunk rows each. Plus one kept
 * occurrence with a newer duplicate row set at generation 2 (a projection that raced a flip), inline rows a
 * promotion deferred, and rows a pending staging holds at generation 3 for a closed occurrence. The generation 2
 * manifest tiles the body: the kept rows, then the new rows from the byte the kept ones end at.
 */
async function deferredPage(engine: BrainEngine, slug: string, half: number, perOccurrence: number) {
  const v1 = Array.from({ length: 2 * half }, (_, i) => segmentText(`## Part ${i}\n\nFirst body of ${slug}, part ${i}.\n`));
  const page = await publishSegmentedPage(engine, slug, v1);
  const kept = page.occurrences.slice(0, half), closed = page.occurrences.slice(half);
  const v2 = Array.from({ length: half }, (_, i) => segmentText(`## Part ${half + i}\n\nSecond body of ${slug}, part ${i}.\n`));
  const staged = await stageGeneration(engine, { pageId: page.pageId, slug, genFrom: 2, texts: v2 });
  const keptBytes = v1.slice(0, half).reduce((n, text) => n + text.body.byteLength, 0);
  await engine.executeRaw('UPDATE page_body_manifest SET seq = seq + $2, byte_start = byte_start + $3 WHERE staging_id = $1::uuid', [staged.stagingId, half, keptBytes]);
  let next = 0;
  const insert = async (occurrences: readonly (number | null)[], generation: number | null) => {
    await engine.executeRaw(`INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, occurrence_id, local_ordinal, raw_byte_start, raw_byte_end, body_generation)
      SELECT $1, $2 + g, 'retirement probe chunk ' || g, 'compiled_truth', ($3::bigint[])[1 + g / $4], g % $4, 0, 10, $5::bigint
      FROM generate_series(0, $6::int - 1) AS g`, [page.pageId, next, occurrences, perOccurrence, generation, occurrences.length * perOccurrence]);
    next += occurrences.length * perOccurrence;
  };
  await insert([null], null);
  await insert(page.occurrences, 1);
  await insert(staged.occurrences, 2);
  await insert([kept[0]!], 2);
  await insert([closed[0]!], 3);
  const flip = await engine.transaction(async tx => {
    const result = await tx.flipBodyGeneration(flipInput(page.pageId, 1, staged.stagingId, [...v1.slice(0, half), ...v2],
      { closeOccurrences: closed, retireChunkOccurrences: closed, retireMaxRows: 1 }));
    await tx.setBodyStagingState(staged.stagingId, 'committed');
    return result;
  });
  expect(flip.retireDeferred).toBe(true);
  await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [page.pageId]);
  return { pageId: page.pageId, occurrences: 3 * half, live: [...kept, ...staged.occurrences] };
}

const SIZES = [{ half: 6, perOccurrence: 30 }, { half: 24, perOccurrence: 30 }] as const;
/** Rows (or buffers) a statement may examine per row it retires or per occurrence of the page. */
const ROWS_PER_UNIT = 12;
/** Rows occurrencesWithoutChunks may examine per occurrence: one index probe each. */
const PROBE_ROWS_PER_OCCURRENCE = 4;

for (const kind of testBackends()) describe(`chunk retirement plan cost (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(async () => { await close?.(); });

  test('a deferred retirement deletes exactly the stale rows, in work bounded by those rows and the page\'s occurrences, at two sizes', async () => {
    const perUnit: number[] = [];
    for (const [i, size] of SIZES.entries()) {
      const slug = `notes/retire-plan-${kind}-${i}`;
      const page = await deferredPage(engine, slug, size.half, size.perOccurrence);
      const before = (await engine.executeRaw<ChunkRow>('SELECT id, occurrence_id::int AS occurrence_id, body_generation::int AS body_generation FROM content_chunks WHERE page_id=$1',
        [page.pageId])).map(r => ({ id: Number(r.id), occurrence_id: r.occurrence_id === null ? null : Number(r.occurrence_id), body_generation: r.body_generation === null ? null : Number(r.body_generation) }));
      const stale = expectedStale(before, 2, new Set(page.live));
      expect(stale.length).toBe(size.perOccurrence * (2 + size.half));
      await engine.executeRaw('ANALYZE content_chunks');

      const log: StatementWork[] = [];
      const built = await buildSegmentedProjection(measured(engine, log), { sourceId: 'default', slug });
      expect(built).toEqual({ chunks: 0, retired: stale.length, sealed: true });
      const after = new Set((await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks WHERE page_id=$1', [page.pageId])).map(r => Number(r.id)));
      expect(before.filter(r => !after.has(r.id)).map(r => r.id).sort((a, b) => a - b)).toEqual(stale);
      const retire = log.filter(statement => /^\s*DELETE/i.test(statement.sql));
      const probes = log.filter(statement => !/^\s*DELETE/i.test(statement.sql));
      expect([retire.length, probes.length]).toEqual([1, 1]);
      expect(retire[0]!.rows).toBeLessThanOrEqual(ROWS_PER_UNIT * (stale.length + page.occurrences));
      expect(probes[0]!.rows).toBeLessThanOrEqual(PROBE_ROWS_PER_OCCURRENCE * page.occurrences);
      for (const statement of log) expect(statement.buffers).toBeLessThanOrEqual(ROWS_PER_UNIT * (stale.length + page.occurrences));

      const probe: StatementWork[] = [];
      expect(await hasStaleChunks(measured(engine, probe), page.pageId, 2, page.live)).toBe(false);
      expect(probe.length).toBe(1);
      expect(probe[0]!.rows).toBeLessThanOrEqual(ROWS_PER_UNIT * page.occurrences);
      perUnit.push(Math.max(retire[0]!.rows / (stale.length + page.occurrences), probe[0]!.rows / page.occurrences));
    }
    expect(perUnit[1]!).toBeLessThanOrEqual(perUnit[0]! * 1.5);
  }, 300_000);
});
