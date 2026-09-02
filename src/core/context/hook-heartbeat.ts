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

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, appendFileSync, chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ToolCallRecord } from '../transcripts/claude-code-jsonl.ts';
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
  /** Cathedral 5 — checkpoint-harvest fact counters (counts only) [S3#7].
   * The ambient-writeback lane (`event: 'writeback'`) reports the same
   * counters plus `superseded` — these are PERSISTED results from the
   * serve-side harvest (OV-A11), never candidate counts. */
  inserted?: number;
  duplicate?: number;
  superseded?: number;
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
  'segment', 'inserted', 'duplicate', 'superseded', 'links', 'flush',
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

// ── Session receipts (memorable integration) ────────────────────────────────
//
// Folded in here rather than given its own module: it shares this file's
// directory, its 0700/0600 permissions, its tail-rewrite compaction and its
// never-throw contract, and it is written from the same session-end path.
// Redaction is NOT reimplemented — the caller runs the corpus text and the
// tool calls through the one existing secret-scan pass in core/secret-scan.ts
// before anything reaches these functions.
//
// Nothing here runs unless the operator has turned the integration on; see
// memorableGateAllowed below — the ONE gate shared by all three consumers
// (commands/hook.ts, the openclaw lane in context-engine.ts, and the doctor
// check in commands/doctor/checks/integrations-memorable.ts).

export const SESSION_RECEIPTS_MAX_LINES = 2000;

export interface SessionReceiptEntry {
  ts: string;
  session_id: string;
  /**
   * Producers today: 'claude-code' + 'codex' (session-end hook lanes) and
   * 'openclaw' (context-engine compaction lane). 'opencode' is declared ahead
   * of its capture lane. NOTE: this union is NOT HookIo.harness — widening
   * THAT union also requires widening HARNESS_CHANNELS in volunteer-events.ts
   * (hook.ts's user-prompt path silently maps unknown channels to
   * 'claude-code', a misattribution, not a compile error).
   */
  harness: 'claude-code' | 'codex' | 'opencode' | 'openclaw';
  corpus_path: string;
  content_hash: string;
  turn_count: number;
  workspace_root: string;
  /**
   * Secret-scanned JSON array of {name, input} for every tool_use block in
   * the parsed window (see ToolCallRecord in claude-code-jsonl.ts) — the
   * actual command/arguments, not the placeholder-only rendering the corpus
   * text itself carries. '[]' when scanning failed or nothing ran.
   */
  tool_calls_json: string;
  /** false when the secret-scan import failed and the corpus was written unscanned — see hook.ts's scan_unavailable degrade. */
  secret_scan_ok: boolean;
}

export async function sessionReceiptsPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'session-receipts.jsonl');
}

/**
 * Where the relay child reports what it did.
 *
 * The relay is spawned detached with stdio ignored, which is deliberate — a
 * session-end hook must never block on, or fail because of, an external tool.
 * But the consequence was that gbrain only ever verified the binary EXISTS. A
 * `memorable record` that exited non-zero — refused consent, failed
 * extraction, API down, malformed receipt — was indistinguishable from
 * success, so `gbrain doctor` could report a healthy relay indefinitely while
 * nothing had been recorded for weeks.
 *
 * The child writes its own outcome here instead. gbrain reads the PREVIOUS
 * run's line at the next session end, so nothing is ever waited on and the
 * fire-and-forget contract is untouched — a failure simply becomes visible one
 * session later rather than never.
 */
export async function relayResultsPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'memorable-relay.jsonl');
}

export interface RelayResult {
  ts: string;
  session_id: string;
  ok: boolean;
  /** Short machine-readable cause when ok is false. Never free text from a
   * subprocess: this reaches the heartbeat, which is counters and reasons. */
  reason?: string;
}

/** The heartbeat reason for the PREVIOUS relay run, or null when it succeeded
 * or never reported. Nothing is waited on here — the answer describes the last
 * run, so a failed relay becomes visible one session later rather than never,
 * and the fire-and-forget contract is untouched.
 *
 * The child's `reason` is UNTRUSTED subprocess output landing in a heartbeat
 * that is counters and reasons [S3#7] — clamp it to the same short
 * machine-code charset hook.ts's reasonCode() enforces, else 'failed'. */
export async function priorRelayFailure(): Promise<string | null> {
  const last = await lastRelayResult();
  if (!last || last.ok) return null;
  return `memorable_relay_${clampRelayCause(last.reason)}`;
}

/** Clamp the relay child's UNTRUSTED self-reported cause to a short machine
 * code — 32 chars, so the 16-char 'memorable_relay_' prefix keeps every
 * composite inside the heartbeat's 48-char reason-code bound. THE one clamp
 * for both consumers (priorRelayFailure above and the doctor check). */
export function clampRelayCause(reason: unknown): string {
  return typeof reason === 'string' && /^[A-Za-z0-9_.:-]{1,32}$/.test(reason) ? reason : 'failed';
}

/**
 * Bounded tail read of a JSONL file — THE one implementation for every reader
 * in this module (`lastReceiptMatches`, `lastRelayResult`,
 * `readSessionReceiptsTail`). Receipts carry tool_calls_json and the files are
 * allowed to reach tens of MB; a full readFileSync on every session end (or
 * every `gbrain doctor` run) is exactly the cost the byte ceilings exist to
 * avoid. A tail read can slice its first line in half; that fragment is
 * dropped here rather than trusted. Never throws — missing/unreadable = [].
 */
const JSONL_TAIL_MAX_BYTES = 1024 * 1024;
/** A single receipt line can exceed the window (tool_calls_json), and a tail
 * that contains no COMPLETE line must not read as "empty file" — double the
 * window until at least one complete line fits, capped well under the 32 MB
 * file ceiling. Real receipts average ~110 KB, so the first window wins in
 * practice and the retries exist for the pathological tail. */
const JSONL_TAIL_HARD_CAP_BYTES = 16 * 1024 * 1024;
function readJsonlTailLines(path: string, maxBytes = JSONL_TAIL_MAX_BYTES): string[] {
  try {
    const size = statSync(path).size;
    for (let window = maxBytes; ; window *= 2) {
      const start = Math.max(0, size - window);
      const fd = openSync(path, 'r');
      let raw: string;
      try {
        const buf = Buffer.alloc(size - start);
        readSync(fd, buf, 0, buf.length, start);
        raw = buf.toString('utf8');
      } finally {
        closeSync(fd);
      }
      const lines = raw.split('\n').filter((l) => l.trim().length > 0);
      // A tail read can slice its first line in half; drop the fragment
      // rather than trust it.
      if (start > 0) lines.shift();
      if (lines.length > 0 || start === 0 || window >= JSONL_TAIL_HARD_CAP_BYTES) return lines;
    }
  } catch {
    return [];
  }
}

/** The newest relay outcome, or null when the child has never reported. Never
 * throws: a missing or corrupt file means "nothing to say", never a broken
 * session end. Bounded: only the newest ~1 MB is ever read. */
export async function lastRelayResult(): Promise<RelayResult | null> {
  const lines = readJsonlTailLines(await relayResultsPath());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!) as RelayResult;
      if (typeof e.ok === 'boolean') return e;
    } catch { /* torn line — keep looking back */ }
  }
  return null;
}

// ── Relay-results trim (gbrain-owned bound on a foreign-appended file) ──────
//
// The memorable child appends one outcome line per relay run and never trims;
// unbounded growth here is the same defect class the receipts file had. Trim
// discipline: (a) BOTH capture lanes may trim (an openclaw-only host has no
// hook lane, and a single-trimmer rule would leave it unbounded) — trims are
// newest-keeping and converge, so a trim racing a trim ends in one valid
// result; (b) prefer trimming when the file is
// mtime-stale (no child wrote recently), but FORCE the trim at a hard ceiling
// regardless — on busy machines (per-compaction openclaw traffic) the mtime
// never goes stale and the file would otherwise grow forever behind the
// bounded tail read; (c) cut on LINE boundaries keeping the newest complete
// lines — a lost `ok:false` line is precisely the observability signal the
// doctor ladder is built on, so never byte-cut. Residual race: the child
// writes via appendFileSync (open-by-path per write, 0.3.4 decompile), so an
// append landing after our rename opens the NEW file — the loss window is a
// single write in flight during the rename itself, near-zero and accepted.

const RELAY_TRIM_THRESHOLD_BYTES = 1024 * 1024;
const RELAY_FORCE_TRIM_BYTES = 8 * 1024 * 1024;
const RELAY_TRIM_TARGET_BYTES = 512 * 1024;
const RELAY_TRIM_STALE_MS = 60_000;

/** Keep the newest complete lines under a byte budget (always at least the
 * newest one, even alone over budget) and tmp+rename the result into place —
 * THE one trim implementation for the relay file and the receipts file. */
function trimJsonlToNewest(p: string, lines: string[], opts: { targetBytes: number; maxLines?: number }): void {
  const kept: string[] = [];
  let bytes = 0;
  const maxLines = opts.maxLines ?? Number.POSITIVE_INFINITY;
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const b = Buffer.byteLength(lines[i]!, 'utf8') + 1;
    if (bytes + b > opts.targetBytes && kept.length > 0) break;
    kept.push(lines[i]!);
    bytes += b;
  }
  kept.reverse();
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 });
  renameSync(tmp, p);
}

/** Opportunistically bound memorable-relay.jsonl. Hook lane only. Never throws. */
export async function maybeTrimRelayResults(nowMs = Date.now()): Promise<void> {
  try {
    const p = await relayResultsPath();
    const st = statSync(p);
    if (st.size <= RELAY_TRIM_THRESHOLD_BYTES) return;
    const stale = nowMs - st.mtimeMs > RELAY_TRIM_STALE_MS;
    if (!stale && st.size <= RELAY_FORCE_TRIM_BYTES) return;
    const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
    trimJsonlToNewest(p, lines, { targetBytes: RELAY_TRIM_TARGET_BYTES });
  } catch { /* missing file or fs refusal — a trim is never load-bearing */ }
}

/**
 * Byte ceiling, because the line count was never the binding constraint.
 *
 * A receipt carries tool_calls_json, and measured against real sessions those
 * lines average 110 KB and reach 353 KB. So 3000 receipts are ~315 MB across
 * 3000 lines: comfortably under the 4000-line trigger, never compacted, and
 * re-read whole into memory on every session end (maxRSS 443 MB, oscillating
 * between ~210 MB and ~420 MB on disk in steady state).
 *
 * This ceiling is the ONLY compaction trigger: the read fires exactly when
 * the pass will act, and it also bounds the readFileSync itself — the file
 * can only exceed it by one append. The line budget is enforced inside the
 * pass (kept.length), not by a separate pre-read trigger.
 */
const RECEIPTS_MAX_BYTES = 32 * 1024 * 1024;
/** What a compaction leaves behind, so the next append does not re-trigger it. */
const RECEIPTS_TARGET_BYTES = RECEIPTS_MAX_BYTES / 2;

/**
 * Append one receipt line, unless it says exactly what the last one for this
 * session already said. Never throws — a receipt-write failure must never
 * break session-end.
 *
 * Returns true when a receipt was written. A RESUMED session runs session-end
 * again, and the corpus file is session-id-keyed and overwritten, so the
 * corpus deduplicates by construction — but the receipt was appended
 * unconditionally, and every append fired the relay again. A session resumed
 * five times paid for five extractions of the same trace.
 *
 * `content_hash` is the exact discriminator: it is the post-redaction hash of
 * the corpus just written, so an identical hash means identical content and
 * genuinely nothing new to record. A CHANGED hash is real appended work and
 * must still be recorded and relayed — the at-least-once contract for new
 * content is unchanged; only exact re-emissions are dropped.
 */
export async function appendSessionReceipt(
  entry: Omit<SessionReceiptEntry, 'ts'>,
  opts: { skipCompaction?: boolean } = {},
): Promise<boolean> {
  try {
    const p = await sessionReceiptsPath();
    if (await lastReceiptMatches(entry.session_id, entry.content_hash)) return false;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(p, line + '\n', { mode: 0o600 });
    // skipCompaction: the openclaw lane runs inside the host's latency-
    // sensitive compact() callback — when its deadline is near, the append
    // lands but the (up to 32 MB) rewrite is deferred to a quieter caller.
    if (opts.skipCompaction) return true;
    let size = 0;
    try {
      size = statSync(p).size;
    } catch {
      /* just appended — best effort */
    }
    // The full read happens only when compaction will ACT (byte cap crossed).
    // A cheaper stat-size trigger used to fire the read at ~320 KB "to check
    // the line count", but receipt lines average ~110 KB — so every session
    // end between 320 KB and 32 MB paid a growing readFileSync that then did
    // nothing. The line budget is still enforced inside the pass below.
    if (size > RECEIPTS_MAX_BYTES) {
      const lines = readFileSync(p, 'utf8').split('\n').filter((l) => l.trim().length > 0);
      // Newest first, stopping at whichever budget binds (shared trim helper
      // — always keeps the newest entry, since a compaction that dropped the
      // receipt just written would break the relay it exists to feed).
      trimJsonlToNewest(p, lines, { targetBytes: RECEIPTS_TARGET_BYTES, maxLines: SESSION_RECEIPTS_MAX_LINES });
    }
    return true;
  } catch {
    /* a receipt is an optional signal — never break the hook it describes */
    return false;
  }
}

/** Newest receipt for this session, compared by content hash.
 *
 * Reads a BOUNDED tail rather than the whole file: receipts carry
 * tool_calls_json and the file is allowed to reach 32 MB, so a full read on
 * every session end is exactly the cost the byte ceiling above exists to
 * avoid. A resumed session's previous receipt is by construction among the
 * most recent, and a miss here only means a duplicate is written — the
 * failure mode is the old behaviour, never a lost receipt. */
async function lastReceiptMatches(sessionId: string, contentHash: string): Promise<boolean> {
  const lines = readJsonlTailLines(await sessionReceiptsPath());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const e = JSON.parse(lines[i]!) as SessionReceiptEntry;
      if (e.session_id === sessionId) return e.content_hash === contentHash;
    } catch {
      /* torn or malformed line — skip */
    }
  }
  return false;
}

/** Last `n` receipt entries (oldest → newest) from the newest ~1 MB of the
 * file — a bounded read, because receipts carry tool_calls_json and the file
 * is allowed to reach 32 MB (doctor calls this on every run). Callers should
 * take the newest per session_id. */
export async function readSessionReceiptsTail(n: number): Promise<SessionReceiptEntry[]> {
  const lines = readJsonlTailLines(await sessionReceiptsPath());
  const out: SessionReceiptEntry[] = [];
  for (const line of lines.slice(-Math.max(0, n))) {
    try {
      out.push(JSON.parse(line) as SessionReceiptEntry);
    } catch {
      /* torn line — skip */
    }
  }
  return out;
}

// ── Consent stamp (gbrain-authored disclosure evidence) ─────────────────────
//
// The relay gate requires TWO things: the config boolean AND this stamp. The
// stamp deliberately does NOT live in ~/.gbrain/config.json — the external
// memorable CLI full-file-rewrites that file on `memorable enable|disable|
// setup` (verified against the 0.3.4 decompile), which would allow stamp
// forgery-by-habit, loss to a lockless rewrite race, and resurrection after
// revocation (a stale CLI snapshot restoring cleared keys). It lives here, in
// a gbrain-private 0600 file the CLI has never written; forging it would
// require the CLI to start writing a file it has never touched — a visible
// escalation, not an existing habit.
//
// Scope-binding: the stamp records WHICH disclosure text was accepted (hash)
// and WHICH capture lanes existed at acceptance. A release that widens the
// egress surface (a new harness lane) changes MEMORABLE_CAPTURE_HARNESSES,
// the stamp stops validating, the relay turns off, and `gbrain doctor` names
// the re-disclosure command — consent never silently stretches over egress
// the user was never shown.

/** The capture lanes the CURRENT build can relay. Widening this list is a
 * deliberate consent event: old stamps stop validating until the user re-runs
 * the disclosure. */
export const MEMORABLE_CAPTURE_HARNESSES: readonly string[] = ['claude-code', 'openclaw', 'codex'];

/** Canonical enable-time disclosure — the one text the user consents to.
 * Rendered by `gbrain config set integrations.memorable.enabled true` and
 * hashed into the consent stamp; editing it invalidates existing stamps. */
export const MEMORABLE_DISCLOSURE_TEXT = `═══════════════════════════════════════════════════════════════
[gbrain] Enable the Memorable session-end relay?
[gbrain]
[gbrain] What this does, mechanically:
[gbrain]  - At the end of a captured session (${MEMORABLE_CAPTURE_HARNESSES.join(', ')}),
[gbrain]    gbrain writes a local receipt and spawns the locally-installed
[gbrain]    third-party \`memorable\` CLI (closed source, published on npm by
[gbrain]    Memorable — not by gbrain, not auditable by gbrain).
[gbrain]  - That CLI sends the session's REDACTED tool calls (commands, file
[gbrain]    paths, URLs, queries + success/failure booleans) and a <=200-char
[gbrain]    task line to Memorable's extraction API. Redaction runs first
[gbrain]    (vendor-key + high-entropy secret scan), but redaction is
[gbrain]    best-effort, not a guarantee.
[gbrain]  - In gbrain-backend mode the CLI has FULL access to your brain
[gbrain]    database (it stores procedures via direct DB access). Prefer its
[gbrain]    standalone mode for sensitive brains.
[gbrain]  - Memorable's own consent (\`memorable enable\`) is separate and also
[gbrain]    required; that CLI can flip gbrain's enable flag, but it can never
[gbrain]    write this consent stamp — only this command can.
[gbrain]
[gbrain] Off switches: gbrain config set integrations.memorable.enabled false
[gbrain]               GBRAIN_MEMORABLE=0 (env kill switch)
═══════════════════════════════════════════════════════════════`;

export function memorableDisclosureSha256(): string {
  return createHash('sha256').update(MEMORABLE_DISCLOSURE_TEXT, 'utf8').digest('hex');
}

export interface MemorableConsentStamp {
  accepted_disclosure: string;
  disclosure_sha256: string;
  harnesses: string[];
}

export async function memorableConsentPath(): Promise<string> {
  return join(await hooksTelemetryDir(), 'memorable-consent.json');
}

/** Write the stamp — called ONLY by the enable-time disclosure flow in
 * commands/config.ts. Returns the path for the confirmation message. */
export async function writeMemorableConsent(): Promise<string> {
  const p = await memorableConsentPath();
  const stamp: MemorableConsentStamp = {
    accepted_disclosure: new Date().toISOString(),
    disclosure_sha256: memorableDisclosureSha256(),
    harnesses: [...MEMORABLE_CAPTURE_HARNESSES],
  };
  writeFileSync(p, JSON.stringify(stamp, null, 2) + '\n', { mode: 0o600 });
  return p;
}

/** Revocation — `config set …enabled false` and `config unset` both call this. */
export async function clearMemorableConsent(): Promise<void> {
  try {
    rmSync(await memorableConsentPath(), { force: true });
  } catch { /* best effort — a leftover stamp without the enable flag is inert */ }
}

export async function readMemorableConsent(): Promise<MemorableConsentStamp | null> {
  try {
    const raw = JSON.parse(readFileSync(await memorableConsentPath(), 'utf8')) as MemorableConsentStamp;
    if (typeof raw?.accepted_disclosure === 'string' && typeof raw?.disclosure_sha256 === 'string' && Array.isArray(raw?.harnesses)) return raw;
  } catch { /* missing or unreadable — no consent evidence */ }
  return null;
}

/** Valid = the CURRENT disclosure text was accepted AND every current capture
 * lane was already listed at acceptance. Fail-closed on any mismatch. */
export async function memorableConsentValid(): Promise<boolean> {
  const stamp = await readMemorableConsent();
  if (!stamp) return false;
  if (stamp.disclosure_sha256 !== memorableDisclosureSha256()) return false;
  return MEMORABLE_CAPTURE_HARNESSES.every((h) => stamp.harnesses.includes(h));
}

/** Why the Memorable gate said no — one vocabulary for hook, context-engine,
 * and doctor, so the three surfaces can never drift apart on what they call
 * the same state. */
export interface MemorableGate {
  allowed: boolean;
  reason?: 'kill_switch' | 'disabled' | 'disclosure_missing';
}

/**
 * ONE gate for the whole Memorable integration, checked before any of it does
 * anything: the receipt is not written, tool calls are not collected, and
 * nothing is spawned unless the operator has explicitly opted in. Off (the
 * default) means gbrain behaves exactly as it does today. Any of 0/false/off/no
 * in GBRAIN_MEMORABLE kills the relay; the env can only ever DISABLE — there is
 * no env value that bypasses the config gate or the consent stamp.
 *
 * `disclosure_missing`: the config boolean is on but the gbrain-authored
 * consent stamp is absent or stale — the state `memorable enable`'s
 * out-of-band config write produces. The relay stays off until the user runs
 * `gbrain config set integrations.memorable.enabled true` and accepts the
 * disclosure (surfaced as a doctor FAIL with exactly that command).
 *
 * Structural param (not GBrainConfig) so this module never imports config.ts —
 * the hook lane, the openclaw context-engine lane, and doctor all pass whatever
 * config object they already hold.
 */
export async function memorableGateAllowed(cfg?: { integrations?: { memorable?: { enabled?: boolean } } } | null): Promise<MemorableGate> {
  // Trimmed + a wide negative net: an emergency kill switch must not fail
  // open on near-miss spellings ('n', 'disabled', a trailing space).
  if (/^(0|false|off|no|n|disable|disabled|none)$/i.test((process.env.GBRAIN_MEMORABLE ?? '').trim())) {
    return { allowed: false, reason: 'kill_switch' };
  }
  if (cfg?.integrations?.memorable?.enabled !== true) return { allowed: false, reason: 'disabled' };
  if (!(await memorableConsentValid())) return { allowed: false, reason: 'disclosure_missing' };
  return { allowed: true };
}

// ── Memorable-side consent evidence (the CLI's own opt-in state) ─────────────
//
// SPEC TARGET (provisional, dated): ~/.memorable/config.json as written by
// memorable-cli 0.3.4 (decompile-verified 2026-08-25). Fields this check
// reads: `backend` ('local' | 'gbrain') and, for the local backend, `consent`
// ('read-write' | 'read-only' | 'deny'; absent = unset = deny). In gbrain-
// backend mode the CLI stores consent on the brain's source row (unreadable
// from this engine-free lane) and mirrors enable/disable into gbrain's config
// gate — so there the gbrain-authored consent stamp above is the required
// evidence instead. Unknown shape = no evidence = skip the spawn, fail-closed
// and doctor-visible (never a guessed yes).

export type MemorableConsentEvidence =
  | { ok: true }
  | { ok: false; reason: 'memorable_not_initialized' | 'memorable_consent_off' };

/** TEST SEAM: GBRAIN_MEMORABLE_CONFIG overrides the directory holding the
 * CLI's config.json (never settable to widen anything — it only tells the
 * evidence check where to LOOK, and a wrong path fails closed). */
function memorableCliConfigPath(): string {
  const dir = process.env.GBRAIN_MEMORABLE_CONFIG || join(homedir(), '.memorable');
  return join(dir, 'config.json');
}

export function memorableConsentEvidence(): MemorableConsentEvidence {
  try {
    const raw = JSON.parse(readFileSync(memorableCliConfigPath(), 'utf8')) as { backend?: unknown; consent?: unknown };
    if (raw?.backend === 'gbrain') return { ok: true };
    if (raw?.backend === 'local') {
      return raw?.consent === 'read-write' ? { ok: true } : { ok: false, reason: 'memorable_consent_off' };
    }
  } catch { /* missing or unparseable — not initialized */ }
  return { ok: false, reason: 'memorable_not_initialized' };
}

/**
 * Secret-scanned JSON of the tool calls covering EXACTLY the span the corpus
 * covers (in remainder mode the corpus is the post-boundary tail while the
 * calls were the whole parsed window). highEntropy is ALWAYS on here: these
 * args are the one artifact that leaves the machine, and without it only
 * vendor-prefixed keys redact — two live credentials reached the API through
 * that gap. Shared by hookSessionEnd and the openclaw context-engine lane so
 * the two capture paths cannot drift on redaction posture.
 *
 * Throws when the scanner import fails — each caller owns its failure mode
 * (the hook degrades `scan_unavailable`; the context-engine lane skips the
 * receipt entirely, fail-closed).
 */
export async function redactedToolCallsJson(calls: ToolCallRecord[], turnIndexes: number[], startTurnIndex: number): Promise<string> {
  const scan = await import('../secret-scan.ts');
  const span = calls.filter((_c, i) => (turnIndexes[i] ?? 0) >= startTurnIndex);
  // Redact each RAW string leaf, then serialize — never the other way round.
  // Scanning the serialized JSON silently missed quoted secrets: JSON escapes
  // the quotes inside string values (\"), the backslash falls outside the
  // scanner's value charset, and `export DB_PASSWORD="…"` inside a Bash
  // command shipped verbatim (red-team verified). Post-redaction re-scan of
  // the serialized form stays as a belt-and-braces pass for anything that
  // only becomes pattern-shaped after serialization.
  const redactLeaves = (v: unknown): unknown => {
    if (typeof v === 'string') return scan.redactFindings(v, { highEntropy: true }).text;
    if (Array.isArray(v)) return v.map(redactLeaves);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, redactLeaves(val)]));
    }
    return v;
  };
  return scan.redactFindings(JSON.stringify(redactLeaves(span)), { highEntropy: true }).text;
}

export interface RelayReceiptResult {
  recorded: boolean;
  degradeReasons: string[];
}

/**
 * Record a session receipt and fire-and-forget the Memorable relay — the ONE
 * implementation shared by the Claude Code session-end hook and the openclaw
 * context-engine compaction lane. Never throws; never blocks on the child;
 * sends nothing off-machine itself (the spawned CLI does its own consent and
 * toggle checks and owns all egress).
 *
 * The GATE STAYS AT THE CALL SITES (`memorableGateAllowed`) — callers need the
 * gate answer earlier than this call (tool-call collection is itself gated).
 * `recorded: false` means an identical resumed emission was deduplicated (or
 * the receipt write failed) — the relay is skipped, so a session resumed five
 * times pays for one extraction, not five.
 */
export async function recordAndRelayReceipt(
  entry: Omit<SessionReceiptEntry, 'ts'>,
  opts: { spawnFn?: typeof spawn; trimRelayFile?: boolean; skipReceiptsCompaction?: boolean } = {},
): Promise<RelayReceiptResult> {
  const degradeReasons: string[] = [];
  let priorFail: string | null = null;
  try {
    // Scope-binding enforcement at the RECEIPT level, not just the stamp
    // level: the accepted disclosure enumerates MEMORABLE_CAPTURE_HARNESSES,
    // so a receipt from any other lane (e.g. an operator-wired opencode
    // session-end riding the claude capture spec) must never reach the relay
    // — consent never silently stretches over egress the user was not shown.
    if (!MEMORABLE_CAPTURE_HARNESSES.includes(entry.harness)) {
      degradeReasons.push('memorable_harness_undisclosed');
      return { recorded: false, degradeReasons };
    }
    if (opts.trimRelayFile) await maybeTrimRelayResults();
    const recorded = await appendSessionReceipt(entry, { skipCompaction: opts.skipReceiptsCompaction });
    if (!recorded) return { recorded: false, degradeReasons };
    // gbrain verified the binary existed, never that it WORKED — surface the
    // PREVIOUS run's self-reported outcome (see relayResultsPath). Collected
    // here, appended LAST: a stale prior-run failure must never mask a
    // current-session reason under the heartbeat's first-degrade-wins rule.
    priorFail = await priorRelayFailure();
    // Consent-before-egress: the receipt above is a local artifact and is
    // always written; the SPAWN is what leads to egress, so it additionally
    // requires positive evidence that Memorable's own consent exists. No
    // evidence => no child process, fail-closed and doctor-visible.
    const evidence = memorableConsentEvidence();
    if (!evidence.ok) {
      degradeReasons.push(evidence.reason);
    } else {
      // Enabled-but-not-installed is named, not spawned into an ENOENT.
      const bin = resolveMemorableBin();
      if (!bin) {
        degradeReasons.push('memorable_cli_missing');
      } else {
        const doSpawn = opts.spawnFn ?? spawn;
        const child = doSpawn(bin, ['record', '--session', entry.session_id], { detached: true, stdio: 'ignore' });
        // ENOENT still arrives as an async 'error' event; without this
        // handler an uncaught one kills the caller.
        child.on('error', () => { /* best-effort by contract */ });
        child.unref();
      }
    }
  } catch {
    /* spawn refused — the relay is best-effort and never fails the caller */
  }
  if (priorFail) degradeReasons.push(priorFail);
  return { recorded: true, degradeReasons };
}

/**
 * Resolve the `memorable` CLI on PATH ourselves before spawning it.
 *
 * spawn() reports a missing executable as an ASYNC 'error' event, which lands
 * after this hook has already written its heartbeat and exited — so an
 * enabled-but-not-installed integration looks exactly like a working one that
 * had nothing to do. Checking first is what makes that state visible in
 * `gbrain doctor` (heartbeat reason `memorable_cli_missing`) instead of
 * silently doing nothing. Honors MEMORABLE_BIN for installs outside PATH.
 */
export function resolveMemorableBin(): string | null {
  const explicit = process.env.MEMORABLE_BIN;
  // The env branch used bare existsSync, so a DIRECTORY named in MEMORABLE_BIN
  // resolved "successfully" and the hook reported outcome: ok while nothing
  // ran. Neither branch checked the execute bit either, so a non-executable
  // file on PATH did the same. Both are the exact failure this function was
  // added to make visible, so both are checked here rather than at one branch.
  if (explicit) return runnable(explicit) ? explicit : null;
  const exts = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, 'memorable' + ext);
      if (runnable(candidate)) return candidate;
    }
  }
  return null;
}

/** A real file this process can actually execute. On win32 the execute bit is
 * not meaningful, so being a file is the whole test there. */
function runnable(p: string): boolean {
  try {
    if (!statSync(p).isFile()) return false;
    if (process.platform !== 'win32') accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
