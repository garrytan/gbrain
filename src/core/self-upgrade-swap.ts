/**
 * The autopilot self-upgrade channel's swap settlement (v0.42; #5855, #6828):
 * what `gbrain upgrade --swap-only` (run by src/commands/autopilot.ts) did.
 * Exit 0 alone cannot tell a swap from a no-op (`bun update` on a tag whose
 * head is already installed exits 0 and changes nothing), so the swap writes a
 * receipt naming what it installed (`SWAP_RECEIPT_ENV`). A receipt from
 * another run (its `from` is not the running version) is ignored, and with no
 * usable receipt the installed version is read with `gbrain --version`.
 * Outcomes:
 *
 *   - the swap's own Bun floor re-check refused (exit 78): hold, never known-bad;
 *   - the same version is still installed: clear the breadcrumb, record no
 *     known-bad, retry after AUTO_CHECK_INTERVAL_MS (`self_upgrade.last_check_ts`);
 *   - the swap failed: record known-bad the version that was installed and
 *     failed (the attempted one when nothing says what was installed); when
 *     that is not the checked version, also throttle and drop the update
 *     cache, so the next check sees the version the install channel delivers;
 *   - exit 0 and nothing proves a newer version is on disk: hold like the
 *     unchanged case, never relaunch onto an unproven swap;
 *   - a newer version is on disk: point the breadcrumb at it, so the
 *     relaunch attributes a crash-on-launch to the version that crashed, and
 *     return `relaunch`.
 *
 * Every stay outcome is persisted and audited here.
 */

import { unlinkSync } from 'node:fs';
import { gbrainPath, loadConfig, saveConfig } from './config.ts';
import { logSelfUpgrade } from './audit/self-upgrade-audit.ts';
import { BUN_FLOOR_EXIT_CODE, BUN_FLOOR_FIX } from './bun-floor.ts';
import { clearUpdateCache, readSwapReceipt, SWAP_RECEIPT_ENV } from './self-upgrade.ts';
import { isNewerVersion, isValidVersionString } from './semver.ts';
import { execSync } from './spawn.ts';

export type AutopilotSwapResult = { relaunch: false } | { relaunch: true; installed: string };

/** The receipt file for the next swap, with any stale one removed. */
export function prepareSwapReceipt(): string {
  const path = gbrainPath('swap-receipt.json');
  try { unlinkSync(path); } catch { /* absent */ }
  return path;
}

/** `gbrain --version` of the binary on PATH, or null when unreadable. */
function probeInstalledVersion(): string | null {
  try {
    const v = String(execSync('gbrain --version', { encoding: 'utf-8', timeout: 10_000, env: { ...process.env, GBRAIN_SKIP_STARTUP_HOOKS: '1' } }))
      .trim().replace(/^gbrain\s*/i, '');
    return isValidVersionString(v) ? v : null;
  } catch {
    return null;
  }
}

function holdWithoutKnownBad(running: string, latestVersion: string, reason: string, errorText?: string): AutopilotSwapResult {
  const fresh = loadConfig();
  if (fresh) {
    fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), last_check_ts: Date.now() };
    delete fresh.self_upgrade.attempting_version;
    saveConfig(fresh);
  }
  logSelfUpgrade({
    channel: 'autopilot', action: 'apply', current: running, latest: latestVersion, outcome: 'skipped',
    reason: `${reason} (${latestVersion} not recorded known-bad; next attempt in 24h)`,
    ...(errorText ? { error: errorText } : {}),
  });
  console.log(`[autopilot] self-upgrade: ${reason}; staying on ${running}, retrying in 24h.`);
  return { relaunch: false };
}

/** Settle a finished `gbrain upgrade --swap-only` (`swapError` is what it threw, or null). */
export function settleAutopilotSwap(running: string, latestVersion: string, swapError: unknown, receiptPath: string): AutopilotSwapResult {
  const raw = readSwapReceipt(receiptPath);
  try { unlinkSync(receiptPath); } catch { /* absent */ }
  const receipt = raw && raw.from === running ? raw : null;
  const errorText = swapError === null ? undefined : swapError instanceof Error ? swapError.message : String(swapError);
  const held = swapError !== null && (swapError as { status?: number }).status === BUN_FLOOR_EXIT_CODE;
  if (held) {
    logSelfUpgrade({ channel: 'autopilot', action: 'unsupported_runtime', current: running, latest: latestVersion, outcome: 'skipped', reason: `gbrain upgrade refused the swap: the Bun floor of ${latestVersion} is not met or unreadable. ${BUN_FLOOR_FIX}` });
    const fresh = loadConfig();
    if (fresh?.self_upgrade?.attempting_version) {
      delete fresh.self_upgrade.attempting_version;
      saveConfig(fresh);
    }
    console.error(`[autopilot] self-upgrade swap failed; staying on ${running}.`);
    return { relaunch: false };
  }

  const observed = receipt ? receipt.installed : probeInstalledVersion();
  if (receipt?.outcome === 'not_installed' || (!receipt && observed === running)) {
    return holdWithoutKnownBad(running, latestVersion, `nothing newer was installed: still running ${running}`, errorText);
  }
  const installed = observed && isNewerVersion(running, observed) ? observed : null;

  if (swapError !== null) {
    const bad = installed ?? latestVersion;
    const fresh = loadConfig();
    if (fresh) {
      const failed = new Set(fresh.self_upgrade?.failed_versions ?? []);
      failed.add(bad);
      fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), failed_versions: [...failed] };
      if (bad !== latestVersion) fresh.self_upgrade.last_check_ts = Date.now();
      delete fresh.self_upgrade.attempting_version;
      saveConfig(fresh);
    }
    if (bad !== latestVersion) clearUpdateCache();
    logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: running, latest: bad, outcome: 'failed', error: errorText });
    console.error(`[autopilot] self-upgrade swap failed; staying on ${running}.`);
    return { relaunch: false };
  }

  if (!installed) {
    return holdWithoutKnownBad(running, latestVersion, 'the swap exited 0 but no newer installed version could be confirmed');
  }
  if (installed !== latestVersion) {
    const fresh = loadConfig();
    if (fresh) {
      fresh.self_upgrade = { ...(fresh.self_upgrade ?? {}), attempting_version: installed };
      saveConfig(fresh);
    }
  }
  return { relaunch: true, installed };
}
