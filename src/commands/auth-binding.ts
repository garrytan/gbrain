/** GBRA-218: the member-binding flags shared by auth create, rescope and register-client. */
import type { BrainEngine } from '../core/engine.ts';
import { memberIdentity, parseMayActFor, parseMemberFlag, type BindingPatch, type BindingResult } from '../core/access/members.ts';
import { usageError } from '../cli/cli-error.ts';

/**
 * GBRA-218: `--member <id>|none` and `--may-act-for <list>|none` on auth create,
 * rescope and register-client. Strips them from `args` (the grant parsers
 * never see them) and returns the binding patch, or null when neither flag
 * was passed. An ill-formed value throws access_member_invalid.
 */
export function takeBindingFlags(args: string[]): { args: string[]; patch: BindingPatch | null } {
  const out: string[] = [];
  const patch: BindingPatch = {};
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = a === '--member' || a.startsWith('--member=') ? '--member' : a === '--may-act-for' || a.startsWith('--may-act-for=') ? '--may-act-for' : null;
    if (!flag) { out.push(a); continue; }
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) {
      throw usageError(`${flag} requires a value.`, flag === '--member' ? 'Pass a member id, or none to unbind (gbrain access member list).' : 'Pass a comma-separated list of member ids, group:<id>, guest or *, or none.');
    }
    if (flag === '--member') patch.member = parseMemberFlag(value);
    else patch.mayActFor = parseMayActFor(value);
    seen = true;
  }
  return { args: out, patch: seen ? patch : null };
}

/** Refuses a binding to a member that is not enabled before any credential is minted or changed. */
export async function checkBindingTarget(engine: BrainEngine, patch: BindingPatch | null): Promise<void> {
  if (patch?.member) await memberIdentity(engine, patch.member);
}

export function bindingLine(b: BindingResult, dryRun = false): string {
  return `  Member: ${b.member ?? 'none'}; may act for: ${b.may_act_for?.join(', ') ?? 'none'}${b.changed ? (dryRun ? ' (preview, not written)' : ' (updated)') : ''}`;
}
