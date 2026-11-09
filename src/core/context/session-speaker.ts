/**
 * session-speaker.ts: who wrote a captured session's user turns (#8064).
 *
 * An orchestrator that launches headless workers (`claude -p`, `codex exec`)
 * on the owner's account renders each worker's first user turn from a
 * template. Without a marker the capture lanes save that brief as the
 * owner's own preferences. ENGINE-FREE (pure fs + process reads), usable from
 * the hook command.
 *
 * `GBRAIN_SESSION_AGENT`, set by the launcher on the worker's environment:
 *   - a label (seat-label charset): the user turns are agent <label>'s. The
 *     session is banked; extraction attributes them to that agent, never to
 *     the owner.
 *   - `off`: nothing from the session is banked.
 *   - `owner`: the turns are the owner's; detection still runs, only to note
 *     (`speaker_owner_override_detected`) a session it finds agent-launched.
 *   - anything else: agent `agent`, reported as `speaker_label_invalid`.
 * Unset: detection (`detectAgentLaunched`) — a headless harness process
 * (claude `-p`/`--print`, codex `exec`) with a claude or codex process
 * among its ancestors. Headless alone is not enough: the owner scripting
 * `claude -p` is still the owner.
 *
 * Sidecar `<sessionId>.speaker.json` (0600, tmp+rename) beside the corpus
 * files, written BEFORE any corpus file of the session; the first record is
 * kept. Its absence means the owner. A resolved speaker that differs from the
 * record is noted as `speaker_mismatch` (#8080), never rewritten; an agent in
 * a session the owner already banked banks nothing (`speaker_mismatch`), since
 * a sidecar would re-attribute the owner's banked turns.
 */

import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from '../spawn.ts';
import { basename, dirname, join } from 'node:path';
import { corpusFileSessionId, SPEAKER_SIDECAR_SUFFIX, speakerFileName } from './corpus-segments.ts';

export const SESSION_AGENT_ENV = 'GBRAIN_SESSION_AGENT';
/** Principal recorded for a session detection marked as agent-launched. */
export const DETECTED_PRINCIPAL = 'agent-launched';
const LABEL_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const RESERVED = new Set(['off', 'owner']);
const ANCESTRY_MAX_DEPTH = 12;
const ANCESTRY_BUDGET_MS = 300;

export type SpeakerSource = 'env' | 'detected';
export type SessionSpeaker =
  | { kind: 'owner' }
  | { kind: 'skip' }
  | { kind: 'agent'; principal: string; source: SpeakerSource; invalid?: boolean };

export interface SpeakerSidecar {
  version: 1;
  principal: string;
  source: SpeakerSource;
  harness: string;
  first_seen: string;
}

/** One process in the hook's ancestry, nearest first: its pid and argv. */
export interface AncestorProcess { pid: number; args: string[] }

type Env = Record<string, string | undefined>;

const base = (s: string) => s.split(/[\\/]/).pop() ?? s;

/** Which harness an argv belongs to (claude-code native binary or node entry; codex), or null. */
export function harnessOfArgs(args: readonly string[]): 'claude' | 'codex' | null {
  for (const a of args.slice(0, 2)) {
    const b = base(a).toLowerCase();
    if (/^claude(\.exe)?$/.test(b) || a.includes('@anthropic-ai/claude-code')) return 'claude';
    if (/^codex(\.exe)?$/.test(b) || a.includes('@openai/codex')) return 'codex';
  }
  return null;
}

function headless(harness: 'claude' | 'codex', args: readonly string[]): boolean {
  if (harness === 'claude') return args.some((a) => a === '-p' || a === '--print' || a.startsWith('--print='));
  return args.slice(1).some((a) => a === 'exec' || a === 'e');
}

/**
 * True when the nearest harness process in `ancestry` (nearest first) runs
 * headless and another claude or codex process sits above it.
 */
export function detectAgentLaunched(ancestry: readonly AncestorProcess[]): boolean {
  const at = ancestry.findIndex((p) => harnessOfArgs(p.args) !== null);
  if (at < 0) return false;
  const harness = harnessOfArgs(ancestry[at].args)!;
  if (!headless(harness, ancestry[at].args)) return false;
  return ancestry.slice(at + 1).some((p) => harnessOfArgs(p.args) !== null);
}

function linuxParent(pid: number): AncestorProcess & { ppid: number } | null {
  const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
  const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  return Number.isInteger(ppid) ? { pid, ppid, args } : null;
}

function psParent(pid: number, timeout: number): AncestorProcess & { ppid: number } | null {
  const r = spawnSync('ps', ['-ww', '-o', 'ppid=,args=', '-p', String(pid)], { encoding: 'utf8', timeout });
  const m = /^\s*(\d+)\s+(.*)$/.exec((r.stdout ?? '').trim());
  return m ? { pid, ppid: Number(m[1]), args: m[2].split(/\s+/) } : null;
}

/** The hook's ancestors, nearest first, bounded in depth and time; a read failure ends the walk. */
export function readProcessAncestry(startPid: number = process.ppid): AncestorProcess[] {
  const out: AncestorProcess[] = [];
  const deadline = Date.now() + ANCESTRY_BUDGET_MS;
  const procfs = existsSync('/proc/self/stat');
  let pid = startPid;
  try {
    while (pid > 1 && out.length < ANCESTRY_MAX_DEPTH && Date.now() < deadline) {
      const p = procfs ? linuxParent(pid) : psParent(pid, Math.max(1, deadline - Date.now()));
      if (!p) break;
      out.push({ pid: p.pid, args: p.args });
      pid = p.ppid;
    }
  } catch { /* unreadable: what was read stands */ }
  return out;
}

/** The session's speaker from the launcher env, else detection over the (lazily read) ancestry. */
export function resolveSessionSpeaker(opts: { env: Env; ancestry?: () => readonly AncestorProcess[] }): SessionSpeaker {
  const raw = opts.env[SESSION_AGENT_ENV]?.trim().toLowerCase();
  if (raw) {
    if (raw === 'off') return { kind: 'skip' };
    if (raw === 'owner') return { kind: 'owner' };
    return LABEL_RE.test(raw) && !RESERVED.has(raw)
      ? { kind: 'agent', principal: raw, source: 'env' }
      : { kind: 'agent', principal: 'agent', source: 'env', invalid: true };
  }
  const ancestry = (opts.ancestry ?? readProcessAncestry)();
  return detectAgentLaunched(ancestry) ? { kind: 'agent', principal: DETECTED_PRINCIPAL, source: 'detected' } : { kind: 'owner' };
}

/** The recorded sidecar, or null when absent or not a valid v1 record (absent means the owner). */
export function readSpeakerSidecar(dir: string, sessionId: string): SpeakerSidecar | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, speakerFileName(sessionId)), 'utf8')) as Partial<SpeakerSidecar>;
    return parsed?.version === 1 && typeof parsed.principal === 'string' && LABEL_RE.test(parsed.principal)
      && (parsed.source === 'env' || parsed.source === 'detected') ? (parsed as SpeakerSidecar) : null;
  } catch {
    return null;
  }
}

/** Record an agent speaker unless one is recorded. Throws on a write failure (the caller then banks nothing). */
export function writeSpeakerSidecar(dir: string, sessionId: string, speaker: { principal: string; source: SpeakerSource }, harness: string): void {
  if (readSpeakerSidecar(dir, sessionId)) return;
  const record: SpeakerSidecar = { version: 1, principal: speaker.principal, source: speaker.source, harness, first_seen: new Date().toISOString() };
  const file = join(dir, speakerFileName(sessionId));
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(record) + '\n', { mode: 0o600 });
  renameSync(tmp, file);
}

/** The agent speaker of a corpus file's session (the sidecar beside the file); undefined means the owner. */
export function corpusFileSpeaker(full: string): { principal: string } | undefined {
  const sidecar = readSpeakerSidecar(dirname(full), corpusFileSessionId(basename(full)));
  return sidecar ? { principal: sidecar.principal } : undefined;
}

/** `corpusFileSpeaker` as a pipeline-context spread (`{ speaker }` or nothing). */
export function speakerOf(full: string): { speaker?: { principal: string } } {
  const speaker = corpusFileSpeaker(full);
  return speaker ? { speaker } : {};
}

/** The context note a fact from an agent session carries. */
export function speakerContextNote(principal: string): string {
  return `speaker: agent ${principal}, not the owner`;
}

/** True when the session already has corpus files in `dir` (banked as the owner's when no sidecar exists). */
function sessionHasCorpusFiles(dir: string, sessionId: string): boolean {
  const id = speakerFileName(sessionId).slice(0, -SPEAKER_SIDECAR_SUFFIX.length);
  try {
    return readdirSync(dir).some((name) => name.endsWith('.txt') && corpusFileSessionId(name) === id);
  } catch {
    return false;
  }
}

type BankDecision =
  { bank: true; reasons: string[] } | { bank: 'skip' | 'failed'; reason: 'capture_opt_out' | 'speaker_write_failed' | 'speaker_mismatch'; reasons: string[] };

/**
 * The hook's banking decision for one event: `bank: true` (an agent speaker
 * is recorded first), `'skip'` (the launcher opted out) or `'failed'` (the
 * marker could not be written, or an agent continues a session already banked
 * as the owner's, so nothing is banked rather than mixing the two). `reasons`
 * are heartbeat notes; a speaker that differs from the recorded one adds
 * `speaker_mismatch` (#8080).
 */
export function bankAsSpeaker(dir: string, sessionId: string, speaker: SessionSpeaker, harness: string): BankDecision {
  if (speaker.kind === 'skip') return { bank: 'skip', reason: 'capture_opt_out', reasons: [] };
  const recorded = readSpeakerSidecar(dir, sessionId);
  if (speaker.kind === 'owner') return { bank: true, reasons: recorded ? ['speaker_mismatch'] : [] };
  const reasons = speaker.invalid ? ['speaker_label_invalid'] : [];
  if (!recorded && sessionHasCorpusFiles(dir, sessionId)) return { bank: 'failed', reason: 'speaker_mismatch', reasons };
  if (recorded && recorded.principal !== speaker.principal) reasons.push('speaker_mismatch');
  try {
    writeSpeakerSidecar(dir, sessionId, speaker, harness);
  } catch {
    return { bank: 'failed', reason: 'speaker_write_failed', reasons };
  }
  return { bank: true, reasons };
}

/**
 * The hook's speaker and banking decision for one event. `owner` from the env
 * still runs detection, so an inherited override that hides an agent-launched
 * session is noted (`speaker_owner_override_detected`, #8080).
 */
export function hookSpeakerDecision(dir: string, sessionId: string, opts: { env: Env; ancestry?: () => readonly AncestorProcess[] }, harness: string): BankDecision {
  const decision = bankAsSpeaker(dir, sessionId, resolveSessionSpeaker(opts), harness);
  const overridden = opts.env[SESSION_AGENT_ENV]?.trim().toLowerCase() === 'owner' && detectAgentLaunched((opts.ancestry ?? readProcessAncestry)());
  return overridden ? { ...decision, reasons: [...decision.reasons, 'speaker_owner_override_detected'] } : decision;
}
