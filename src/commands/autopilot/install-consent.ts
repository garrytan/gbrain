/**
 * `gbrain autopilot --install` consent (agent-first operator wave E9).
 *
 * Installing the autopilot daemon is a `persistent_install`: a background job
 * that outlives the session and, when provider keys are configured, runs paid
 * LLM/embedding phases within the configured budgets. The install goes
 * through `requireConsent` (TTY prompt, `--yes`, or the user's
 * `consent.preapprove.persistent_install`); a non-TTY caller without it gets
 * the exit-3 `confirmation_required` payload and nothing is written.
 * `--dry-run` prints the plan (target, job, every file it would write) and
 * changes nothing.
 */
import { join } from 'node:path';
import type { BrainEngine } from '../../core/engine.ts';
import { gbrainPath, loadConfigFileOnly } from '../../core/config.ts';
import { isConsentRefusal, printConsentRefusal, requireConsent } from '../../core/consent.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { AutopilotJob } from '../../core/autopilot-paths.ts';
import type { InstallTarget } from '../autopilot.ts';
import { plistPath, systemdUnitPath } from './jobs.ts';

export interface AutopilotInstallPlan {
  target: InstallTarget;
  repoPath: string;
  job: AutopilotJob;
}

const TARGET_LABEL: Record<InstallTarget, string> = {
  macos: 'launchd agent (starts at login, restarts on exit)',
  'linux-systemd': 'systemd user service (starts at boot, restarts on exit)',
  'ephemeral-container': 'container start script (runs when the container starts)',
  'linux-cron': 'crontab entry (runs every few minutes)',
};

/** Every file or table entry the install would write, for the dry run and the consent text. */
export function installWrites(plan: AutopilotInstallPlan): string[] {
  const wrapper = join(gbrainPath(), 'autopilot-run.sh');
  const job = plan.target === 'macos' ? plistPath(plan.job.launchdLabel)
    : plan.target === 'linux-systemd' ? systemdUnitPath(plan.job.systemdUnit)
      : plan.target === 'ephemeral-container' ? plan.job.startScriptPath
        : 'your crontab (one gbrain autopilot line)';
  return [wrapper, job];
}

function providerKeysPresent(): boolean {
  const file = loadConfigFileOnly() as Record<string, unknown> | null;
  return !!(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.VOYAGE_API_KEY
    || file?.anthropic_api_key || file?.openai_api_key || file?.voyage_api_key);
}

/** `--dry-run`: the plan, nothing written. */
export function renderInstallDryRun(plan: AutopilotInstallPlan): string {
  return [
    `gbrain autopilot --install --dry-run: nothing was written.`,
    `  target: ${plan.target} — ${TARGET_LABEL[plan.target]}`,
    `  repo:   ${plan.repoPath}`,
    `  would write:`,
    ...installWrites(plan).map((w) => `    ${w}`),
    `  ${providerKeysPresent() ? 'Provider keys are configured, so LLM and embedding phases will spend provider credits within the configured budgets.' : 'No provider keys are configured, so only free maintenance phases will run.'}`,
    `  Install: gbrain autopilot --install --yes (after the user agrees). Remove later: gbrain autopilot --uninstall`,
  ].join('\n');
}

/**
 * True when the install may proceed. On refusal prints the consent payload
 * (`--json` → one JSON document) and sets exit 3; nothing has been written.
 */
export async function autopilotInstallConsent(engine: BrainEngine, args: string[], plan: AutopilotInstallPlan): Promise<boolean> {
  const paid = providerKeysPresent();
  const passthrough = args.filter((a) => a !== '--yes' && a !== '--dry-run' && a !== '--json');
  try {
    await requireConsent({
      command: 'autopilot',
      effects: ['persistent_install'],
      actor: 'agent',
      what: 'Install the gbrain autopilot background service',
      why: `Installs a ${TARGET_LABEL[plan.target]} that keeps the brain at ${plan.repoPath} synced, extracted and consolidated in the background. Writes: ${installWrites(plan).join(', ')}.`
        + (paid ? ' Provider keys are configured, so its LLM and embedding phases spend provider credits within the configured budgets.' : ''),
      risk: 'A background job keeps running after this session and starts again at login/boot until `gbrain autopilot --uninstall` removes it.',
      user_message: `I'd like to install gbrain's background maintenance (autopilot) so your brain stays synced and indexed without you running anything.`
        + (paid ? ' It will use your configured AI provider keys, which costs a little within your budget settings.' : '')
        + ' You can remove it any time with `gbrain autopilot --uninstall`. OK?',
      argv: ['gbrain', 'autopilot', ...passthrough, '--yes'],
      preview_argv: ['gbrain', 'autopilot', ...passthrough, '--dry-run'],
      args,
    }, { getConfig: (k) => engine.getConfig(k) });
    return true;
  } catch (e) {
    if (!isConsentRefusal(e)) throw e;
    setCliExitVerdict(printConsentRefusal(e, { json: args.includes('--json') }));
    return false;
  }
}
