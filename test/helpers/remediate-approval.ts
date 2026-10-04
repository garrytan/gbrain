/**
 * `doctor --remediate --yes --include-repairs` binds the destructive repair
 * steps to the current plan (C1): the approved command carries
 * `--expect <plan_hash>`. Tests that drive an agreed run append the hash the
 * refusal would have printed, computed by the same code path.
 */
import type { BrainEngine } from '../../src/core/engine.ts';
import { remediationPlanHash } from '../../src/commands/doctor/remediate-consent.ts';

export async function approvedRemediateArgs(engine: BrainEngine, args: string[]): Promise<string[]> {
  if (!args.includes('--include-repairs') || args.includes('--resume') || args.includes('--expect')) return args;
  return [...args, '--expect', await remediationPlanHash(engine, args)];
}
