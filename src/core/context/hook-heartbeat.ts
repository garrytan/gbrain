/**
 * hook-heartbeat.ts — the hooks telemetry JSONL, extracted from hook.ts
 * (cathedral 5) so the serve-side checkpoint harvest can append its outcome
 * events WITHOUT importing the command module. ENGINE-FREE, pure fs.
 *
 * Contract [S3#7, B3] (unchanged from the hook.ts original): append-JSONL at
 * `<gbrain home>/integrations/hooks/heartbeat.jsonl` — counters, durations,
 * and error/status CODES only, NEVER prompt/fact/slug text. Dir 0700, file
 * capped at HEARTBEAT_MAX_LINES (tail-rewrite). `readHeartbeatTail` is the
 * doctor/status read surface. Fields are copied EXPLICITLY — the schema
 * allowlist is enforced by construction, not by trust. Never throws.
 */

import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureGbrainHome, resolveGbrainHome } from '../gbrain-home.ts';

/** Heartbeat file line cap [S3#7]. */
export const HEARTBEAT_MAX_LINES = 5000;

export interface HookHeartbeatEntry {
  ts: string;
  event: string;
  outcome: 'ok' | 'degraded' | 'error';
  reason?: string;
  duration_ms: number;
  turns?: number;
  bytes?: number;
  /** Secret-scan redaction COUNT at the session-end corpus write (never content) [S3#2, S3#7]. */
  redactions?: number;
  /**
   * Cathedral 5 — segment/corpus-mode status CODE for the compact and
   * session-end lanes (segment_banked / segment_dup / empty_window /
   * deadline_scan / remainder / skip_covered / …). Codes only, never
   * slugs/fact text [S3#7].
   */
  segment?: string;
  /** Cathedral 5 — checkpoint-harvest fact counters (counts only) [S3#7]. */
  inserted?: number;
  duplicate?: number;
  /**
   * Cathedral 5 — the compact hook's harvest-schedule ACK code
   * (`scheduled` / `skip_queue_full` / `skip_not_found` / `skip_bad_basename`
   * / `skip_no_session` / `skip_shutting_down` / `skip_already_queued`).
   * Without it a persistently misconfigured split corpus dir or a full queue
   * is observable nowhere. Codes only [S3#7].
   */
  flush?: string;
  /** Cathedral 5 — checkpoint-harvest verified-link COUNT (never slugs) [S3#7]. */
  links?: number;
}

/** The FULL key allowlist — CI greps the fixture against this [S3#7]. */
export const HEARTBEAT_ALLOWED_KEYS = [
  'ts', 'event', 'outcome', 'reason', 'duration_ms', 'turns', 'bytes', 'redactions',
  'segment', 'inserted', 'duplicate', 'links', 'flush',
] as const;

/** Gbrain home resolver: the S3#10 choke point (create-or-resolve, fail-open). */
async function resolveHome(): Promise<string> {
  try {
    return ensureGbrainHome();
  } catch {
    return resolveGbrainHome();
  }
}

function ensureDir0700(dir: string): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* best effort */
  }
  return dir;
}

async function hooksTelemetryDir(): Promise<string> {
  const home = await resolveHome();
  ensureDir0700(join(home, 'integrations'));
  return ensureDir0700(join(home, 'integrations', 'hooks'));
}

/** Heartbeat JSONL path (exported for doctor/status/tests). */
export async function heartbeatPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'heartbeat.jsonl');
}

/** Status file the session-end parser-drift check writes [G3]. */
export async function hookStatusPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'status.json');
}

/**
 * Compaction trigger: only read the file back when its byte size could hold
 * more than ~2x HEARTBEAT_MAX_LINES entries. 40B is below any real entry's
 * size (the ISO ts alone is 24 chars), so this check can never UNDER-trigger.
 */
const HEARTBEAT_COMPACT_CHECK_BYTES = 2 * HEARTBEAT_MAX_LINES * 40;

/**
 * Append a heartbeat entry with a single O_APPEND write (no read-modify-write
 * per event — readers already tolerate torn lines). Compaction (tail-trim to
 * HEARTBEAT_MAX_LINES via tmp+rename) runs only when a cheap size/line-count
 * check says the file exceeds ~2x the cap. Never throws.
 */
export async function writeHeartbeat(
  entry: HookHeartbeatEntry,
  opts?: {
    /**
     * Skip the tail-trim compaction. The trim is read→tmp→rename with no
     * lock; a LONG-LIVED high-frequency writer (the serve harvest pump)
     * trimming concurrently with short-lived hook appends would silently
     * drop the other process's O_APPEND lines. Serve passes trim:false so
     * only short-lived hooks trim (the pre-existing narrow race window).
     */
    trim?: boolean;
  },
): Promise<void> {
  try {
    const p = await heartbeatPath();
    const line = JSON.stringify({
      ts: entry.ts,
      event: entry.event,
      outcome: entry.outcome,
      ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
      duration_ms: entry.duration_ms,
      ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
      ...(entry.bytes !== undefined ? { bytes: entry.bytes } : {}),
      ...(entry.redactions !== undefined ? { redactions: entry.redactions } : {}),
      ...(entry.segment !== undefined ? { segment: entry.segment } : {}),
      ...(entry.inserted !== undefined ? { inserted: entry.inserted } : {}),
      ...(entry.duplicate !== undefined ? { duplicate: entry.duplicate } : {}),
      ...(entry.links !== undefined ? { links: entry.links } : {}),
      ...(entry.flush !== undefined ? { flush: entry.flush } : {}),
    });
    appendFileSync(p, line + '\n', { mode: 0o600 });
    if (opts?.trim === false) return;
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* just appended — best effort */
    }
    if (size > HEARTBEAT_COMPACT_CHECK_BYTES) {
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      if (lines.length > 2 * HEARTBEAT_MAX_LINES) {
        const tmp = `${p}.tmp-${process.pid}`;
        writeFileSync(tmp, lines.slice(-HEARTBEAT_MAX_LINES).join('\n') + '\n', { mode: 0o600 });
        renameSync(tmp, p);
      }
    }
  } catch {
    /* telemetry never breaks a hook */
  }
}

/** Last `n` heartbeat entries (oldest → newest). Doctor/status read surface. */
export async function readHeartbeatTail(n: number): Promise<HookHeartbeatEntry[]> {
  try {
    const p = await heartbeatPath();
    const raw = readFileSync(p, 'utf8');
    const lines = raw.split('\n').filter((l) => l.trim().length > 0);
    const out: HookHeartbeatEntry[] = [];
    for (const line of lines.slice(-Math.max(0, n))) {
      try {
        out.push(JSON.parse(line) as HookHeartbeatEntry);
      } catch {
        /* torn line — skip */
      }
    }
    return out;
  } catch {
    return [];
  }
}
