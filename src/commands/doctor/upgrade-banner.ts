/**
 * The `gbrain post-upgrade` recovery banner (fix wave 3, Lane D). Runs every
 * wave check once (the full checks, not `doctor --fast`) and, when any has a
 * finding, prints one `[AGENT] Relay this to your operator` block naming the
 * selected brain, the count per finding, the read-only preview command and
 * the instruction to ask the user before applying anything. It never prints
 * an applying command (`--yes`, `--apply`): applying is the user's decision.
 * A clean brain prints nothing.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { runWaveChecks } from './wave-checks.ts';
import { readConnectorSourceStatuses } from '../../core/persistence/connector-status.ts';

/** #5686: connector sources that re-walk their window once, or resumed from a pre-upgrade checkpoint. */
async function connectorRewalkNote(engine: BrainEngine): Promise<string | null> {
  const statuses = [...(await readConnectorSourceStatuses(engine)).values()];
  const rewalking = statuses.filter(status => status.upgrade_recovery === 'rewalking_once').length;
  const resumed = statuses.filter(status => status.upgrade_recovery === 'resumed').length;
  if (!rewalking && !resumed) return null;
  return `connector_rewalk: ${rewalking} connector source(s) re-walk their window once on the next run (a one-time admission spike, not new churn)`
    + `${resumed ? `; ${resumed} resumed from a pre-upgrade checkpoint` : ''}. Check with: gbrain sources status`;
}

/**
 * Extra banner lines contributed by other subsystems (for example the count
 * of connector sources that will re-walk once after a checkpoint migration).
 * Each returns null when it has nothing to say.
 */
export const POST_UPGRADE_NOTES: Array<(engine: BrainEngine) => Promise<string | null>> = [connectorRewalkNote];

export async function postUpgradeRecoveryBanner(engine: BrainEngine, brainLabel: string): Promise<string[]> {
  const findings = (await runWaveChecks(engine)).filter(f => f.state !== 'ok');
  const notes = (await Promise.all(POST_UPGRADE_NOTES.map(note => note(engine).catch(() => null)))).filter((n): n is string => !!n);
  if (!findings.length && !notes.length) return [];
  const lines = ['', `[AGENT] Relay this to your operator: brain ${brainLabel} has residual state to review after the upgrade.`];
  for (const { spec, check, state } of findings) {
    const how = spec.resolution === 'repair' ? 'repairable after the user agrees' : spec.resolution === 'operator' ? 'needs an operator action' : 'reported only; no command clears it yet';
    lines.push(state === 'unknown' ? `[AGENT]   ${spec.id}: could not be checked (health unknown)` : `[AGENT]   ${spec.id}: ${spec.count(check.details ?? {})} (${how})`);
  }
  for (const note of notes) lines.push(`[AGENT]   ${note}`);
  lines.push('[AGENT] Preview (read-only): gbrain doctor --remediation-plan');
  lines.push('[AGENT] Ask the user before applying any repair; the plan prints the exact commands. Recipe: docs/guides/repair.md#recover-after-upgrading-to-this-release');
  return lines;
}
