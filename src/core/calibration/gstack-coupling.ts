/**
 * v0.36.1.0 (T11 / E4) — gstack-learnings coupling.
 *
 * When the grade_takes phase auto-resolves a take as 'incorrect' (or
 * 'partial' — partial wrongs are weaker signal but still worth recording),
 * write a learning entry to gstack's per-project learnings.jsonl so other
 * gstack skills (plan-ceo-review, ship, investigate, ...) can pull it as
 * context when relevant.
 *
 * Config gate (D5 + CDX-17 mitigation):
 *   `cycle.grade_takes.write_gstack_learnings` — default false for safety
 *   (external users may not have gstack installed, and the gstack-learnings
 *   API isn't stable yet). Garry's brain flips it true to opt in.
 *
 * Write path (graceful degrade):
 *   1. Honor config gate — bail when flag is false.
 *   2. Locate gstack-learnings-log binary on PATH via execFileSync('which').
 *   3. Shell out with structured args. Best-effort: failures log a warning
 *      and DO NOT throw — calibration data writes are independent of gstack.
 *
 * Namespace:
 *   Every entry's `key` starts with 'gbrain:calibration:v0.36.1.0:' so an
 *   `--undo-wave v0.36.1.0` can later prune these via
 *   `gstack-learnings-prune` (Lane D / T17).
 */

import { execFileSync } from 'node:child_process';
import { GBrainError } from '../types.ts';

export interface IncorrectResolutionEvent {
  /** Take that resolved incorrect/partial. */
  takeId: number;
  pageSlug: string;
  rowNum: number;
  /** Holder of the take (e.g. 'garry'). */
  holder: string;
  /** The claim text (truncated to ~200 chars). */
  claim: string;
  /** Quality the grade phase wrote: 'incorrect' or 'partial'. */
  quality: 'incorrect' | 'partial';
  /** Original conviction-weight at the time of the take. */
  weight: number;
  /** Optional active bias tags from the calibration profile (correlate the learning to the pattern). */
  activeBiasTags?: string[];
  /** Optional confidence the grade phase recorded. */
  confidence?: number;
  /** Optional reasoning the judge model produced. */
  reasoning?: string;
}

/** Wire shape sent to gstack-learnings-log via stdin (matches the binary's CLI). */
export interface GstackLearningEntry {
  skill: string;
  type: 'observation';
  key: string;
  insight: string;
  confidence: number;
  source: 'observed';
  files?: string[];
}

/**
 * Test seam: replace the actual gstack-binary call. Production path uses
 * execFileSync; tests pass a stub.
 */
export type GstackWriter = (entry: GstackLearningEntry) => Promise<void> | void;

/** v0.36.1.0 — namespace prefix. Lane D `--undo-wave` filters on this. */
export const GSTACK_LEARNING_NAMESPACE = 'gbrain:calibration:v0.36.1.0:';

/** Build the learning entry from a resolution event. Pure. */
export function buildLearningEntry(event: IncorrectResolutionEvent): GstackLearningEntry {
  const truncatedClaim = event.claim.length > 200 ? event.claim.slice(0, 200) + '…' : event.claim;
  const tagSuffix = event.activeBiasTags && event.activeBiasTags.length > 0
    ? `:${event.activeBiasTags[0]}`
    : '';
  const insightLead = event.quality === 'incorrect' ? 'was wrong' : 'was partially wrong';
  const reasoningTail = event.reasoning ? ` Reasoning: ${event.reasoning.slice(0, 200)}` : '';
  const tagTail = event.activeBiasTags && event.activeBiasTags.length > 0
    ? ` Pattern: ${event.activeBiasTags.join(', ')}.`
    : '';
  return {
    skill: 'gbrain-calibration',
    type: 'observation',
    key: `${GSTACK_LEARNING_NAMESPACE}take-${event.takeId}${tagSuffix}`,
    insight:
      `${event.holder} ${insightLead} on "${truncatedClaim}" ` +
      `(conviction ${event.weight.toFixed(2)}, graded ${event.quality}).${tagTail}${reasoningTail}`,
    confidence: typeof event.confidence === 'number' ? event.confidence : 0.8,
    source: 'observed',
    files: [event.pageSlug],
  };
}

/**
 * Production writer: shell out to gstack-learnings-log if it's on PATH.
 * Returns silently on success. Throws on hard failure so the caller can
 * decide whether to log or continue.
 */
export function defaultGstackWriter(entry: GstackLearningEntry): void {
  // Locate the binary. `which` is portable across macOS / Linux.
  let binaryPath: string;
  try {
    binaryPath = execFileSync('which', ['gstack-learnings-log'], { encoding: 'utf8' }).trim();
  } catch {
    throw new GBrainError(
      'GSTACK_BINARY_NOT_FOUND',
      'gstack-learnings-log binary not on PATH',
      'install gstack (~/.claude/skills/gstack/setup) or set cycle.grade_takes.write_gstack_learnings: false to disable',
    );
  }
  if (!binaryPath) {
    throw new GBrainError(
      'GSTACK_BINARY_NOT_FOUND',
      'gstack-learnings-log resolved to empty path',
      'install gstack (~/.claude/skills/gstack/setup) or disable via config',
    );
  }
  // Send the JSON entry as argv[1] per gstack-learnings-log convention.
  // Falls back to stdin if argv is too long; keep entry small enough that
  // argv is always sufficient.
  execFileSync(binaryPath, [JSON.stringify(entry)], { encoding: 'utf8', timeout: 5000 });
}

export interface WriteIncorrectResolutionOpts {
  event: IncorrectResolutionEvent;
  /** Config gate — must be `true` for the write to proceed. */
  enabled: boolean;
  /** Test seam: override the writer. Production omits this. */
  writer?: GstackWriter;
}

export interface WriteIncorrectResolutionResult {
  written: boolean;
  /** Why the write was skipped (when written=false). */
  reason?: 'config_disabled' | 'binary_missing' | 'write_failed' | 'quality_not_eligible';
  /** Error message when reason='write_failed' or 'binary_missing'. */
  error?: string;
}

/**
 * Main entry point. Honors config gate. Writes via the gstack binary (or
 * test-injected writer). Always succeeds: failures log a warning to the
 * returned result and continue.
 */
export async function writeIncorrectResolution(
  opts: WriteIncorrectResolutionOpts,
): Promise<WriteIncorrectResolutionResult> {
  if (!opts.enabled) {
    return { written: false, reason: 'config_disabled' };
  }
  if (opts.event.quality !== 'incorrect' && opts.event.quality !== 'partial') {
    return { written: false, reason: 'quality_not_eligible' };
  }
  const entry = buildLearningEntry(opts.event);
  const writer = opts.writer ?? defaultGstackWriter;
  try {
    await writer(entry);
    return { written: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    const reason = error.includes('not on PATH') || error.includes('NOT_FOUND')
      ? 'binary_missing'
      : 'write_failed';
    return { written: false, reason, error };
  }
}
