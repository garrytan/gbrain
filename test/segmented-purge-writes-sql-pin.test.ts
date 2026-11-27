/**
 * engine-sql/segmented-purge-writes.ts: the statements PGLite and Postgres run for the fact purge's segmented writes and
 * its version-body read are the text the call sites ran through `executeRaw` before they became typed members
 * (applySegmentedBody's staging lock and stale chunk delete, deleteRewrittenDerivations' delete, and the purge's
 * rewriteVersionBodies read), byte for byte and with the same parameters.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each member sends exactly the old statement text and parameter list; the raw reader the held-fact move
 *    still uses (rewriteVersionBodies with a `where`) builds the same text it built before.
 *  - Regression: a reworded statement changes what the SQL engines lock, delete or read, which the parity cases compare
 *    only by outcome.
 *  - Seam: a recording executor in place of the engine's `executeRaw`; the literals below are the old call sites' text.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { deleteRewrittenSegmentDerivations, deleteUnstagedSegmentChunks, listPurgeVersionBodies, lockBodyStagingState,
  PURGE_VERSION_BODY_SQL } from '../src/core/engine-sql/segmented-purge-writes.ts';
import { rewriteVersionBodies } from '../src/core/facts/purge.ts';

function recorder(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const tx = { executeRaw: async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return rows; } };
  return { calls, tx: tx as unknown as BrainEngine };
}

const OLD_PURGE_VERSION_BODY_SQL = "SELECT v.id,p.slug,v.compiled_truth,v.timeline,\n        (strpos(lower(COALESCE(v.title,'')),$4)>0 OR strpos(lower(COALESCE(v.frontmatter::text,'')),$5)>0) AS metadata\n      FROM page_versions v JOIN pages p ON p.id=v.page_id\n      WHERE p.source_id=$1 AND v.body_storage='inline' AND v.id>$3 AND (v.page_id=ANY($2::int[]) OR (strpos(lower(v.compiled_truth),$4)>0 OR strpos(lower(COALESCE(v.timeline,'')),$4)>0\n  OR strpos(lower(COALESCE(v.title,'')),$4)>0 OR strpos(lower(COALESCE(v.frontmatter::text,'')),$5)>0))\n      ORDER BY v.id LIMIT 5000";

describe('segmented purge writes: the SQL engines run the old statements', () => {
  test('lockBodyStagingState locks the staging row and answers its state or null', async () => {
    const { calls, tx } = recorder([{ state: 'prepared' }]);
    expect(await lockBodyStagingState(tx, 'a1b2')).toBe('prepared');
    expect(calls).toEqual([{ sql: 'SELECT state FROM page_body_stagings WHERE id=$1::uuid FOR UPDATE', params: ['a1b2'] }]);
    expect(await lockBodyStagingState(recorder([]).tx, 'a1b2')).toBeNull();
  });

  test('deleteUnstagedSegmentChunks deletes the generation rows outside the staged indexes', async () => {
    const { calls, tx } = recorder();
    await deleteUnstagedSegmentChunks(tx, 7, 3, [4, 5]);
    expect(calls).toEqual([{ sql: 'DELETE FROM content_chunks WHERE page_id=$1 AND body_generation=$2 AND NOT (chunk_index = ANY($3::int[]))',
      params: [7, 3, [4, 5]] }]);
  });

  test('deleteRewrittenSegmentDerivations sends the old delete and counts the returned rows', async () => {
    const { calls, tx } = recorder([{}, {}]);
    const deleted = await deleteRewrittenSegmentDerivations(tx, { pageId: 7, touchedOccurrenceIds: [11], linkReachOccurrenceIds: [10, 12],
      pipelines: ['links', 'mentions', 'timeline', 'fences'], liveOccurrenceIds: [10, 11, 12] });
    expect(deleted).toBe(2);
    expect(calls).toEqual([{ sql: `DELETE FROM page_segment_derivations WHERE page_id=$1
    AND (occurrence_id = ANY($2::bigint[]) OR (pipeline = 'links' AND occurrence_id = ANY($3::bigint[]))
      OR (pipeline = ANY($4::text[]) AND NOT (occurrence_id = ANY($5::bigint[])))) RETURNING 1`,
    params: [7, [11], [10, 12], ['links', 'mentions', 'timeline', 'fences'], [10, 11, 12]] }]);
  });

  test('listPurgeVersionBodies sends the purge read rewriteVersionBodies built, with the same parameters', async () => {
    expect(PURGE_VERSION_BODY_SQL).toBe(OLD_PURGE_VERSION_BODY_SQL);
    const { calls, tx } = recorder();
    await listPurgeVersionBodies(tx, { sourceId: 'default', pageIds: [3, 9], after: 40, needle: 'alice said "tea"', escaped: 'alice said \\"tea\\"' });
    expect(calls).toEqual([{ sql: OLD_PURGE_VERSION_BODY_SQL, params: ['default', [3, 9], 40, 'alice said "tea"', 'alice said \\"tea\\"'] }]);
  });

  test('rewriteVersionBodies with a where still builds the old raw read (the held-fact move), lock clause included', async () => {
    const { calls, tx } = recorder();
    await rewriteVersionBodies(tx, { columns: '', where: 'v.id>$2 AND p.slug=$3', params: after => ['default', after, 'people/a'], lock: true },
      text => text, () => undefined);
    expect(calls).toEqual([{ sql: "SELECT v.id,p.slug,v.compiled_truth,v.timeline\n      FROM page_versions v JOIN pages p ON p.id=v.page_id\n      WHERE p.source_id=$1 AND v.body_storage='inline' AND v.id>$2 AND p.slug=$3\n      ORDER BY v.id LIMIT 5000 FOR UPDATE OF v",
      params: ['default', 0, 'people/a'] }]);
  });
});
