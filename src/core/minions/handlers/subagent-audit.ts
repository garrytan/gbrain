/**
 * Subagent audit + heartbeat log. JSONL, file-rotated weekly, best-effort.
 *
 * Two event flavors:
 *   - submission: one line per subagent job submit (mirrors shell-audit).
 *   - heartbeat:  one line per LLM turn boundary (started / completed) so
 *                 `gbrain agent logs <job> --follow` has fresh content to
 *                 show during long Anthropic calls. Without these, a
 *                 30-second model call produces zero output between turns
 *                 and --follow looks frozen.
 *
 * Never logs prompts, tool inputs, or full tool outputs (PII risk — input
 * vars may contain emails, free text from the user, etc.). DO log
 * non-identifying operational fields: tokens, duration, model, tool_name.
 *
 * `GBRAIN_AUDIT_DIR` overrides the default ~/.gbrain/audit/ path — useful
 * for container deploys with a read-only $HOME.
 *
 * 2026-05-16 refactored to use the shared `createAuditLogger` primitive
 * from `~/Projects/gbrain/src/core/audit-jsonl.ts`. Two event types share
 * one logger via union type; `readSubagentAuditForJob` is a thin filter
 * on top of `logger.readRecent`.
 */

import { createAuditLogger, computeIsoWeekFilename } from '../../audit-jsonl.ts';

export interface SubagentSubmissionEvent {
  ts: string;
  type: 'submission';
  caller: 'cli' | 'mcp' | 'worker';
  remote: boolean;
  job_id: number;
  parent_job_id?: number | null;
  model?: string;
  tools_count?: number;
  allowed_tools?: string[];
}

export interface SubagentHeartbeatEvent {
  ts: string;
  type: 'heartbeat';
  job_id: number;
  event: 'llm_call_started' | 'llm_call_completed' | 'tool_called' | 'tool_result' | 'tool_failed';
  turn_idx: number;
  /** Tool name for tool_* events. Never the input — that may contain secrets. */
  tool_name?: string;
  /** ms elapsed for *_completed / tool_result / tool_failed. */
  ms_elapsed?: number;
  /** Token rollup for llm_call_completed. Per-turn, not cumulative. */
  tokens?: { in?: number; out?: number; cache_read?: number; cache_create?: number };
  /** Short error text for tool_failed. First 200 chars. */
  error?: string;
}

export type SubagentAuditEvent = SubagentSubmissionEvent | SubagentHeartbeatEvent;

const logger = createAuditLogger<SubagentAuditEvent>({
  prefix: 'subagent-jobs',
  stderrTag: '[subagent-audit]',
  continueMessage: 'job continues',
  // Defensive: trim heartbeat error text to avoid huge stack traces in audit.
  // Type narrowing via discriminator before touching the heartbeat-only field.
  transform: (event) => {
    if (event.type === 'heartbeat') {
      // Now safely narrowed to SubagentHeartbeatEvent (minus ts).
      const hb = event as Omit<SubagentHeartbeatEvent, 'ts'>;
      if (hb.error) {
        return { ...hb, error: hb.error.slice(0, 200) };
      }
    }
    return event;
  },
});

/** File name, rotated by ISO week. `subagent-jobs-YYYY-Www.jsonl`. */
export function computeSubagentAuditFilename(now: Date = new Date()): string {
  return computeIsoWeekFilename('subagent-jobs', now);
}

/** Low-level append. Best-effort; write failure goes to stderr + keep running. */
function append(event: SubagentAuditEvent): void {
  // The factory's log() takes Omit<T, 'ts'>; convert by destructuring ts off.
  // We accept SubagentAuditEvent (with ts) here because the legacy callers
  // construct it that way. Adjust to the factory's contract.
  const { ts: _ts, ...rest } = event;
  void _ts;
  logger.log(rest as Omit<SubagentAuditEvent, 'ts'>);
}

export function logSubagentSubmission(event: Omit<SubagentSubmissionEvent, 'ts' | 'type'>): void {
  logger.log({ ...event, type: 'submission' });
}

export function logSubagentHeartbeat(event: Omit<SubagentHeartbeatEvent, 'ts' | 'type'>): void {
  logger.log({ ...event, type: 'heartbeat' });
}

/**
 * Read back all audit events for a job id from the current + prior week
 * files. Used by `gbrain agent logs <job>`. Returns chronological order.
 *
 * `sinceIso` (if present) filters to events with ts >= sinceIso.
 *
 * Implementation: thin filter over the factory's 14-day-window readRecent.
 * Factory returns newest-first; this function re-sorts to oldest-first
 * per existing API contract.
 */
export function readSubagentAuditForJob(jobId: number, opts: { sinceIso?: string } = {}): SubagentAuditEvent[] {
  // 14 days covers current + prior ISO week boundary cases the old code
  // handled explicitly. The factory's prefix-scoped reads handle the
  // walk-multiple-files concern.
  const all = logger.readRecent(14);
  return all
    .filter((ev) => (ev as { job_id?: number }).job_id === jobId)
    .filter((ev) => !opts.sinceIso || ev.ts >= opts.sinceIso)
    .sort((a, b) => a.ts.localeCompare(b.ts)); // oldest-first per API
}

/** Exported for unit tests. */
export const __testing = {
  append,
};
