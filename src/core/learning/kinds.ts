/**
 * Nightly learning: the ledger's item kinds and the reads derive.ts, read.ts and stats.ts share. Kept apart from
 * derive.ts so the read side never loads the producers' modules.
 */
import type { BrainEngine } from '../engine.ts';

export const LEARNING_KINDS = ['fact_added', 'you_wrote', 'promise_found', 'page_filled', 'conflict_found', 'duplicate_to_confirm'] as const;
export type LearningKind = (typeof LEARNING_KINDS)[number];
/** Things the brain changed: kept or undone, and the only kinds the bar counts. */
export const CHANGE_KINDS: readonly LearningKind[] = ['fact_added', 'promise_found', 'page_filled'];
/** Things the brain asks about: answered, never kept, never counted. */
export const QUESTION_KINDS: readonly LearningKind[] = ['conflict_found', 'duplicate_to_confirm'];

/** Keyless brains: the thin close contacts the last learning_derive pass counted ({count, cost_usd, cost_basis, recorded_at}); learned reads it. */
export const KEYLESS_THIN_CONTACTS_KEY = 'learning.keyless_thin_contacts';

export const CLAIM_CONFLICT_SWEEP_SQL = "d.sweep_id LIKE 'claim_conflicts:%'";

/** NOT EXISTS over learning_items for one target: whether a pointer of one of `kinds` (a quoted SQL list) already names it. */
export function notRecordedSql(kinds: string, table: string, id: string): string {
  return `NOT EXISTS (SELECT 1 FROM learning_items li WHERE li.kind IN (${kinds}) AND li.target_table = '${table}' AND li.target_id = ${id})`;
}

/** Pending claim-conflict proposals with no ledger item in `$1`'s sources (null: every source): the backlog the note shows as one count. */
export const CONFLICT_BACKLOG_SQL = `SELECT count(*)::int AS n FROM decide_proposals d
  WHERE ${CLAIM_CONFLICT_SWEEP_SQL} AND d.status = 'pending' AND ($1::text[] IS NULL OR d.source_id = ANY($1::text[]))
    AND ${notRecordedSql("'conflict_found'", 'decide_proposals', 'd.id')}`;

/** Whether this brain has the ledger table (a brain behind the migration, or a thin client's, does not). */
export async function learningTablePresent(engine: BrainEngine): Promise<boolean> {
  const [row] = await engine.executeRaw<{ ok: boolean }>(`SELECT to_regclass('learning_items') IS NOT NULL AS ok`);
  return row?.ok === true;
}
