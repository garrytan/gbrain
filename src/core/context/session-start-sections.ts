/**
 * Named sections of the SessionStart pack (onboarding roadmap PR 2): the first-session suggestion and nightly
 * learning's count line. Engine-free: the serve fits them under one byte budget in priority order, and the hook
 * composes the survivors ahead of the rest of its output and acknowledges a section with a receipt only when its
 * final payload still holds it. No new IPC message type: sections ride the context_pack response, and the
 * acknowledgement rides the context_pack bankOnly arm (an older serve ignores both fields).
 *
 * The hook also keeps a redacted local outcome per startup session (harness, hashed session id, outcome code) so
 * `gbrain onboarding status` and doctor can say why the suggestion did or did not reach a session.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { gbrainPath } from '../config.ts';

export type SessionStartSectionName = 'first_session' | 'nightly_learning' | 'standing_rules';
/** Priority order: earlier names win the shared budget and print first. standing_rules (C2) renders only when rules.session_start is on. */
export const SESSION_START_SECTION_ORDER: readonly SessionStartSectionName[] = ['first_session', 'nightly_learning', 'standing_rules'];
/** One byte budget shared by every named section. */
export const SESSION_START_SECTIONS_MAX_BYTES = 2048;

export interface SessionStartSection {
  name: SessionStartSectionName;
  text: string;
  /** Reservation token the hook returns in its acknowledgement; only sections that count deliveries carry one. */
  receipt?: string;
}

/** Sections in priority order, each kept whole or dropped whole, together within SESSION_START_SECTIONS_MAX_BYTES. */
export function fitSessionStartSections(sections: SessionStartSection[], maxBytes = SESSION_START_SECTIONS_MAX_BYTES): { kept: SessionStartSection[]; dropped: SessionStartSectionName[] } {
  const ordered = [...sections].filter(s => s.text).sort((a, b) => SESSION_START_SECTION_ORDER.indexOf(a.name) - SESSION_START_SECTION_ORDER.indexOf(b.name));
  const kept: SessionStartSection[] = [];
  const dropped: SessionStartSectionName[] = [];
  let used = 0;
  for (const s of ordered) {
    const bytes = Buffer.byteLength(s.text, 'utf8') + (kept.length ? 2 : 0);
    if (used + bytes > maxBytes) { dropped.push(s.name); continue; }
    kept.push(s);
    used += bytes;
  }
  return { kept, dropped };
}

/**
 * Hook outcome of the first-session section for one startup session. Distinguishes the expected ways it does not
 * arrive from an unexpected failure: not_due (the serve said no, with its reason), no_ipc (no serve answered),
 * serve_not_ready (the harness's serve did not bind in time), stale_protocol (a serve without the protocol echo),
 * unsupported (a serve without sections), deadline (the hook's own deadline), trimmed (cut from the final payload),
 * ack_failed (written, but the receipt did not land; nothing was counted), failed (anything else).
 */
export type FirstSessionOutcome = 'delivered' | 'not_due' | 'no_ipc' | 'serve_not_ready' | 'stale_protocol' | 'unsupported' | 'deadline' | 'trimmed' | 'ack_failed' | 'failed';
export interface FirstSessionOutcomeEntry { ts: string; harness: string; session: string; outcome: FirstSessionOutcome; reason?: string; retried?: true }

export const FIRST_SESSION_OUTCOME_MAX_LINES = 50;
const REASON_RE = /^[a-z0-9_]{1,40}$/;
const hashedSession = (id: string) => createHash('sha256').update(id).digest('hex').slice(0, 12);

export function firstSessionOutcomePath(): string {
  return gbrainPath('onboarding', 'first-session-hook.jsonl');
}

/** Append one redacted outcome (session id hashed, reason a code), keeping the newest FIRST_SESSION_OUTCOME_MAX_LINES. Fail-open. */
export function recordFirstSessionOutcome(entry: { harness: string; sessionId: string; outcome: FirstSessionOutcome; reason?: string; retried?: boolean; now?: Date }): void {
  try {
    const path = firstSessionOutcomePath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const line: FirstSessionOutcomeEntry = {
      ts: (entry.now ?? new Date()).toISOString(),
      harness: /^[a-z-]{1,20}$/.test(entry.harness) ? entry.harness : 'unknown',
      session: hashedSession(entry.sessionId),
      outcome: entry.outcome,
      ...(entry.reason && REASON_RE.test(entry.reason) ? { reason: entry.reason } : {}),
      ...(entry.retried ? { retried: true as const } : {}),
    };
    appendFileSync(path, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    if (lines.length > FIRST_SESSION_OUTCOME_MAX_LINES) {
      const tmp = `${path}.tmp-${process.pid}`;
      writeFileSync(tmp, `${lines.slice(-FIRST_SESSION_OUTCOME_MAX_LINES).join('\n')}\n`, { mode: 0o600 });
      renameSync(tmp, path);
    }
  } catch { /* silent-read-ok: fail-open, the outcome is diagnostic only and never blocks session start */ }
}

/** The recorded outcomes, oldest first; [] when none or unreadable. */
export function readFirstSessionOutcomes(): FirstSessionOutcomeEntry[] {
  try {
    return readFileSync(firstSessionOutcomePath(), 'utf8').split('\n').filter(Boolean).flatMap((l) => {
      try { const e = JSON.parse(l) as FirstSessionOutcomeEntry; return typeof e.outcome === 'string' && typeof e.ts === 'string' ? [e] : []; } catch { return []; } // silent-read-ok: a torn line is skipped
    });
  } catch { return []; } // silent-read-ok: no hook has recorded a startup session on this machine yet
}
