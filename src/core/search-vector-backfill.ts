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
 */

import type { BrainEngine } from './engine.ts';
import { checkpointKey } from './backfill-base.ts';
import { chunkSearchVectorSql, pageSearchVectorSql } from './fts-language.ts';
import { sanitizeRemoteBody } from './remote-body.ts';

/** Rows per backfill UPDATE. Keyset-batched so one statement never locks the whole table. */
export const BACKFILL_BATCH_SIZE = 5000;

export interface VectorBackfillOpts {
  lang: string;
  /** Checkpoint name (→ `backfill.<name>.last_id`). */
  checkpoint: string;
  /** Extra SQL predicate over the table's own columns; only matching rows are rebuilt. */
  where?: string;
  tick?: (n: number) => void;
}

async function savedCursor(engine: BrainEngine, checkpoint: string): Promise<number> {
  const saved = Number(await engine.getConfig(checkpointKey(checkpoint)));
  return Number.isFinite(saved) && saved > 0 ? saved : 0;
}

const batchIds = (table: string, cursor: number, where: string | undefined) => `
  SELECT id FROM ${table}
  WHERE search_vector IS NOT NULL AND id > ${cursor}${where ? ` AND (${where})` : ''}
  ORDER BY id
  LIMIT ${BACKFILL_BATCH_SIZE}`;

/** Chunk vectors are a pure function of the row's own columns, so one UPDATE per batch. Returns rows rebuilt. */
export async function backfillChunkVectors(engine: BrainEngine, opts: VectorBackfillOpts): Promise<number> {
  let cursor = await savedCursor(engine, opts.checkpoint);
  let total = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number }>(`
      UPDATE content_chunks SET search_vector = ${chunkSearchVectorSql(opts.lang)}
      WHERE id IN (${batchIds('content_chunks', cursor, opts.where)})
      RETURNING id
    `);
    if (rows.length === 0) break;
    total += rows.length;
    opts.tick?.(rows.length);
    cursor = rows.reduce((m, r) => Math.max(m, Number(r.id)), cursor);
    await engine.setConfig(checkpointKey(opts.checkpoint), String(cursor));
    if (rows.length < BACKFILL_BATCH_SIZE) break;
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
 * indexes it under the current trigger. Returns rows read.
 */
export async function backfillPageVectors(engine: BrainEngine, opts: VectorBackfillOpts): Promise<number> {
  let cursor = await savedCursor(engine, opts.checkpoint);
  let total = 0;
  for (;;) {
    const rows = await engine.executeRaw<{ id: number; timeline: string | null; knowledge_revision: string }>(`
      UPDATE pages SET id = id
      WHERE id IN (${batchIds('pages', cursor, opts.where)})
      RETURNING id, timeline, knowledge_revision::text AS knowledge_revision
    `);
    if (rows.length === 0) break;
    await engine.executeRaw(`
      UPDATE pages p SET search_vector = ${pageSearchVectorSql('p.title', 'v.timeline', opts.lang)}
      FROM unnest($1::int[], $2::text[], $3::uuid[]) AS v(id, timeline, revision)
      WHERE p.id = v.id AND p.knowledge_revision = v.revision
    `, [rows.map(r => Number(r.id)), rows.map(r => sanitizeRemoteBody(r.timeline ?? '')), rows.map(r => r.knowledge_revision)]);
    total += rows.length;
    opts.tick?.(rows.length);
    cursor = rows.reduce((m, r) => Math.max(m, Number(r.id)), cursor);
    await engine.setConfig(checkpointKey(opts.checkpoint), String(cursor));
    if (rows.length < BACKFILL_BATCH_SIZE) break;
  }
  return total;
}
