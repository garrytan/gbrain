/**
 * `minions_migration` line for a v0.11.0 Phase F the upgrade skipped because
 * the brain names no repo (#6755). Reads the pending host-work item Phase F
 * recorded and this brain's installed autopilot job (job files, crontab); no
 * engine. Quiet once an autopilot is installed for this brain.
 */
import type { Check } from '../../doctor.ts';
import { agentFix } from '../check-fix.ts';
import { autopilotInstallCommand, autopilotInstalledForBrain, pendingAutopilotInstall } from '../../migrations/v0_11_0-install.ts';

export function autopilotInstallPendingCheck(): Check | null {
  const todo = pendingAutopilotInstall();
  if (!todo || autopilotInstalledForBrain()) return null;
  const inputs = todo.repo === null
    ? [{ name: 'REPO_PATH', how: 'Ask the user for the path of the brain repo the autopilot should keep in sync (the directory gbrain sync imports).' }]
    : undefined;
  return {
    name: 'minions_migration',
    status: 'warn',
    message: `No autopilot is installed: the v0.11.0 upgrade skipped its install because sync.repo_path is unset. Install it: ${autopilotInstallCommand(todo.repo)}`,
    fix: agentFix(todo.install_argv,
      'Installs the background maintenance daemon (sync, extract, embed) for this brain repo under the host supervisor; a persistent install, so ask the user first.',
      'minions_migration', { consent: ['persistent_install'], ...(inputs ? { inputs } : {}) }),
    details: { pending_host_work: todo },
  };
}
