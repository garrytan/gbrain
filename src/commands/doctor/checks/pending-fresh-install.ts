/**
 * Doctor row for E8 fresh-install migrations, shared by the local doctor
 * (`checks/local-runtime.ts`) and the remote report (`report-remote.ts`).
 * Filesystem-only (the migration ledger); no subprocess, no engine.
 */
import { migrationLedgerSummary } from '../../../core/migration-ledger.ts';
import { VERSION } from '../../../version.ts';
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';

/**
 * E8: setup migrations a brain created by `gbrain init` has not run yet
 * (`pending_fresh_install`). Expected work, so `ok` + `severity: 'info'` with
 * the command that finishes it; null when there are none.
 */
export function pendingFreshInstallCheck(): Check | null {
  const setup = migrationLedgerSummary(VERSION).pending_fresh_install;
  if (setup.length === 0) return null;
  return {
    name: 'minions_migration',
    status: 'ok',
    severity: 'info',
    message: `${setup.length} setup migration(s) not run yet on this new brain (pending_fresh_install: ${setup.join(', ')}). Expected after gbrain init, not a failed upgrade.`,
    fix: agentFix(['gbrain', 'apply-migrations', '--yes', '--no-autopilot-install'],
      'Runs the setup migrations gbrain init left pending (preferences, host-work notes, shared-skill checkpoints) on the brain host, without installing background services.',
      'minions_migration', { requires_exclusive: true }),
    details: { pending_fresh_install: setup },
  };
}
