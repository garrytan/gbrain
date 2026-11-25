/**
 * The shadow replay lock and the one destructive delete of shadow capture state (docs/guides/shadow-capture.md).
 * The lock lives in `<shadow dir>/replay/lock`; the nightly replay holds it for its whole run, and every destructive
 * delete takes it first, so a delete never runs while a replay reads or writes the same files.
 */
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, rmdirSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { processAlive } from './capture.ts';
import { captureDir } from './capture-state.ts';
import { ReplayError } from './replay-errors.ts';

/**
 * Takes the replay lock: created exclusively (the token is linked into place, so it is never seen empty). The holder
 * writes its own deadline. A lock is never taken over automatically, even a stale one: two contenders could both
 * judge it stale and both enter. The error names a stale lock's file for an operator to remove. Unlock removes the
 * lock only while it still holds this caller's token.
 */
export function acquireReplayLock(dir: string, budgetMs: number): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, 'lock');
  const token = `${process.pid} ${Date.now() + budgetMs + 30 * 60_000} ${randomBytes(6).toString('hex')}\n`;
  const unlock = () => { if (lockHolder(path) === token) rmSync(path, { force: true }); };
  if (createLock(path, token)) return unlock;
  const [pid, deadline] = (lockHolder(path) ?? '').split(' ').map(Number);
  const stale = Date.now() >= (deadline ?? 0) && !processAlive(pid);
  throw new ReplayError('shadow_replay_busy', stale ? `stale lock ${path}: no replay holds it; remove it, then rerun` : `lock ${path}`);
}

function createLock(path: string, token: string): boolean {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', 0o600);
  try { writeSync(fd, token); } finally { closeSync(fd); }
  try { linkSync(tmp, path); return true; } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw e;
  } finally { rmSync(tmp, { force: true }); }
}

function lockHolder(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * THE destructive delete (`capture delete`, `engine shadow stop --delete`): the replay lock first (shadow_replay_busy
 * while a replay runs), then the data (`whole`: the brain's whole shadow folder). Returns what it deleted.
 */
export function deleteReplayState(shadowDir: string, opts: { whole: boolean; keep?: string[] }): string[] {
  const replayDir = join(shadowDir, 'replay');
  const cap = captureDir(shadowDir);
  const unlock = acquireReplayLock(replayDir, 0);
  const gone: string[] = [];
  try {
    const rm = (p: string) => { rmSync(p, { recursive: true, force: true }); gone.push(p); };
    if (opts.whole) { for (const f of readdirSync(shadowDir)) if (f !== 'replay' && !opts.keep?.includes(f)) rm(join(shadowDir, f)); }
    else if (existsSync(cap)) { for (const f of readdirSync(cap)) if (f !== 'state.json' && f !== 'off') rm(join(cap, f)); }
    for (const f of readdirSync(replayDir)) if (f !== 'lock') rm(join(replayDir, f));
    return gone;
  } finally {
    unlock();
    if (opts.whole) for (const d of [replayDir, shadowDir]) { try { rmdirSync(d); } catch { /* a new run's lock appeared: it stays */ } }
  }
}
