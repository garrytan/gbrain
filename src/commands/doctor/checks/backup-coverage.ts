/**
 * doctor/checks/backup-coverage.ts — `backup_coverage`: is the user's brain +
 * skills backed up to a git remote at all? Sibling of `bootstrap_push_health`
 * (which owns staleness of an EXISTING remote); this check owns ABSENCE.
 *
 * Trust boundary (D4): git probes against DB-supplied local_path run only on
 * the trusted local doctor path (`localOnly: true`, the checkSyncFreshness
 * precedent at doctor.ts). Without it the check is a cache-only reader.
 */

import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { getBackupStatus } from '../../../core/backup/coverage.ts';
import {
  backupCacheAge,
  backupCheckDisabled,
  loadBackupStatus,
  type BackupStatus,
} from '../../../core/backup/status-file.ts';

function toCheck(s: BackupStatus, note?: string): Check {
  const details = {
    totals: s.totals,
    checked_at: s.checked_at,
    computed_by: s.computed_by,
    cache_age: backupCacheAge(s),
    ...(note ? { note } : {}),
  };
  if (s.overall === 'warn') {
    const ids = s.assets
      .filter((a) => a.state === 'no_remote')
      .map((a) => a.id)
      .join(', ');
    return {
      name: 'backup_coverage',
      status: 'warn',
      message:
        `${s.totals.no_remote} knowledge asset(s) have no git remote — local-only, unrecoverable on disk loss: ${ids}. ` +
        'Run `gbrain backup status` for fix commands (`gbrain bootstrap repo` / `git remote add origin <url>` / `gbrain sources harden <id>`).',
      details,
    };
  }
  return {
    name: 'backup_coverage',
    status: 'ok',
    message: `${s.totals.recoverable_repos} knowledge repo(s) git-backed; last checked ${backupCacheAge(s)}`,
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
  if (!opts.localOnly) {
    // Remote surface: cache-only AND aggregate-only. toCheck's warn message
    // names asset ids (local paths for workspace assets) — that is local-owner
    // detail; a remote reader gets counts, never identifiers (the same
    // amendment-29 discipline as backupNoticeText's 'aggregate' surface).
    const cached = loadBackupStatus();
    if (!cached) {
      return {
        name: 'backup_coverage',
        status: 'ok',
        message: 'not checked from this surface — run `gbrain backup check` on the brain host',
      };
    }
    const details = {
      totals: cached.totals,
      checked_at: cached.checked_at,
      cache_age: backupCacheAge(cached),
      note: 'cache-only (remote surface never probes git; aggregate counts only)',
    };
    return cached.overall === 'warn'
      ? {
          name: 'backup_coverage',
          status: 'warn',
          message:
            `${cached.totals.no_remote} of ${cached.totals.assets} knowledge asset(s) have no git remote — ` +
            'run `gbrain backup status` on the brain host for the per-asset detail and fix commands.',
          details,
        }
      : {
          name: 'backup_coverage',
          status: 'ok',
          message: `${cached.totals.recoverable_repos} knowledge repo(s) git-backed; last checked ${backupCacheAge(cached)}`,
          details,
        };
  }
  try {
    const s = await getBackupStatus(engine, {
      localGitProbes: true,
      computedBy: 'doctor',
      ...(opts.now ? { now: opts.now } : {}),
    });
    return toCheck(s);
  } catch {
    return { name: 'backup_coverage', status: 'warn', message: 'backup coverage unreadable' };
  }
}
