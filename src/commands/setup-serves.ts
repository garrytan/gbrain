/**
 * GST-363 (PR 1): `gbrain setup <harness> --serves one|several`. Setup stays engine-free, so every brain read and
 * write here is a child of the absolute launcher (as `gbrain init` is):
 *
 *   - `gbrain access serves --json` reads whether the brain serves several people, its owner and the member the
 *     stdio server reads as. An existing brain it cannot read refuses (setup_serves_unreadable). A one-person setup
 *     (the default) on a brain that serves several people refuses (setup_serves_several) unless the stdio connection
 *     it writes is bound: to config mcp.stdio_member, or to the owner (access.owner_member), which setup then writes
 *     as mcp.stdio_member. The brain-first text says the connection is already scoped only once it is bound.
 *   - `--serves several --members a,b` runs `gbrain access serves several --yes --json` (members, one folder rule per
 *     member, one bound key per member in a 0600 file) and proves the labels with one bound read per member
 *     per other member (`gbrain find people/<other>/ --as <member> --json`): none returns a page.
 */
import { opError, OperationError } from '../core/ops/contract.ts';
import { readRoster, rosterEmpty, type ServesReceipt, type ServesStatus, receiptLines, receiptOk } from './access-serves.ts';

export interface ServesFlags { serves?: 'one' | 'several'; members?: string; membersFile?: string; source?: string; dryRun: boolean }

export interface ProofLine { member: string; own: number; leaked: string[] }
export interface ServesOutcome {
  mode: 'one' | 'several';
  /** 'several' once the brain serves several people and this harness's connection is bound: the brain-first text follows it. */
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

/** The brain's serves view through a child, or the child's error when it cannot read the brain. */
export function readServesStatus(launcher: string): { status: ServesStatus } | { error: string } {
  const r = child(launcher, ['access', 'serves', '--json']);
  const status = r.ok ? parsed<ServesStatus>(r.stdout) : null;
  return status && 'serves' in status ? { status } : { error: (r.stderr || r.stdout).trim() || 'gbrain access serves --json printed nothing' };
}

export function servesUnreadable(error: string, harness: string): OperationError {
  return opError('setup_serves_unreadable', `Setup could not read whether this brain serves several people (${error.split('\n')[0]}), so it cannot tell whether the ${harness} connection would read for everyone. Nothing was written.`,
    'Run gbrain access serves --json to see why the brain cannot be read, fix that, then run setup again.',
    { fix: { argv: ['gbrain', 'access', 'serves', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Read-only: shows whom the brain serves, or the error that stops setup reading it.' } });
}

/** The refusal for a one-person setup that would write an unbound connection on a brain that serves several people. */
export function servesOneRefusal(status: ServesStatus | null, harness: string): OperationError | null {
  if (!status || status.serves !== 'several' || status.stdio_member || status.owner) return null;
  const why = status.from === 'config' ? 'config access.serves is several' : `it has ${status.enabled_members.length} enabled members (${status.enabled_members.join(', ')})`;
  const labelled = status.from === 'config';
  const argv = labelled ? ['gbrain', 'config', 'set', 'mcp.stdio_member', '<member>'] : ['gbrain', 'setup', harness, '--serves', 'several', '--members', status.enabled_members.join(',') || '<id,...>'];
  return opError('setup_serves_several',
    `This brain serves several people (${why}), and the ${harness} connection setup would write is bound to nobody, so it would read every page no rule restricts for whoever asks. Nothing was written.`,
    labelled ? `Bind this harness to the person it serves with ${argv.join(' ')} (or name the owner: gbrain access owner set <member>), then run setup again.`
      : `Run ${argv.join(' ')} to label each person, or name the owner first (gbrain access owner set <member>) so this harness reads as the owner.`,
    { fix: { argv, consent: ['credentials'], actor: 'user', ask_user: true, requires_exclusive: false,
      why: labelled ? 'Makes the local stdio server read as that member; the user picks who it serves.' : 'Adds a member, a folder only that member reads and a bound key for each person, and binds this harness to the owner when one is named.',
      verify: { argv: ['gbrain', 'access', 'serves', '--json'] } } });
}

/** --serves several: the labelling child (preview on a dry run) and, when applied, one bound read per member. */
function runServesSeveral(launcher: string, roster: string[], flags: ServesFlags): Omit<ServesOutcome, 'brain_serves'> {
  const r = child(launcher, ['access', 'serves', 'several', '--members', roster.join(','), ...(flags.source ? ['--source', flags.source] : []), ...(flags.dryRun ? [] : ['--yes']), '--json']);
  const receipt = parsed<ServesReceipt>(r.stdout);
  if (!receipt || !('members' in receipt)) return { mode: 'several', error: (r.stderr || r.stdout).trim() || 'gbrain access serves several failed' };
  if (flags.dryRun || receipt.error || !receipt.applied) return { mode: 'several', receipt };
  const source = flags.source ? ['--source-id', flags.source] : [];
  const read = (member: string, prefix: string, limit: number) => {
    const found = child(launcher, ['find', prefix, '--as', member, '--limit', String(limit), ...source, '--json']);
    return { pages: parsed<{ pages?: Array<{ slug: string }> }>(found.stdout)?.pages, error: (found.stderr || found.stdout).trim() };
  };
  const proof: ProofLine[] = [];
  for (const member of roster) {
    const own = read(member, `people/${member}/`, 500);
    if (!own.pages) return { mode: 'several', receipt, proof, error: `the bound read as ${member} failed: ${own.error}` };
    const leaked: string[] = [];
    for (const other of roster.filter(m => m !== member)) {
      const seen = read(member, `people/${other}/`, 20);
      if (!seen.pages) return { mode: 'several', receipt, proof, error: `the bound read as ${member} failed: ${seen.error}` };
      leaked.push(...seen.pages.map(p => p.slug));
    }
    proof.push({ member, own: own.pages.length, leaked });
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
  const read = hasBrain && !liveOurs ? readServesStatus(launcher) : null;
  if (read && 'error' in read) return servesUnreadable(read.error, harness);
  const status = read?.status ?? null;
  if (flags.serves === 'several') return { roster, status };
  const refusal = servesOneRefusal(status, harness);
  return refusal ?? { roster, status };
}

/** The serves part of a setup run (a preview on a dry run), or null when it has nothing to do or say: a one-person brain. */
export function servesApply(flags: ServesFlags, launcher: string, plan: ServesPlan, hasBrain: boolean): ServesOutcome | null {
  const several = flags.serves === 'several';
  const labelled = !several ? null : hasBrain || !flags.dryRun ? runServesSeveral(launcher, plan.roster, flags)
    : { mode: 'several' as const, note: `the new brain is created first; then ${plan.roster.join(', ')} each get a member, a folder rule and a bound key` };
  const reread = several && !flags.dryRun ? readServesStatus(launcher) : null;
  const status = reread ? ('status' in reread ? reread.status : null) : plan.status;
  const stdio = bindStdioToOwner(launcher, several && !status ? { serves: 'several', from: 'config', enabled_members: plan.roster, since: null, owner: null, stdio_member: null } : status, flags.dryRun);
  if (!labelled && !stdio) return null;
  const outcome: ServesOutcome = { ...(labelled ?? { mode: 'one' as const }), brain_serves: 'one', ...(stdio ? { stdio } : {}),
    ...(reread && 'error' in reread ? { error: `reading the brain back failed: ${reread.error}` } : {}) };
  const bound = !!stdio && stdio.action !== 'unbound';
  return { ...outcome, brain_serves: bound && servesOk(outcome) ? 'several' : 'one' };
}

/** Binds this harness's stdio server to the owner on a brain that serves several people, when nothing binds it yet. */
export function bindStdioToOwner(launcher: string, status: ServesStatus | null, dryRun: boolean): ServesOutcome['stdio'] {
  if (!status || status.serves !== 'several') return undefined;
  if (status.stdio_member) return { member: status.stdio_member, action: 'keep', detail: `this harness reads as ${status.stdio_member} (config mcp.stdio_member)` };
  if (!status.owner) return { member: null, action: 'unbound', detail: 'this harness reads as nobody in particular (only pages no rule restricts), so its instructions keep the one-person scoping lines: bind it with gbrain config set mcp.stdio_member <member> or name the owner (gbrain access owner set <member>), then run setup again' };
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
      : `  proof      a read bound to ${p.member} sees its own folder (${p.own} page(s)) and no page of another member's folder`),
    ...(o.stdio ? [`  stdio      ${o.stdio.detail}`] : []),
    ...(o.note ? [`  labels     ${o.note}`] : []),
    ...(o.error ? [`  error      ${o.error}`] : []),
  ];
}
