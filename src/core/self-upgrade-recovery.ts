/**
 * #6828 known-bad recovery. Before the fix, a swap that installed nothing
 * (`bun update` on a moving tag whose head was already installed) still
 * reported "swapped", the supervisor relaunched the SAME version, and the
 * boot reconcile recorded the attempted, never-installed version in
 * `self_upgrade.failed_versions`, so the auto channel skipped that release
 * forever. This module finds the entries the audit proves were never
 * installed. Clearing them is the operator step
 * `gbrain self-upgrade --clear-never-installed [--apply]`; doctor's
 * `self_upgrade_health` names its preview as the fix. File plane only.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, gbrainPath } from './config.ts';
import { readAllSelfUpgrades } from './audit/self-upgrade-audit.ts';
import { CRASH_ON_LAUNCH_REASON_PREFIX, SWAPPED_REASON } from './self-upgrade.ts';

/** The preview and apply commands of the recovery. */
export const CLEAR_NEVER_INSTALLED_PREVIEW = ['gbrain', 'self-upgrade', '--clear-never-installed'];
export const CLEAR_NEVER_INSTALLED_APPLY = [...CLEAR_NEVER_INSTALLED_PREVIEW, '--apply'];

export interface NeverInstalledEntry {
  version: string;
  /** The version that ran both before the swap and after the relaunch. */
  running: string;
  /** When the swap reported "swapped" and when the relaunch recorded the entry. */
  swapped_at: string;
  recorded_at: string;
}

/** The last upgrade gbrain recorded (`~/.gbrain/upgrade-state.json` `last_upgrade`). */
export interface LastUpgrade { from: string; to: string; ts: string }

/** The longest a pre-fix swap could run between its apply row and its `swapped` row (the swap's own timeout). */
const SWAP_WINDOW_MS = 300_000;

/**
 * The `failed_versions` entries proven never installed. The audit pair alone
 * (a `swapped` row, then a `crash-on-launch` row on the same running version)
 * is not proof: a release that installed, passed the smoke and crashed before
 * its boot reconcile, with the old version restored by hand, leaves the same
 * rows. The proof is the record the pre-fix no-op swap itself wrote:
 * `last_upgrade` with `from` and `to` both the running version, timestamped
 * between that entry's apply row and its `swapped` row. A real install writes
 * `from` != `to` there, and a later swap overwrites the record with a
 * timestamp outside the window, so only the most recent no-op can be proven.
 * An entry also needs exactly one recorded failure, and no audit row may ever
 * have run it. Anything unproven stays known-bad. Pure; `events` in ts order.
 */
export function neverInstalledFailedVersions(
  failedVersions: readonly string[],
  events: readonly { ts: string; channel: string; action: string; current: string; latest?: string | null; outcome?: string; reason?: string }[],
  lastUpgrade: LastUpgrade | null,
): NeverInstalledEntry[] {
  if (!lastUpgrade || lastUpgrade.from !== lastUpgrade.to) return [];
  const recordedAt = Date.parse(lastUpgrade.ts);
  if (!Number.isFinite(recordedAt)) return [];
  const out: NeverInstalledEntry[] = [];
  for (const version of failedVersions) {
    if (events.some((e) => e.current === version)) continue;
    const failures = events.flatMap((e, i) => (e.outcome === 'failed' && e.latest === version ? [i] : []));
    if (failures.length !== 1) continue;
    const recorded = events[failures[0]];
    if (!recorded.reason?.startsWith(CRASH_ON_LAUNCH_REASON_PREFIX) || recorded.current !== lastUpgrade.from) continue;
    const before = events.slice(0, failures[0]);
    const swapIdx = before.findLastIndex((e) => e.channel === 'autopilot' && e.latest === version && e.outcome !== undefined);
    const swap = before[swapIdx];
    if (!swap || swap.outcome !== 'applied' || swap.reason !== SWAPPED_REASON || swap.current !== recorded.current) continue;
    const start = before.slice(0, swapIdx).findLast((e) => e.channel === 'autopilot' && e.latest === version && e.outcome === undefined);
    const swappedAt = Date.parse(swap.ts);
    const windowStart = start ? Date.parse(start.ts) : swappedAt - SWAP_WINDOW_MS;
    if (!(recordedAt >= windowStart && recordedAt <= swappedAt)) continue;
    out.push({ version, running: recorded.current, swapped_at: swap.ts, recorded_at: recorded.ts });
  }
  return out;
}

/** `last_upgrade` from `~/.gbrain/upgrade-state.json` (where `gbrain upgrade` writes it), or null. */
function readLastUpgrade(): LastUpgrade | null {
  try {
    const path = gbrainPath('upgrade-state.json');
    if (!existsSync(path)) return null;
    const u = (JSON.parse(readFileSync(path, 'utf8')) as { last_upgrade?: Record<string, unknown> }).last_upgrade;
    return u && typeof u.from === 'string' && typeof u.to === 'string' && typeof u.ts === 'string' ? { from: u.from, to: u.to, ts: u.ts } : null;
  } catch {
    return null;
  }
}

/** The known-bad entries the audit proves were never installed, with the current list. */
export function findNeverInstalledFailures(): { failed: string[]; clearable: NeverInstalledEntry[] } {
  const failed = loadConfig()?.self_upgrade?.failed_versions ?? [];
  if (failed.length === 0) return { failed, clearable: [] };
  return { failed, clearable: neverInstalledFailedVersions(failed, readAllSelfUpgrades(), readLastUpgrade()) };
}

