/**
 * v0.38 Slice 3 — D4 — JSONL audit for `submit_agent` MCP op.
 *
 * Mirrors `shell-audit.ts`: weekly-rotated JSONL at
 * `~/.gbrain/audit/agent-jobs-YYYY-Www.jsonl` (override via
 * `GBRAIN_AUDIT_DIR`). Best-effort writes — disk-full / permission errors
 * go to stderr and do not block dispatch.
 *
 * What we log (every submit_agent call):
 *   - ts: ISO 8601 UTC
 *   - client_id: the OAuth client that submitted
 *   - model: the resolved provider:model string
 *   - bound_tools: the (filtered) tools the agent could call
 *   - bound_source: the bound source_id from the client's registration
 *   - slug_prefixes: the put_page namespace allowlist
 *   - max_concurrent: cap from the binding row
 *   - budget_remaining_cents: pre-call remaining headroom (informational)
 *   - prompt_summary: redacted via summarizeMcpParams (declared-keys only +
 *     approximate byte count) — the prompt text itself never lands in the
 *     audit trail.
 *   - outcome: 'submitted' on the initial row; subsequent rows can be
 *     written by the worker on terminal states (deferred to follow-up).
 *
 * Privacy: the prompt is the most sensitive field and is hashed via
 * `summarizeMcpParams`. tools + slug_prefixes are user-declared identifiers,
 * not content, so they're fine to log verbatim. Audit file mode is the
 * process umask (typically 644) — operators should treat the audit dir
 * the same way they treat ~/.gbrain (private).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { gbrainPath } from '../config.ts';

export interface AgentAuditEvent {
  ts: string;
  client_id: string;
  job_id: number;
  model: string;
  bound_tools: string[];
  bound_source: string | null;
  slug_prefixes: string[];
  max_concurrent: number;
  budget_remaining_cents: number | null;
  prompt_byte_count: number;
  outcome: 'submitted' | 'completed' | 'failed' | 'budget_exceeded' | 'aborted';
  final_spend_cents?: number;
  error_summary?: string;
}

/** Compute `agent-jobs-YYYY-Www.jsonl` using ISO-8601 week numbering. */
export function computeAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon=0, Sun=6
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // shift to Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `agent-jobs-${isoYear}-W${ww}.jsonl`;
}

function resolveAuditDir(): string {
  const env = process.env.GBRAIN_AUDIT_DIR;
  if (env && env.trim()) return env.trim();
  return gbrainPath('audit');
}

/** Append one event. Best-effort; logs to stderr on failure. */
export function logAgentSubmission(event: Omit<AgentAuditEvent, 'ts'>): void {
  const fullEvent: AgentAuditEvent = {
    ts: new Date().toISOString(),
    ...event,
  };
  try {
    const dir = resolveAuditDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, computeAuditFilename());
    fs.appendFileSync(file, JSON.stringify(fullEvent) + '\n', 'utf8');
  } catch (err) {
    process.stderr.write(
      `[agent-audit] failed to write submission event for job ${event.job_id}: ` +
      `${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

/** Read recent events across files (for `gbrain doctor` integrations + tests). */
export function readRecentAgentEvents(days: number, now: Date = new Date()): AgentAuditEvent[] {
  const dir = resolveAuditDir();
  if (!fs.existsSync(dir)) return [];
  const cutoff = new Date(now.getTime() - days * 86400000);
  const events: AgentAuditEvent[] = [];
  try {
    const files = fs.readdirSync(dir).filter(f => f.startsWith('agent-jobs-') && f.endsWith('.jsonl'));
    for (const f of files) {
      const filePath = path.join(dir, f);
      const stat = fs.statSync(filePath);
      // Skip files older than (cutoff - 14 days) — gives a buffer for the ISO week boundary.
      if (stat.mtime < new Date(cutoff.getTime() - 14 * 86400000)) continue;
      const content = fs.readFileSync(filePath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line) as AgentAuditEvent;
          const evDate = new Date(ev.ts);
          if (evDate >= cutoff) events.push(ev);
        } catch {
          // Skip malformed lines.
        }
      }
    }
  } catch (err) {
    process.stderr.write(
      `[agent-audit] failed to read recent events: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  // Newest first.
  events.sort((a, b) => b.ts.localeCompare(a.ts));
  return events;
}
