/**
 * Doctor facts, fence and trust reads: the statements `gbrain doctor` checks (and the readers they share) ran through
 * `executeRaw`, each with the same text and parameters, on the engine's own `executeRaw`; only their home moved.
 * PGLite and Postgres run these exact statements. Nothing here is composed: every variant is one literal constant.
 *
 * The Rust engine answers each member from its store or, where the store keeps no writer of the relation, with the
 * empty value (rust/docs/store/cli-reads-doctor-facts-trust.md).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/**
 * The members of this file. Each replaced a statement doctor ran through its deadline-bound executeRaw, so
 * src/core/statement-deadline.ts keeps that bound on them (BOUNDED_TYPED_READS).
 */
export const DOCTOR_FACTS_TRUST_MEMBERS: readonly string[] = [
  'countConversationPipelinePages', 'listPersistentWriterContention',
];

/** A timestamp column as an engine returns it: a Date, or the text a driver without a timestamp codec gives. */
type Stamp = Date | string;

/** One source whose deferred facts writes persist: the count and the oldest write time. */
export interface WriterContentionRow { source_id: string; n: number; oldest: Stamp }

const COUNT_CONVERSATION_PIPELINE_PAGES_SQL = `SELECT count(*)::int AS n FROM pages
      WHERE deleted_at IS NULL AND type = ANY($1::text[]) AND NOT (slug LIKE ANY($2::text[]))`;

/** Live pages of the conversation-pipeline `types` whose slug matches none of the `slugPatterns` (LIKE patterns). */
export async function countConversationPipelinePages(raw: EngineRawRead, types: readonly string[], slugPatterns: readonly string[]): Promise<number> {
  const [row] = await raw<{ n: number }>(COUNT_CONVERSATION_PIPELINE_PAGES_SQL, [types, slugPatterns]);
  return Number(row?.n ?? 0);
}

const LIST_PERSISTENT_WRITER_CONTENTION_SQL = `SELECT l.source_id, COUNT(*)::int AS n, MIN(l.created_at) AS oldest
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
        ORDER BY l.source_id`;

/**
 * Per source, the facts writes deferred before admission (`reason`) in the last 24 hours that no facts-absorb job for the same
 * page completed after, when they persist: more than 10, or the oldest over an hour old. Throws the missing-table error of
 * `minion_jobs` on a brain without it.
 */
export async function listPersistentWriterContention(raw: EngineRawRead, reason: string): Promise<WriterContentionRow[]> {
  return raw<WriterContentionRow>(LIST_PERSISTENT_WRITER_CONTENTION_SQL, [reason]);
}
