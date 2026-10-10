/** Filesystem-only setup mutex. Never reclaims an unknown or live owner. */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { atomicWriteTextFile } from '../bootstrap/atomic-write.ts';
import { assertNoSymlinks } from '../agent-install/state.ts';

export const HERMES_SETUP_LOCK_STALE_MS = 120_000;
interface Owner { pid: number; host: string; acquired_at: number; token: string }
function ownerAt(path: string): Owner | null {
  try {
    assertNoSymlinks(join(path, 'owner.json'));
    const value = JSON.parse(readFileSync(join(path, 'owner.json'), 'utf8'));
    return Number.isInteger(value.pid) && value.pid > 0 && typeof value.host === 'string' &&
      Number.isFinite(value.acquired_at) && typeof value.token === 'string' && value.token ? value : null;
  } catch { return null; }
}
function provablyDead(owner: Owner): boolean {
  if (owner.host !== hostname()) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

export function acquireHermesSetupLock(path: string): { release(): void } {
  assertNoSymlinks(path);
  let made = false;
  try { mkdirSync(path, { mode: 0o700 }); made = true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = ownerAt(path);
    if (!owner || Date.now() - owner.acquired_at <= HERMES_SETUP_LOCK_STALE_MS || !provablyDead(owner)) {
      throw new Error('configuration_conflict: Hermes setup lock owner is live or unverified; preserve the receipt and retry after verifying the owner');
    }
    // Only one contender may move a stale generation. Never remove by the
    // original path after rename: another process may already own that name.
    const guard = `${path}.reap`;
    assertNoSymlinks(guard);
    try { mkdirSync(guard, { mode: 0o700 }); }
    catch { throw new Error('configuration_conflict: Hermes setup lock recovery is already in progress'); }
    const tombstone = `${path}.dead-${owner.token.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 80)}`;
    try {
      const current = ownerAt(path);
      if (!current || current.token !== owner.token || !provablyDead(current)) throw new Error('configuration_conflict: Hermes setup lock owner changed');
      assertNoSymlinks(tombstone);
      if (existsSync(tombstone)) throw new Error('configuration_conflict: preserve the prior Hermes lock recovery artifact');
      renameSync(path, tombstone);
      rmSync(tombstone, { recursive: true });
      try { mkdirSync(path, { mode: 0o700 }); made = true; }
      catch { throw new Error('configuration_conflict: another Hermes setup acquired the recovered profile lock'); }
    } finally { rmSync(guard, { recursive: true }); }
  }
  const token = randomUUID();
  try {
    atomicWriteTextFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), acquired_at: Date.now(), token }), { forceMode: 0o600 });
  } catch (error) {
    if (made) rmSync(path, { recursive: true });
    throw error;
  }
  return { release() {
    if (ownerAt(path)?.token === token) rmSync(path, { recursive: true });
  } };
}
