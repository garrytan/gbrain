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
import { compactWriteReceiptsDetailed, yieldToEventLoop, type ReceiptCompactionResult } from './journal.ts';
import { sweepCompactedReservations } from './receipt-true-up.ts';

export const LAST_COMPACTION_KEY = 'persistence.maintenance.last_compaction';
export const COMPACTION_STALE_HOURS_KEY = 'persistence.maintenance.compaction_stale_hours';
export const DEFAULT_COMPACTION_STALE_HOURS = 24;
const RECORD_EVERY_MS = 60 * 60_000;

export interface CompactionRecord extends ReceiptCompactionResult { at: string; host_id: string }
const recordedAt = new WeakMap<object, number>();

export async function runCompactionPass(engine: BrainEngine, opts: { hostId: string; notice?: boolean; now?: number }): Promise<CompactionRecord> {
  const result = await compactWriteReceiptsDetailed(engine);
  await yieldToEventLoop();
  const swept = await sweepCompactedReservations(engine);
  await yieldToEventLoop();
  const now = opts.now ?? Date.now();
  const record: CompactionRecord = { at: new Date(now).toISOString(), host_id: opts.hostId, compacted: result.compacted,
    freed_bytes: result.freed_bytes + swept.freed_bytes, skipped_by_reason: result.skipped_by_reason };
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

/** The last recorded pass, or null when none was recorded (or the record does not parse). */
export async function readLastCompaction(engine: Pick<BrainEngine, 'getConfig'>): Promise<CompactionRecord | null> {
  const raw = await engine.getConfig(LAST_COMPACTION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CompactionRecord;
    return typeof parsed?.at === 'string' && Number.isFinite(Date.parse(parsed.at)) ? parsed : null;
  } catch { return null; }
}
