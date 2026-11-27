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
 *   - GBRA-585 D: on a brain with no owner it also names one: --owner <id>, else the login name as a member id
 *     (loginOwnerId), passed to the child as --owner. An existing owner is kept and no credential is rebound.
 *   - GBRA-585 C: turning a one-person brain shared while it holds open pages refuses (setup_history_choice_required)
 *     until the admin picks --labelled-only (keep that history private) or --open-history (members read it).
 */
import { closeSync, existsSync, openSync, readSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { openclawStateDir } from '../core/setup/brain-first.ts';
import { companySourceFirst, COMPANY_SOURCE, labelsInCompany, mintedKeysReadCalls, type BrainShape, type LayoutOutcome } from './setup-brain-layout.ts';
import { opError, OperationError } from '../core/ops/contract.ts';
import { ACCESS_ID_RE } from '../core/access/principals.ts';
import { bunSpawnSync } from '../core/spawn.ts';
import { loadConfig } from '../core/config.ts';
import { companyRuleLines, readRoster, readsLines, rosterEmpty, type ServesReceipt, type ServesStatus, receiptLines, receiptOk } from './access-serves.ts';

/** `source`: the source the members are labelled in, the harness's pinned source (--source, GBRAIN_SOURCE or a Codex receipt); unset, the labelling child resolves the brain's own (sources.default). `brain` and `team` are the run's --shape, so a pin on the company source adds it before labelling. */
export interface ServesFlags { serves?: 'one' | 'several'; members?: string; membersFile?: string; source?: string; stdioMember?: string; labelledOnly?: boolean; openHistory?: boolean; owner?: string; brain?: BrainShape; team?: boolean; dryRun: boolean }

/** GBRA-585 D: the login name of the person running setup as a member id (lower-cased, other characters as '-'), or null when none fits. */
export function loginOwnerId(login?: string): string | null {
  let name = login;
  if (name === undefined) { try { name = userInfo().username; } catch { name = process.env.USER ?? process.env.LOGNAME ?? ''; } }
  const id = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 64).replace(/[._-]+$/, '');
  return ACCESS_ID_RE.test(id) ? id : null;
}

/** The owner --serves several names when the brain has none: --owner, else the login name. */
function servesOwner(flags: ServesFlags, harness: string, roster: string[]): ServesOwner | OperationError {
  if (flags.owner) return { id: flags.owner, from: 'flag' };
  const id = loginOwnerId();
  return id ? { id, from: 'login' } : opError('invalid_params', `Setup names the brain owner from your login name, and it does not make a member id; nothing was written.`,
    `Name the owner yourself: run gbrain setup ${harness} --serves several --members ${roster.join(',')} again with --owner followed by the owner's member id.`);
}

export interface ServesOwner { id: string; from: 'flag' | 'login' }

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
  /** GBRA-585: on PGLite, what serving several people over `gbrain serve --http` costs the admin, and the move to Postgres. */
  engine?: string;
  /** GBRA-585 D: where the owner setup asked the child to name came from. */
  owner_from?: ServesOwner['from'];
  /** GBRA-585 A: the labelling child run again after the layout step added the company source, so the keys this run minted read it. */
  regrant?: ServesReceipt;
  /** GST-4043: the company source this run added before labelling the members in it (the layout step then keeps it). */
  company_first?: NonNullable<LayoutOutcome['company']>;
  error?: string;
}

/** GBRA-585: a PGLite brain is opened by one process at a time, so a running `gbrain serve --http` blocks most admin commands. */
export const PGLITE_SEVERAL_NOTE = 'PGLite lets one process at a time open this brain, so while gbrain serve --http runs for the members, '
  + 'admin commands (access, sources, auth) and most reads refuse with pglite_busy until it stops, and every member\'s connection drops while it is down; '
  + 'page and fact writes (put, remember) still work through it. For a brain several people use, move to Postgres first: gbrain migrate --to postgres (docs/ENGINES.md#pglite-live-serve)';

/**
 * GST-4043: a gbrain child on the host brain (GBRAIN_BRAIN_ID=host), so a .gbrain-mount or registered mount around the
 * directory setup runs from never redirects it; a thin client ignores the variable, where an explicit --brain refuses.
 */
function child(launcher: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const r = bunSpawnSync([launcher, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GBRAIN_BRAIN_ID: 'host' } });
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

/**
 * GBRA-585 C: --serves several on a brain that serves one person and holds pages the members' keys would read (the
 * labelling preview's open_pages, or a count that could not be read) needs the admin's choice first. A brain this run
 * creates, a brain with no open pages and a brain already shared are not refused.
 */
export function historyRefusal(status: ServesStatus | null, preview: ServesReceipt | null, flags: ServesFlags, harness: string, roster: string[], owner: ServesOwner | undefined, previewError?: string): OperationError | null {
  if (flags.serves !== 'several' || flags.labelledOnly || flags.openHistory || status?.serves !== 'one') return null;
  const counted = preview && 'members' in preview ? preview : null;
  const open = counted?.open_pages;
  if (open && !open.total) return null;
  const parts = open ? [open.sensitive ? `${open.sensitive} of them DMs, chat or mail` : '', open.archive ? `${open.archive} in the conversation archive` : ''].filter(Boolean) : [];
  const holds = open ? `${open.total} page(s) no rule or readable_by restricts${parts.length ? ` (${parts.join(', ')})` : ''}`
    : `pages setup could not count (${counted ? counted.open_pages_error?.code ?? 'open_pages_failed' : `the preview failed${previewError ? `: ${previewError}` : ''}`})`;
  const ownerId = status.owner ?? owner?.id;
  const labelled = roster.filter(m => m !== ownerId);
  const pin = owner && (owner.from === 'flag' || (owner.id === ownerId && labelled.length < roster.length)) ? ['--owner', owner.id] : [];
  const argvFor = (members: string[]) => ['gbrain', 'setup', harness, '--serves', 'several', '--members', members.join(','), ...(flags.source ? ['--source', flags.source] : []), ...pin];
  const keep = [...argvFor(labelled.length ? labelled : roster), '--labelled-only'];
  const share = [...argvFor(roster), '--open-history'];
  const ownerOut = ownerId && labelled.length && labelled.length < roster.length ? `; the owner ${ownerId} reads the whole brain, so it is never labelled-only and stays out of that run's --members` : '';
  return opError('setup_history_choice_required',
    `This brain serves one person and holds ${holds}; turned shared as asked, every member's key would read them. Nothing was written. Run setup again with --labelled-only to keep that history private, or with --open-history to let every member read it.`,
    `Pick one: ${keep.join(' ')} keeps that history private (each member reads only pages labelled for them; with the company shape, setup adds one company/ rule so they read the company pages${ownerOut}), or ${share.join(' ')} lets every member read it.`,
    { fix: { argv: keep, consent: ['credentials'], actor: 'user', ask_user: true, requires_exclusive: false,
      why: 'Keeps the existing pages from the members; ask the user, who may instead choose --open-history so the members read them.',
      verify: { argv: ['gbrain', 'access', 'serves', '--json'] } } });
}

/** --serves several: the labelling child (preview on a dry run) and, when applied, one bound read per member. */
function servesArgv(roster: string[], flags: ServesFlags, owner: ServesOwner | undefined, apply: boolean): string[] {
  return ['access', 'serves', 'several', '--members', roster.join(','), ...(flags.source ? ['--source', flags.source] : []), ...(flags.labelledOnly ? ['--labelled-only'] : []), ...(owner ? ['--owner', owner.id] : []), ...(apply ? ['--yes'] : []), '--json'];
}

function runServesSeveral(launcher: string, roster: string[], flags: ServesFlags, owner: ServesOwner | undefined): Omit<ServesOutcome, 'brain_serves'> {
  const r = child(launcher, servesArgv(roster, flags, owner, !flags.dryRun));
  const receipt = parsed<ServesReceipt>(r.stdout);
  const from = owner ? { owner_from: owner.from } : {};
  if (!receipt || !('members' in receipt)) return { mode: 'several', ...from, error: (r.stderr || r.stdout).trim() || 'gbrain access serves several failed' };
  if (flags.dryRun || receipt.error || !receipt.applied) return { mode: 'several', ...from, receipt };
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
  return { mode: 'several', ...from, receipt, proof };
}

/** `tie`: the owner a company setup's own harness entry reads as (GST-2904), known to be an enabled member once this run's labelling lands. */
export interface ServesPlan { roster: string[]; status: ServesStatus | null; owner?: ServesOwner; tie?: string }

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
  if (flags.serves === 'several') {
    const owner = servesOwner(flags, harness, roster);
    if (owner instanceof OperationError) return owner;
    const run = status?.serves === 'one' && !flags.labelledOnly && !flags.openHistory ? child(launcher, servesArgv(roster, flags, owner, false)) : null;
    const preview = run ? parsed<ServesReceipt>(run.stdout) : null;
    const said = run ? `${run.stdout}\n${run.stderr}` : '';
    const previewError = said.match(/"code"\s*:\s*"([a-z0-9_]+)"/)?.[1] ?? run?.stderr.trim().split('\n')[0]?.slice(0, 200);
    const tie = status?.owner ?? (!status ? owner.id : preview?.owner && preview.owner.action !== 'blocked' ? preview.owner.id : undefined);
    return historyRefusal(status, preview, flags, harness, roster, owner, previewError || undefined) ?? { roster, status, owner, ...(tie ? { tie } : {}) };
  }
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
  const inCompany = several && labelsInCompany(flags.brain, !!flags.team, flags.source);
  const first = inCompany && (hasBrain || !flags.dryRun) ? companySourceFirst(launcher, flags.dryRun) : null;
  const ahead = [...(hasBrain ? [] : ['the new brain is created']), ...(flags.dryRun && inCompany && (!hasBrain || first?.action === 'created') ? [`source ${COMPANY_SOURCE} is added`] : [])];
  const labelled = !several ? null
    : first?.action === 'failed' ? { mode: 'several' as const, error: `source ${COMPANY_SOURCE}, which the members are labelled in, could not be added: ${first.detail ?? 'unknown error'}` }
    : !ahead.length || !flags.dryRun ? { ...runServesSeveral(launcher, plan.roster, flags, plan.owner), ...(first?.action === 'created' ? { company_first: first } : {}) }
    : { mode: 'several' as const, note: `${ahead.join(' and ')} first; then ${plan.roster.join(', ')} each get a member, a folder rule and a bound key${plan.owner ? `, and ${plan.owner.id} is named the brain owner` : ''}` };
  const reread = several && !flags.dryRun ? readServesStatus(launcher) : null;
  const status = reread ? ('status' in reread ? reread.status : null) : plan.status;
  const preview = several && flags.dryRun && status?.serves !== 'several';
  const view: ServesStatus | null = preview ? { serves: 'several', from: 'config', enabled_members: plan.roster, since: null, owner: null, stdio_member: status?.stdio_member ?? null } : status;
  const stdio = bindStdio(harness, view, entry, flags.dryRun);
  if (!labelled && !stdio) return null;
  const pglite = several && (loadConfig()?.engine ?? 'pglite') === 'pglite';
  const outcome: ServesOutcome = { ...(labelled ?? { mode: 'one' as const }), brain_serves: 'one', ...(stdio ? { stdio } : {}), ...(pglite ? { engine: PGLITE_SEVERAL_NOTE } : {}),
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
  return !o || (!o.error && (!o.receipt || receiptOk(o.receipt)) && (!o.regrant || receiptOk(o.regrant)) && (o.proof ?? []).every(p => p.leaked.length === 0));
}

/**
 * GBRA-585 A: setup labels the people before the layout step adds the company source, so when this run added it, the
 * labelling child runs once more and the keys it minted with a source list gain `company` (it adds, never removes).
 * A dry run says so instead. When the re-run adds the company/ rule (--labelled-only), the layout's call readers become
 * that rule's readers, since the layout step read them before the rule existed. Otherwise the readers line names the
 * member keys setup minted only once this run left them reading `company` (callReadersAfterServes).
 */
export function servesAfterLayout(o: ServesOutcome | null, flags: ServesFlags, launcher: string, plan: ServesPlan, layout: LayoutOutcome | null | undefined): ServesOutcome | null {
  if (!o || flags.serves !== 'several') return o;
  const added = layout?.company?.action === 'created';
  if (o.company_first && layout?.company?.action === 'kept') layout.company = o.company_first;
  if (!added) {
    callReadersAfterServes(o.receipt, launcher, plan, layout);
    return o;
  }
  if (flags.dryRun) return { ...o, note: [o.note, 'the member keys this run mints also read source company once the layout step adds it: every page in it, including the calls it imports, which every member reads whether or not they attended',
    ...(flags.labelledOnly ? ['as the members are labelled-only, a folder rule company/ in source company then names them and the owner as its readers'] : [])].filter(Boolean).join('; ') };
  if (!o.receipt?.applied || o.error) return o;
  const r = child(launcher, servesArgv(plan.roster, flags, plan.owner, true));
  const regrant = parsed<ServesReceipt>(r.stdout);
  if (!regrant || !('members' in regrant)) return { ...o, error: `giving the member keys source company failed: ${(r.stderr || r.stdout).trim() || 'gbrain access serves several printed nothing'}` };
  const rule = regrant.company_rule;
  if (rule && rule.action !== 'blocked' && layout.transcripts?.readers) {
    const names = rule.readers.map(p => p.replace(/^member:/, ''));
    layout.transcripts.readers = { members: names, serves: 'several', detail: `${names.join(', ')} only (the company/ rule on source company names them, so the labelled-only members read the calls through it)` };
  } else callReadersAfterServes(regrant, launcher, plan, layout);
  return { ...o, regrant };
}

/** GBRA-585 A: the layout read the call readers before the labelling ran; once a member key this run left reads company, they are those keys. */
function callReadersAfterServes(receipt: ServesReceipt | undefined, launcher: string, plan: ServesPlan, layout: LayoutOutcome | null | undefined): void {
  const readers = layout?.transcripts?.readers;
  if (!readers || readers.members !== 'every_source_reader' || readers.serves !== 'several' || !receipt?.applied || !receipt.keys.some(k => k.reads?.includes('company'))) return;
  const status = parsed<{ enabled_members?: string[] }>(child(launcher, ['access', 'serves', '--json', '--no-open-pages']).stdout);
  layout!.transcripts!.readers = { members: 'every_source_reader', serves: 'several', detail: mintedKeysReadCalls(status?.enabled_members ?? plan.roster) };
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
    ...(o.owner_from === 'login' && o.receipt?.owner && o.receipt.owner.action !== 'keep' && o.receipt.owner.action !== 'blocked'
      ? [`  owner      ${o.receipt.owner.id} is named from your login name; to name someone else, ${dryRun ? 'pass --owner <id>' : 'add them (gbrain access member add <id>) and run gbrain access owner set <id>'}`] : []),
    ...(o.regrant ? [...o.regrant.keys.filter(k => k.adds?.length).map(k => `  key        ${k.member}: now also reads ${k.adds!.join(', ')}, which this run added`),
      ...o.regrant.keys.filter(k => k.action === 'skipped').map(k => `  key        ${k.member}: skipped: ${k.detail}`), ...companyRuleLines(o.regrant), ...readsLines(o.regrant)] : []),
    ...(o.stdio ? [`  stdio      ${o.stdio.detail}`] : []),
    ...(o.engine ? [`  engine     ${o.engine}`] : []),
    ...(o.note ? [`  labels     ${o.note}`] : []),
    ...(o.error ? [`  error      ${o.error}`] : []),
  ];
}
