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
    return await extractTimelineFromMeetings(engine, {
      sourceIdFilter: data.sourceId,
    });
  };
}
