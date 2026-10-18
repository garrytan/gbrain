import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { capacityDiagnostics } from '../../../core/persistence/diagnostics.ts';
import { oneYearCapacity, readJournalLimits } from '../../../core/persistence/limits.ts';
import type { CapacityForecast } from '../../../core/persistence/capacity-forecast.ts';
import { doctorCapacityForecast, forecastOrNull } from '../capacity-memo.ts';
import { capacityVerify } from '../../../core/persistence/capacity-view.ts';
import { BACKGROUND_PRODUCERS, readBackgroundPauseShare } from '../../../core/persistence/admission-origin.ts';

const VERIFY = 'gbrain doctor --only persistence_capacity --json';
const DOCS = 'docs/guides/concurrent-writes.md#quota-near-exhaustion';

/**
 * #5470/#6696 (A3): a cumulative managed-write cap (permanent request IDs,
 * receipt bytes) is a warning when it is at 80% or would refuse admission
 * within `persistence.capacity.warn_days` (30) at its 7-day rate, and a
 * failure at 95% or within `persistence.capacity.fail_days` (7). The rate is
 * the full 7-day aggregate (capacity-forecast.ts); receipt bytes forecast at
 * their compacted (net) size. Each key gets the one value that covers a year.
 * A scope past the background pause line (A5) names the producers it pauses.
 * The fix verifies through doctor and the read-scope `get_brain_health` band (#6696 B2).
 */
export async function checkPersistenceCapacity(engine: BrainEngine): Promise<Check> {
  try {
    const counters = await engine.executeRaw<{ key: string; outstanding_count: string; intent_bytes: string; lifetime_ids: string;
      terminal_bytes: string; recovery_bytes: string }>(`SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,
      terminal_bytes::text,recovery_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key`);
    const limits = await readJournalLimits(engine);
    const forecast: CapacityForecast | null = await doctorCapacityForecast(engine, { limits }).catch(forecastOrNull);
    const pause = await readBackgroundPauseShare(engine);
    const cumulative = capacityDiagnostics(counters, limits).filter(row => row.resource === 'lifetime_ids' || row.resource === 'terminal_bytes');
    const resources = [];
    const needed = new Map<string, number>();
    let worst: 'ok' | 'warn' | 'fail' = 'ok';
    for (const row of cumulative) {
      const predicted = forecast?.rows.find(f => f.scope === row.scope && f.resource === row.resource);
      const paused = row.used >= Math.floor(row.limit * pause);
      const predictedStatus = predicted?.status ?? (row.approaching_capacity ? 'warn' : 'ok');
      const status = paused && predictedStatus === 'ok' ? 'warn' : predictedStatus;
      if (status === 'ok') continue;
      if (status === 'fail' || worst === 'ok') worst = status;
      // No admission inside the window: the latest admissions, however old, size the year instead.
      const value = predicted && predicted.per_day_7d > 0 ? predicted.recommended_limit
        : await oneYearCapacity(engine, row.scope, row.resource === 'lifetime_ids' ? 'LifetimeIds' : 'TerminalBytes', row.used, row.limit);
      resources.push({ scope: row.scope, resource: row.resource, used: row.used, limit: row.limit, config_key: row.config_key, status, background_paused: paused,
        ...(predicted ? { pct: predicted.pct, days_to_exhaustion: predicted.days_to_exhaustion, exhaustion_date: predicted.exhaustion_date, basis: predicted.basis,
          per_day_7d: predicted.per_day_7d, ...(predicted.net_per_day_7d !== undefined ? { net_per_day_7d: predicted.net_per_day_7d } : {}),
          ...(predicted.reclaimable_bytes !== undefined ? { reclaimable_bytes: predicted.reclaimable_bytes } : {}) } : {}) });
      // Every principal shares one brain-wide key, so each key gets the largest value any scope needs.
      needed.set(row.config_key, Math.max(needed.get(row.config_key) ?? 0, value));
    }
    const anyPaused = resources.some(r => r.background_paused);
    const commands = [...needed].map(([key, value]) => `gbrain config set ${key} ${value}`);
    const details = { exact: true, inspected: counters.length, truncated: false, resources, commands, verify: VERIFY, docs: DOCS,
      background_pause_pct: Math.round(pause * 100), paused_producers: anyPaused ? [...BACKGROUND_PRODUCERS] : [],
      forecast: forecast ? { thresholds: forecast.thresholds, window_days: forecast.window_days, retention_days: forecast.retention_days,
        table_bytes: forecast.table_bytes, rows: forecast.rows } : { health: 'unknown' } };
    const thresholds = forecast?.thresholds;
    if (!resources.length) return { name: 'persistence_capacity', status: 'ok', details,
      message: thresholds ? `Managed write capacity is below ${thresholds.warn_pct}% of every cumulative limit and none runs out within ${thresholds.warn_days} days at its 7-day rate.`
        : 'Managed write capacity is below 80% of every cumulative limit.' };
    const [first] = [...needed];
    return { name: 'persistence_capacity', status: worst, details,
      fix: { argv: ['gbrain', 'config', 'set', first![0], String(first![1])], consent: [], actor: 'host_admin', requires_exclusive: false,
        verify: capacityVerify(), docs: DOCS,
        why: `Raises ${first![0]} to a value that covers about one more year at the 7-day rate; reversible with gbrain config unset.${commands.length > 1 ? ` Also run: ${commands.slice(1).join('; ')}.` : ''}` },
      message: `${resources.length} managed write limit(s) near exhaustion: ${resources.map(r => `${r.scope} ${r.resource} ${r.used}/${r.limit}`
        + ('days_to_exhaustion' in r && r.days_to_exhaustion !== null ? ` (about ${r.days_to_exhaustion} day(s) left at the 7-day rate, ${r.basis})` : '')).join('; ')}. `
        + `Admission refuses at the limit. Run on the brain host: ${commands.join('; ')} (each covers about one more year at the current admission rate), `
        + `then verify with ${VERIFY}. Permanent request IDs are never evicted.`
        + (anyPaused ? ` Background writes are paused past ${Math.round(pause * 100)}% (write_capacity_backpressure): ${BACKGROUND_PRODUCERS.join(', ')}; interactive writes keep the rest.` : '') };
  } catch (error) {
    return { name: 'persistence_capacity', status: 'warn',
      message: `Managed write capacity could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { exact: false, inspected: 0, truncated: true, health: 'unknown' } };
  }
}
