/**
 * pi-sweep.ts — recover pi sessions that never ran session-end.
 *
 * pi's `session_shutdown` (the gbrain extension's session-end trigger) does
 * not fire when pi is SIGKILLed, crashes, or the terminal is closed out from
 * under it, so those sessions never reach the dream corpus. The hook lane's
 * `discoverPiSessionFile` is deliberately id-matched only (no newest-file
 * guess), so nothing else picks them up either.
 *
 * At every pi session-start, `findPiSweepCandidates` lists session files in
 * pi's store that:
 *   - are not the session now starting,
 *   - were modified within `maxAgeMs` (default 7 days — inside the corpus
 *     retention window, so a pruned corpus file is never re-created),
 *   - have been idle at least `idleMs` (default 30 minutes — pi appends to the
 *     file on every entry, so a session live in another terminal is skipped),
 *   - have no corpus file for their session id, or one OLDER than the session
 *     file (a resumed session that was then killed),
 *   - and were not already attempted at this exact mtime (`pi-sweep.json`), so
 *     a file whose capture always degrades is not retried every start.
 * Newest first, at most `limit` (default 3) per start.
 *
 * The caller hands each candidate to the ordinary `gbrain hook session-end
 * --harness pi` path in a detached child, so secret scanning, the seat
 * sidecar and corpus pruning are exactly the normal capture's. Engine-free
 * (hook.ts imports this); every failure is swallowed.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const PI_SWEEP_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const PI_SWEEP_IDLE_MS = 30 * 60 * 1000;
export const PI_SWEEP_LIMIT = 3;
/** Bounds the store walk: pi nests one cwd-slug directory deep. */
const MAX_FILES_SCANNED = 2000;

export interface PiSweepCandidate {
  sessionId: string;
  path: string;
  mtimeMs: number;
}

export interface PiSweepOpts {
  sessionsDir: string;
  corpusDir: string;
  /** File recording `{ "<path>": <mtimeMs> }` already handed to session-end. */
  stateFile: string;
  currentSessionId?: string;
  now?: number;
  maxAgeMs?: number;
  idleMs?: number;
  limit?: number;
}

/** Same rule as hook.ts sanitizeSessionId (the corpus file name). */
function corpusName(id: string): string {
  const s = id.replace(/[^A-Za-z0-9._-]/g, '-').replace(/^-+/, '').slice(0, 120);
  return s && !/^\.+$/.test(s) ? s : 'unknown';
}

/** The `{type:"session", id}` header on line 1, read without loading the file. */
function headerSessionId(path: string): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(4096);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const first = buf.subarray(0, n).toString('utf8').split('\n', 1)[0]?.trim();
    if (!first) return null;
    const obj = JSON.parse(first) as { type?: unknown; id?: unknown };
    return obj.type === 'session' && typeof obj.id === 'string' && obj.id ? obj.id : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* noop */ }
  }
}

function readState(path: string): Record<string, number> {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Session files directly in the store or one cwd-slug directory down; symlinks skipped. */
function listSessionFiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, depth: number) => {
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (out.length >= MAX_FILES_SCANNED) return;
      const p = join(dir, name);
      let st;
      try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory() && depth === 0) visit(p, 1);
      else if (st.isFile() && name.endsWith('.jsonl')) out.push(p);
    }
  };
  visit(root, 0);
  return out;
}

export function findPiSweepCandidates(opts: PiSweepOpts): PiSweepCandidate[] {
  const now = opts.now ?? Date.now();
  const maxAge = opts.maxAgeMs ?? PI_SWEEP_MAX_AGE_MS;
  const idle = opts.idleMs ?? PI_SWEEP_IDLE_MS;
  const limit = opts.limit ?? PI_SWEEP_LIMIT;
  const attempted = readState(opts.stateFile);
  const fresh: Array<{ path: string; mtimeMs: number }> = [];
  for (const path of listSessionFiles(opts.sessionsDir)) {
    let mtimeMs: number;
    try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
    const age = now - mtimeMs;
    if (age > maxAge || age < idle) continue;
    if (attempted[path] === mtimeMs) continue;
    fresh.push({ path, mtimeMs });
  }
  fresh.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out: PiSweepCandidate[] = [];
  for (const f of fresh) {
    if (out.length >= limit) break;
    const sessionId = headerSessionId(f.path);
    if (!sessionId || sessionId === opts.currentSessionId) continue;
    const corpus = join(opts.corpusDir, `${corpusName(sessionId)}.txt`);
    try {
      if (existsSync(corpus) && statSync(corpus).mtimeMs >= f.mtimeMs) continue;
    } catch { /* unreadable corpus file: treat as missing */ }
    out.push({ sessionId, path: f.path, mtimeMs: f.mtimeMs });
  }
  return out;
}

/** Record candidates as attempted (best-effort; entries for vanished files are dropped). */
export function markPiSweepAttempted(stateFile: string, candidates: PiSweepCandidate[]): void {
  if (candidates.length === 0) return;
  try {
    const state = readState(stateFile);
    for (const c of candidates) state[c.path] = c.mtimeMs;
    for (const p of Object.keys(state)) if (!existsSync(p)) delete state[p];
    const dir = join(stateFile, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${stateFile}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, stateFile);
  } catch { /* a lost state file only means one more attempt */ }
}

/**
 * Hand each candidate to `gbrain hook session-end --harness pi` in a detached
 * child (same re-exec rule as hook.ts's detached push: a compiled binary is
 * its own entrypoint, a dev checkout re-execs process.argv[1]). Never throws.
 */
export function spawnDetachedPiSessionEnd(payload: string): void {
  const exec = process.execPath ?? '';
  const args = ['hook', 'session-end', '--harness', 'pi'];
  const argv = /[/\\]gbrain(\.exe)?$/.test(exec) ? args : [process.argv[1] ?? '', ...args];
  const child = spawn(exec, argv, { detached: true, stdio: ['pipe', 'ignore', 'ignore'], env: process.env });
  child.on('error', () => {});
  child.stdin?.on('error', () => {});
  child.stdin?.end(payload);
  child.unref();
}

/** The session-start entry point. `GBRAIN_PI_SWEEP=0` disables it. Never throws. */
export function sweepPiSessions(o: {
  home: string;
  sessionsDir: string;
  corpusDir: string;
  currentSessionId: unknown;
  spawn?: (payload: string) => void;
  now?: number;
}): PiSweepCandidate[] {
  if (process.env.GBRAIN_PI_SWEEP === '0') return [];
  try {
    const stateFile = join(o.home, 'hooks', 'pi-sweep.json');
    const found = findPiSweepCandidates({
      sessionsDir: o.sessionsDir, corpusDir: o.corpusDir, stateFile, now: o.now,
      currentSessionId: typeof o.currentSessionId === 'string' ? o.currentSessionId : undefined,
    });
    markPiSweepAttempted(stateFile, found);
    const send = o.spawn ?? spawnDetachedPiSessionEnd;
    for (const c of found) {
      try {
        send(JSON.stringify({ hook_event_name: 'SessionEnd', session_id: c.sessionId, transcript_path: c.path, reason: 'gbrain_sweep' }));
      } catch { /* one failed spawn must not stop the rest */ }
    }
    return found;
  } catch {
    return []; // fail open: a backstop, never a session-start blocker
  }
}
