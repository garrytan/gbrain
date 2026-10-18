/**
 * `extract-timeline-from-meetings` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * v0.41.18.0 (A11, T8): extract-timeline-from-meetings handler. Wraps
 * extractTimelineFromMeetings. NOT in PROTECTED_JOB_NAMES (pure SQL + string
 * scan, no LLM spend).
 */
export function makeExtractTimelineFromMeetingsHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { extractTimelineFromMeetings } = await import('../../extract-timeline-from-meetings.ts');
    const data = (job.data ?? {}) as { sourceId?: string };
    const result = await extractTimelineFromMeetings(engine, {
      sourceIdFilter: data.sourceId,
    });
    // #6273: a refused or still-pending write is a failed job, never a completed one.
    if (result.batch_errors + (result.pages_pending ?? 0) > 0) {
      throw new Error(`extract-timeline-from-meetings: ${result.batch_errors} write(s) refused, ${result.pages_pending ?? 0} page(s) pending`
        + (result.first_batch_error ? `; first error: ${result.first_batch_error}` : ''));
    }
    return result;
  };
}
