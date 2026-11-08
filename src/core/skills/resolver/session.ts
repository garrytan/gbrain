/**
 * Per-session dedupe and budget state: `skill-index/sessions/<key>.json`,
 * keyed by sha256(scope, harness, session id) and never by catalog, so a
 * session merging a user and a project catalog has one no-repeat set and
 * one budget. The file holds canonical skill ids and turn counters only:
 * no turn text, no clock.
 *
 * Preparing a turn reads the state; committing it is separate and happens
 * only after the caller confirms delivery (the CLI after stdout is written,
 * the library through commit()). Shadow mode uses its own scope, so its
 * recorded blocks follow the same rules without touching real state.
 * Commits are serialized per file under a short lease with a bounded wait;
 * a lost commit only means a skill may be suggested again.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, writeFileDurable } from './fsutil.ts';
import { acquireLease, releaseLease } from './lock.ts';
import { sessionsDir } from './paths.ts';

export const MAX_SESSION_FILES = 10_000;
export const MAX_SESSION_IDS = 10_000;
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const GC_WORK_BOUND = 1000;
const STATE_CAP_BYTES = 2 * 1024 * 1024;

export interface SessionState {
  v: 1;
  /** Turns committed so far. */
  turn: number;
  /** Block tokens delivered so far. */
  spent: number;
  /** Skill id -> the turn it was last suggested. */
  last: Record<string, number>;
  /** Skill ids already re-suggested once. */
  again: Record<string, 1>;
}

export const freshState = (): SessionState => ({ v: 1, turn: 0, spent: 0, last: {}, again: {} });

export function sessionKey(scope: 'on' | 'shadow', harness: string | undefined, sessionId: string): string {
  return createHash('sha256').update(JSON.stringify(['gbrain-skill-resolver-session', 1, scope, harness ?? '', sessionId])).digest('hex');
}

const statePath = (home: string, key: string) => join(sessionsDir(home), `${key}.json`);

export function loadSession(home: string, key: string): SessionState {
  try {
    const p = statePath(home, key);
    if (statSync(p).size > STATE_CAP_BYTES) return freshState();
    const s = JSON.parse(readFileSync(p, 'utf8')) as SessionState;
    if (s?.v !== 1 || typeof s.turn !== 'number' || typeof s.spent !== 'number' || !s.last || typeof s.last !== 'object') return freshState();
    return { v: 1, turn: s.turn, spent: s.spent, last: s.last, again: s.again && typeof s.again === 'object' ? s.again : {} };
  } catch {
    return freshState();
  }
}

export interface TurnDelta { tokens: number; suggested: string[]; resuggested: string[]; reset: boolean }

/** Apply one delivered turn. False when the commit was skipped (busy lock, file cap). */
export async function commitSession(home: string, key: string, delta: TurnDelta): Promise<boolean> {
  const dir = sessionsDir(home);
  ensureDir(dir);
  const p = statePath(home, key);
  let exists = true;
  try { statSync(p); } catch { exists = false; }
  if (!exists) { try { if (readdirSync(dir).length >= MAX_SESSION_FILES) return false; } catch { return false; } }
  let lease;
  try { lease = await acquireLease(`${p}.lock`, { purpose: 'session-commit', leaseMs: 2000, retries: 3, waitMs: 5 }); } catch { return false; }
  try {
    const s = delta.reset ? freshState() : loadSession(home, key);
    s.turn += 1;
    s.spent += delta.tokens;
    for (const id of delta.resuggested) s.again[id] = 1;
    for (const id of delta.suggested) if (id in s.last || Object.keys(s.last).length < MAX_SESSION_IDS) s.last[id] = s.turn;
    writeFileDurable(p, JSON.stringify(s));
    return true;
  } finally {
    releaseLease(lease);
  }
}

export async function resetSession(home: string, key: string): Promise<void> {
  try { unlinkSync(statePath(home, key)); } catch { /* none */ }
}

/** Delete session files idle for 7 days, examining at most GC_WORK_BOUND files per run. */
export function gcSessions(home: string, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(sessionsDir(home)); } catch { return 0; }
  const start = names.length > GC_WORK_BOUND ? Math.floor(Math.random() * names.length) : 0;
  for (let i = 0; i < Math.min(names.length, GC_WORK_BOUND); i++) {
    const p = join(sessionsDir(home), names[(start + i) % names.length]!);
    try { if (now - statSync(p).mtimeMs > SESSION_TTL_MS) { unlinkSync(p); removed++; } } catch { /* raced */ }
  }
  return removed;
}
