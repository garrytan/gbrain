/**
 * The git sync hold read persistence/sync-holds.ts readGitSourceHolds ran through `executeRaw` (Rust engine lane 11).
 * The statement text is the caller's, byte for byte (test/engine-sql-caller-raw-sql-pins.test.ts), so PGLite and
 * Postgres answer exactly as before. A Rust brain keeps no hold rows: its git sync path, the only hold writer, refuses
 * (src/core/rust-engine/store-members/persistence.ts).
 */
import { GIT_HOLD_OP } from './persistence-journal.ts';

/** The engine's own executeRaw, so a statement fault a test injects on the engine reaches the hold read. */
export interface HoldRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}

/** Which holds `readGitHoldRecords` returns: every source's, or only `sourceIds`; every run's, or only `runId`'s. */
export interface GitHoldRecordsQuery { sourceIds?: string[]; runId?: string }

/** $1 the hold op, $2 the source ids or null, $3 the run id or null; a read-only mirror's record says so. */
export const GIT_HOLD_RECORDS_SQL = `SELECT CASE WHEN COALESCE(s.config->>'mirror_read_only','false')='true' THEN jsonb_set(h.completed_keys->0,'{read_only_checkout}','true'::jsonb) ELSE h.completed_keys->0 END AS record FROM op_checkpoints h
    JOIN sources s ON s.id=h.completed_keys->0->>'source_id' AND s.incarnation::text=h.completed_keys->0->>'incarnation'
    WHERE h.op=$1 AND ($2::text[] IS NULL OR s.id=ANY($2::text[])) AND ($3::text IS NULL OR h.completed_keys->0->>'run_id'=$3)
    ORDER BY s.id,h.fingerprint`;

/** The hold records of each source's current incarnation, by source id then fingerprint. */
export function readGitHoldRecords<R = Record<string, unknown>>(exec: HoldRead, opts: GitHoldRecordsQuery = {}): Promise<Array<{ record: R }>> {
  return exec.executeRaw<{ record: R }>(GIT_HOLD_RECORDS_SQL, [GIT_HOLD_OP, opts.sourceIds ?? null, opts.runId ?? null]);
}
