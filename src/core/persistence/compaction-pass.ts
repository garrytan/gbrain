/**
 * #6696 (A11): the resident consumer's compaction pass, made visible. One pass
 * compacts what `compactWriteReceiptsDetailed` finds eligible, runs one bounded
 * step of the one-shot sweep of receipts compacted before reservations were
 * trued up, and records `{at, host_id, compacted, freed_bytes,
 * skipped_by_reason}` in `persistence.maintenance.last_compaction` (when it
 * compacted something, else at most once an hour per process). Doctor reads
 * the record (`persistence_compaction`) and warns when a live consumer has not
 * recorded a pass within `persistence.maintenance.compaction_stale_hours`
 * (default 24). A pass that frees bytes writes one `[persistence]
 * phase=compaction` line on stderr when the owner is `serve`.
 */
import type { BrainEngine } from '../engine.ts';
import { compactReceipt, compactWriteReceiptsDetailed, NEWEST_SYNC_RECEIPT_EXCLUSION, OPEN_SYNC_CURSOR_EXCLUSION, yieldToEventLoop, type ReceiptCompactionResult } from './journal.ts';
import { getCode } from '../retry-matcher.ts';
import type { WriteRequest } from './model.ts';
import { HOUSEKEEPING_FLOOR_DAYS, readCompactableReceiptBytes, readReceiptTargetBytes, RECEIPT_RETENTION_KEY } from './limits.ts';
import { sweepCompactedReservations } from './receipt-true-up.ts';

export const LAST_COMPACTION_KEY = 'persistence.maintenance.last_compaction';
export const COMPACTION_STALE_HOURS_KEY = 'persistence.maintenance.compaction_stale_hours';
export const DEFAULT_COMPACTION_STALE_HOURS = 24;
const RECORD_EVERY_MS = 60 * 60_000;

/** `early`: receipts of `compacted` that housekeeping took before the default retention (GBRA-108). */
export interface CompactionRecord extends ReceiptCompactionResult { at: string; host_id: string; early: number }
const recordedAt = new WeakMap<object, number>();

export async function runCompactionPass(engine: BrainEngine, opts: { hostId: string; notice?: boolean; now?: number }): Promise<CompactionRecord> {
  const result = await compactWriteReceiptsDetailed(engine);
  await yieldToEventLoop();
  // A housekeeping error never skips the reservation sweep or the pass record: it is counted and the pass carries on.
  const early = await housekeepReceipts(engine).catch((error: unknown): ReceiptCompactionResult => {
    process.stderr.write(`[persistence] phase=housekeeping error=${getCode(error) ?? (error instanceof Error ? error.message : String(error))}\n`);
    return { compacted: 0, freed_bytes: 0, skipped_by_reason: { housekeeping_error: 1 } };
  });
  for (const [reason, n] of Object.entries(early.skipped_by_reason)) result.skipped_by_reason[reason] = (result.skipped_by_reason[reason] ?? 0) + n;
  await yieldToEventLoop();
  const swept = await sweepCompactedReservations(engine);
  await yieldToEventLoop();
  const now = opts.now ?? Date.now();
  const record: CompactionRecord = { at: new Date(now).toISOString(), host_id: opts.hostId, compacted: result.compacted + early.compacted,
    freed_bytes: result.freed_bytes + early.freed_bytes + swept.freed_bytes, skipped_by_reason: result.skipped_by_reason, early: early.compacted };
  if (record.compacted > 0 || record.freed_bytes > 0 || now - (recordedAt.get(engine) ?? -Infinity) >= RECORD_EVERY_MS) {
    // The record is a report: a refused config write (a read-only or fenced brain) never fails the maintenance tick.
    if (await engine.setConfig(LAST_COMPACTION_KEY, JSON.stringify(record)).then(() => true, () => false)) recordedAt.set(engine, now);
  }
  if (opts.notice && record.freed_bytes > 0) {
    const skipped = Object.entries(record.skipped_by_reason).map(([reason, n]) => `${reason}:${n}`).join(',');
    process.stderr.write(`[persistence] phase=compaction compacted=${record.compacted} freed_bytes=${record.freed_bytes}${skipped ? ` skipped=${skipped}` : ''}\n`);
  }
  return record;
}

/**
 * What housekeeping may compact early (GBRA-108). Settled receipts, except `submit_job` ones (atom retries, generation
 * members and synthesis postprocess read their committed intents), a subagent's own writes (`restrictedNamespace`: a deferred
 * synthesis postprocess compares the child's committed content with the page) and connector writes (a later retry's `retryOf` resolves
 * an earlier refusal). Refused receipts only where the producer writes again from current content and nothing reads the
 * intent: managed sync, file import, reconcile and file repair page writes, and maintenance pages. Every other refusal keeps
 * its intent until the retention window: a caller's write (`gbrain repair failed-writes` replays it), conversation facts
 * (the frozen extraction), atom members, connector items (their held-retry pointer).
 */
const EARLY_SQL = (r: string) => `((${r}.state IN ('committed','cancelled') AND ${r}.operation<>'submit_job' AND COALESCE(${r}.intent->>'kind','') NOT LIKE 'connector_%'
        AND COALESCE(${r}.authority->>'restrictedNamespace','')<>'true')
      OR (${r}.state IN ('failed','conflict') AND ((${r}.operation='put_page' AND (${r}.intent->>'kind' LIKE 'managed_sync_%'
        OR ${r}.intent->>'kind' IN ('managed_file_import','canonical_reconcile','managed_file_repair')))
        OR (${r}.operation='submit_job' AND ${r}.intent->>'kind'='managed_maintenance_page'))))`;
/**
 * GBRA-108: while receipts not yet compacted reserve more than `persistence.housekeeping.receipt_target_bytes` and the retention is
 * the default, one batch of receipts older than HOUSEKEEPING_FLOOR_DAYS that `EARLY_SQL` admits compacts early, oldest first.
 * An explicit retention is the operator's and is kept, and every exclusion of the retention pass applies (`compactReceipt`
 * rechecks state, age, effects and sync under its lock; operation and intent never change once a request ends).
 */
export async function housekeepReceipts(engine: BrainEngine): Promise<ReceiptCompactionResult> {
  const result: ReceiptCompactionResult = { compacted: 0, freed_bytes: 0, skipped_by_reason: {} };
  const [target, [state]] = await Promise.all([readReceiptTargetBytes(engine), engine.executeRaw<{ retention: string | null; used: string | null; cutoff: string }>(
    `SELECT (SELECT value FROM config WHERE key=$1) AS retention,(SELECT terminal_bytes::text FROM persistence_counters WHERE key='brain') AS used,
      to_char((now()-($2::double precision*interval '1 day')) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cutoff`, [RECEIPT_RETENTION_KEY, HOUSEKEEPING_FLOOR_DAYS])]);
  if (!state || state.retention !== null || target === 0 || Number(state.used ?? 0) <= target) return result;
  if (await readCompactableReceiptBytes(engine) <= target) return result;
  const states = ['committed', 'cancelled', 'failed', 'conflict'];
  const rows = await engine.executeRaw<Pick<WriteRequest, 'id' | 'principal_kind' | 'principal_id'>>(`SELECT id,principal_kind,principal_id FROM persistence_requests r
    WHERE state=ANY($1::text[]) AND recovery IS NULL AND NOT compacted AND completed_at < $2::timestamptz
    AND ${EARLY_SQL('r')}
    AND NOT EXISTS (SELECT 1 FROM persistence_effects e WHERE e.request_id=r.id AND e.state<>'committed')
    ${OPEN_SYNC_CURSOR_EXCLUSION('r')}
    ${NEWEST_SYNC_RECEIPT_EXCLUSION('r')}
    ORDER BY sequence LIMIT 100`, [states, state.cutoff]);
  for (const row of rows) {
    const done = await compactReceipt(engine, row, { states, completedBefore: state.cutoff }).catch(error => {
      if (['55P03', '57014'].includes(getCode(error) ?? '')) return { skipped: 'lock_timeout' };
      throw error;
    });
    if ('skipped' in done) result.skipped_by_reason[done.skipped] = (result.skipped_by_reason[done.skipped] ?? 0) + 1;
    else { result.compacted++; result.freed_bytes += done.freed_bytes; }
  }
  return result;
}

/** The last recorded pass, or null when none was recorded (or the record does not parse). */
export async function readLastCompaction(engine: Pick<BrainEngine, 'getConfig'>): Promise<CompactionRecord | null> {
  const raw = await engine.getConfig(LAST_COMPACTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CompactionRecord;
    return typeof parsed?.at === 'string' && Number.isFinite(Date.parse(parsed.at)) ? parsed : null;
  } catch { return null; }
}
