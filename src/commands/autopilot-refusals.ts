/**
 * GBRA-438: the two `gbrain autopilot --install` refusals through the agent
 * error contract (code, why, fix); PGLite and repo-less brains are pointed at
 * free upkeep (`gbrain maintain --status`) instead of a daemon.
 */
import { opError } from '../core/ops/contract.ts';

const UPKEEP_STATUS_FIX = {
  argv: ['gbrain', 'maintain', '--status'], consent: [], actor: 'agent' as const, requires_exclusive: false,
  why: 'Shows when free upkeep last ran and what it left for you; on a brain with no autopilot, gbrain maintain --unattended runs that upkeep (no model calls, no page purge).',
};

/** GBRA-438: the PGLite daemon refusal through the agent error contract (code, why, fix). */
export function autopilotPgliteRefusal(message: string) {
  return opError('autopilot_pglite_daemon', `${message.split('\n')[0]!} To install the daemon anyway on a dedicated brain, re-run with --force.`,
    'Run gbrain serve instead (it owns the lock and runs the resident sweep). Check free upkeep with gbrain maintain --status. For a dedicated-brain daemon, re-run gbrain autopilot --install --force.',
    { why: 'A PGLite brain has one writer; a daemon holding it all day would block every other gbrain process.', fix: UPKEEP_STATUS_FIX });
}

/** GBRA-438: the no-repo refusal through the agent error contract; a repo-less brain is served by free upkeep instead. */
export function autopilotNoRepoRefusal(engineKind: string) {
  return opError('autopilot_no_repo', 'No repo path: sync.repo_path and the default source local_path are unset or relative.',
    'Pass --repo <absolute-directory> for a brain kept in git; a repo-less brain needs no autopilot: gbrain maintain --status shows its free upkeep.',
    { why: 'The autopilot daemon syncs a git checkout, so it needs an absolute repo directory.', fix: engineKind === 'pglite' ? UPKEEP_STATUS_FIX
      : { argv: ['gbrain', 'autopilot', '--install', '--repo', '<dir>'], consent: ['persistent_install'], actor: 'user', ask_user: true, requires_exclusive: false,
        inputs: [{ name: 'dir', how: 'The absolute path of the brain repo, from the user.' }], why: 'Installs the autopilot daemon for the named checkout.' } });
}

