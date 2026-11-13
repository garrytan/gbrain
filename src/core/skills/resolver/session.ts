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
 *
 * Every commit (either kind) then starts a session GC pass, at most once per
 * GC_INTERVAL_MS per home (the mtime of logs/session-gc.stamp, touched when a
 * pass finishes its slice), after the commit has settled and with async I/O
 * only, so it never costs a turn's deadline; without it, past
 * MAX_SESSION_FILES new sessions would never dedupe. A short-lived process
 * (the hook lane) passes a GcBound and awaits sessionGcSettled() before it
 * exits: at most LANE_GC_FILES files, stopping at its deadline, and a pass the
 * deadline cut leaves no stamp, so the next turn tries again.
 */
import { createHash } from 'node:crypto';
import { promises, readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs';
const { mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } = promises;
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureDir, writeFileDurable } from './fsutil.ts';
import { acquireLease, type Lease, releaseLease, releaseLeaseAsync, tryAcquireLeaseAsync } from './lock.ts';
import { logsDir, sessionsDir } from './paths.ts';

export const MAX_SESSION_FILES = 10_000;
export const MAX_SESSION_IDS = 10_000;
export const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
export const GC_WORK_BOUND = 1000;
export const GC_INTERVAL_MS = 10 * 60 * 1000;
export const LANE_GC_FILES = 64;

/** A GC pass for a short-lived process: at most `files` files, none started after `until` (performance.now()). */
export interface GcBound { files: number; until: number }
const gcStamp = (home: string) => join(logsDir(home), 'session-gc.stamp');
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
  /** Hermes: the conversation history length the last committed turn saw (a shorter one means Hermes compacted in place). */
  history?: number;
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
    return { v: 1, turn: s.turn, spent: s.spent, last: s.last, again: s.again && typeof s.again === 'object' ? s.again : {}, ...historyOf(s) };
  } catch {
    return freshState();
  }
}

export interface TurnDelta { tokens: number; suggested: string[]; resuggested: string[]; reset: boolean; history?: number }

const historyOf = (s: { history?: unknown }) => (Number.isSafeInteger(s.history) && (s.history as number) >= 0 ? { history: s.history as number } : {});

/**
 * Whether a Hermes turn must start the session fresh: Hermes compacts in
 * place (same session id) and sends hooks no compaction event, so a history
 * shorter than the one the last committed turn saw is the compaction. A
 * session with no stored length (a new one, or state from before this field)
 * or a turn whose length is unknown never resets.
 */
export async function historyShrank(home: string, key: string, length: number | undefined): Promise<boolean> {
  if (length === undefined) return false;
  try {
    const p = statePath(home, key);
    if ((await stat(p)).size > STATE_CAP_BYTES) return false;
    const stored = historyOf(JSON.parse(await readFile(p, 'utf8')) as { history?: unknown }).history;
    return stored !== undefined && length < stored;
  } catch {
    return false;
  }
}

/** Apply one delivered turn. False when the commit was skipped (busy lock, file cap). */
export async function commitSession(home: string, key: string, delta: TurnDelta): Promise<boolean> {
  try { return await commitSync(home, key, delta); } finally { scheduleSessionGc(home); }
}

async function commitSync(home: string, key: string, delta: TurnDelta): Promise<boolean> {
  const dir = sessionsDir(home);
  ensureDir(dir);
  const p = statePath(home, key);
  let exists = true;
  try { statSync(p); } catch { exists = false; }
  if (!exists) { try { if (readdirSync(dir).length >= MAX_SESSION_FILES) return false; } catch { return false; } }
  let lease;
  try { lease = await acquireLease(`${p}.lock`, { purpose: 'session-commit', leaseMs: 2000, retries: 3, waitMs: 5 }); } catch { return false; }
  try {
    writeFileDurable(p, JSON.stringify(applyDelta(delta.reset ? freshState() : loadSession(home, key), delta)));
    return true;
  } finally {
    releaseLease(lease);
  }
}

function applyDelta(s: SessionState, delta: TurnDelta): SessionState {
  s.turn += 1;
  s.spent += delta.tokens;
  for (const id of delta.resuggested) s.again[id] = 1;
  for (const id of delta.suggested) if (id in s.last || Object.keys(s.last).length < MAX_SESSION_IDS) s.last[id] = s.turn;
  if (delta.history !== undefined) s.history = delta.history;
  return s;
}

/**
 * commitSession with async I/O only (no sync file call), for the hook lane,
 * whose event loop owns its deadline. Same file, lease and rules; a busy
 * lease is retried a few times over at most ~15 ms, then the commit is
 * skipped (a skipped commit only means a repeat).
 */
export interface CommitHold { lease?: Lease | null; tmp?: string | null; at?: (stage: 'held' | 'written') => Promise<void> }

export async function commitSessionAsync(home: string, key: string, delta: TurnDelta, hold: CommitHold = {}, gc?: GcBound): Promise<boolean> {
  try { return await commitAsync(home, key, delta, hold); } finally { scheduleSessionGc(home, gc); }
}

async function commitAsync(home: string, key: string, delta: TurnDelta, hold: CommitHold): Promise<boolean> {
  const dir = sessionsDir(home);
  const p = statePath(home, key);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    let exists = true;
    try { await stat(p); } catch { exists = false; }
    if (!exists && (await readdir(dir)).length >= MAX_SESSION_FILES) return false;
    let lease = null;
    for (let attempt = 0; attempt < 4 && !lease; attempt++) {
      lease = await tryAcquireLeaseAsync(`${p}.lock`, { purpose: 'session-commit', leaseMs: 2000 });
      if (!lease && attempt < 3) await new Promise(r => setTimeout(r, 2 ** attempt * 2));
    }
    if (!lease) return false;
    hold.lease = lease;
    try {
      await hold.at?.('held');
      let s = freshState();
      if (!delta.reset) {
        try {
          if ((await stat(p)).size <= STATE_CAP_BYTES) {
            const raw = JSON.parse(await readFile(p, 'utf8')) as SessionState;
            if (raw?.v === 1 && typeof raw.turn === 'number' && typeof raw.spent === 'number' && raw.last && typeof raw.last === 'object') s = { v: 1, turn: raw.turn, spent: raw.spent, last: raw.last, again: raw.again && typeof raw.again === 'object' ? raw.again : {}, ...historyOf(raw) };
          }
        } catch { /* none or unreadable: fresh */ }
      }
      const tmp = join(dir, `.${key}.json.tmp-${randomBytes(6).toString('hex')}`);
      hold.tmp = tmp;
      const fh = await open(tmp, 'wx', 0o600);
      try { await fh.writeFile(JSON.stringify(applyDelta(s, delta))); await fh.sync(); } finally { await fh.close(); }
      await hold.at?.('written');
      try { await rename(tmp, p); } catch (e) { await unlink(tmp).catch(() => {}); throw e; } finally { hold.tmp = null; }
      return true;
    } finally {
      await releaseLeaseAsync(lease);
      hold.lease = null;
    }
  } catch {
    return false;
  }
}

export async function resetSession(home: string, key: string): Promise<void> {
  try { await unlink(statePath(home, key)); } catch { /* none */ }
}

/** At most `bound` of a directory's names, from a random start once there are more. */
function gcSlice(names: string[], bound = GC_WORK_BOUND): string[] {
  const start = names.length > bound ? Math.floor(Math.random() * names.length) : 0;
  return Array.from({ length: Math.min(names.length, bound) }, (_, i) => names[(start + i) % names.length]!);
}

/** Delete session files idle for 7 days, examining at most GC_WORK_BOUND files per run. */
export function gcSessions(home: string, now: number = Date.now()): number {
  let removed = 0;
  let names: string[];
  try { names = readdirSync(sessionsDir(home)); } catch { return 0; }
  for (const name of gcSlice(names)) {
    const p = join(sessionsDir(home), name);
    try { if (now - statSync(p).mtimeMs > SESSION_TTL_MS) { unlinkSync(p); removed++; } } catch { /* raced */ }
  }
  return removed;
}

/**
 * gcSessions with async I/O only. An idle session file is deleted only under
 * its commit lease and after a second stat, so a commit landing between the
 * first stat and the unlink keeps its file; a held lease skips it. A pass
 * that finishes its slice touches the GC stamp, so the commit-path pass skips
 * the next interval; a bounded pass its deadline cut does not.
 */
export async function gcSessionsAsync(home: string, now: number = Date.now(), bound?: GcBound): Promise<number> {
  const dir = sessionsDir(home);
  let names: string[];
  try { names = await readdir(dir); } catch { return 0; }
  let removed = 0;
  const idle = async (p: string) => now - (await stat(p)).mtimeMs > SESSION_TTL_MS;
  for (const name of gcSlice(names, bound?.files)) {
    if (bound && performance.now() > bound.until) return removed;
    const p = join(dir, name);
    try {
      if (!(await idle(p))) continue;
      if (!name.endsWith('.json')) { await unlink(p); removed++; continue; }
      const lease = await tryAcquireLeaseAsync(`${p}.lock`, { purpose: 'session-gc', leaseMs: 2000 });
      if (!lease) continue;
      try { if (await idle(p)) { await unlink(p); removed++; } } finally { await releaseLeaseAsync(lease); }
    } catch { /* raced */ }
  }
  try {
    await mkdir(logsDir(home), { recursive: true, mode: 0o700 });
    await writeFile(gcStamp(home), '', { mode: 0o600 });
  } catch { /* unwritable: the next commit tries again */ }
  return removed;
}

let gcPass: Promise<number> | null = null;

/** Start a GC pass once the current task ends, unless one finished in this home within GC_INTERVAL_MS. Never throws; a long-lived host never waits on it. */
export function scheduleSessionGc(home: string, bound?: GcBound): void {
  const prev = gcPass;
  gcPass = new Promise<void>(r => setImmediate(r)).then(async () => {
    await prev;
    try { if (Date.now() - (await stat(gcStamp(home))).mtimeMs < GC_INTERVAL_MS) return 0; } catch { /* none yet */ }
    return gcSessionsAsync(home, Date.now(), bound);
  }).catch(() => 0);
}

/** Resolves once the GC passes started so far have finished (tests, and the hook lane before it exits). */
export const sessionGcSettled = async (): Promise<void> => { await gcPass; };
