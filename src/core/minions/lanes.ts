/**
 * Claim-time lane reservation for long jobs (#7242).
 *
 * One worker at `--concurrency 2` could hold both slots with brain-wide
 * passes (an autopilot cycle, global maintenance, an embed backfill) for tens
 * of minutes while short per-page jobs such as `facts-absorb` waited behind
 * them for days. With concurrency >= 2, at most `concurrency - reserved`
 * slots may hold a long job (never fewer than one, so long work still runs);
 * the rest stay free for everything else. The worker passes the long names as
 * `excludeNames` to `MinionQueue.claim` once that budget is used.
 *
 * DEFAULT_LONG_JOB_NAMES holds only single-flight, brain-wide passes with a
 * 30-minute budget in handler-timeouts.ts, plus doctor-refresh:
 *   - autopilot-cycle, autopilot-global-maintenance: the per-source and
 *     brain-wide maintenance passes that motivated the issue.
 *   - embed-backfill: a brain-wide embedding backfill.
 *   - connector-sync: a full account sync for a chat connector.
 *   - extract: a brain-wide `extract --stale` sweep or remediation pass.
 *   - doctor-refresh: the background measure of every standard doctor check
 *     (#7263; its own overall budget in commands/doctor/last-known.ts).
 * Per-page jobs (facts-absorb, chronicle_extract, contextual_reindex_per_chunk, embed-page)
 * are deliberately absent: they arrive in large fan-outs, so limiting them to
 * one slot would cut their throughput. subagent jobs are absent too: callers
 * wait on them interactively. Operators add names with
 * `minions.long_job_names`.
 */
import type { BrainEngine } from '../engine.ts';

export const DEFAULT_LONG_JOB_NAMES: readonly string[] = [
  'autopilot-cycle',
  'autopilot-global-maintenance',
  'embed-backfill',
  'connector-sync',
  'extract',
  'doctor-refresh',
];

export const DEFAULT_SHORT_JOB_RESERVED_SLOTS = 1;
export const SHORT_JOB_RESERVED_SLOTS_KEY = 'minions.short_job_reserved_slots';
export const LONG_JOB_NAMES_KEY = 'minions.long_job_names';

/** Slots that may hold a long job; equals concurrency when the reservation does not apply. */
export function longJobSlots(concurrency: number, reservedSlots: number): number {
  if (concurrency < 2 || reservedSlots <= 0) return concurrency;
  return Math.max(1, concurrency - reservedSlots);
}

/** The names the next claim must skip: the long names once in-flight long jobs fill their slots, else none. */
export function claimExclusions(
  policy: { concurrency: number; shortJobReservedSlots: number; longJobNames: readonly string[] },
  inFlightNames: Iterable<string>,
): string[] {
  const budget = longJobSlots(policy.concurrency, policy.shortJobReservedSlots);
  if (budget >= policy.concurrency || policy.longJobNames.length === 0) return [];
  const long = new Set(policy.longJobNames);
  let running = 0;
  for (const name of inFlightNames) if (long.has(name)) running++;
  return running >= budget ? [...long] : [];
}

/** `minions.long_job_names`: a JSON array or a comma list, added to the defaults. Unparseable entries are dropped. */
export function parseLongJobNames(raw: string | null | undefined): string[] {
  const text = raw?.trim() ?? '';
  if (text === '') return [];
  let items: unknown[];
  if (text.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(text);
      items = Array.isArray(parsed) ? parsed : [];
    } catch {
      items = [];
    }
  } else {
    items = text.split(',');
  }
  return items.filter((s): s is string => typeof s === 'string').map(s => s.trim()).filter(s => s !== '');
}

/** `minions.short_job_reserved_slots`: a non-negative integer; anything else is null (use the default). */
export function parseReservedSlots(raw: string | null | undefined): number | null {
  const text = raw?.trim() ?? '';
  if (!/^\d+$/.test(text)) return null;
  return Number(text);
}

export interface LanePolicy {
  longJobNames: string[];
  shortJobReservedSlots: number;
}

/** Reads both keys; a read failure or invalid value falls back to the defaults with one stderr line. */
export async function resolveLanePolicy(engine: Pick<BrainEngine, 'getConfig'>): Promise<LanePolicy> {
  let reservedRaw: string | null = null;
  let namesRaw: string | null = null;
  try {
    [reservedRaw, namesRaw] = await Promise.all([
      engine.getConfig(SHORT_JOB_RESERVED_SLOTS_KEY),
      engine.getConfig(LONG_JOB_NAMES_KEY),
    ]);
  } catch (e) {
    console.error(`[worker] could not read lane config (${e instanceof Error ? e.message : String(e)}); using defaults.`);
  }
  let reserved = parseReservedSlots(reservedRaw);
  if (reserved === null) {
    if (reservedRaw != null && reservedRaw.trim() !== '') {
      console.error(`[worker] ${SHORT_JOB_RESERVED_SLOTS_KEY}=${JSON.stringify(reservedRaw)} is not a non-negative integer; using ${DEFAULT_SHORT_JOB_RESERVED_SLOTS}.`);
    }
    reserved = DEFAULT_SHORT_JOB_RESERVED_SLOTS;
  }
  return {
    longJobNames: [...new Set([...DEFAULT_LONG_JOB_NAMES, ...parseLongJobNames(namesRaw)])],
    shortJobReservedSlots: reserved,
  };
}

/** The "Minion worker started" fragment. */
export function describeLanePolicy(concurrency: number, reservedSlots: number): string {
  const budget = longJobSlots(concurrency, reservedSlots);
  if (budget >= concurrency) return 'long-job lane: off';
  return `long-job lane: ${budget} of ${concurrency} slots`;
}
