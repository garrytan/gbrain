/**
 * doctor/checks/backup-coverage.ts — `backup_coverage` diagnostics.
 *
 * Trust boundary (D4): git probes against DB-supplied local_path run only on
 * the trusted local doctor path (`localOnly: true`, the checkSyncFreshness
 * precedent at doctor.ts). Without it the check is a cache-only reader.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { getBackupStatus } from '../../../core/backup/coverage.ts';
import {
  blockingAssetReasons,
  backupCacheAge,
  backupCheckDisabled,
  isBackupStatusStale,
  loadBackupStatus,
  currentBackupEvidence,
  type BackupStatus,
} from '../../../core/backup/status-file.ts';

/** Why a verdict warns beyond its assets: a degraded compute or a stale cache. */
function verdictCaveats(s: BackupStatus, now?: number): string[] {
  return [
    ...(s.degraded ? ['the database was unreadable during the check'] : []),
    ...(isBackupStatusStale(s, now) ? ['the verdict is older than the check interval'] : []),
  ];
}

/** Lead with the assets when any block recovery; otherwise the caveats are the cause. */
function warnLead(assetClause: string | null, caveats: string[]): string {
  if (assetClause) return `${assetClause}${caveats.length > 0 ? ` Also: ${caveats.join('; ')}.` : ''}`;
  return `Backup verdict is not current: ${caveats.length > 0 ? caveats.join('; ') : 'its check time could not be verified'}.`;
}

const LISTED_ASSET_CAP = 5;

function toCheck(s: BackupStatus, now?: number): Check {
  const details = {
    totals: s.totals,
    checked_at: s.checked_at,
    computed_by: s.computed_by,
    cache_age: backupCacheAge(s, now),
    recovery_scope: s.recovery_scope,
    degraded: s.degraded === true,
  };
  if (s.overall === 'warn') {
    const unverified = blockingAssetReasons(s, 'local');
    const listed = unverified.slice(0, LISTED_ASSET_CAP).map((a) => `${a.id} (${a.reason})`).join(', ');
    const more = unverified.length > LISTED_ASSET_CAP ? `, and ${unverified.length - LISTED_ASSET_CAP} more` : '';
    const assetClause = unverified.length > 0 ? `${unverified.length} knowledge asset(s) lack verified recovery: ${listed}${more}.` : null;
    return {
      name: 'backup_coverage',
      status: 'warn',
      message:
        `${warnLead(assetClause, verdictCaveats(s, now))} Current recovery is not verified for all repositories. ` +
        'Run `gbrain backup status` for fix commands (`gbrain bootstrap repo` / `git remote add origin <url>` / `gbrain sources harden <id>`).',
      details,
    };
  }
  return {
    name: 'backup_coverage',
    status: 'ok',
    message: `${s.totals.recoverable_repos} knowledge repo(s) have verified remote commits; last checked ${backupCacheAge(s, now)}. Git does not cover the full database.`,
    details,
  };
}

export async function checkBackupCoverage(
  engine: BrainEngine,
  opts: { localOnly?: boolean; now?: Date } = {},
): Promise<Check> {
  if (backupCheckDisabled()) {
    return {
      name: 'backup_coverage',
      status: 'ok',
      message: 'backup check disabled (backup.check_enabled=false or GBRAIN_BACKUP_CHECK=0)',
    };
  }
  if (opts.localOnly !== true) {
    // Remote surface: cache-only AND aggregate-only. toCheck's warn message
    // names asset ids (local paths for workspace assets) — that is local-owner
    // detail; a remote reader gets counts, never identifiers (the same
    // amendment-29 discipline as backupNoticeText's 'aggregate' surface).
    const raw = loadBackupStatus();
    if (!raw) {
      return {
        name: 'backup_coverage',
        status: 'warn',
        message: 'not checked from this surface — run `gbrain backup check` on the brain host',
      };
    }
    const cached = currentBackupEvidence(raw, opts.now?.getTime());
    const details = {
      totals: cached.totals,
      checked_at: cached.checked_at,
      cache_age: backupCacheAge(cached, opts.now?.getTime()),
      recovery_scope: cached.recovery_scope,
      degraded: cached.degraded === true,
      note: 'cache-only (remote surface never probes git; aggregate counts only)',
    };
    // Aggregate-only: reason counts, never asset ids.
    const byReason = new Map<string, number>();
    for (const { reason } of blockingAssetReasons(cached, 'aggregate')) byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    const unverifiedCount = [...byReason.values()].reduce((a, b) => a + b, 0);
    const reasons = [...byReason].map(([reason, n]) => `${n} ${reason}`).join(', ');
    const assetClause = unverifiedCount > 0
      ? `${unverifiedCount} of ${cached.totals.assets} knowledge asset(s) lack verified recovery (${reasons}).`
      : null;
    return cached.overall === 'warn'
      ? {
          name: 'backup_coverage',
          status: 'warn',
          message:
            `${warnLead(assetClause, verdictCaveats(cached, opts.now?.getTime()))} Current recovery is not verified for all repositories — ` +
            'run `gbrain backup status` on the brain host for the per-asset detail and fix commands.',
          details,
        }
      : {
          name: 'backup_coverage',
          status: 'ok',
          message: `${cached.totals.recoverable_repos} knowledge repo(s) have verified remote commits in the cache; last checked ${backupCacheAge(cached, opts.now?.getTime())}. Git does not cover the full database.`,
          details,
        };
  }
  try {
    const s = await getBackupStatus(engine, {
      localGitProbes: true,
      verifyRemoteRefs: true,
      computedBy: 'doctor',
      ...(opts.now ? { now: opts.now } : {}),
    });
    return toCheck(s, opts.now?.getTime());
  } catch {
    return { name: 'backup_coverage', status: 'warn', message: 'backup coverage unreadable' };
  }
}
