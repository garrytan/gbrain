/**
 * Upgrade trail checks: `upgrade_errors` (post-upgrade failure ledger with the
 * #4517 superseded-record re-verification), `self_upgrade_health` and
 * `bun_runtime`.
 * Peeled verbatim from doctor.ts (refactor wave 1, W4 doctor); doctor.ts
 * re-exports every symbol under its original name.
 */

import { existsSync, readFileSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import { gbrainPath } from '../../../core/config.ts';
import { LATEST_VERSION } from '../../../core/migrate.ts';
import { MINIMUM_BUN_VERSION, SECURE_BUN_VERSION, bunVersionMeets, unsupportedBunMessage } from '../../../core/runtime-version.ts';
import { isNewerVersion, isValidVersionString } from '../../../core/semver.ts';
import type { SelfUpgradeAction } from '../../../core/self-upgrade.ts';
import type { SelfUpgradeAuditEvent } from '../../../core/audit/self-upgrade-audit.ts';
import { VERSION as GBRAIN_BINARY_VERSION } from '../../../version.ts';
import type { Check } from '../../doctor.ts';
import { agentFix, doctorVerify } from '../check-fix.ts';

/**
 * #4517: is the latest upgrade-errors.jsonl record superseded? True when the
 * running binary version is at/past the version the failed upgrade was moving
 * to AND the schema ledger is current (no pending migrations) — i.e. a later
 * (or retried) upgrade demonstrably finished the job. Pure + exported for
 * tests. Compares ALL dot-segments (the canonical `compareVersions` stops at
 * 3, which would treat 0.31.4.1 == 0.31.4.0); a malformed version fails
 * closed (keeps warning), except a non-version target with a `from` version.
 */
export function upgradeErrorResolved(
  failedToVersion: string,
  binaryVersion: string,
  schemaCurrent: boolean,
  failedFromVersion?: string,
): boolean {
  if (!schemaCurrent) return false;
  if (typeof failedToVersion !== 'string' || typeof binaryVersion !== 'string') return false;
  // #6718: a record with no installable target (`latest` from a pinned install
  // with no newer published tag, `unknown` from a binary swap) can never be
  // reached; the binary moving past the version it failed FROM supersedes it.
  if (!isValidVersionString(failedToVersion) && typeof failedFromVersion === 'string') {
    return isNewerVersion(failedFromVersion, binaryVersion);
  }
  const a = binaryVersion.replace(/^v/, '').split('.');
  const b = failedToVersion.replace(/^v/, '').split('.');
  if (a.length === 0 || b.length === 0) return false;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const da = parseInt(a[i] ?? '0', 10);
    const db = parseInt(b[i] ?? '0', 10);
    if (!Number.isFinite(da) || !Number.isFinite(db) || Number.isNaN(da) || Number.isNaN(db)) return false;
    if (da > db) return true;
    if (da < db) return false;
  }
  return true; // equal → the failed target version is now running
}

/**
 * #5855: the auto-upgrade the newest autopilot event holds for the Bun floor,
 * while its target is still newer than the running binary (a later apply, or
 * a manual upgrade to the target, ends the hold); null otherwise. `recent` is
 * in ts order.
 */
function heldAutoUpgrade(recent: SelfUpgradeAuditEvent[], runningVersion: string): SelfUpgradeAuditEvent | null {
  const last = recent.filter((e) => e.channel === 'autopilot').at(-1);
  if (last?.action !== ('unsupported_runtime' satisfies SelfUpgradeAction) || !last.latest) return null;
  return isNewerVersion(runningVersion, last.latest) ? last : null;
}

/**
 * v0.42 self_upgrade_health. Surfaces the self-upgrade mode, whether an update
 * is pending (from the cache), an auto-upgrade held for the Bun floor (#5855),
 * and any recent failed auto-upgrade attempts. File-plane only (no DB) so it
 * runs on thin clients. Warn on a held auto-upgrade or recent failures,
 * otherwise ok.
 */
export function checkSelfUpgradeHealth(): Check {
  try {
    const { loadConfig } = require('../../../core/config.ts');
    const {
      resolveSelfUpgradeMode,
      pendingUpgradeVersion,
    } = require('../../../core/self-upgrade.ts');
    const { readRecentSelfUpgrades } = require('../../../core/audit/self-upgrade-audit.ts');

    const cfg = loadConfig();
    const mode = resolveSelfUpgradeMode(cfg);
    if (mode === 'off') {
      return {
        name: 'self_upgrade_health',
        status: 'ok',
        message: 'Self-upgrade disabled (mode=off). Enable: gbrain config set self_upgrade.mode notify',
      };
    }

    const parts: string[] = [`mode=${mode}`];
    // Shared stale/foreign-cache guard: only report an upgrade strictly newer
    // than the RUNNING binary (pendingUpgradeVersion owns the rule).
    const pendingLatest = pendingUpgradeVersion(GBRAIN_BINARY_VERSION, Date.now());
    if (pendingLatest) {
      parts.push(`update available: ${GBRAIN_BINARY_VERSION} -> ${pendingLatest} (run: gbrain self-upgrade)`);
    }
    const failedVersions: string[] = cfg?.self_upgrade?.failed_versions ?? [];
    if (failedVersions.length > 0) {
      parts.push(`skipping known-bad: ${failedVersions.join(', ')}`);
    }

    // #6828: a known-bad entry the audit proves was never installed blocks
    // that release forever; the fix is the preview of the clearing step.
    if (failedVersions.length > 0) {
      const { findNeverInstalledFailures, CLEAR_NEVER_INSTALLED_PREVIEW, CLEAR_NEVER_INSTALLED_APPLY } = require('../../../core/self-upgrade-recovery.ts');
      const { clearable } = findNeverInstalledFailures() as { clearable: Array<{ version: string; running: string }> };
      if (clearable.length > 0) {
        const versions = clearable.map((e) => e.version).join(', ');
        return {
          name: 'self_upgrade_health',
          status: 'warn',
          message: `Auto-upgrade skips ${versions} as known-bad, but ${clearable.length === 1 ? 'it was' : 'they were'} never installed: a swap that installed nothing was reported as swapped (#6828) (${parts.join('; ')}).`,
          fix: agentFix([...CLEAR_NEVER_INSTALLED_PREVIEW, '--json'],
            'The preview lists each entry with the swap that recorded it and changes nothing; its --apply removes exactly those entries.',
            'self_upgrade_health', {
              docs: 'docs/guides/upgrades-auto-update.md#known-bad-never-installed',
              then: agentFix([...CLEAR_NEVER_INSTALLED_APPLY],
                'Removes exactly the entries the preview proved were never installed; gbrain config set self_upgrade.failed_versions puts one back.',
                'self_upgrade_health'),
            }),
        };
      }
    }

    // readRecent lists the current week before the previous one; order by ts.
    const recent = (readRecentSelfUpgrades(7) as SelfUpgradeAuditEvent[])
      .toSorted((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    const held = heldAutoUpgrade(recent, GBRAIN_BINARY_VERSION);
    if (held) {
      return {
        name: 'self_upgrade_health',
        status: 'warn',
        message: `Auto-upgrade to ${held.latest} held: ${held.reason ?? 'Bun floor not met'} (${parts.join('; ')}).`,
      };
    }
    const failures = recent.filter((e) => e.outcome === 'failed');
    if (failures.length > 0) {
      const last = failures[failures.length - 1];
      return {
        name: 'self_upgrade_health',
        status: 'warn',
        message:
          `${failures.length} self-upgrade failure(s) in 7d (${parts.join('; ')}). ` +
          `Last: ${last.latest ?? '?'}${last.error ? ` — ${last.error}` : ''}. ` +
          `Check ~/.gbrain/upgrade-errors.jsonl; apply manually with gbrain self-upgrade.`,
      };
    }

    return { name: 'self_upgrade_health', status: 'ok', message: parts.join('; ') };
  } catch (e) {
    return {
      name: 'self_upgrade_health',
      status: 'ok',
      message: `Self-upgrade status unavailable (${e instanceof Error ? e.message : String(e)})`,
    };
  }
}

/**
 * Upgrade-error trail (v0.13+). `gbrain upgrade` silently swallows
 * best-effort failures in `gbrain post-upgrade`; the failure record is
 * appended to `~/.gbrain/upgrade-errors.jsonl` so we can surface it here
 * with a paste-ready recovery hint. Without this, users end up with
 * half-upgraded brains and no signal.
 *
 * #4517: a failure record on its own doesn't mean the brain is STILL
 * broken — the recovery hint (e.g. `apply-migrations --yes`) may have
 * already fixed it. Suppression requires BOTH proofs: the installed
 * binary's own version is at/past the record's `to_version` (the failed
 * upgrade demonstrably completed filesystem-side) AND the schema ledger is
 * current (`config.version >= LATEST_VERSION` — the DB half of the upgrade
 * also finished). A binary alone can lie: `self-upgrade` swaps the binary
 * before `post-upgrade` runs migrations, which is exactly the failure this
 * trail records. When the schema can't be verified (no engine, unreadable
 * version), the warn stays — fail-closed. A superseded record downgrades to
 * an explicit status:'ok' line (rather than silence) so the operator sees
 * the past failure was resolved, not swallowed.
 * `upgradeErrorResolved` above is the pure decision fn.
 */
export async function checkUpgradeErrors(
  engine: Pick<BrainEngine, 'getConfig'> | null,
): Promise<Check | null> {
  try {
    const errPath = gbrainPath('upgrade-errors.jsonl');
    if (!existsSync(errPath)) return null;
    const lines = readFileSync(errPath, 'utf-8').split('\n').filter(l => l.trim());
    if (lines.length === 0) return null;
    const latest = JSON.parse(lines[lines.length - 1]) as {
      ts: string; phase: string; from_version: string; to_version: string; hint: string;
    };
    const date = latest.ts.slice(0, 10);
    let schemaCurrent = false;
    if (engine) {
      try {
        const v = parseInt((await engine.getConfig('version')) || '0', 10);
        schemaCurrent = v >= LATEST_VERSION;
      } catch { /* unverifiable → keep warning */ }
    }
    if (upgradeErrorResolved(latest.to_version, GBRAIN_BINARY_VERSION, schemaCurrent, latest.from_version)) {
      return {
        name: 'upgrade_errors',
        status: 'ok',
        message: `Past post-upgrade failure on ${date} (${latest.from_version} → ${latest.to_version}) superseded: binary now ${GBRAIN_BINARY_VERSION}, schema current.`,
      };
    }
    return {
      name: 'upgrade_errors',
      status: 'warn',
      message: `Post-upgrade failure on ${date} (${latest.from_version} → ${latest.to_version}, phase: ${latest.phase}). Recovery: ${latest.hint}`,
    };
  } catch {
    // Read/parse failure is itself best-effort; skip silently.
    return null;
  }
}

/**
 * The running Bun against the supported floor. The CLI refuses to start below
 * it, so a local doctor normally reports ok; the fail row keeps the fix
 * command for any caller that reaches doctor on an older runtime. A supported
 * runtime below SECURE_BUN_VERSION warns (#7373): a standalone binary embeds
 * the Bun it was built with, so its fix is a new gbrain binary, while a bun
 * install runs on the user's Bun and `bun upgrade` fixes it.
 */
export function checkBunRuntime(version = typeof Bun === 'undefined' ? '' : Bun.version, executable = process.execPath): Check {
  const refusal = unsupportedBunMessage(version);
  if (refusal) return { name: 'bun_runtime', status: 'fail', message: refusal.replaceAll('\n', ' ') };
  if (bunVersionMeets(version, SECURE_BUN_VERSION)) return { name: 'bun_runtime', status: 'ok', message: `Bun ${version} (minimum ${MINIMUM_BUN_VERSION})` };
  const standalone = !/^bun(-[\w.-]+)?(\.exe)?$/i.test(executable.split(/[\\/]/).pop() ?? '');
  return {
    name: 'bun_runtime',
    status: 'warn',
    message: `Bun ${version} carries the Brotli decoder flaw CVE-2026-111497, fixed in Bun ${SECURE_BUN_VERSION} (reachable through fetch() with Content-Encoding: br and the decompression APIs). `
      + (standalone
        ? 'This gbrain binary embeds that Bun: install the latest gbrain binary (`gbrain upgrade`), then restart GBrain services. Upgrading a separately installed bun does not change it.'
        : 'Run `bun upgrade`, then restart GBrain services.'),
    fix: {
      argv: standalone ? ['gbrain', 'upgrade'] : ['bun', 'upgrade'],
      consent: [],
      actor: 'user',
      why: `Bun ${SECURE_BUN_VERSION} carries the Brotli fix for CVE-2026-111497; GBrain services pick it up on restart.`,
      verify: doctorVerify('bun_runtime'),
      requires_exclusive: false,
    },
  };
}
