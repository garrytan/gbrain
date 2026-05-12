/**
 * eval-contradictions/judge-errors — first-class judge error collection.
 *
 * Codex caught a real bug: per-pair skip on judge throws (the C2 decision)
 * biases the headline number downward IF errors cluster around messy
 * contradiction-like pairs. The fix is to count errors in the denominator
 * and surface them with a typed reason in the output, not bury them in stderr.
 *
 * The `note` field on the counts block is for the human reader of the JSON.
 * It says explicitly that errors are counted, not hidden.
 */

import type { JudgeErrorKind, JudgeErrorRow, JudgeErrorsCounts } from './types.ts';

const ERROR_NOTE =
  'errors counted toward denominator; do not silently disappear from the report';

/** Classify a thrown error into one of the typed kinds. Conservative; defaults to 'unknown'. */
export function classifyError(err: unknown): JudgeErrorKind {
  if (!err || typeof err !== 'object') return 'unknown';
  const msg = (err as Error).message?.toLowerCase?.() ?? '';
  if (msg.includes('parse') || msg.includes('json') || msg.includes('repair')) {
    return 'parse_fail';
  }
  if (msg.includes('refus') || msg.includes("can't help") || msg.includes('cannot help')) {
    return 'refusal';
  }
  if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('aborted')) {
    return 'timeout';
  }
  if (
    msg.includes('500') ||
    msg.includes('502') ||
    msg.includes('503') ||
    msg.includes('504') ||
    msg.includes('overload')
  ) {
    return 'http_5xx';
  }
  return 'unknown';
}

/** Mutable collector. Calling code pushes rows; finalize() returns the counts block. */
export class JudgeErrorCollector {
  private rows: JudgeErrorRow[] = [];

  record(pairId: string, err: unknown): void {
    const kind = classifyError(err);
    const reason = err instanceof Error ? err.message : String(err);
    this.rows.push({ kind, pair_id: pairId, reason });
  }

  rowsOut(): readonly JudgeErrorRow[] {
    return this.rows;
  }

  finalize(): JudgeErrorsCounts {
    const counts: JudgeErrorsCounts = {
      parse_fail: 0,
      refusal: 0,
      timeout: 0,
      http_5xx: 0,
      unknown: 0,
      total: 0,
      note: ERROR_NOTE,
    };
    for (const row of this.rows) {
      counts[row.kind]++;
      counts.total++;
    }
    return counts;
  }
}
