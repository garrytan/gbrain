/**
 * #6696 B1/B2: the one read of managed write capacity that `/admin/api/ops`
 * and the remote bands share: the counter diagnostics (`capacityDiagnostics`:
 * used and limit per scope and resource), the 7-day forecast
 * (`readCapacityForecast`, light: days to exhaustion per scope and resource,
 * null when it could not be read, which every consumer treats as "days
 * unknown", never "plenty"), and the last receipt compaction the consumer
 * recorded (`readLastCompaction`).
 */
import type { BrainEngine } from '../engine.ts';
import { capacityDiagnostics } from './diagnostics.ts';
import { readJournalLimits } from './limits.ts';
import { readCapacityForecast, type CapacityForecast } from './capacity-forecast.ts';
import { readLastCompaction, type CompactionRecord } from './compaction-pass.ts';
import type { CapacitySnapshot } from './capacity-snapshot.ts';
import { CAPACITY_VERIFY } from './capacity-verify.ts';

export type CapacityRow = ReturnType<typeof capacityDiagnostics>[number];

export interface CapacityView {
  rows: CapacityRow[];
  counters_read: number;
  forecast: CapacityForecast | null;
  last_compaction: CompactionRecord | null;
}

/** Resources that never drain on their own (transient caps refill as requests finish). */
export const CUMULATIVE_RESOURCES: ReadonlySet<string> = new Set(['lifetime_ids', 'terminal_bytes']);

export type CounterRow = { key: string; outstanding_count: string; intent_bytes: string; lifetime_ids: string; terminal_bytes: string; recovery_bytes: string };

/** The brain and principal counter rows (the input `capacityDiagnostics` reads). */
export async function readCapacityCounters(engine: BrainEngine): Promise<CounterRow[]> {
  return engine.executeRaw<CounterRow>(`SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,
    terminal_bytes::text,recovery_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key`);
}

export async function readCapacityView(engine: BrainEngine): Promise<CapacityView> {
  const counters = await readCapacityCounters(engine);
  const limits = await readJournalLimits(engine);
  const forecast = await readCapacityForecast(engine, { limits, light: true }).catch(() => null);
  return { rows: capacityDiagnostics(counters, limits), counters_read: counters.length, forecast, last_compaction: await readLastCompaction(engine) };
}

/**
 * The read-only verification of every capacity fix: doctor on the brain host, and
 * the read-scope `get_brain_health` operation where it is callable (remote agents
 * without admin scope see the band clear).
 */
export function capacityVerify(): { argv: string[]; mcp: { tool: string; arguments: Record<string, unknown> } } {
  return { argv: [...CAPACITY_VERIFY.argv], mcp: { ...CAPACITY_VERIFY.mcp } };
}

export type CapacityBand = 'ok' | 'low' | 'critical';
export type DaysBand = 'under_7' | '7_to_30' | '30_to_90' | '90_to_365' | 'over_365' | 'unknown';

/**
 * Remote-safe banding of the cached capacity snapshot: no scope identities, no exact counters. `low` and
 * `critical` follow doctor `persistence_capacity` (80% / 95%, or out within the warn / fail days); a snapshot
 * that could not be read is days `unknown`, never plenty.
 */
export function capacityBands(snapshot: CapacitySnapshot, thresholds: { warnDays: number; failDays: number }): { capacity: CapacityBand; days: DaysBand; max_pct_band: '<80' | '80-95' | '>=95' } {
  const pct = snapshot.rows.reduce((max, r) => Math.max(max, r.pct), 0);
  const known = snapshot.rows.map((r) => r.days_to_exhaustion).filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  const days = known.length ? Math.min(...known) : null;
  // A row without days does not run out within the forecast horizon (3650 days) at its 7-day rate.
  const daysBand: DaysBand = snapshot.status !== 'ok' ? 'unknown' : days === null ? 'over_365' : days < 7 ? 'under_7' : days < 30 ? '7_to_30' : days < 90 ? '30_to_90' : days < 365 ? '90_to_365' : 'over_365';
  const capacity: CapacityBand = pct >= 95 || (days !== null && days < thresholds.failDays) ? 'critical'
    : pct >= 80 || snapshot.low.length > 0 || (days !== null && days < thresholds.warnDays) ? 'low' : 'ok';
  return { capacity, days: daysBand, max_pct_band: pct >= 95 ? '>=95' : pct >= 80 ? '80-95' : '<80' };
}
