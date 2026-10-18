/**
 * #6696 B2 (Garry decision d2b): what a remote agent without admin scope may
 * see of brain health — bands, never exact counters, slugs, paths, request ids
 * or principal identities. Served by the read-scope operation
 * `get_brain_health` and the thin client's `gbrain doctor --only
 * persistence_capacity` when its token lacks admin.
 *
 * Capacity is brain-wide host state (one band for the brain and every
 * principal), read from the shared 60 s capacity snapshot (`cachedCapacitySnapshot`); write failures are scoped to the caller's readable sources. A
 * section that could not be read is `unknown`, never a clear band. A source whose managed sync run stays blocked past
 * the doctor threshold (#6858) turns the status to `attention`. Answers are
 * cached per engine and scope for 60 s, so a polling agent costs one read a
 * minute.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { capacityBands, type CapacityBand, type DaysBand } from '../../core/persistence/capacity-view.ts';
import { cachedCapacitySnapshot } from '../../core/persistence/capacity-snapshot.ts';
import { readCapacityThresholds } from '../../core/persistence/capacity-forecast.ts';
import { cachedTerminalSummary } from '../serve-http-metrics.ts';
import { readEmbeddingState } from '../../core/embedding-state.ts';
import { readGhostPages } from '../../core/ghost-pages.ts';
import { MANAGED_SYNC_BLOCKED_FAIL_MS, readBlockedManagedSyncs } from '../../core/persistence/sync-blocked.ts';

export const BRAIN_HEALTH_TTL_MS = 60_000;
export type CountBand = 'none' | '1-9' | '10-99' | '100-999' | '1000+' | 'unknown';

export function countBand(n: number | null | undefined): CountBand {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return 'unknown';
  return n === 0 ? 'none' : n < 10 ? '1-9' : n < 100 ? '10-99' : n < 1000 ? '100-999' : '1000+';
}

export interface BrainHealthBands {
  schema_version: 1;
  status: 'ok' | 'attention' | 'unknown';
  capacity: { band: CapacityBand | 'unknown'; days: DaysBand; max_pct_band: '<80' | '80-95' | '>=95' | 'unknown'; forecast: 'available' | 'unavailable' };
  write_failures: { band: CountBand; active_blockers: CountBand; window_days: number | null };
  /** Chunks search cannot fully see (ops-mode, index-backed: `lower_bound` when some states were not counted). */
  unsearchable: { band: CountBand; lower_bound: boolean };
  /** Live pages whose canonical file is gone on the owner host; `reason` when not counted here (for example not_owner_host). */
  ghost_pages: { band: CountBand; reason?: string };
  /** #6858: sources whose managed sync run has been blocked on a page longer than the doctor `managed_sync_blocked` threshold. */
  sync_blocked: { band: CountBand };
  /** The read-only command an operator runs on the brain host for the full report. */
  host_command: string[];
}

const cache = new WeakMap<BrainEngine, Map<string, { at: number; value: Promise<BrainHealthBands> }>>();

/** `sourceIds`: the sources this caller may read (undefined: every source). */
export function readBrainHealthBands(engine: BrainEngine, opts: { sourceIds?: string[] } = {}, now = Date.now()): Promise<BrainHealthBands> {
  const key = opts.sourceIds ? [...opts.sourceIds].sort().join('\u0000') : '*';
  const perEngine = cache.get(engine) ?? new Map();
  cache.set(engine, perEngine);
  const hit = perEngine.get(key);
  if (hit && now - hit.at < BRAIN_HEALTH_TTL_MS) return hit.value;
  const value = computeBands(engine, opts.sourceIds);
  perEngine.set(key, { at: now, value });
  return value;
}

async function computeBands(engine: BrainEngine, sourceIds: string[] | undefined): Promise<BrainHealthBands> {
  const [capacity, failures, unsearchable, ghostPages, syncBlocked] = await Promise.all([
    Promise.all([cachedCapacitySnapshot(engine), readCapacityThresholds(engine)])
      .then(([snapshot, thresholds]) => snapshot.status !== 'ok'
        ? { capacity: 'unknown' as const, days: 'unknown' as const, max_pct_band: 'unknown' as const, forecast: 'unavailable' as const }
        : { ...capacityBands(snapshot, thresholds), forecast: 'available' as const })
      .catch(() => ({ capacity: 'unknown' as const, days: 'unknown' as const, max_pct_band: 'unknown' as const, forecast: 'unavailable' as const })),
    cachedTerminalSummary(engine).then((summary) => {
      if (summary.status !== 'ok') return { band: 'unknown' as const, active_blockers: 'unknown' as const, window_days: null };
      const visible = summary.sources.filter((s) => !sourceIds || sourceIds.includes(s.source_id));
      return { band: countBand(visible.reduce((n, s) => n + s.unresolved.rows, 0)), active_blockers: countBand(visible.reduce((n, s) => n + s.active_blockers.length, 0)),
        window_days: summary.window_days };
    }),
    readEmbeddingState(engine, { mode: 'ops', ...(sourceIds ? { sourceIds } : {}) })
      .then((state) => state.status === 'unknown' ? { band: 'unknown' as const, lower_bound: false } : { band: countBand(state.unsearchable), lower_bound: state.unsearchable_complete === false })
      .catch(() => ({ band: 'unknown' as const, lower_bound: false })),
    readGhostPages(engine, { sampleLimit: 0, ...(sourceIds ? { sourceIds } : {}) })
      .then((g): { band: CountBand; reason?: string } => g.status === 'known' ? { band: countBand(g.count) } : { band: 'unknown', ...(g.reason ? { reason: g.reason } : {}) })
      .catch(() => ({ band: 'unknown' as const })),
    readBlockedManagedSyncs(engine, sourceIds)
      .then((blocked): { band: CountBand } => ({ band: countBand(new Set(blocked.filter(b => Date.now() - Date.parse(b.blocked_since) > MANAGED_SYNC_BLOCKED_FAIL_MS).map(b => b.source_id)).size) }))
      .catch(() => ({ band: 'unknown' as const })),
  ]);
  const bands = { capacity: { band: capacity.capacity, days: capacity.days, max_pct_band: capacity.max_pct_band, forecast: capacity.forecast }, write_failures: failures, unsearchable, ghost_pages: ghostPages,
    sync_blocked: syncBlocked };
  const unknown = bands.capacity.band === 'unknown' || failures.band === 'unknown';
  const attention = bands.capacity.band === 'low' || bands.capacity.band === 'critical' || (failures.active_blockers !== 'none' && failures.active_blockers !== 'unknown')
    || (ghostPages.band !== 'none' && ghostPages.band !== 'unknown') || (syncBlocked.band !== 'none' && syncBlocked.band !== 'unknown');
  return { schema_version: 1, status: attention ? 'attention' : unknown ? 'unknown' : 'ok', ...bands, host_command: ['gbrain', 'doctor', '--tier', 'ops', '--json'] };
}
