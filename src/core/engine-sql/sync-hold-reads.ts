/** The op_checkpoints op of a `gbrain sources retry-held` request: the held paths the next sync re-screens. */
export const GIT_HOLD_RETRY_OP = 'sync-hold-retry';

/** Which holds `readGitHoldRecords` returns: every source's, or only `sourceIds`; every run's, or only `runId`'s. */
export interface GitHoldRecordsQuery { sourceIds?: string[]; runId?: string }

/** What a sync hold report reads besides the holds: the summary counters (null when the incarnation has none) and the source's mirror flag text (null when unset or the source is absent). */
export interface GitHoldReportInputs { summary: GitHoldSummaryRow | null; mirror: string | null }

/** One source incarnation's hold summary counters (zero when a counter is absent). */
export interface GitHoldSummaryRow {
  count: number | string; images: number | string; fences: number | string; stalled: number | string;
  concurrent: number | string; dirty: number | string; drift: number | string;
}



/** The engine's own executeRaw, so a statement fault a test injects on the engine reaches the hold read. */
export interface HoldRead {
  executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]>;
}
