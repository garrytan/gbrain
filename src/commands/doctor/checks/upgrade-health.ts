/**
 * Upgrade trail checks: `upgrade_errors` (post-upgrade failure ledger with the
 * #4517 superseded-record re-verification) and `self_upgrade_health`.
 * Peeled verbatim from doctor.ts (refactor wave 1, W4 doctor); doctor.ts
 * re-exports every symbol under its original name.
 */

import { existsSync, readFileSync } from 'fs';
import type { BrainEngine } from '../../../core/engine.ts';
import { gbrainPath } from '../../../core/config.ts';
import { LATEST_VERSION } from '../../../core/migrate.ts';
import { VERSION as GBRAIN_BINARY_VERSION } from '../../../version.ts';
import type { Check } from '../../doctor.ts';

/**
 * #4517: is the latest upgrade-errors.jsonl record superseded? True when the
 * running binary version is at/past the version the failed upgrade was moving
 * to AND the schema ledger is current (no pending migrations) — i.e. a later
 * (or retried) upgrade demonstrably finished the job. Pure + exported for
 * tests. Compares ALL dot-segments (the canonical `compareVersions` stops at
 * 3, which would treat 0.31.4.1 == 0.31.4.0); a malformed version fails
 * closed (keeps warning).
 */
export function upgradeErrorResolved(
  failedToVersion: string,
  binaryVersion: string,
  schemaCurrent: boolean,
): boolean {
  if (!schemaCurrent) return false;
  if (typeof failedToVersion !== 'string' || typeof binaryVersion !== 'string') return false;
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
 * v0.42 self_upgrade_health. Surfaces the self-upgrade mode, whether an update
 * is pending (from the cache), and any recent failed auto-upgrade attempts.
 * File-plane only (no DB) so it runs on thin clients. Three-state: warn on
 * recent failures, otherwise ok.
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

    const recent = readRecentSelfUpgrades(7) as Array<{ outcome?: string; error?: string; latest?: string | null }>;
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
    if (upgradeErrorResolved(latest.to_version, GBRAIN_BINARY_VERSION, schemaCurrent)) {
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
