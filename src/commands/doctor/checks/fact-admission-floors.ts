/**
 * fact_admission_floors (informational, #6590): whether the brain's embedding
 * model has a measured cosine floor for fact admission. `recall --question`
 * and `query`'s facts arm admit a fact on similarity alone at the absolute
 * floors in `search/fact-relevance.ts` (0.5 for the `reserve` rule, 0.6 for
 * the facts arm). Those floors depend on the model's cosine scale, and no
 * model has a measured floor yet, so on a high-baseline embedder an unrelated
 * question clears them and an empty facts list stops meaning "nothing
 * matched". Always status ok: it says how far to trust an empty list.
 */
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { embeddingsDisabled } from '../../../core/embedding-disabled.ts';
import { calibrationKey } from '../../../core/facts/supersession-threshold.ts';
import { FACT_ADMISSION_FLOOR_EVIDENCE, FACTS_ARM_COSINE_MIN, RESERVE_COSINE_MIN } from '../../../core/search/fact-relevance.ts';

async function runFactAdmissionFloors(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('fact_admission_floors');
  try {
    if (await embeddingsDisabled(engine)) {
      checks.push({ name: 'fact_admission_floors', status: 'ok', severity: 'info', readiness_state: 'not_applicable',
        message: 'Embeddings are off on this brain, so facts are admitted by keyword and named entity only; no cosine floor applies.' });
      return checks;
    }
    const { getEmbeddingModel, getEmbeddingDimensions } = await import('../../../core/ai/gateway.ts');
    const key = calibrationKey(getEmbeddingModel(), getEmbeddingDimensions());
    const evidence = FACT_ADMISSION_FLOOR_EVIDENCE[key];
    const details = { key, reserve_cosine_min: RESERVE_COSINE_MIN, facts_arm_cosine_min: FACTS_ARM_COSINE_MIN, measured: evidence !== undefined, evidence: evidence ?? null };
    if (evidence) {
      checks.push({ name: 'fact_admission_floors', status: 'ok', details,
        message: `Fact admission floors (cosine ${RESERVE_COSINE_MIN} for recall questions, ${FACTS_ARM_COSINE_MIN} for the query facts arm) are measured for ${key} (${evidence}).` });
      return checks;
    }
    checks.push({ name: 'fact_admission_floors', status: 'ok', severity: 'info', readiness_state: 'degraded', details,
      message: `Fact admission floors (cosine ${RESERVE_COSINE_MIN} for recall questions, ${FACTS_ARM_COSINE_MIN} for the query facts arm) are not measured for ${key}. `
        + 'If this model scores unrelated text high, recall --question can return facts for a question nothing answers, so an empty facts list is the reliable signal only on a measured model.' });
  } catch (error) {
    checks.push({ name: 'fact_admission_floors', status: 'ok', severity: 'info', readiness_state: 'unknown',
      message: `Could not resolve the embedding model for the fact admission floors: ${error instanceof Error ? error.message : String(error)}.` });
  }
  return checks;
}

export const factAdmissionFloorsEntry: DoctorEntry = {
  name: 'fact_admission_floors',
  emits: ['fact_admission_floors'],
  run: runFactAdmissionFloors,
};
