/**
 * The commit log and commit positions (multi-user mode with the commit log on; rust/docs/store/commit-log.md).
 * `BrainEngine` extends this interface. Only a Rust engine whose store keeps a commit log answers; every other engine,
 * and a Rust engine with the log off, refuses with `engine_capability_missing` (capability `commit_log`) before any work.
 */
import { opError } from '../ops/contract.ts';

/** Where one commit sits in the brain's commit order: the record file's commit sequence, then the transaction's place in that group commit. */
export interface CommitPosition { sequence: number; index: number }

/** One commit record, as `readCommitLog` returns it (its ops stay in the store; `op_count` says how many). */
export interface CommitLogRecord {
  position: CommitPosition;
  /** Microseconds since the Unix epoch, UTC; strictly increasing in position order. */
  commit_time_us: number;
  origin: { host_id: string; incarnation: string; writer_id: string };
  /** The persistence request ids the commit carried. */
  write_ids: string[];
  op_count: number;
}

/** One page of the commit log, read from one snapshot. */
export interface CommitLogPage {
  records: CommitLogRecord[];
  /** The newest commit with a record (the log's start before the first). */
  newest: CommitPosition | null;
  oldest_retained: CommitPosition | null;
  /** True when `after` cannot be continued from the log (older than its start or than what retention trimmed, or past its newest): install a snapshot first. */
  snapshot_required: boolean;
}

/** One fact of an entity in commit order (`listEntityFactsInCommitOrder`): the number its commit gave it, and its row id. */
export interface EntityFactCommitPosition {
  /** The entity's commit sequence: 1 for its first fact, then one more for each later fact, in commit order. */
  sequence: number;
  fact_id: number;
}

export interface CommitLogMembers {
  /** Up to `limit` (at most 10,000) commit records after `after` (null: from where the log starts), from one snapshot. */
  readCommitLog(after: CommitPosition | null, limit: number): Promise<CommitLogPage>;
  /**
   * The position the engine's newest finished write or transaction committed at, or null before the first. On the engine
   * a transaction callback received (`transaction(async tx => ...)`), the position that transaction committed at, also
   * after it ended; null while it is open or when it rolled back.
   */
  lastCommitPosition(): Promise<CommitPosition | null>;
  /**
   * The facts of one entity in `sourceId`, in the order their writers committed them (conformance C11): up to `limit`
   * (at most 10,000), after `afterSequence` (omitted: from the first). Facts later deleted or moved to another entity
   * are left out, so the sequence can show gaps. Existing fact reads (`listFactsByEntity`) keep their own order.
   */
  listEntityFactsInCommitOrder(
    sourceId: string, entitySlug: string, opts: { afterSequence?: number; limit: number },
  ): Promise<EntityFactCommitPosition[]>;
}

/** The refusal of a commit-log member on an engine that keeps no commit log (`engine_capability_missing`, reason `commit_log`). */
export function commitLogMissing(member: keyof CommitLogMembers): Promise<never> {
  return Promise.reject(opError('engine_capability_missing',
      `This brain's engine keeps no commit log, so ${member} did not run (it needs the commit_log capability); nothing ran.`,
      'Open the brain on the Rust engine in multi-user mode with the commit log on (GBRAIN_RUST_MULTIUSER=1, GBRAIN_RUST_COMMIT_LOG=1).',
      { reason: 'commit_log', detail: `member=${member} capability=commit_log outcome=none written=nothing` }));
}
