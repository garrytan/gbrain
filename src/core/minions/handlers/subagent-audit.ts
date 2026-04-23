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
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './shell-audit.ts';

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

/** File name, rotated by ISO week. `subagent-jobs-YYYY-Www.jsonl`. */
export function computeSubagentAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `subagent-jobs-${isoYear}-W${ww}.jsonl`;
}

/** Low-level append. Best-effort; write failure goes to stderr + keep running. */
function append(event: SubagentAuditEvent): void {
  const dir = resolveAuditDir();
  const file = path.join(dir, computeSubagentAuditFilename());
  const line = JSON.stringify(event) + '\n';
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, line, { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[subagent-audit] write failed (${msg}); job continues\n`);
  }
}

export function logSubagentSubmission(event: Omit<SubagentSubmissionEvent, 'ts' | 'type'>): void {
  append({ ...event, ts: new Date().toISOString(), type: 'submission' });
}

export function logSubagentHeartbeat(event: Omit<SubagentHeartbeatEvent, 'ts' | 'type'>): void {
  // Defensive: trim error text to avoid accidentally writing huge stack traces.
  const trimmed = event.error ? { ...event, error: event.error.slice(0, 200) } : event;
  append({ ...trimmed, ts: new Date().toISOString(), type: 'heartbeat' });
}

/**
 * Read back all audit events for a job id from the current + prior week
 * files. Used by `gbrain agent logs <job>`. Returns chronological order.
 *
 * `sinceIso` (if present) filters to events with ts >= sinceIso.
 */
export function readSubagentAuditForJob(jobId: number, opts: { sinceIso?: string } = {}): SubagentAuditEvent[] {
  const dir = resolveAuditDir();
  if (!fs.existsSync(dir)) return [];

  const now = new Date();
  const thisWeek = computeSubagentAuditFilename(now);
  const weekAgo = computeSubagentAuditFilename(new Date(now.getTime() - 7 * 86400000));
  const candidates = [...new Set([weekAgo, thisWeek])];

  const out: SubagentAuditEvent[] = [];
  for (const name of candidates) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line) continue;
      let ev: SubagentAuditEvent;
      try {
        ev = JSON.parse(line) as SubagentAuditEvent;
      } catch {
        continue;
      }
      // Submission events have job_id at top level; heartbeats too. Both safe.
      if ((ev as { job_id?: number }).job_id !== jobId) continue;
      if (opts.sinceIso && ev.ts < opts.sinceIso) continue;
      out.push(ev);
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

/** Exported for unit tests. */
export const __testing = {
  append,
};
