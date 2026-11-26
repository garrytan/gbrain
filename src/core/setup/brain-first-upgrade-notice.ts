/**
 * post-upgrade: a harness wired before the brain-first block existed, or a
 * plugin-only install (its per-turn hook adds the rule only with a block),
 * gets one line naming the setup command that writes only that block.
 * Read-only and best-effort; an opt-out prints nothing.
 *
 * L1: an installed block whose agent-policy line no longer matches
 * `brain_first.policy_line` (turned off, or on) is rewritten, so the setting
 * takes effect at the next upgrade as well as the next setup.
 */
import { existsSync, readFileSync } from 'node:fs';
import { instructionBlockUpgradeHints } from '../../commands/doctor/checks/harness-wiring.ts';
import { BRAIN_FIRST_BEGIN, BRAIN_FIRST_END, brainFirstTargetAt, isBrainFirstHarness, readBrainFirstLedger, syncBrainFirst } from './brain-first.ts';
import { POLICY_LINE_LEAD, policyLineFor } from './policy-line.ts';

export function printBrainFirstUpgradeNotice(log: (line: string) => void = console.log): void {
  try { for (const line of refreshPolicyLineBlocks()) log(line); } catch { /* cosmetic; never block the upgrade */ }
  try { for (const line of instructionBlockUpgradeHints()) log(line); } catch { /* cosmetic; never block the upgrade */ }
}

/** Rewrite each installed block whose policy line differs from the setting; returns one line per rewritten file. */
export function refreshPolicyLineBlocks(): string[] {
  const lines: string[] = [];
  for (const e of readBrainFirstLedger()) {
    if (e.status !== 'installed' || !e.access || !isBrainFirstHarness(e.harness) || !existsSync(e.path)) continue;
    const text = readFileSync(e.path, 'utf8');
    const begin = text.indexOf(BRAIN_FIRST_BEGIN);
    const end = text.indexOf(BRAIN_FIRST_END);
    if (begin < 0 || end < begin) continue;
    const has = text.slice(begin, end).includes(POLICY_LINE_LEAD);
    const want = policyLineFor(e.access) !== null;
    if (has === want) continue;
    const out = syncBrainFirst({ target: brainFirstTargetAt(e.harness, e.path), access: e.access, decision: { value: 'accepted', source: 'prior' }, writer: 'upgrade', dryRun: false });
    if (out.action !== 'preserve') lines.push(`[gbrain] ${want ? 'Added' : 'Removed'} the agent-policy line in ${e.path} (brain_first.policy_line).`);
  }
  return lines;
}
