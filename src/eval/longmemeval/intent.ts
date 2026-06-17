/**
 * v0.40.2.0 — LongMemEval intent classifier.
 *
 * Sibling of `src/core/think/intent.ts` with one key addition: it
 * prefers the dataset's `question_type` field (LongMemEval ships these
 * labels populated) before falling back to the shared regex set. For
 * datasets without question_type, the regex fallback is byte-identical
 * to think's classifier — both classifiers SHARE the underlying patterns
 * by importing them. No drift.
 */

import { classifyIntent as classifyByText, type Intent } from '../../core/think/intent.ts';
import type { LongMemEvalQuestion } from './adapter.ts';

export type { Intent };

/**
 * Map LongMemEval's `question_type` field to our 3-bucket Intent.
 *
 * Dataset labels (as of May 2026):
 *   - 'temporal-reasoning'        → temporal
 *   - 'knowledge-update'          → knowledge_update
 *   - 'single-session-user'       → other (general question about one chat)
 *   - 'single-session-assistant'  → other
 *   - 'multi-session'             → other (general multi-session synthesis)
 *   - 'single-session-preference' → other (preference, not chronology)
 *   - any unknown                 → fall through to regex classifier
 */
function mapDatasetQuestionType(qt: string | undefined): Intent | null {
  if (typeof qt !== 'string') return null;
  const lower = qt.trim().toLowerCase();
  if (lower === 'temporal-reasoning') return 'temporal';
  if (lower === 'knowledge-update') return 'knowledge_update';
  if (
    lower === 'single-session-user' ||
    lower === 'single-session-assistant' ||
    lower === 'multi-session' ||
    lower === 'single-session-preference'
  ) {
    return 'other';
  }
  return null;
}

/**
 * Classify a LongMemEval question. Prefers the dataset's
 * `question_type` label when present; falls back to the shared regex
 * classifier otherwise. Returns 'other' for any question that doesn't
 * trigger the routing path.
 */
export function classifyIntent(q: LongMemEvalQuestion): Intent {
  const fromType = mapDatasetQuestionType(q.question_type);
  if (fromType !== null) return fromType;
  return classifyByText(q.question);
}
