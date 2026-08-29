/**
 * Shared env resolver for the stall-watchdog knobs (#1950 sync, #4599 embed).
 * One parameterized implementation so the two surfaces' semantics cannot
 * drift: unset/empty/garbage → the caller's default; any finite number is
 * returned as-is (<= 0 disables the watchdog). Env-only incident knobs by
 * design — no config-dashboard surface.
 *
 * Lives in its own leaf module (not sync-reconcile.ts or embed-stall.ts) so
 * neither the sync nor the embed cluster has to import the other's machinery
 * just to parse an env var.
 */
export function resolveStallAbortSecondsFromEnv(
  envVar: string,
  defaultSec: number,
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env[envVar];
  if (raw === undefined || raw === '') return defaultSec;
  const n = Number(raw);
  if (!Number.isFinite(n)) return defaultSec;
  return n; // n <= 0 disables the watchdog
}
