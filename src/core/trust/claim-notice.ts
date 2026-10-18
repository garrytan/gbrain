/**
 * `gbrain post-upgrade` (#5575, legacy content): while unclaimed sources hold
 * rows from before trust tiers, an [AGENT] tell_user_to_run block asks the agent
 * to relay what claiming means; only the owner claims, at a terminal
 * (`gbrain trust claim-sources`, trust/claim.ts). It repeats on every
 * post-upgrade until nothing is left to claim. A claim whose lift did not
 * finish gets the resume command instead. Never runs the claim or the scan.
 * Best-effort: never blocks the upgrade.
 */
import type { BrainEngine } from '../engine.ts';
import { agentBlock } from '../agent-markers.ts';
import { CLAIM_USER_MESSAGE, readUnclaimedLegacySources } from './claim.ts';
import { TRUST_CLAIM_COMMAND, TRUST_CLAIM_RESUME_COMMAND } from './claim-state.ts';

export async function trustClaimUpgradeNotice(engine: Pick<BrainEngine, 'executeRaw'>): Promise<string[] | null> {
  const { unclaimed, pending } = await readUnclaimedLegacySources(engine);
  const verify = 'gbrain doctor --only trust_sources_unclaimed --json';
  if (pending.length) {
    return ['', ...agentBlock({
      why: `A claim of ${pending.join(', ')} did not finish lifting its legacy rows.`,
      actor: 'agent', next: `run: ${TRUST_CLAIM_RESUME_COMMAND.join(' ')}`, verify,
    }).trimEnd().split('\n'), ''];
  }
  if (!unclaimed.length) return null;
  const rows = unclaimed.reduce((n, s) => n + s.legacy_unknown, 0);
  return ['', ...agentBlock({
    why: `${rows} row(s) written before trust tiers in ${unclaimed.length} unclaimed source(s) read as "unverified origin". New agent-written content is already flagged `
      + 'when it reads as instructions; older content is flagged only after the user claims their sources and runs gbrain trust scan, which no agent starts.',
    actor: 'user', next: `tell_user_to_run: ${TRUST_CLAIM_COMMAND.join(' ')}`,
    if_yes: `The user runs ${TRUST_CLAIM_COMMAND.join(' ')} in a terminal on the brain host; it asks them to type each source id (--yes never claims). Preview: gbrain trust claim-sources --dry-run --json.`,
    if_no: 'Run nothing; those rows stay "unverified origin" and nothing is flagged unless the user later runs gbrain trust scan.',
    verify,
  }, { showUser: CLAIM_USER_MESSAGE }).trimEnd().split('\n'), ''];
}

export async function printTrustClaimUpgradeNotice(engine: Pick<BrainEngine, 'executeRaw'>, log: (line: string) => void = console.log): Promise<boolean> {
  try {
    const lines = await trustClaimUpgradeNotice(engine);
    if (!lines) return false;
    for (const line of lines) log(line);
    return true;
  } catch {
    return false;
  }
}
