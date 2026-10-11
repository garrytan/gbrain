/**
 * Keyset-batched rebuilds of stored keyword vectors, shared by
 * `gbrain reindex-search-vector` (every row, new language) and the
 * fts-cjk-boundary migration (only rows whose text has a CJK/ASCII boundary).
 *
 * Each batch is its own statement, never one transaction: on Postgres one
 * transaction would hold every row lock for the whole run, and a hang inside
 * it would bank zero progress. The keyset cursor persists after every batch
 * under `backfill.<checkpoint>.last_id`, so a killed run resumes with at most
 * one batch redone; the caller clears it when the run finishes.
 *
 * Every batch is bounded by an id range as well as a row count: it scans at
 * most `BACKFILL_RANGE` ids past the cursor and rebuilds at most
 * `BACKFILL_BATCH_SIZE` matching rows, so a filtered run (the migration) costs
 * one bounded scan per statement even when nothing matches, and the cursor
 * advances to the range end either way. The run stops at the table's highest
 * id read by the first batch; rows written later go through the new triggers.
 */

import type { BrainEngine } from './engine.ts';
import { checkpointKey } from './backfill-base.ts';
import { chunkSearchVectorSql, pageSearchVectorSql } from './fts-language.ts';
import { sanitizeRemoteBody } from './remote-body.ts';

/** Rows per backfill UPDATE. Keyset-batched so one statement never locks the whole table. */
export const BACKFILL_BATCH_SIZE = 5000;
/** Ids scanned per backfill statement, matched or not. */
export const BACKFILL_RANGE = 50_000;

export interface VectorBackfillOpts {
  lang: string;
  /** Checkpoint name (→ `backfill.<name>.last_id`). */
  checkpoint: string;
  /** Extra SQL predicate over the table's own columns; only matching rows are rebuilt. */
  where?: string;
  /** Ids scanned per statement; defaults to `BACKFILL_RANGE`. */
  range?: number;
  tick?: (n: number) => void;
}

async function savedCursor(engine: BrainEngine, checkpoint: string): Promise<number> {
  const saved = Number(await engine.getConfig(checkpointKey(checkpoint)));
  return Number.isFinite(saved) && saved > 0 ? saved : 0;
}

const batchIds = (table: string, cursor: number, end: number, where: string | undefined) => `
  SELECT id FROM ${table}
  WHERE search_vector IS NOT NULL AND id > ${cursor} AND id <= ${end}${where ? ` AND (${where})` : ''}
  ORDER BY id
  LIMIT ${BACKFILL_BATCH_SIZE}`;

/** Where the next batch starts: the last row rebuilt when the row cap was hit, else the range end. */
const nextCursor = (matched: number, lastId: number, end: number) => (matched >= BACKFILL_BATCH_SIZE ? lastId : end);

/** Chunk vectors are a pure function of the row's own columns, so one UPDATE per batch. Returns rows rebuilt. */
export async function backfillChunkVectors(engine: BrainEngine, opts: VectorBackfillOpts): Promise<number> {
  const range = opts.range ?? BACKFILL_RANGE;
  let cursor = await savedCursor(engine, opts.checkpoint);
  let hi: number | undefined;
  let total = 0;
  for (;;) {
    const end = cursor + range;
    const [batch] = await engine.executeRaw<{ hi: number; n: number; last: number }>(`
      WITH bound AS (SELECT coalesce(max(id), 0) AS hi FROM content_chunks),
      upd AS (
        UPDATE content_chunks SET search_vector = ${chunkSearchVectorSql(opts.lang)}
        WHERE id IN (${batchIds('content_chunks', cursor, end, opts.where)})
        RETURNING id
      )
      SELECT (SELECT hi FROM bound) AS hi, count(*)::int AS n, coalesce(max(upd.id), 0) AS last FROM upd
    `);
    if (!batch) break;
    hi ??= Number(batch.hi);
    const n = Number(batch.n);
    total += n;
    if (n > 0) opts.tick?.(n);
    cursor = nextCursor(n, Number(batch.last), end);
    await engine.setConfig(checkpointKey(opts.checkpoint), String(cursor));
    if (cursor >= hi) break;
  }
  return total;
}

/**
 * #6374: page vectors rebuilt with the seal's own expression. The pages
 * trigger fires only on `UPDATE OF title,timeline` and indexes the RAW
 * timeline, so neither an UPDATE-to-self nor re-firing it is right. Each batch
 * reads its rows through an UPDATE-to-self (row locks held for that statement
 * only, never across the TypeScript sanitize), sanitizes the timeline exactly
 * as the seal does, then writes `search_vector` guarded by the knowledge
 * revision it read: a page edited in between is skipped, and its own seal
 * indexes it under the current trigger. The timeline is the seal's input: a
 * page with a database withdrawal or purge (its own or source-wide) is read
 * through `readPageSnapshot`, whose timeline carries that overlay, so a
 * withdrawn fact never returns to the vector; other pages' raw timeline is
 * already their effective one. Returns rows read.
 */
export async function backfillPageVectors(engine: BrainEngine, opts: VectorBackfillOpts): Promise<number> {
  const range = opts.range ?? BACKFILL_RANGE;
  let cursor = await savedCursor(engine, opts.checkpoint);
  let hi: number | undefined;
  let total = 0;
  for (;;) {
    const end = cursor + range;
    const batch = await engine.executeRaw<{ hi: number; id: number | null; slug: string; source_id: string; timeline: string | null; knowledge_revision: string; withdrawn: boolean }>(`
      WITH bound AS (SELECT coalesce(max(id), 0) AS hi FROM pages),
      upd AS (
        UPDATE pages SET id = id
        WHERE id IN (${batchIds('pages', cursor, end, opts.where)})
        RETURNING id, slug, source_id, timeline, knowledge_revision::text AS knowledge_revision,
          (EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id = pages.source_id AND (w.subject = '*' OR w.subject = pages.slug))
            OR EXISTS (SELECT 1 FROM fact_purges x WHERE x.source_id = pages.source_id AND (x.subject = '*' OR x.subject = pages.slug))) AS withdrawn
      )
      SELECT bound.hi, upd.* FROM bound LEFT JOIN upd ON true
    `);
    if (batch.length === 0) break;
    hi ??= Number(batch[0]!.hi);
    const rows = batch.filter(r => r.id !== null);
    const ids: number[] = [];
    const timelines: string[] = [];
    const revisions: string[] = [];
    for (const r of rows) {
      let timeline = r.timeline ?? '';
      if (r.withdrawn) {
        const snapshot = await engine.readPageSnapshot(r.slug, { sourceId: r.source_id, includeDeleted: true });
        if (!snapshot) continue;
        timeline = snapshot.page.timeline ?? '';
      }
      ids.push(Number(r.id));
      timelines.push(sanitizeRemoteBody(timeline));
      revisions.push(r.knowledge_revision);
    }
    if (ids.length > 0) await engine.executeRaw(`
      UPDATE pages p SET search_vector = ${pageSearchVectorSql('p.title', 'v.timeline', opts.lang)}
      FROM unnest($1::int[], $2::text[], $3::uuid[]) AS v(id, timeline, revision)
      WHERE p.id = v.id AND p.knowledge_revision = v.revision
    `, [ids, timelines, revisions]);
    total += rows.length;
    if (rows.length > 0) opts.tick?.(rows.length);
    cursor = nextCursor(rows.length, rows.reduce((m, r) => Math.max(m, Number(r.id)), cursor), end);
    await engine.setConfig(checkpointKey(opts.checkpoint), String(cursor));
    if (cursor >= hi) break;
  }
  return total;
}
