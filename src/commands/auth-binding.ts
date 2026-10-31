/** GBRA-218: the member-binding flags shared by auth create, rescope and register-client. */
import type { BrainEngine } from '../core/engine.ts';
import { memberIdentity, parseMayActFor, parseMemberFlag, type BindingPatch, type BindingResult } from '../core/access/members.ts';
import { ATTEST_SYSTEMS, parseAttestOps } from '../core/access/actor.ts';
import { operationsByName } from '../core/operations.ts';
import { opError } from '../core/ops/contract.ts';
import { usageError } from '../cli/cli-error.ts';

const FLAGS = ['--member', '--may-act-for', '--attest-actor', '--attest-ops'] as const;
type Flag = typeof FLAGS[number];
const NEEDS: Record<Flag, string> = {
  '--member': 'Pass a member id, or none to unbind (gbrain access member list).',
  '--may-act-for': 'Pass a comma-separated list of member ids, group:<id>, guest or *, or none.',
  '--attest-actor': 'Pass qm (the system whose x-qm-actor header this credential may send), or none.',
  '--attest-ops': 'Pass a comma-separated list of operations an attested call may run (default memory_recall,memory_write).',
};

function parseAttestActor(value: string): string | null {
  if (value.trim() === 'none') return null;
  if (ATTEST_SYSTEMS.includes(value.trim())) return value.trim();
  throw opError('invalid_params', `--attest-actor ${value} is not a system gbrain trusts to name people.`, `Pass ${ATTEST_SYSTEMS.join(' or ')}, or none to clear the right.`);
}

/**
 * GBRA-218: `--member <id>|none` and `--may-act-for <list>|none` on auth create, rescope and register-client;
 * GST-359 C1: `--attest-actor qm|none` and `--attest-ops <list>` (the attest right). Strips them from `args` (the
 * grant parsers never see them) and returns the binding patch, or null when no such flag was passed. An ill-formed
 * value throws access_member_invalid or invalid_params.
 */
export function takeBindingFlags(args: string[]): { args: string[]; patch: BindingPatch | null } {
  const out: string[] = [];
  const patch: BindingPatch = {};
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const flag = FLAGS.find(f => a === f || a.startsWith(`${f}=`));
    if (!flag) { out.push(a); continue; }
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw usageError(`${flag} requires a value.`, NEEDS[flag]);
    if (flag === '--member') patch.member = parseMemberFlag(value);
    else if (flag === '--may-act-for') patch.mayActFor = parseMayActFor(value);
    else if (flag === '--attest-actor') patch.attestActor = parseAttestActor(value);
    else patch.attestOps = parseAttestOps(value, name => operationsByName[name]);
    seen = true;
  }
  return { args: out, patch: seen ? patch : null };
}

/** Refuses a binding to a member that is not enabled before any credential is minted or changed. */
export async function checkBindingTarget(engine: BrainEngine, patch: BindingPatch | null): Promise<void> {
  if (patch?.member) await memberIdentity(engine, patch.member);
}

export function bindingLine(b: BindingResult, dryRun = false): string {
  const attest = b.attest_actor ? `; attests actor: ${b.attest_actor} for ${(b.attest_ops ?? ['memory_recall', 'memory_write']).join(', ')}` : '';
  return `  Member: ${b.member ?? 'none'}; may act for: ${b.may_act_for?.join(', ') ?? 'none'}${attest}${b.changed ? (dryRun ? ' (preview, not written)' : ' (updated)') : ''}`;
}
