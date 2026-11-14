/**
 * GST-363 (PR 1): `gbrain setup <harness> --serves one|several`. Setup stays engine-free, so every brain read and
 * write here is a child of the absolute launcher (as `gbrain init` is):
 *
 *   - `gbrain access serves --json` reads whether the brain serves several people and the member the stdio server
 *     reads as. An existing brain it cannot read refuses (setup_serves_unreadable). A one-person setup (the default)
 *     on a brain that serves several people refuses (setup_serves_several) unless this harness's entry or config
 *     mcp.stdio_member binds the stdio connection. --stdio-member <enabled member> on claude-code or codex writes
 *     `serve --stdio-member <member>` into that one harness entry (setup never writes mcp.stdio_member), so it binds
 *     only that harness on this machine, PGLite or Postgres; setup refuses the flag where a shared-stdio harness
 *     (sharedStdioHarness) is installed. A rewrite carries an entry's own member forward and never adds one. The
 *     brain-first text says the connection is already scoped only once it is bound.
 *   - `--serves several --members a,b` runs `gbrain access serves several --yes --json` (members, one folder rule per
 *     member, one bound key per member in a 0600 file) and proves the labels with one bound read per member
 *     per other member (`gbrain find people/<other>/ --as <member> --json`): none returns a page.
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openclawStateDir } from '../core/setup/brain-first.ts';
import { opError, OperationError } from '../core/ops/contract.ts';
import { bunSpawnSync } from '../core/spawn.ts';
import { readRoster, rosterEmpty, type ServesReceipt, type ServesStatus, receiptLines, receiptOk } from './access-serves.ts';

export interface ServesFlags { serves?: 'one' | 'several'; members?: string; membersFile?: string; source?: string; stdioMember?: string; labelledOnly?: boolean; dryRun: boolean }

/** GST-363: the --stdio-member this harness entry will carry (member) and the one it carries now (previous). */
export interface EntryBinding { member: string | null; previous: string | null }

/**
 * A harness installed on this host whose stdio sessions serve several conversations (OpenClaw, Hermes), or null.
 * A `hermes` on PATH counts only as a script (the Hermes agent's launcher): React Native ships a compiled JavaScript
 * engine under the same name.
 */
export function sharedStdioHarness(): string | null {
  const which = (bin: string) => { try { return Bun.which(bin, { PATH: process.env.PATH ?? '' }); } catch { return null; } };
  if (which('openclaw') || existsSync(openclawStateDir())) return 'OpenClaw';
  if (isScript(which('hermes')) || existsSync(process.env.HERMES_HOME?.trim() || join(homedir(), '.hermes'))) return 'Hermes';
  return null;
}

function isScript(path: string | null): boolean {
  if (!path) return false;
  try {
    const fd = openSync(path, 'r');
    try { const head = Buffer.alloc(2); return readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === '#!'; } finally { closeSync(fd); }
  } catch { return false; }
}

export interface ProofLine { member: string; own: number; leaked: string[] }
export interface ServesOutcome {
  mode: 'one' | 'several';
  /** 'several' once the brain serves several people and this harness's connection is bound: the brain-first text follows it. */
  brain_serves: 'one' | 'several';
  note?: string;
  receipt?: ServesReceipt;
  proof?: ProofLine[];
  stdio?: { member: string | null; action: 'write' | 'keep' | 'remove' | 'unbound'; detail: string };
  error?: string;
}

function child(launcher: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = bunSpawnSync([launcher, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env });
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
  const r = child(launcher, ['access', 'serves', '--json', '--no-open-pages']);
  const status = r.ok ? parsed<ServesStatus>(r.stdout) : null;
  return status && 'serves' in status ? { status } : { error: (r.stderr || r.stdout).trim() || 'gbrain access serves --json printed nothing' };
}

export function servesUnreadable(error: string, harness: string): OperationError {
  return opError('setup_serves_unreadable', `Setup could not read whether this brain serves several people (${error.split('\n')[0]}), so it cannot tell whether the ${harness} connection would read for everyone. Nothing was written.`,
    'Run gbrain access serves --json to see why the brain cannot be read, fix that, then run setup again.',
    { fix: { argv: ['gbrain', 'access', 'serves', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Read-only: shows whom the brain serves, or the error that stops setup reading it.' } });
}

/** The refusal for a one-person setup that would write an unbound connection on a brain that serves several people. */
export function servesOneRefusal(status: ServesStatus | null, harness: string, entry: EntryBinding = { member: null, previous: null }): OperationError | null {
  if (!status || status.serves !== 'several' || status.stdio_member || (entry.member && status.enabled_members.includes(entry.member))) return null;
  if (!entry.member && entry.previous) return null;
  const why = status.from === 'config' ? 'config access.serves is several' : `it has ${status.enabled_members.length} enabled members (${status.enabled_members.join(', ')})`;
  const argv = ['gbrain', 'setup', harness, '--serves', 'several', '--members', status.enabled_members.join(',') || '<id,...>'];
  return opError('setup_serves_several',
    `This brain serves several people (${why}), and the ${harness} connection setup would write is bound to nobody, so it would read every page no rule restricts for whoever asks. Nothing was written.`,
    `Run ${argv.join(' ')} to label each person; add --stdio-member <member> only for a harness that one person alone uses.`,
    { fix: { argv, consent: ['credentials'], actor: 'user', ask_user: true, requires_exclusive: false,
      why: 'Adds a member, a folder only that member reads and a bound key for each person; the stdio server stays unbound unless the user names --stdio-member.',
      verify: { argv: ['gbrain', 'access', 'serves', '--json'] } } });
}

/** --serves several: the labelling child (preview on a dry run) and, when applied, one bound read per member. */
function runServesSeveral(launcher: string, roster: string[], flags: ServesFlags): Omit<ServesOutcome, 'brain_serves'> {
  const r = child(launcher, ['access', 'serves', 'several', '--members', roster.join(','), ...(flags.source ? ['--source', flags.source] : []), ...(flags.labelledOnly ? ['--labelled-only'] : []), ...(flags.dryRun ? [] : ['--yes']), '--json']);
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
export function servesPreflight(flags: ServesFlags, launcher: string, harness: string, hasBrain: boolean, liveOurs: boolean, entry: EntryBinding = { member: null, previous: null }): ServesPlan | OperationError {
  const roster = servesRoster(flags, harness);
  if (roster instanceof OperationError) return roster;
  const named = flags.stdioMember;
  if (named && flags.serves === 'several' && !roster.includes(named)) return opError('invalid_params', `--stdio-member ${named} is not one of the people in --members; nothing was written.`, 'Name a member listed in --members.');
  if (named && flags.serves !== 'several' && !hasBrain) return opError('invalid_params', `--stdio-member ${named} names a member, and this brain does not exist yet, so it has none; nothing was written.`, `Label the people it serves in the same run: gbrain setup ${harness} --serves several --members <ids> --stdio-member ${named}.`);
  if ((flags.serves === 'several' || named) && liveOurs) {
    return opError('setup_owner_conflict', `A live stdio serve started by this registration holds the PGLite brain, and ${flags.serves === 'several' ? 'labelling several people needs to write to it' : `checking that ${named} is an enabled member needs to read it`}; nothing was written.`,
      `Quit the ${harness} session that started it, then run setup again.`, { reason: 'live_serve', docs: 'docs/guides/repair.md#setup-owner-conflict' });
  }
  const read = hasBrain && !liveOurs ? readServesStatus(launcher) : null;
  if (read && 'error' in read) return servesUnreadable(read.error, harness);
  const status = read?.status ?? null;
  if (flags.serves === 'several') return { roster, status };
  if (named && !status?.enabled_members.includes(named)) {
    return opError('invalid_params', `--stdio-member ${named} is not an enabled member of this brain, so the ${harness} sessions would read as nobody; nothing was written.`,
      `Name one of: ${status?.enabled_members.join(', ') || '(none yet; label them with --serves several --members <ids>)'}.`,
      { fix: { argv: ['gbrain', 'access', 'serves', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why: 'Read-only: lists the enabled members a --stdio-member may name.' } });
  }
  const refusal = servesOneRefusal(status, harness, entry);
  return refusal ?? { roster, status };
}

/** The serves part of a setup run (a preview on a dry run), or null when it has nothing to do or say: a one-person brain with no bound entry. */
export function servesApply(flags: ServesFlags, launcher: string, harness: string, plan: ServesPlan, hasBrain: boolean, entry: EntryBinding = { member: null, previous: null }): ServesOutcome | null {
  const several = flags.serves === 'several';
  const labelled = !several ? null : hasBrain || !flags.dryRun ? runServesSeveral(launcher, plan.roster, flags)
    : { mode: 'several' as const, note: `the new brain is created first; then ${plan.roster.join(', ')} each get a member, a folder rule and a bound key` };
  const reread = several && !flags.dryRun ? readServesStatus(launcher) : null;
  const status = reread ? ('status' in reread ? reread.status : null) : plan.status;
  const preview = several && flags.dryRun && status?.serves !== 'several';
  const view: ServesStatus | null = preview ? { serves: 'several', from: 'config', enabled_members: plan.roster, since: null, owner: null, stdio_member: status?.stdio_member ?? null } : status;
  const stdio = bindStdio(harness, view, entry, flags.dryRun);
  if (!labelled && !stdio) return null;
  const outcome: ServesOutcome = { ...(labelled ?? { mode: 'one' as const }), brain_serves: 'one', ...(stdio ? { stdio } : {}),
    ...(reread && 'error' in reread ? { error: `reading the brain back failed: ${reread.error}` } : {}) };
  const bound = !!stdio?.member && view?.serves === 'several';
  return { ...outcome, brain_serves: bound && servesOk(outcome) ? 'several' : 'one' };
}

/**
 * Whom this harness's stdio sessions read as. Setup writes nothing to the brain here: the member rides in the harness
 * entry (`serve --stdio-member`, written by the MCP step), and config mcp.stdio_member is only ever set by hand.
 */
export function bindStdio(harness: string, status: ServesStatus | null, entry: EntryBinding, dryRun: boolean): ServesOutcome['stdio'] {
  const tense = (done: string, todo: string) => dryRun ? `would ${todo}` : done;
  const m = entry.member;
  if (m) {
    const action = m === entry.previous ? 'keep' as const : 'write' as const;
    const starts = action === 'keep' ? 'starts' : tense('now starts', 'start');
    if (status && !status.enabled_members.includes(m)) return { member: null, action, detail: `this ${harness} entry ${starts} serve --stdio-member ${m}, and ${m} is not an enabled member of this brain, so its sessions read as nobody` };
    return { member: m, action, detail: `this ${harness} entry ${starts} serve --stdio-member ${m}: only its sessions read as ${m}, including pages only ${m} may read; other harnesses on this host are unchanged` };
  }
  const removed = entry.previous ? `${tense('removed', 'remove')} --stdio-member ${entry.previous} from this ${harness} entry; ` : '';
  const action = removed ? 'remove' as const : null;
  if (status?.stdio_member) return { member: status.stdio_member, action: action ?? 'keep', detail: `${removed}this harness reads as ${status.stdio_member} through config mcp.stdio_member, set by hand, which every stdio session that opens this brain without --stdio-member reads as` };
  if (status?.serves !== 'several' && !removed) return undefined;
  return { member: null, action: action ?? 'unbound', detail: `${removed}this harness's stdio sessions read only pages no rule restricts, so its instructions keep the one-person scoping lines; to bind a harness only one person uses, run gbrain setup ${harness} --stdio-member <member>` };
}

export function servesOk(o: ServesOutcome | null): boolean {
  return !o || (!o.error && (!o.receipt || receiptOk(o.receipt)) && (o.proof ?? []).every(p => p.leaked.length === 0));
}

/** GST-2670 (F9): the proof covers the people/ folders only, so it names the open pages that member's key still reads. */
function openTail(r: ServesReceipt | undefined, member: string): string {
  const open = r?.open_pages;
  if (!r || r.open_pages === undefined) return '';
  if (!open) return '; open pages unknown';
  if (!open.total || r.members.find(m => m.id === member)?.labelled_only || member === open.owner) return '';
  return `; its keys can also read open pages listed above (${open.total} across the members' sources)`;
}

export function servesLines(o: ServesOutcome, dryRun: boolean): string[] {
  return [
    ...(o.receipt ? receiptLines(o.receipt).filter(l => !(dryRun && l.startsWith('Nothing written'))) : []),
    ...(o.proof ?? []).map(p => p.leaked.length
      ? `  proof      ${p.member} reads pages of another member's folder: ${p.leaked.join(', ')}`
      : `  proof      a read bound to ${p.member} sees its own folder (${p.own} page(s)) and no page of another member's folder${openTail(o.receipt, p.member)}`),
    ...(o.stdio ? [`  stdio      ${o.stdio.detail}`] : []),
    ...(o.note ? [`  labels     ${o.note}`] : []),
    ...(o.error ? [`  error      ${o.error}`] : []),
  ];
}
