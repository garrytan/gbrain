/**
 * seat.ts — seat identity for captured sessions (#4618).
 *
 * A seat names the agent seat (harness home) whose conversation a corpus file
 * came from, so dream synthesis can credit synthesized pages to it on a brain
 * several agents feed. ENGINE-FREE: pure fs + crypto, usable from the hook
 * command and the OpenClaw context engine.
 *
 * Label: `GBRAIN_SEAT` (operator-chosen, lowercased, `SEAT_LABEL_RE`). Absent
 * ⇒ `home-<8 hex>`, the first 8 hex chars of sha256 over the harness home's
 * realpath — the raw path never leaves the machine, because the seat lands in
 * page frontmatter that may be committed to git. An invalid label falls back
 * to the home seat and reports `seat_label_invalid`. `GBRAIN_SEAT=off` is the
 * opt-out: no seat is recorded, so synthesized pages carry none.
 *
 * Sidecar: `<sessionId>.seat.json` (0600, tmp+rename) beside the corpus
 * files, written BEFORE a corpus file or segment is renamed into place, so a
 * sweep never sees a corpus file without its seat. The first seat recorded
 * for a session is kept; a later capture under another seat reports
 * `seat_conflict` and leaves the sidecar unchanged.
 */

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { seatFileName } from './corpus-segments.ts';

const SEAT_LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** The reserved label that turns seat capture off. */
const SEAT_OFF = 'off';

export type SeatReason = 'seat_label_invalid' | 'seat_conflict' | 'seat_write_failed';

/** Fixed heartbeat recovery hints (constant text, never content). */
const SEAT_REASON_HINTS: Record<SeatReason, string> = {
  seat_label_invalid:
    'GBRAIN_SEAT is not a valid seat label (1-64 chars of a-z 0-9 . _ -, starting with a letter or digit); ' +
    'sessions are credited to the harness-home seat until you re-run `gbrain bootstrap hooks --seat <label>` ' +
    'or `gbrain bootstrap harness --seat <label>` with a valid label',
  seat_conflict:
    'this session was first captured under a different seat; the first seat is kept for the whole session. ' +
    'No action needed unless the session was resumed from another agent home on purpose',
  seat_write_failed:
    'the seat sidecar could not be written beside the session corpus, so pages synthesized from this session ' +
    'carry no seat; make the corpus dir (dream.synthesize.session_corpus_dir, default ' +
    '~/.gbrain/transcripts/corpus) writable by this user (`ls -ld` it); the next capture of the session records the seat',
};

export function seatReasonHint(reason: string | undefined): string | undefined {
  return reason !== undefined && Object.hasOwn(SEAT_REASON_HINTS, reason)
    ? SEAT_REASON_HINTS[reason as SeatReason]
    : undefined;
}

export interface SeatSidecar {
  version: 1;
  seat: string;
  seat_source: 'env' | 'harness_home';
  hook_lane: string;
  harness: string;
  first_seen: string;
}

export interface ResolvedSeat {
  seat: string;
  seat_source: SeatSidecar['seat_source'];
  reasons: SeatReason[];
}

type Env = Record<string, string | undefined>;

/** Lowercased, validated seat label; null when the value is not a valid label. */
export function normalizeSeatLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const label = raw.trim().toLowerCase();
  return SEAT_LABEL_RE.test(label) ? label : null;
}

function parentOfNearestAncestor(path: string, name: string): string | null {
  let dir = dirname(resolve(path));
  for (;;) {
    if (basename(dir) === name) return dirname(dir);
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * The harness home a session ran under. Claude Code: the directory holding
 * `projects/` in the transcript path, else CLAUDE_CONFIG_DIR, else CODEX_HOME.
 * Codex: CODEX_HOME (its hook is spawned by codex, which owns that env).
 * OpenClaw: the agent directory holding `sessions/`. pi: PI_CODING_AGENT_DIR
 * (its extension spawns the hook inside pi's env). Each falls back to the
 * harness's default home under $HOME.
 */
function harnessHome(opts: { env: Env; harness?: string; transcriptPath?: string | null }): string {
  const { env, harness, transcriptPath } = opts;
  const home = env.HOME?.trim() || homedir();
  if (harness === 'codex') return env.CODEX_HOME?.trim() || join(home, '.codex');
  if (harness === 'pi') return env.PI_CODING_AGENT_DIR?.trim() || join(home, '.pi', 'agent');
  if (harness === 'openclaw') {
    return (transcriptPath && parentOfNearestAncestor(transcriptPath, 'sessions')) || join(home, '.openclaw');
  }
  return (transcriptPath && parentOfNearestAncestor(transcriptPath, 'projects'))
    || env.CLAUDE_CONFIG_DIR?.trim()
    || env.CODEX_HOME?.trim()
    || join(home, '.claude');
}

function homeSeat(dir: string): string {
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    real = resolve(dir);
  }
  return `home-${createHash('sha256').update(real, 'utf8').digest('hex').slice(0, 8)}`;
}

/** The session's seat; null when `GBRAIN_SEAT=off` turned seat capture off. */
export function resolveSeat(opts: { env: Env; harness?: string; transcriptPath?: string | null }): ResolvedSeat | null {
  const raw = opts.env.GBRAIN_SEAT;
  const reasons: SeatReason[] = [];
  if (raw !== undefined && raw.trim() !== '') {
    const label = normalizeSeatLabel(raw);
    if (label === SEAT_OFF) return null;
    if (label) return { seat: label, seat_source: 'env', reasons };
    reasons.push('seat_label_invalid');
  }
  return { seat: homeSeat(harnessHome(opts)), seat_source: 'harness_home', reasons };
}

/** The recorded sidecar, or null when absent, unreadable or not a valid v1 record. */
export function readSeatSidecar(dir: string, sessionId: string): SeatSidecar | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, seatFileName(sessionId)), 'utf8')) as Partial<SeatSidecar>;
    return parsed?.version === 1 && typeof parsed.seat === 'string' && SEAT_LABEL_RE.test(parsed.seat)
      ? (parsed as SeatSidecar)
      : null;
  } catch {
    return null;
  }
}

/**
 * Record the session's seat unless one is already recorded. Returns the
 * heartbeat reasons (resolution reasons plus `seat_conflict`). Throws only on
 * a write failure.
 */
export function writeSeatSidecar(
  dir: string,
  sessionId: string,
  resolved: ResolvedSeat,
  meta: { harness: string; hookLane: string },
): SeatReason[] {
  const reasons = [...resolved.reasons];
  const prior = readSeatSidecar(dir, sessionId);
  if (prior) {
    if (prior.seat !== resolved.seat) reasons.push('seat_conflict');
    return reasons;
  }
  const record: SeatSidecar = {
    version: 1,
    seat: resolved.seat,
    seat_source: resolved.seat_source,
    hook_lane: meta.hookLane,
    harness: meta.harness,
    first_seen: new Date().toISOString(),
  };
  const file = join(dir, seatFileName(sessionId));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
  return reasons;
}

/** The hook lane label recorded in the sidecar (charset-bounded; never raw env text). */
export function hookLaneLabel(raw: string | undefined): string {
  if (!raw) return 'workspace';
  return /^[a-z0-9_-]{1,32}$/.test(raw) ? raw : 'other';
}
