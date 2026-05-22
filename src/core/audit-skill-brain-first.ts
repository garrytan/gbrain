/**
 * audit-skill-brain-first.ts — Snapshot+diff audit trail for the v0.36.x
 * `skill_brain_first` doctor check (A2 + F11 + F12 from /plan-eng-review).
 *
 * **Why snapshot+diff, not append-every-run:** doctor runs ~20-50x/day on
 * a working brain (autopilot cycle, dev flow, CI). Writing every detected
 * violation per run produces ~2K lines/day of churn on a 42-violator
 * deployment — pure noise, no trend signal. Instead:
 *
 *   - Load the last-known snapshot of violator slugs.
 *   - Diff against the current detection.
 *   - Write JSONL audit lines ONLY for transitions (added/removed slugs).
 *   - On `--fix` apply, write a `fixed` event per applied fix.
 *   - Write the new snapshot atomically.
 *
 * Result: stable brain produces 0 audit writes per doctor run. The audit
 * log becomes signal, not noise. `tail -20 audit-YYYY-Www.jsonl` shows
 * real events.
 *
 * **Race handling (F12):** concurrent doctor runs (autopilot + dev + CI)
 * are real. `writeSnapshotAtomically` uses an mkstemp-style unique tmpfile
 * + `rename()`. Last-writer-wins is the explicit semantic — concurrent
 * snapshot writes do NOT collude. Acceptable for read-mostly audit data:
 * the worst case is one doctor run misses a transition because another
 * run rewrote the snapshot first; the next run reconciles.
 *
 * Mirrors the ISO-week filename pattern from `audit-slug-fallback.ts` and
 * `minions/handlers/supervisor-audit.ts` so all gbrain audit channels share
 * one rotation discipline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveAuditDir } from './minions/handlers/shell-audit.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BrainFirstAuditEventKind = 'detected' | 'resolved' | 'fixed';

export interface BrainFirstAuditEvent {
  ts: string;
  event: BrainFirstAuditEventKind;
  skill: string;
  /** External-lookup patterns matched at the moment of the event. */
  external_patterns?: string[];
  /** Optional run correlation id (e.g. `${pid}-${startEpochMs}`). */
  doctor_run_id?: string;
  /** Stable code consumed by future doctor `skill_brain_first_trend` check. */
  code: 'SKILL_BRAIN_FIRST';
  severity: 'info';
}

export interface SnapshotDiff {
  added: string[];     // slugs newly in violation
  removed: string[];   // slugs no longer in violation (resolved / removed)
  unchanged: string[]; // slugs in both (no audit write)
}

// ---------------------------------------------------------------------------
// ISO-week filename helpers (parity with audit-slug-fallback.ts)
// ---------------------------------------------------------------------------

/**
 * `skill-brain-first-YYYY-Www.jsonl` — ISO-8601 week math, identical to
 * `computeSlugFallbackAuditFilename()` so file rotation is consistent
 * across all audit channels.
 */
export function computeBrainFirstAuditFilename(now: Date = new Date()): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const dayNum = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNum + 3);
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstThursdayDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstThursdayDayNum + 3);
  const weekNum = Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86400000)) + 1;
  const ww = String(weekNum).padStart(2, '0');
  return `skill-brain-first-${isoYear}-W${ww}.jsonl`;
}

const SNAPSHOT_FILENAME = 'skill-brain-first-snapshot.json';

// ---------------------------------------------------------------------------
// Snapshot I/O
// ---------------------------------------------------------------------------

interface SnapshotFile {
  /** Schema version — bump when shape changes. */
  schema_version: 1;
  /** ISO-8601 timestamp of when the snapshot was last written. */
  written_at: string;
  /** Sorted array of violator slugs (canonical for diff stability). */
  violators: string[];
}

/**
 * Load the snapshot file. Returns an empty Set + `present: false` flag
 * when the file is missing OR corrupt JSON. Callers (doctor) use the
 * `present` flag to decide whether to bootstrap-write all current
 * violators as `detected` events on first run.
 */
export function loadSnapshot(): { violators: Set<string>; present: boolean } {
  const file = path.join(resolveAuditDir(), SNAPSHOT_FILENAME);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { violators: new Set(), present: false };
  }
  try {
    const parsed = JSON.parse(content) as SnapshotFile;
    if (
      typeof parsed !== 'object' || parsed === null ||
      !Array.isArray(parsed.violators)
    ) {
      // Corrupt shape — once-per-process warn, treat as missing.
      warnOnce(`[gbrain] snapshot corrupt: ${file} (unexpected shape); treating as missing`);
      return { violators: new Set(), present: false };
    }
    const slugs = new Set<string>();
    for (const v of parsed.violators) {
      if (typeof v === 'string' && v.length > 0) slugs.add(v);
    }
    return { violators: slugs, present: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnOnce(`[gbrain] snapshot corrupt: ${file} (${msg}); treating as missing`);
    return { violators: new Set(), present: false };
  }
}

/**
 * Compute the added/removed/unchanged diff against the previous snapshot.
 * Pure function (no I/O) so callers can compose it with caching layers.
 */
export function diffAgainstSnapshot(
  current: Set<string>,
  previous: Set<string>,
): SnapshotDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const slug of current) {
    if (previous.has(slug)) unchanged.push(slug);
    else added.push(slug);
  }
  for (const slug of previous) {
    if (!current.has(slug)) removed.push(slug);
  }
  added.sort();
  removed.sort();
  unchanged.sort();
  return { added, removed, unchanged };
}

/**
 * Write the snapshot atomically. Uses a process-unique tmpfile suffix
 * (`<pid>-<epoch_ms>-<random>`) followed by `rename()`, the standard
 * POSIX atomic-replace idiom.
 *
 * **Last-writer-wins (F12):** two concurrent doctor runs may both write
 * snapshots in arbitrary order; whichever lands last sticks. The
 * intervening run's transitions are correctly captured in its own
 * append-only JSONL — only the snapshot state is "lost," and the next
 * run reconciles by diffing against the now-current snapshot. This is
 * documented behavior, not a bug; the alternative (cross-process file
 * locking) is overkill for read-mostly audit data.
 *
 * Write failures log to stderr but never throw — audit is best-effort.
 */
export function writeSnapshotAtomically(violators: Set<string>, now: Date = new Date()): void {
  const dir = resolveAuditDir();
  const finalPath = path.join(dir, SNAPSHOT_FILENAME);
  const tmpSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const tmpPath = path.join(dir, `${SNAPSHOT_FILENAME}.tmp.${tmpSuffix}`);
  const sorted = Array.from(violators).sort();
  const payload: SnapshotFile = {
    schema_version: 1,
    written_at: now.toISOString(),
    violators: sorted,
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8' });
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] snapshot write failed (${msg}); doctor continues\n`);
    // Best-effort cleanup of the tmpfile if rename failed mid-flight.
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Audit JSONL writer
// ---------------------------------------------------------------------------

/**
 * Append a brain-first audit event to the current week's JSONL.
 *
 * Best-effort — write failures log to stderr but never throw. Doctor
 * continues even if the audit dir is read-only or the disk is full.
 */
export function logBrainFirstEvent(
  partial: Omit<BrainFirstAuditEvent, 'ts' | 'severity' | 'code'>,
  now: Date = new Date(),
): void {
  const event: BrainFirstAuditEvent = {
    ts: now.toISOString(),
    severity: 'info',
    code: 'SKILL_BRAIN_FIRST',
    ...partial,
  };
  const dir = resolveAuditDir();
  const file = path.join(dir, computeBrainFirstAuditFilename(now));
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(event) + '\n', { encoding: 'utf8' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gbrain] brain-first audit write failed (${msg}); doctor continues\n`);
  }
}

/**
 * Append `detected`/`resolved` events for an entire diff in one call.
 * Bounded: writes at most `diff.added.length + diff.removed.length` lines.
 * A no-transition diff writes nothing (the A2 contract).
 */
export function appendAuditEventsForTransitions(
  diff: SnapshotDiff,
  patternsBySlug: Map<string, string[]>,
  doctor_run_id?: string,
  now: Date = new Date(),
): void {
  for (const slug of diff.added) {
    logBrainFirstEvent({
      event: 'detected',
      skill: slug,
      external_patterns: patternsBySlug.get(slug),
      doctor_run_id,
    }, now);
  }
  for (const slug of diff.removed) {
    logBrainFirstEvent({
      event: 'resolved',
      skill: slug,
      doctor_run_id,
    }, now);
  }
}

// ---------------------------------------------------------------------------
// Reader (consumed by future skill_brain_first_trend doctor check, TODO-2)
// ---------------------------------------------------------------------------

/**
 * Read recent (`days` window, default 7) brain-first audit events from the
 * current + previous ISO-week JSONLs. Missing files / corrupt rows are
 * skipped silently — audit reads are forensic, not blocking.
 */
export function readRecentBrainFirstEvents(
  days = 7,
  now: Date = new Date(),
): BrainFirstAuditEvent[] {
  const dir = resolveAuditDir();
  const cutoff = now.getTime() - days * 86400000;
  const out: BrainFirstAuditEvent[] = [];
  const filenames = [
    computeBrainFirstAuditFilename(now),
    computeBrainFirstAuditFilename(new Date(now.getTime() - 7 * 86400000)),
  ];
  for (const filename of filenames) {
    const file = path.join(dir, filename);
    let content: string;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (line.length === 0) continue;
      try {
        const ev = JSON.parse(line) as BrainFirstAuditEvent;
        const ts = Date.parse(ev.ts);
        if (Number.isFinite(ts) && ts >= cutoff) out.push(ev);
      } catch {
        // Corrupt row — skip.
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Once-per-process warn (corrupt snapshot bootstrap path)
// ---------------------------------------------------------------------------

const _warnedSet = new Set<string>();

function warnOnce(message: string): void {
  if (_warnedSet.has(message)) return;
  _warnedSet.add(message);
  process.stderr.write(`${message}\n`);
}

/** Test-only: reset the once-per-process warning gate. */
export function _resetWarnedSetForTests(): void {
  _warnedSet.clear();
}
