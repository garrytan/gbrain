/**
 * What the W6 take-grading eval measured (evals/take-grading/; verdicts in
 * gbrain-evals).
 *
 * `GRADE_TAKES_MEASURED_MODELS`: the judge models that met the preregistered
 * rule on the counted split (evals/take-grading/PREREGISTRATION.md): among
 * verdicts the auto-resolve rule would apply (not `unresolvable`, confidence
 * at or above `GRADE_TAKES_AUTO_RESOLVE_THRESHOLD`), the one-sided 95% upper
 * bound on the wrong share is at most 1%. Measured 2026-10-16 at gbrain
 * d99b84694 (prompt `hybrid-evidence-v2`): gpt-6.1-sol applied 496 of 750
 * verdicts with none wrong (upper bound 0.6%); Sonnet 5.5 (121 applied, 1
 * wrong, 3.9%) and Opus 5.5 (2 applied) did not qualify.
 *
 * Nothing auto-resolves today: the cycle runs grade_takes with auto-resolve
 * off. `gbrain takes grades` marks each cached verdict whose judge is not on
 * this list, so a reviewer knows which verdicts no measurement backs.
 */
import { splitProviderModelId } from '../model-id.ts';

export const GRADE_TAKES_MEASURED_MODELS: readonly string[] = ['openai:gpt-6.1-sol'];

/** The prompt version the measurement used; a verdict asked with another prompt is not measured. */
export const GRADE_TAKES_MEASURED_PROMPT_VERSION = 'hybrid-evidence-v2';

/** True when a cached verdict's judge (a bare model id, as grade_takes stores it) is on the measured list and it was asked with the measured prompt. */
export function gradeJudgeMeasured(judgeModelId: string, promptVersion: string): boolean {
  if (promptVersion !== GRADE_TAKES_MEASURED_PROMPT_VERSION) return false;
  const bare = splitProviderModelId(judgeModelId).model || judgeModelId;
  return GRADE_TAKES_MEASURED_MODELS.some(m => (splitProviderModelId(m).model || m) === bare);
}
