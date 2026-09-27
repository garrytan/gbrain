/** Complete an unattended swap before autopilot opens the brain on relaunch. */
import { execFileSync } from 'child_process';
import { loadConfigFileOnly } from '../core/config.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { logSelfUpgrade } from '../core/audit/self-upgrade-audit.ts';
import { VERSION } from '../version.ts';
import { currentCliInvocation } from '../core/current-cli-invocation.ts';
import { clearPendingUpgrade, pendingUpgradeExists, pendingUpgradeTarget } from '../core/autopilot-upgrade-pending.ts';
import { readSourceUpgradeGuard, recordRecoveredBinary, sourceUpgradeIncomplete } from '../core/source-upgrade-guard.ts';
import { resolveAutopilotPositionals, runAutopilotStatus, uninstallDaemon } from './autopilot.ts';
import { assessUpgradeOutcome, detectInstallMethod, recordUpgradeError } from './upgrade.ts';

export function completePendingAutopilotUpgrade(force = false): boolean {
  const attempted = loadConfigFileOnly()?.self_upgrade?.attempting_version;
  if (!force && attempted !== VERSION) return true;

  try {
    const invocation = currentCliInvocation(['post-upgrade', '--no-autopilot-install', '--strict']);
    execFileSync(invocation.file, invocation.args, {
      stdio: 'inherit',
      timeout: Number(process.env.GBRAIN_POST_UPGRADE_TIMEOUT_MS || 1_800_000),
      env: {
        ...process.env,
        GBRAIN_NO_AUTOPILOT_INSTALL: '1',
        GBRAIN_SKIP_STARTUP_HOOKS: '1',
      },
    });
    return true;
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    recordUpgradeError({
      phase: 'post-upgrade',
      fromVersion: 'unknown',
      toVersion: attempted ?? VERSION,
      error,
      hint: 'Run: gbrain post-upgrade --no-autopilot-install',
    });
    logSelfUpgrade({ channel: 'autopilot', action: 'apply', current: VERSION, latest: attempted ?? VERSION, outcome: 'failed', error });
    console.error('[autopilot] post-upgrade setup failed; retrying before the next start.');
    return false;
  }
}

/** Preserve status/uninstall's engine-free path and gate a normal daemon start. */
export function preflightAutopilotCommand(input: string[]): { args: string[]; handled: boolean } {
  const args = resolveAutopilotPositionals(input);
  if (args.includes('--uninstall')) { uninstallDaemon(); return { args, handled: true }; }
  if (args.includes('--status')) { runAutopilotStatus(args); return { args, handled: true }; }
  const normalStart = !args.includes('--install') && !args.includes('--help') && !args.includes('-h');
  const pending = pendingUpgradeExists();
  if (normalStart && pending && assessUpgradeOutcome(pendingUpgradeTarget() ?? '', VERSION) !== 'ok') {
    console.error('[autopilot] upgrade target is not installed; repair the installation and run gbrain upgrade --no-autopilot-install before restarting.');
    setCliExitVerdict(1);
    return { args, handled: true };
  }
  let setupCompleted = false;
  if (sourceUpgradeIncomplete()) {
    const marker = readSourceUpgradeGuard();
    const binaryReady = detectInstallMethod() === 'binary'
      && marker?.repoRoot
      && marker?.targetVersion
      && assessUpgradeOutcome(marker.targetVersion, VERSION) === 'ok';
    if (!binaryReady) {
      console.error('[autopilot] source upgrade incomplete; repair that checkout and run its gbrain upgrade --no-autopilot-install.');
      setCliExitVerdict(1);
      return { args, handled: true };
    }
    // A staged binary may take over only after its target version and strict
    // post-upgrade setup are verified. Keep the source marker for any later
    // switch back to the incomplete checkout.
    if (marker.recoveredBinaryVersion !== VERSION && normalStart) {
      if (!completePendingAutopilotUpgrade(true)) {
        setCliExitVerdict(1);
        return { args, handled: true };
      }
      try { recordRecoveredBinary(VERSION); } catch {
        setCliExitVerdict(1);
        return { args, handled: true };
      }
      setupCompleted = true;
    }
  }
  if (normalStart) {
    if (!setupCompleted && !completePendingAutopilotUpgrade(pending)) {
      setCliExitVerdict(1);
      return { args, handled: true };
    }
    if (pending) {
      try { clearPendingUpgrade(); } catch {
        setCliExitVerdict(1);
        return { args, handled: true };
      }
    }
  }
  return { args, handled: false };
}
