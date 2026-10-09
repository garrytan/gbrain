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
    // #6273: timeline writes that were refused, failed or left pending fail the job instead of completing over rows that were never written.
    const pending = result.pages_pending ?? 0;
    if (result.batch_errors > 0 || pending > 0) {
      throw new Error(`extract-timeline-from-meetings: ${result.batch_errors} timeline write(s) refused or failed, ${pending} page(s) left pending ` +
        `(${result.entries_created} row(s) written${result.first_batch_error ? `; first error: ${result.first_batch_error}` : ''}). ` +
        `A rerun writes the rest; written rows are not duplicated.`);
    }
    return result;
  };
}
