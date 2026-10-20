/**
 * #6796: `minions_migration` line for an applied migration whose ledger row
 * records `apply_migrations_pending` and whose stored report still names host
 * work (`apply-migrations --list` status `applied_pending_host_work`): the
 * checkpoint landed, but publication or a source's writer setup is not done.
 * Unenrolled members and opted-out sources are not host work, and a declined
 * migration is never reported. Read-only.
 */
import { compareVersions, hostWorkInspectArgv, hostWorkPendingForVersion } from '../../../core/migration-ledger.ts';
import type { CompletedMigrationEntry } from '../../../core/preferences.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';

export function migrationHostWorkCheck(history: Map<string, CompletedMigrationEntry[]>, declined: ReadonlySet<string>, hostWork: ReadonlySet<string>): Check | null {
  const versions = [...history.keys()].filter(v => !declined.has(v) && hostWork.has(v) && hostWorkPendingForVersion(v, history)).sort(compareVersions);
  if (versions.length === 0) return null;
  const argv = hostWorkInspectArgv(versions[0]);
  return {
    name: 'minions_migration',
    status: 'warn',
    message: `Migration(s) ${versions.join(', ')} applied_pending_host_work: the checkpoint is recorded, but host publication or source setup is not done. `
      + `Inspect each source's next step: ${argv.join(' ')}; once that work is done, \`gbrain apply-migrations --yes\` records it.`,
    fix: agentFix(argv, "Lists each source's pending host step (writer setup, publication) and its command; changes nothing.", 'minions_migration'),
    details: { code: 'migration_host_work_pending', applied_pending_host_work: versions },
  };
}
