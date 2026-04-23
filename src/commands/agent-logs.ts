/**
 * `gbrain agent logs <job_id> [--follow] [--since <spec>]`
 *
 * Reads two sources and merges them chronologically:
 *   - ~/.gbrain/audit/subagent-jobs-*.jsonl  (heartbeat + submission events
 *     — lives on the WORKER's filesystem, so this CLI's effectiveness is
 *     host-local today; see docs/guides/plugin-authors.md caveat #2)
 *   - subagent_messages (DB rows, authoritative for persisted conversation)
 *
 * No new DB tables; all the infrastructure landed in prior Lane commits.
 */

import type { BrainEngine } from '../core/engine.ts';
import { readSubagentAuditForJob } from '../core/minions/handlers/subagent-audit.ts';
import type { SubagentAuditEvent } from '../core/minions/handlers/subagent-audit.ts';
import { loadTranscriptRows, renderTranscript } from '../core/minions/transcript.ts';
import type { SubagentMessageRow } from '../core/minions/transcript.ts';

export interface AgentLogsOpts {
  follow?: boolean;
  /** ISO-8601 timestamp OR relative like "5m" / "1h" / "2d". */
  since?: string;
  /** Override poll interval for --follow. Default 1000ms. */
  pollMs?: number;
  /** Injectable writer for testing; default process.stdout.write. */
  write?: (s: string) => void;
  /** Abort to cut off a --follow loop cleanly (tests + Ctrl-C). */
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'dead', 'cancelled']);

export async function runAgentLogs(
  engine: BrainEngine,
  jobId: number,
  opts: AgentLogsOpts = {},
): Promise<void> {
  const write = opts.write ?? ((s: string) => { process.stdout.write(s); });
  const sinceIso = parseSince(opts.since);

  // Seeded render: dump everything we have right now.
  let lastTs: string | undefined = sinceIso;
  lastTs = await dumpSince(engine, jobId, lastTs, write);

  if (!opts.follow) return;

  const pollMs = opts.pollMs ?? 1000;
  while (!opts.signal?.aborted) {
    await sleep(pollMs, opts.signal);
    lastTs = await dumpSince(engine, jobId, lastTs, write);
    // Break on terminal job status so --follow exits once the run is done.
    const status = await readJobStatus(engine, jobId);
    if (status && TERMINAL_STATUSES.has(status)) {
      write(`\n[gbrain agent] job ${jobId} reached terminal state: ${status}\n`);
      return;
    }
  }
}

/**
 * Dump events with ts >= sinceIso. Returns the max ts seen so the next
 * poll round filters cleanly. When `sinceIso` is undefined on first call,
 * everything is dumped.
 */
async function dumpSince(
  engine: BrainEngine,
  jobId: number,
  sinceIso: string | undefined,
  write: (s: string) => void,
): Promise<string | undefined> {
  const audit = readSubagentAuditForJob(jobId, sinceIso ? { sinceIso } : {});
  const { messages, tools } = await loadTranscriptRows(engine, jobId);

  // Merge audit events + message rows into one timeline ordered by ts.
  const merged: Array<{ ts: string; line: string }> = [];

  for (const e of audit) {
    if (sinceIso && e.ts <= sinceIso) continue;
    merged.push({ ts: e.ts, line: formatAudit(e) });
  }
  for (const m of messages) {
    const ts = m.ended_at.toISOString();
    if (sinceIso && ts <= sinceIso) continue;
    merged.push({ ts, line: formatMessage(m) });
  }

  merged.sort((a, b) => a.ts.localeCompare(b.ts));

  let maxTs = sinceIso;
  for (const item of merged) {
    write(`${item.ts} ${item.line}\n`);
    if (!maxTs || item.ts > maxTs) maxTs = item.ts;
  }

  // Transcript tail (renders the full message/tool tree) only if we
  // actually have messages and the job is in a terminal state. This
  // avoids spamming a half-rendered transcript mid-run.
  if (messages.length > 0 && !sinceIso) {
    const status = await readJobStatus(engine, jobId);
    if (status && TERMINAL_STATUSES.has(status)) {
      write('\n');
      write(renderTranscript(messages, tools));
      write('\n');
    }
  }

  return maxTs;
}

function formatAudit(e: SubagentAuditEvent): string {
  if (e.type === 'submission') {
    return `[submission] ${e.caller} model=${e.model ?? '?'} tools=${e.tools_count ?? 0}`;
  }
  // heartbeat
  const parts = [`[${e.event}]`, `turn=${e.turn_idx}`];
  if (e.tool_name) parts.push(`tool=${e.tool_name}`);
  if (e.ms_elapsed != null) parts.push(`${e.ms_elapsed}ms`);
  if (e.tokens) {
    const t = e.tokens;
    const tokStr = [
      t.in ? `in=${t.in}` : null,
      t.out ? `out=${t.out}` : null,
      t.cache_read ? `cache_read=${t.cache_read}` : null,
      t.cache_create ? `cache_create=${t.cache_create}` : null,
    ].filter(Boolean).join(' ');
    if (tokStr) parts.push(`tokens(${tokStr})`);
  }
  if (e.error) parts.push(`error="${e.error.slice(0, 100)}"`);
  return parts.join(' ');
}

function formatMessage(m: SubagentMessageRow): string {
  const blockTypes = m.content_blocks.map(b => b.type).join(',');
  return `[message #${m.message_idx} ${m.role}] blocks=${blockTypes || '(empty)'}`;
}

async function readJobStatus(engine: BrainEngine, jobId: number): Promise<string | null> {
  const rows = await engine.executeRaw<{ status: string }>(
    `SELECT status FROM minion_jobs WHERE id = $1`,
    [jobId],
  );
  return rows[0]?.status ?? null;
}

const RELATIVE_RE = /^(\d+)\s*(s|m|h|d)$/i;

/** Parse `--since`. Accepts ISO-8601 or relative ("5m", "1h", "2d"). */
export function parseSince(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const [, nStr, unitRaw] = rel;
    const unit = unitRaw!.toLowerCase();
    const n = parseInt(nStr!, 10);
    const mult = unit === 's' ? 1000
      : unit === 'm' ? 60_000
      : unit === 'h' ? 3_600_000
      : 86_400_000; // 'd'
    return new Date(Date.now() - n * mult).toISOString();
  }
  // Assume ISO. `new Date(input).toISOString()` both validates and
  // normalizes; invalid ISO throws.
  const d = new Date(trimmed);
  if (isNaN(d.getTime())) {
    throw new Error(`--since: could not parse "${input}" as ISO-8601 or relative (e.g. "5m", "1h")`);
  }
  return d.toISOString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export const __testing = {
  parseSince,
  formatAudit,
  formatMessage,
  dumpSince,
};
