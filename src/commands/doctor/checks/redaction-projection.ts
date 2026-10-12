/**
 * redaction_projection_pending doctor check: the chunks were cut under a
 * different `redaction.projection_classes` list than the policy names now
 * (the re-seal that `gbrain config set` runs did not complete, or the key was
 * written by another path). Until the re-seal runs, chunks, embeddings and
 * evidence of matching pages carry the old projection.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { REDACTION_CONFIG_KEYS } from '../../../core/redaction-policy.ts';
import { redactionProjectionState } from '../../../core/page-state/redaction-reseal.ts';

export async function redactionProjectionPendingCheck(engine: BrainEngine): Promise<Check> {
  const name = 'redaction_projection_pending';
  try {
    const state = await redactionProjectionState(engine);
    const details = { sealed_classes: state.sealed, policy_classes: state.wanted, pending: state.pending ? 1 : 0, count: 'exact', truncated: false };
    if (!state.pending) return { name, status: 'ok', details, message: state.wanted.length ? `Chunks are cut with the redaction classes the policy names (${state.wanted.join(', ')}).` : 'No redaction projection class is set; chunks carry the stored text (private keys excepted).' };
    const value = state.wanted.join(',') || 'none';
    return { name, status: 'warn', details, message: `Chunks were cut with redaction classes [${state.sealed.join(', ') || 'none'}] but the policy names [${state.wanted.join(', ') || 'none'}]. `
      + `Run \`gbrain config set ${REDACTION_CONFIG_KEYS.projection} ${value}\` on the brain host to re-seal (no provider calls), then \`gbrain embed --stale\`.` };
  } catch (error) {
    return { name, status: 'warn', message: `Redaction projection state could not be read: ${error instanceof Error ? error.message : String(error)}. Health is unknown.`,
      details: { count: 'unknown', truncated: true, health: 'unknown' } };
  }
}
