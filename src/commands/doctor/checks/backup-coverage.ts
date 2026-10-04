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
import type { Action } from '../../../core/agent-output.ts';
import { checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import {
  BACKUP_COACH_MIN_AGE_DAYS,
  BACKUP_COACH_MIN_ITEMS,
  assetBlocksRecovery,
  backupCoachingDue,
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

/** Remote surface: the per-asset detail and fixes live on the brain host. */
function hostBackupCheck(): Action {
  return { argv: ['gbrain', 'backup', 'status'], consent: [], actor: 'host_admin', requires_exclusive: false,
    why: 'Lists each knowledge asset without verified recovery and its fix command; only the brain host can read it.',
    user_message: 'Please run `gbrain backup status` on the machine that hosts your brain to see which parts are not backed up.' };
}

/**
 * E7 per-asset wording: what each blocking asset's evidence can and cannot
 * restore. Repo evidence never covers DB-only pages, facts, config or credentials.
 */
function assetCoverageWording(s: BackupStatus): string {
  const kinds = new Set(s.assets.filter(assetBlocksRecovery).map((a) => a.kind));
  const parts: string[] = [];
  if (kinds.has('source_repo') || kinds.has('bootstrap_workspace')) {
    parts.push('A source repo with a pushed git remote restores its Markdown files only, never DB-only pages, facts, config or credentials.');
  }
  if (kinds.has('db_only') || kinds.has('db_content')) {
    parts.push('DB-only pages and facts live only in the database: an export or database backup is their only copy.');
  }
  return parts.length ? parts.join(' ') : 'Git evidence covers committed repository files only, not the full database.';
}

/**
 * The first blocking asset's fix as an Action. `not_a_git_repo` sources (for
 * example gbrain's own content directory) have no git remote to add, so their
 * fix is an export to a directory the user picks; db_only/db_content assets use
 * their own fix argv. `bootstrap repo` and pushes carry {credentials, egress}.
 */
function backupAssetFix(s: BackupStatus): Action | undefined {
  for (const a of s.assets.filter(assetBlocksRecovery)) {
    const argv = a.fix_argv ?? (a.kind === 'source_repo' && a.detail === 'not_a_git_repo'
      ? ['gbrain', 'export', '--source', a.id, '--dir', `<BACKUP_DIR>/${a.id}`] : null);
    if (!argv) continue;
    const filled = argv.map((x) => x.replace(/^BACKUP_DIR\//, '<BACKUP_DIR>/'));
    const egress = argv[1] === 'bootstrap' || (argv[1] === 'sources' && argv[2] === 'push');
    return {
      argv: filled, consent: egress ? ['credentials', 'egress'] : [], actor: 'agent', requires_exclusive: false,
      why: egress
        ? 'Creates a private GitHub repository for the brain and pushes to it (needs the user\'s GitHub credentials; content leaves this machine).'
        : `Writes a Markdown copy of '${a.id}' (pages and facts) to a directory outside the brain so it survives losing the database.`,
      ...(filled.some((x) => x.includes('<BACKUP_DIR>')) ? { inputs: [{ name: 'BACKUP_DIR', how: 'Ask the user where backups should live (a directory outside the brain, ideally synced or on another disk).' }] } : {}),
      verify: doctorVerify('backup_coverage'), docs: 'docs/operations/backup-check.md',
    };
  }
  return undefined;
}

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
    const fix = backupAssetFix(s);
    const message =
      `${warnLead(assetClause, verdictCaveats(s, now))} ${assetCoverageWording(s)} ` +
      'Run `gbrain backup status` for each asset\'s fix command.';
    if (!backupCoachingDue(s, now)) {
      const m = s.maturity!;
      return infoCheck('backup_coverage',
        `Not urgent yet: the brain holds ${m.items} page(s)+fact(s) and is under ${BACKUP_COACH_MIN_AGE_DAYS} days old (backup coaching starts at ${BACKUP_COACH_MIN_ITEMS} items or ${BACKUP_COACH_MIN_AGE_DAYS} days). ${message}`,
        'degraded', fix, details);
    }
    return {
      name: 'backup_coverage',
      status: 'warn',
      message,
      details,
      ...(fix ? { fix } : { fix_unavailable_reason: 'operator_judgement' as const }),
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
        fix: hostBackupCheck(),
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
    if (cached.overall === 'warn' && !backupCoachingDue(cached, opts.now?.getTime())) {
      return infoCheck('backup_coverage',
        `Not urgent yet: the brain is under ${BACKUP_COACH_MIN_AGE_DAYS} days old with fewer than ${BACKUP_COACH_MIN_ITEMS} pages+facts. ${assetClause ?? ''}`.trim(),
        'degraded', hostBackupCheck(), details);
    }
    return cached.overall === 'warn'
      ? {
          fix: hostBackupCheck(),
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
  } catch (e) {
    return checkError('backup_coverage', 'read backup coverage', e);
  }
}
