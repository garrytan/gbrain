/**
 * The statements of src/core/engine-sql/doctor-facts-trust.ts keep the exact text the doctor readers built inline.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: each statement equals the text its reader ran through executeRaw before the move (parameters in the same
 *    order), no member lists a name the engine lacks, and no member is listed twice.
 *  - Regression: a drifted statement changes which pages, deferrals or rows doctor reports on PGLite and Postgres.
 *  - Why existing coverage misses it: the parity cases compare engines on seeded rows, not the text against the old builder.
 *  - Seam: a recording raw reader (no engine).
 */
import { describe, expect, test } from 'bun:test';
import { DOCTOR_FACTS_TRUST_MEMBERS, countConversationPipelinePages, listPersistentWriterContention } from '../src/core/engine-sql/doctor-facts-trust.ts';
import { RUST_ENGINE_MEMBERS } from '../src/core/rust-engine/members.ts';

function recorder(rows: unknown[] = []) {
  const calls: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const raw = (async (sql: string, params?: unknown[]) => { calls.push({ sql, params }); return rows; }) as never;
  return { raw, calls };
}

describe('doctor facts, fence and trust SQL text', () => {
  test('conversation-pipeline page count: the statement conversationPipelineNote ran', async () => {
    const { raw, calls } = recorder([{ n: 3 }]);
    expect(await countConversationPipelinePages(raw, ['chat'], ['meetings/%'])).toBe(3);
    expect(calls).toEqual([{ sql: `SELECT count(*)::int AS n FROM pages
      WHERE deleted_at IS NULL AND type = ANY($1::text[]) AND NOT (slug LIKE ANY($2::text[]))`, params: [['chat'], ['meetings/%']] }]);
  });

  test('persistent writer contention: the statement persistentWriterContention ran', async () => {
    const { raw, calls } = recorder();
    await listPersistentWriterContention(raw, 'write_deferred_unadmitted');
    expect(calls).toEqual([{ sql: `SELECT l.source_id, COUNT(*)::int AS n, MIN(l.created_at) AS oldest
         FROM ingest_log l
        WHERE l.source_type = 'facts:absorb'
          AND l.created_at >= now() - INTERVAL '24 hours'
          AND split_part(l.summary, ':', 1) = $1
          AND NOT EXISTS (
            SELECT 1 FROM minion_jobs j
             WHERE j.name = 'facts-absorb' AND j.status = 'completed' AND j.finished_at >= l.created_at
               AND j.data->>'slug' = l.source_ref AND COALESCE(j.data->>'sourceId', 'default') = l.source_id)
        GROUP BY l.source_id
       HAVING COUNT(*) > 10 OR MIN(l.created_at) < now() - INTERVAL '1 hour'
        ORDER BY l.source_id`, params: ['write_deferred_unadmitted'] }]);
  });

  test('every listed member is a classified engine member, once', () => {
    expect(new Set(DOCTOR_FACTS_TRUST_MEMBERS).size).toBe(DOCTOR_FACTS_TRUST_MEMBERS.length);
    for (const member of DOCTOR_FACTS_TRUST_MEMBERS) expect(Object.keys(RUST_ENGINE_MEMBERS)).toContain(member);
  });
});
