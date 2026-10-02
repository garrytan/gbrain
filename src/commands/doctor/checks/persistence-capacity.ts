import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { capacityDiagnostics } from '../../../core/persistence/diagnostics.ts';
import { oneYearCapacity, readJournalLimits } from '../../../core/persistence/limits.ts';

/**
 * #5470: warn at 80% of a cumulative managed-write cap (permanent request IDs,
 * receipt bytes) before admission refuses. Transient caps drain on their own.
 * Bounded: one indexed read per counter row (brain plus each principal).
 */
export async function checkPersistenceCapacity(engine: BrainEngine): Promise<Check> {
  try {
    const counters = await engine.executeRaw<{ key: string; outstanding_count: string; intent_bytes: string; lifetime_ids: string;
      terminal_bytes: string; recovery_bytes: string }>(`SELECT key,outstanding_count::text,intent_bytes::text,lifetime_ids::text,
      terminal_bytes::text,recovery_bytes::text FROM persistence_counters WHERE key='brain' OR key LIKE 'principal:%' ORDER BY key`);
    const limits = await readJournalLimits(engine);
    const near = capacityDiagnostics(counters, limits)
      .filter(row => row.approaching_capacity && (row.resource === 'lifetime_ids' || row.resource === 'terminal_bytes'));
    const resources = [];
    const needed = new Map<string, number>();
    for (const row of near) {
      const value = await oneYearCapacity(engine, row.scope, row.resource === 'lifetime_ids' ? 'LifetimeIds' : 'TerminalBytes', row.used, row.limit);
      resources.push({ scope: row.scope, resource: row.resource, used: row.used, limit: row.limit, config_key: row.config_key });
      needed.set(row.config_key, Math.max(needed.get(row.config_key) ?? 0, value));
    }
    // Every principal shares one brain-wide key, so each key gets the largest value any scope needs.
    const commands = [...needed].map(([key, value]) => `gbrain config set ${key} ${value}`);
    const details = { exact: true, inspected: counters.length, truncated: false, resources, commands };
    if (!resources.length) return { name: 'persistence_capacity', status: 'ok', message: 'Managed write capacity is below 80% of every cumulative limit.', details };
    return { name: 'persistence_capacity', status: 'warn', details,
      message: `${resources.length} managed write limit(s) at or above 80%: ${resources.map(r =>
        `${r.scope} ${r.resource} ${r.used}/${r.limit}`).join('; ')}. Admission refuses at the limit. Run on the brain host: ${commands.join('; ')} ` +
        '(each covers about one more year at the current admission rate). This is a mitigation: permanent request IDs are never evicted.' };
  } catch (error) {
    return { name: 'persistence_capacity', status: 'warn',
      message: `Managed write capacity could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { exact: false, inspected: 0, truncated: true, health: 'unknown' } };
  }
}
