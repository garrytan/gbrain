/**
 * GST-363 (PR 1): `gbrain setup <harness> --serves one|several`. Setup stays engine-free, so every brain read and
 * write here is a child of the absolute launcher (as `gbrain init` is):
 *
 *   - `gbrain access serves --json` reads whether the brain serves several people, its owner and the member the
 *     stdio server reads as. A one-person setup (the default) on a brain that serves several people refuses
 *     (setup_serves_several) unless the stdio connection it writes is bound: to config mcp.stdio_member, or to the
 *     owner (access.owner_member), which setup then writes as mcp.stdio_member.
 *   - `--serves several --members a,b` runs `gbrain access serves several --yes --json` (members, one folder rule per
 *     member, one bound key per member in a 0600 file) and proves the labels with one bound read per member
 *     (`gbrain find people/ --as <member> --json`): each sees its own folder and world pages, never another
 *     member's folder.
 */
import { opError, OperationError } from '../core/ops/contract.ts';
import { readRoster, rosterEmpty, type ServesReceipt, type ServesStatus, receiptLines, receiptOk } from './access-serves.ts';

export interface ServesFlags { serves?: 'one' | 'several'; members?: string; membersFile?: string; source?: string; dryRun: boolean }

export interface ProofLine { member: string; own: number; world: number; leaked: string[] }
export interface ServesOutcome {
  mode: 'one' | 'several';
  /** Whether the brain serves several people once this run is done: the brain-first text follows it. */
  brain_serves: 'one' | 'several';
  note?: string;
  receipt?: ServesReceipt;
  proof?: ProofLine[];
  stdio?: { member: string | null; action: 'write' | 'keep' | 'unbound'; detail: string };
  error?: string;
}

function child(launcher: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = Bun.spawnSync([launcher, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env });
  return { ok: r.exitCode === 0, stdout: r.stdout?.toString() ?? '', stderr: r.stderr?.toString() ?? '' };
}

function parsed<T>(text: string): T | null {
  try { return JSON.parse(text) as T; } catch { return null; }
}

/** The roster for --serves several, validated before setup writes anything; an empty one refuses with the fix. */
export function servesRoster(flags: ServesFlags, harness: string): string[] | OperationError {
  if (flags.serves !== 'several') return [];
  try {
    const roster = readRoster(flags.members, flags.membersFile);
    return roster.length ? roster : rosterEmpty(`gbrain setup ${harness} --serves several`) as OperationError;
  } catch (e) {
    if (e instanceof OperationError) return e;
    return opError('invalid_params', `--members-file could not be read: ${(e as Error).message}`, 'Pass a readable file with one member id per line.');
  }
}

/** The brain's serves view through a child, or null when there is no brain yet or the child cannot read it. */
export function readServesStatus(launcher: string): ServesStatus | null {
  const r = child(launcher, ['access', 'serves', '--json']);
  return r.ok ? parsed<ServesStatus>(r.stdout) : null;
}

/** The refusal for a one-person setup that would write an unbound connection on a brain that serves several people. */
export function servesOneRefusal(status: ServesStatus | null, harness: string): OperationError | null {
  if (!status || status.serves !== 'several' || status.stdio_member || status.owner) return null;
  const why = status.from === 'config' ? 'config access.serves is several' : `it has ${status.enabled_members.length} enabled members (${status.enabled_members.join(', ')})`;
  const argv = ['gbrain', 'setup', harness, '--serves', 'several', '--members', status.enabled_members.join(',') || '<id,...>'];
  return opError('setup_serves_several',
    `This brain serves several people (${why}), and the ${harness} connection setup would write is bound to nobody, so it would read every page no rule restricts for whoever asks. Nothing was written.`,
    `Run ${argv.join(' ')} to label each person, or name the owner first (gbrain access owner set <member>) so this harness reads as the owner.`,
    { fix: { argv, consent: ['credentials'], actor: 'user', ask_user: true, requires_exclusive: false,
      why: 'Adds a member, a folder only that member reads and a bound key for each person, and binds this harness to the owner when one is named.',
      verify: { argv: ['gbrain', 'access', 'serves', '--json'] } } });
}

/** --serves several: the labelling child (preview on a dry run) and, when applied, one bound read per member. */
function runServesSeveral(launcher: string, roster: string[], flags: ServesFlags): Omit<ServesOutcome, 'brain_serves'> {
  const r = child(launcher, ['access', 'serves', 'several', '--members', roster.join(','), ...(flags.source ? ['--source', flags.source] : []), ...(flags.dryRun ? [] : ['--yes']), '--json']);
  const receipt = parsed<ServesReceipt>(r.stdout);
  if (!receipt || !('members' in receipt)) return { mode: 'several', error: (r.stderr || r.stdout).trim() || 'gbrain access serves several failed' };
  if (flags.dryRun || receipt.error) return { mode: 'several', receipt };
  const proof: ProofLine[] = [];
  for (const member of roster) {
    const found = child(launcher, ['find', 'people/', '--as', member, '--limit', '500', ...(flags.source ? ['--source-id', flags.source] : []), '--json']);
    const pages = parsed<{ pages?: Array<{ slug: string }> }>(found.stdout)?.pages;
    if (!pages) return { mode: 'several', receipt, proof, error: `the bound read as ${member} failed: ${(found.stderr || found.stdout).trim()}` };
    const others = roster.filter(m => m !== member).map(m => `people/${m}/`);
    proof.push({ member, own: pages.filter(p => p.slug.startsWith(`people/${member}/`)).length,
      world: pages.filter(p => !roster.some(m => p.slug.startsWith(`people/${m}/`))).length,
      leaked: pages.map(p => p.slug).filter(s => others.some(o => s.startsWith(o))) });
  }
  return { mode: 'several', receipt, proof };
}

export interface ServesPlan { roster: string[]; status: ServesStatus | null }

/**
 * Before setup writes anything: the roster (an empty one refuses), the brain's serves view (none for a brain setup is
 * about to create, or while this registration's own stdio serve holds a PGLite brain), and the one-person refusal.
 */
export function servesPreflight(flags: ServesFlags, launcher: string, harness: string, hasBrain: boolean, liveOurs: boolean): ServesPlan | OperationError {
  const roster = servesRoster(flags, harness);
  if (roster instanceof OperationError) return roster;
  if (flags.serves === 'several' && liveOurs) {
    return opError('setup_owner_conflict', 'A live stdio serve started by this registration holds the PGLite brain, and labelling several people needs to write to it; nothing was written.',
      `Quit the ${harness} session that started it, then run setup again.`, { reason: 'live_serve', docs: 'docs/guides/repair.md#setup-owner-conflict' });
  }
  const status = hasBrain && !liveOurs ? readServesStatus(launcher) : null;
  if (flags.serves === 'several') return { roster, status };
  const refusal = servesOneRefusal(status, harness);
  return refusal ?? { roster, status };
}

/** The serves part of a setup run (a preview on a dry run), or null when it has nothing to do or say: a one-person brain. */
export function servesApply(flags: ServesFlags, launcher: string, plan: ServesPlan, hasBrain: boolean): ServesOutcome | null {
  const several = flags.serves === 'several';
  const labelled = !several ? null : hasBrain || !flags.dryRun ? runServesSeveral(launcher, plan.roster, flags)
    : { mode: 'several' as const, note: `the new brain is created first; then ${plan.roster.join(', ')} each get a member, a folder rule and a bound key` };
  const status = several && !flags.dryRun ? readServesStatus(launcher) : plan.status;
  const stdio = bindStdioToOwner(launcher, several && !status ? { serves: 'several', from: 'config', enabled_members: plan.roster, owner: null, stdio_member: null } : status, flags.dryRun);
  if (!labelled && !stdio) return null;
  return { ...(labelled ?? { mode: 'one' as const }), brain_serves: several || status?.serves === 'several' ? 'several' : 'one', ...(stdio ? { stdio } : {}) };
}

/** Binds this harness's stdio server to the owner on a brain that serves several people, when nothing binds it yet. */
export function bindStdioToOwner(launcher: string, status: ServesStatus | null, dryRun: boolean): ServesOutcome['stdio'] {
  if (!status || status.serves !== 'several') return undefined;
  if (status.stdio_member) return { member: status.stdio_member, action: 'keep', detail: `this harness reads as ${status.stdio_member} (config mcp.stdio_member)` };
  if (!status.owner) return { member: null, action: 'unbound', detail: 'this harness reads as nobody in particular: name the owner (gbrain access owner set <member>) and run setup again to bind it' };
  if (!dryRun) {
    const r = child(launcher, ['config', 'set', 'mcp.stdio_member', status.owner]);
    if (!r.ok) return { member: null, action: 'unbound', detail: `gbrain config set mcp.stdio_member ${status.owner} failed: ${r.stderr.trim()}` };
  }
  return { member: status.owner, action: 'write', detail: `this harness reads as the owner, ${status.owner} (config mcp.stdio_member)` };
}

export function servesOk(o: ServesOutcome | null): boolean {
  return !o || (!o.error && (!o.receipt || receiptOk(o.receipt)) && (o.proof ?? []).every(p => p.leaked.length === 0));
}

export function servesLines(o: ServesOutcome, dryRun: boolean): string[] {
  return [
    ...(o.receipt ? receiptLines(o.receipt).filter(l => !(dryRun && l.startsWith('Nothing written'))) : []),
    ...(o.proof ?? []).map(p => p.leaked.length
      ? `  proof      ${p.member} reads pages of another member's folder: ${p.leaked.join(', ')}`
      : `  proof      a read bound to ${p.member} sees its own folder (${p.own} page(s)) and ${p.world} world page(s) under people/, and no other member's folder`),
    ...(o.stdio ? [`  stdio      ${o.stdio.detail}`] : []),
    ...(o.note ? [`  labels     ${o.note}`] : []),
    ...(o.error ? [`  error      ${o.error}`] : []),
  ];
}
