/**
 * embedding_restamp_stalled (W3, GBRA-224): the free signature restamp
 * (core/embedding-restamp.ts) failed EMBEDDING_RESTAMP_FAILURE_BOUND runs in a
 * row. Read-only, from the heal audit; page class for doctor --alert. Pages
 * whose vectors already match the current model keep reading as another
 * model's space until it runs clean.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { EMBEDDING_RESTAMP_ENABLED_KEY, EMBEDDING_RESTAMP_FAILURE_BOUND, restampEscalation } from '../../../core/embedding-restamp.ts';
import { healEnabled } from '../../../core/heal-audit.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';

export async function embeddingRestampStalledCheck(engine: BrainEngine): Promise<Check> {
  const enabled = await healEnabled(engine, EMBEDDING_RESTAMP_ENABLED_KEY);
  const escalation = enabled ? await restampEscalation(engine) : null;
  const details = { enabled, bound: EMBEDDING_RESTAMP_FAILURE_BOUND, ...(escalation ? { last: escalation } : {}) };
  if (!escalation) {
    return { name: 'embedding_restamp_stalled', status: 'ok',
      message: enabled ? 'The embedding signature restamp is running clean' : `The embedding signature restamp is off (${EMBEDDING_RESTAMP_ENABLED_KEY}=false)`, details };
  }
  return { name: 'embedding_restamp_stalled', status: 'warn',
    message: `The free embedding signature restamp failed ${escalation.attempt} maintenance runs in a row (bound ${EMBEDDING_RESTAMP_FAILURE_BOUND}); last error: ${escalation.detail ?? 'unknown'}. `
      + `Pages whose vectors already match ${escalation.subject} keep reading as another model's space until it runs clean. Fix the error, then run the embed phase once; `
      + `${EMBEDDING_RESTAMP_ENABLED_KEY}=false turns the restamp off.`,
    details, fix: agentFix(['gbrain', 'dream', '--phase', 'embed', '--json'], 'Runs the embed phase, which restamps first; free for the restamp itself, and embeds any stale chunks with the configured provider.', 'embedding_restamp_stalled') };
}
