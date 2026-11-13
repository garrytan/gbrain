/** GBRA-218: the member-binding flags shared by auth create, rescope and register-client. */
import type { BrainEngine } from '../core/engine.ts';
import { memberIdentity, parseMayActFor, parseMemberFlag, type BindingPatch, type BindingResult } from '../core/access/members.ts';
import { ATTEST_SYSTEMS, DEFAULT_ATTEST_OPS, parseAttestOps } from '../core/access/actor.ts';
import { operationsByName } from '../core/operations.ts';
import { opError } from '../core/ops/contract.ts';
import { assertValidSourceId } from '../core/source-id.ts';
import { usageError } from '../cli/cli-error.ts';

const FLAGS = ['--member', '--may-act-for', '--attest-actor', '--attest-ops', '--attest-read', '--attest-sources'] as const;
type Flag = typeof FLAGS[number];
const NEEDS: Record<Flag, string> = {
  '--member': 'Pass a member id, or none to unbind (gbrain access member list).',
  '--may-act-for': 'Pass a comma-separated list of member ids, group:<id>, guest or *, or none.',
  '--attest-actor': 'Pass qm (the system whose x-qm-actor header this credential may send), or none.',
  '--attest-ops': 'Pass a comma-separated list of operations an attested call may run (default get_write_request,memory_recall,memory_write).',
  '--attest-read': 'Pass person (a call that names sources reads them as the person), scope (as the scope, and every call must name a person) or none (the default: named sources read as the scope).',
  '--attest-sources': 'Pass a comma-separated list of scope sources an attested memory_write may name (source_id), or none.',
};

function parseAttestRead(value: string): 'person' | 'scope' | null {
  const v = value.trim();
  if (v === 'none') return null;
  if (v === 'person' || v === 'scope') return v;
  throw opError('invalid_params', `--attest-read ${value} is not a read mode.`, NEEDS['--attest-read']);
}

/** GST-1113: `--attest-sources a,b|none`: distinct source ids (each checked against the brain when applied), or null. */
function parseAttestSources(value: string): string[] | null {
  if (value.trim() === 'none') return null;
  const sources = [...new Set(value.split(',').map(s => s.trim()).filter(Boolean))];
  if (!sources.length) throw opError('invalid_params', '--attest-sources needs at least one source.', 'Pass a comma-separated list of scope source ids, or none to clear it.');
  for (const s of sources) assertValidSourceId(s);
  return sources.sort();
}

function parseAttestActor(value: string): string | null {
  if (value.trim() === 'none') return null;
  if (ATTEST_SYSTEMS.includes(value.trim())) return value.trim();
  throw opError('invalid_params', `--attest-actor ${value} is not a system gbrain trusts to name people.`, `Pass ${ATTEST_SYSTEMS.join(' or ')}, or none to clear the right.`);
}

/**
 * GBRA-218: `--member <id>|none` and `--may-act-for <list>|none` on auth create, rescope and register-client;
 * GST-359 C1: `--attest-actor qm|none` and `--attest-ops <list>` (the attest right); GST-1158 F3: `--attest-read
 * person|scope|none` (how an attested call that names sources reads them). Strips them from `args` (the
 * grant parsers never see them) and returns the binding patch, or null when no such flag was passed. An ill-formed
 * value throws access_member_invalid or invalid_params.
 */
export function takeBindingFlags(args: string[]): { args: string[]; patch: BindingPatch | null } {
  const out: string[] = [];
  const patch: BindingPatch = {};
  let seen = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--yes') { yes = true; continue; }
    // GST-363: --reads-unscoped (with --yes) lets one credential read unscoped on a brain that serves several people; none removes it.
    if (a === '--reads-unscoped' || a.startsWith('--reads-unscoped=')) {
      const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[i + 1] === 'none' ? args[++i] : undefined;
      if (value !== undefined && value !== 'none') throw usageError(`--reads-unscoped takes no value, or none (got ${value}).`, 'Pass --reads-unscoped --yes to let this credential read unscoped on purpose, or --reads-unscoped none to remove it.');
      patch.readsUnscoped = value === undefined;
      seen = true;
      continue;
    }
    const flag = FLAGS.find(f => a === f || a.startsWith(`${f}=`));
    if (!flag) { out.push(a); continue; }
    const value = a.includes('=') ? a.slice(a.indexOf('=') + 1) : args[++i];
    if (value === undefined || value === '' || value.startsWith('--')) throw usageError(`${flag} requires a value.`, NEEDS[flag]);
    if (flag === '--member') patch.member = parseMemberFlag(value);
    else if (flag === '--may-act-for') patch.mayActFor = parseMayActFor(value);
    else if (flag === '--attest-actor') patch.attestActor = parseAttestActor(value);
    else if (flag === '--attest-read') patch.attestRead = parseAttestRead(value);
    else if (flag === '--attest-ops') patch.attestOps = parseAttestOps(value, name => operationsByName[name]);
    else patch.attestSources = parseAttestSources(value);
    seen = true;
  }
  if (patch.readsUnscoped === true && !yes) {
    throw usageError('--reads-unscoped needs --yes: on a brain that serves several people this credential then reads every page no rule restricts, for whoever is asking.',
      'Bind it to the person it serves instead (--member <id>), or confirm with --reads-unscoped --yes.');
  }
  if (yes && patch.readsUnscoped === undefined) out.push('--yes');
  return { args: out, patch: seen ? patch : null };
}

/** Refuses a binding to a member that is not enabled before any credential is minted or changed. */
export async function checkBindingTarget(engine: BrainEngine, patch: BindingPatch | null): Promise<void> {
  if (patch?.member) await memberIdentity(engine, patch.member);
}

export function bindingLine(b: BindingResult, dryRun = false): string {
  const attest = b.attest_actor ? `; attests actor: ${b.attest_actor} for ${(b.attest_ops ?? DEFAULT_ATTEST_OPS).join(', ')}; named sources read as: ${b.attest_read ?? 'scope (default)'}${b.attest_sources?.length ? `; scope sources: ${b.attest_sources.join(', ')}` : ''}` : '';
  const unscoped = b.reads_unscoped === undefined ? '' : `; reads unscoped: ${b.reads_unscoped ? 'yes (every page no rule restricts, for any asker)' : 'no'}`;
  return `  Member: ${b.member ?? 'none'}; may act for: ${b.may_act_for?.join(', ') ?? 'none'}${attest}${unscoped}${b.changed ? (dryRun ? ' (preview, not written)' : ' (updated)') : ''}`;
}
