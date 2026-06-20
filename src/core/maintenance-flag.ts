/**
 * Maintenance window flag — lets the dream cycle claim EXCLUSIVE access to the
 * single-connection PGLite engine.
 *
 * PGLite is a single-writer WASM Postgres. When a dream cycle (especially the
 * slow propose_takes phase) runs, a concurrently-spawned `gbrain serve` (MCP
 * server, auto-launched by an assistant's MCP client) either holds the lock and
 * starves the cycle (the cycle times out acquiring the lock → "Timed out waiting
 * for PGLite lock" → degrades to filesystem-only) or piles up as blocked
 * processes pressuring memory. Either way the dream cannot run reliably while
 * serves contend.
 *
 * Fix: `gbrain dream` writes this flag for the duration of its cycle. `gbrain
 * serve` checks it at startup and DEFERS (releases the lock + exits 0) when a
 * cycle is active, so the cycle gets exclusive access. The MCP client respawns
 * the serve after the (twice-daily, time-bounded) cycle clears the flag. A TTL
 * backstop means a crashed cycle never wedges serves forever.
 */
import { writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const flagPath = (): string => join(homedir(), '.gbrain', '.maintenance');
/** Backstop: a flag older than this is treated as stale (crashed cycle). */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 60 minutes

/** Claim the maintenance window for `ttlMs` (best-effort; never throws). */
export function setMaintenance(ttlMs = DEFAULT_TTL_MS): void {
  try {
    mkdirSync(join(homedir(), '.gbrain'), { recursive: true });
    writeFileSync(
      flagPath(),
      JSON.stringify({ pid: process.pid, started_at: Date.now(), expires_at: Date.now() + ttlMs }),
    );
  } catch {
    /* best-effort — a missing flag just means serves don't defer */
  }
}

/** Release the maintenance window (best-effort; never throws). */
export function clearMaintenance(): void {
  try {
    rmSync(flagPath(), { force: true });
  } catch {
    /* best-effort */
  }
}

/** True iff a dream cycle currently holds the maintenance window (fresh flag). */
export function isMaintenanceActive(): boolean {
  try {
    if (!existsSync(flagPath())) return false;
    const j = JSON.parse(readFileSync(flagPath(), 'utf8')) as { expires_at?: unknown };
    if (typeof j.expires_at === 'number' && Date.now() > j.expires_at) return false; // stale
    return true;
  } catch {
    return false;
  }
}
