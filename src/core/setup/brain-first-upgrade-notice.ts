/**
 * post-upgrade: a harness wired before the brain-first block existed, or a
 * plugin-only install (its per-turn hook adds the rule only with a block),
 * gets one line naming the setup command that writes only that block.
 * Read-only and best-effort; an opt-out prints nothing.
 */
import { instructionBlockUpgradeHints } from '../../commands/doctor/checks/harness-wiring.ts';

export function printBrainFirstUpgradeNotice(log: (line: string) => void = console.log): void {
  try { for (const line of instructionBlockUpgradeHints()) log(line); } catch { /* cosmetic; never block the upgrade */ }
}
