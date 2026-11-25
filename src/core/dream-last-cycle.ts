/**
 * The record a completed full `gbrain dream` cycle leaves in the brain's config, which `gbrain status` shows as the
 * last full cycle beside autopilot's `autopilot-cycle` jobs. A repo-less brain has no other record of a dream run.
 */
import type { BrainEngine } from './engine.ts';

export const DREAM_LAST_FULL_CYCLE_KEY = 'dream.last_full_cycle';

export interface DreamCycleRecord {
  finished_at: string;
  name: 'dream';
  status: string;
  duration_ms: number;
  totals: Record<string, unknown>;
}

/** A cycle that ran to its end: ok, clean or partial, but never one that was aborted or lost its lock part way. */
export function completedFullCycle(report: { status: string; reason?: string }): boolean {
  return ['ok', 'clean', 'partial'].includes(report.status) && report.reason !== 'aborted' && report.reason !== 'lock_stolen';
}

export async function recordDreamFullCycle(engine: BrainEngine, report: { timestamp: string; duration_ms: number; status: string; totals: object }): Promise<void> {
  const record: DreamCycleRecord = {
    finished_at: new Date(Date.parse(report.timestamp) + report.duration_ms).toISOString(),
    name: 'dream', status: report.status, duration_ms: report.duration_ms, totals: report.totals as Record<string, unknown>,
  };
  await engine.setConfig(DREAM_LAST_FULL_CYCLE_KEY, JSON.stringify(record));
}

/** The last recorded dream cycle; null when there is none or the row does not parse. */
export async function readDreamFullCycle(engine: BrainEngine): Promise<DreamCycleRecord | null> {
  const raw = await engine.getConfig(DREAM_LAST_FULL_CYCLE_KEY);
  if (!raw) return null;
  let record: DreamCycleRecord | null;
  try {
    record = JSON.parse(raw) as DreamCycleRecord | null;
  } catch (err) { // silent-read-ok: only JSON.parse is caught; a malformed record reads as no recorded cycle
    if (!(err instanceof SyntaxError)) throw err;
    return null;
  }
  return record && typeof record.finished_at === 'string' && !Number.isNaN(Date.parse(record.finished_at)) ? record : null;
}
