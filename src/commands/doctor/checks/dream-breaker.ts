/**
 * dream_paid_loop: read-only view of the dream paid-loop breaker. Warns when a
 * dream synthesize or patterns key has died at least the breaker limit
 * (`dream.breaker.max_dead_submissions`, default 3) times within 24 hours,
 * using the same counting function the breaker enforces with.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { countDeadDreamSubmissions, dreamBreakerResetCommand, loadDreamBreakerThreshold, DREAM_BREAKER_CONFIG_KEY } from '../../../core/cycle/dream-breaker.ts';
import type { Check } from '../../doctor.ts';

export async function dreamPaidLoopCheck(engine: BrainEngine): Promise<Check> {
  const threshold = await loadDreamBreakerThreshold(engine);
  const rows = await countDeadDreamSubmissions(engine);
  const limit = threshold === 0 ? 3 : threshold;
  const looping = rows.filter(row => row.dead_submissions >= limit);
  const details = { threshold, breaker_enabled: threshold > 0, inspected_keys: rows.length, count_exact: true,
    keys: looping.map(row => ({ key_prefix: row.base_key.startsWith('dream:patterns:') ? 'dream:patterns:' : 'dream:synth-v2:', ...row })) };
  if (looping.length === 0) {
    return { name: 'dream_paid_loop', status: 'ok', message: `No dream key died ${limit}+ times in 24h`, details };
  }
  const shown = looping.slice(0, 3).map(row => `${row.base_key} (${row.dead_submissions}x)`).join('; ');
  const action = threshold === 0
    ? `The breaker is disabled (${DREAM_BREAKER_CONFIG_KEY}=0), so these keys are still being resubmitted.`
    : `The breaker refuses them until reset; fix the cause, then run ${dreamBreakerResetCommand(looping[0]!.base_key)}.`;
  return { name: 'dream_paid_loop', status: 'warn',
    message: `${looping.length} dream key(s) died ${limit}+ times in 24h: ${shown}. ${action}`, details };
}
