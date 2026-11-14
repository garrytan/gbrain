/**
 * GST-363 (PR 1): `gbrain access serves`, the labelling half of a brain that serves several people.
 *
 *   gbrain access serves [--json] [--no-open-pages]      Read-only: one or several, why, owner, stdio member, open pages
 *   gbrain access serves several --members a,b [--members-file f] [--source id] [--labelled-only] [--yes] [--json]
 *
 * `several` previews, then with --yes: writes config access.serves = several, adds each member (existing ones are
 * kept), adds one folder rule per member (people/<member>/ readable by that member) through the folder-rule path
 * (preview, then write at the previewed revision; a git-store source commits .gbrain/access.yml through the commit
 * door, a repo-less source writes the database revision log), and mints one key per member through the auth create
 * mint, bound to that member and written to a 0600 file under <configDir>/member-keys/, never inside a git work tree.
 * A preview with any BLOCKED line writes nothing; config access.serves is written last, once members, rules and keys
 * are in place. Every step is idempotent on the member id, so a re-run after a partial failure converges; the receipt names paths,
 * never key values. `gbrain setup <harness> --serves several` runs this as a child and adds the bound-read proof.
 * GST-2670: the preview, the receipt and the read-only status also count the pages every member's key can still read
 * (core/access/open-pages.ts, best effort: a failed count never stops the run), and --labelled-only marks each member
 * of the roster labelled-only after the members step (never the owner, refused before anything is written).
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { configDir } from '../core/config.ts';
import { hashToken } from '../core/utils.ts';
import { opError } from '../core/ops/contract.ts';
import { usageError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { normalizeRule, type FolderRule } from '../core/access/folder-rules.ts';
import { addMember, getMember, parseIdList } from '../core/access/members.ts';
import { ownerMemberId } from '../core/access/owner.ts';
import { stdioMemberId } from '../core/access/caller.ts';
import { brainServes, SERVES_KEY, unlabeledPeopleFolders, type PeopleFolder, type ServesView } from '../core/access/serves.ts';
import { setMemberLabelledOnly } from '../core/access/labelled-only.ts';
import { openPagesLines, readOpenPages, type OpenPagesError, type OpenPagesRead } from '../core/access/open-pages.ts';
import type { OpenPages } from '../core/access/open-pages.ts';
import { addFolderRules, currentFolderRules } from './access-rules.ts';
import { mintToken } from './auth-mint.ts';

export const MEMBER_KEY_DIR = 'member-keys';
export const memberKeyName = (member: string): string => `member-${member}`;
export const memberKeyDir = (): string => join(configDir(), MEMBER_KEY_DIR);

export interface ServesStatus extends ServesView { owner: string | null; stdio_member: string | null; open_pages?: OpenPages | null; open_pages_error?: OpenPagesError }

type Step = 'members' | 'labelled_only' | 'rules' | 'keys' | 'config';
export interface ServesReceipt {
  serves: 'several';
  source_id: string;
  applied: boolean;
  config: { key: string; value: 'several'; action: 'write' | 'keep' };
  members: Array<{ id: string; action: 'add' | 'keep' | 'blocked'; detail?: string; labelled_only?: 'set' | 'keep' }>;
  rules: Array<{ id: string; prefix: string; readers: string[]; action: 'add' | 'keep' | 'blocked'; detail?: string }>;
  rule_write?: { store: string; revision: number | null; state: string; git_commit?: string | null };
  keys: Array<{ member: string; token_name: string; path: string; action: 'mint' | 'keep' | 'blocked'; detail?: string }>;
  key_dir: string;
  /** People folders with pages that no rule covers once this run's rules are in place: every member reads them. */
  unlabeled: PeopleFolder[];
  /** GST-2670: the pages no rule or readable_by restricts that the members' keys read, once this run's rules are in place; null when the count failed. */
  open_pages: OpenPages | null;
  open_pages_error?: OpenPagesError;
  /** The steps finished before a failure (partial-failure report); every one is idempotent, so a re-run converges. */
  completed: Step[];
  error?: { code: string; message: string };
}

/** Member ids from --members and --members-file (one per line or comma-separated; # starts a comment). */
export function readRoster(members: string | undefined, file: string | undefined): string[] {
  const fromFile = file ? readFileSync(file, 'utf8').split('\n').map(l => l.replace(/#.*/, '')).join(',') : '';
  return parseIdList([members ?? '', fromFile].filter(Boolean).join(','), 'member');
}

export function rosterEmpty(command: string): Error {
  return opError('access_serves_roster_empty', 'A brain that serves several people needs the list of people; none was given, so nothing was written.',
    `Name every person with --members <id,...> or --members-file <file>, for example: ${command} --members alice-example,bob-example`,
    { why: 'Each person gets a member, a folder only they read and a key bound to them; setup never guesses who they are.' });
}

/** The first directory at or above `dir` that holds .git, or null; symlinks are resolved, so a link into a checkout counts. */
function gitRootAbove(dir: string): string | null {
  let existing = dir;
  while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
  const physical = join(realpathSync(existing), relative(existing, dir));
  for (let d = physical; ; d = dirname(d)) {
    if (existsSync(join(d, '.git'))) return d;
    if (dirname(d) === d) return null;
  }
}

export async function servesStatus(engine: BrainEngine, opts: { openPages?: boolean } = {}): Promise<ServesStatus> {
  const view = await brainServes(engine);
  const live = (id: string | null) => (id && view.enabled_members.includes(id) ? id : null);
  const status: ServesStatus = { ...view, owner: live(await ownerMemberId(engine)), stdio_member: live(await stdioMemberId(engine)) };
  return view.serves === 'several' && opts.openPages !== false ? { ...status, ...await readOpenPages(engine) } : status;
}

async function plan(engine: BrainEngine, roster: string[], sourceId: string, labelledOnly: boolean): Promise<ServesReceipt> {
  const keyDir = memberKeyDir();
  const gitRoot = gitRootAbove(keyDir);
  if (gitRoot) {
    throw opError('access_serves_key_dir_in_git', `Member keys go to ${keyDir}, which is inside the git work tree at ${gitRoot}; a key there could be committed, so nothing was written.`,
      'Point GBRAIN_HOME at a directory outside any git checkout (the default is your home directory), then run the command again.',
      { why: 'Key files hold live credentials and must never sit where a commit could pick them up.' });
  }
  const explicit = (await engine.getConfig(SERVES_KEY))?.trim();
  const owner = await ownerMemberId(engine);
  const members: ServesReceipt['members'] = [];
  for (const id of roster) {
    const m = await getMember(engine, id);
    const entry: ServesReceipt['members'][number] = !m ? { id, action: 'add' } : m.status === 'enabled' ? { id, action: 'keep' }
      : { id, action: 'blocked', detail: m.status === 'disabled' ? `member is disabled: enable it with gbrain access member enable ${id}` : 'member id was removed and can never be reused; use a new id' };
    if (labelledOnly && entry.action !== 'blocked') {
      if (id === owner) Object.assign(entry, { action: 'blocked', detail: `${id} is the brain owner, who reads the whole brain, so it is never labelled-only: leave it out of this run or name another owner first (gbrain access owner set <member>)` });
      else entry.labelled_only = m?.labelled_only ? 'keep' : 'set';
    } else if (m?.labelled_only && entry.action !== 'blocked') entry.labelled_only = 'keep';
    members.push(entry);
  }
  const base = await currentFolderRules(engine, sourceId);
  const rules: ServesReceipt['rules'] = roster.map((id) => {
    const r = normalizeRule({ prefix: `people/${id}/`, readable_by: [id] });
    if ('problem' in r) return { id, prefix: `people/${id}/`, readers: [id], action: 'blocked', detail: r.problem };
    const clash = base.find(b => b.prefix === r.rule.prefix || b.id === r.rule.id);
    if (!clash) return { id: r.rule.id, prefix: r.rule.prefix, readers: r.rule.readable_by, action: 'add' };
    if (clash.prefix === r.rule.prefix && clash.readable_by.length === 1 && clash.readable_by[0] === `member:${id}`) return { id: clash.id, prefix: clash.prefix, readers: clash.readable_by, action: 'keep' };
    const readers = clash.readable_by.map(p => p.replace(/^member:/, '')).join(', ');
    return { id: r.rule.id, prefix: r.rule.prefix, readers: r.rule.readable_by, action: 'blocked',
      detail: `rule "${clash.id}" on ${clash.prefix} already exists, readable by ${readers}, not by ${id} alone; change it with gbrain access rule add --id ${clash.id} --prefix ${clash.prefix} --readers ${id} --source ${sourceId}` };
  });
  const keys: ServesReceipt['keys'] = [];
  for (const id of roster) {
    const name = memberKeyName(id);
    const path = join(keyDir, `${id}.key`);
    const [token] = await engine.executeRaw<{ member_id: string | null; token_hash: string }>('SELECT member_id, token_hash FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]);
    if (members.find(m => m.id === id)?.action === 'blocked') keys.push({ member: id, token_name: name, path, action: 'blocked', detail: 'the member is not enabled' });
    else if (!token && existsSync(path)) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `a key file is already at ${path} but no live key is named ${name} (another brain's key, or one revoked by hand); move or delete the file, then run this again` });
    else if (!token) keys.push({ member: id, token_name: name, path, action: 'mint' });
    else if (token.member_id !== id) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `a token named ${name} exists but is not bound to ${id}; revoke it (gbrain auth revoke ${name}) or bind it (gbrain auth rescope --token ${name} --member ${id})` });
    else if (!existsSync(path)) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `the key ${name} exists but its file is gone and a key is shown only once; revoke it (gbrain auth revoke ${name}) and run this again to mint a new one` });
    else if (hashToken(readFileSync(path, 'utf8').trim()) !== token.token_hash) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `the file does not hold the live key ${name} (it was revoked and made again, or another brain wrote it); revoke it (gbrain auth revoke ${name}), delete ${path} and run this again to mint a new one` });
    else keys.push({ member: id, token_name: name, path, action: 'keep' });
  }
  return { serves: 'several', source_id: sourceId, applied: false, config: { key: SERVES_KEY, value: 'several', action: explicit === 'several' ? 'keep' : 'write' },
    members, rules, keys, key_dir: keyDir, unlabeled: await unlabeledOutside(engine, sourceId, rules), ...await openPagesFor(engine, sourceId, members, rules, labelledOnly), completed: [] };
}

/** The open pages once this run's members, keys and rules are in place (the preview counts what it is about to add). */
function openPagesFor(engine: BrainEngine, sourceId: string, members: ServesReceipt['members'], rules: ServesReceipt['rules'], labelledOnly: boolean): Promise<OpenPagesRead> {
  return readOpenPages(engine, {
    planned: { members: members.filter(m => m.action !== 'blocked').map(m => m.id), source: sourceId, labelledOnly },
    exclude: rules.filter(r => r.action !== 'blocked').map(r => ({ source: sourceId, prefix: r.prefix })),
  });
}

/** Unlabeled people folders, not counting the ones this run's rules cover. */
async function unlabeledOutside(engine: BrainEngine, sourceId: string, rules: ServesReceipt['rules']): Promise<PeopleFolder[]> {
  const covered = new Set(rules.filter(r => r.action !== 'blocked').map(r => r.prefix));
  return (await unlabeledPeopleFolders(engine)).filter(u => !(u.source === sourceId && covered.has(u.prefix)));
}

const blocked = (r: ServesReceipt): boolean => [...r.members, ...r.rules, ...r.keys].some(x => x.action === 'blocked');

function writeKeyFile(path: string, token: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${token}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

function abortAfter(step: string): void {
  if (process.env.GBRAIN_SETUP_ABORT_AFTER === step) throw new Error(`GBRAIN_SETUP_ABORT_AFTER=${step}: stopped on purpose after ${step}.`);
}

/** Plans, and with `apply` writes, the several-people labelling; a failure is reported in the receipt, never thrown. */
export async function labelSeveral(engine: BrainEngine, roster: string[], sourceId: string, apply: boolean, json: boolean, opts: { labelledOnly?: boolean } = {}): Promise<ServesReceipt> {
  const labelledOnly = opts.labelledOnly === true;
  const receipt = await plan(engine, roster, sourceId, labelledOnly);
  if (!apply || blocked(receipt)) return receipt;
  receipt.applied = true;
  try {
    for (const m of receipt.members.filter(x => x.action === 'add')) await addMember(engine, m.id);
    receipt.completed.push('members');
    abortAfter('serves-members');
    if (labelledOnly) {
      for (const m of receipt.members.filter(x => x.labelled_only === 'set')) await setMemberLabelledOnly(engine, m.id, true, { remote: false });
      receipt.completed.push('labelled_only');
    }
    const added = receipt.rules.filter(r => r.action === 'add').map((r): FolderRule => ({ id: r.id, prefix: r.prefix, readable_by: r.readers }));
    if (added.length) {
      const { result } = await addFolderRules(engine, sourceId, added, { apply: true, json });
      if (result) receipt.rule_write = { store: result.store, revision: result.revision, state: result.state, ...(result.git ? { git_commit: result.git.commit ?? null } : {}) };
    }
    receipt.completed.push('rules');
    abortAfter('serves-rules');
    for (const k of receipt.keys.filter(x => x.action === 'mint')) {
      const minted = await mintToken(engine, k.token_name, { scopes: ['read', 'write'], binding: { member: k.member },
        ...(sourceId === 'default' ? {} : { sources: { kind: 'scalar' as const, writeSource: sourceId } }) });
      try {
        writeKeyFile(k.path, minted.token);
      } catch (e) {
        await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [minted.id]);
        throw e;
      }
      abortAfter('serves-key');
    }
    receipt.completed.push('keys');
    if (receipt.config.action === 'write') await engine.setConfig(SERVES_KEY, 'several');
    receipt.completed.push('config');
    receipt.unlabeled = await unlabeledOutside(engine, sourceId, receipt.rules);
    const { open_pages, open_pages_error } = await openPagesFor(engine, sourceId, receipt.members, receipt.rules, labelledOnly);
    receipt.open_pages = open_pages;
    if (open_pages_error) receipt.open_pages_error = open_pages_error; else delete receipt.open_pages_error;
  } catch (e) {
    receipt.error = { code: (e as { code?: string }).code ?? 'internal_error', message: e instanceof Error ? e.message : String(e) };
  }
  return receipt;
}

const ruleWritePending = (r: ServesReceipt): boolean => !!r.rule_write && r.rule_write.state !== 'applied' && r.rule_write.state !== 'unchanged';

export function receiptLines(r: ServesReceipt): string[] {
  const verb = (a: string) => (r.applied ? { add: 'added', mint: 'minted', write: 'written', keep: 'kept', blocked: 'BLOCKED' } : { add: 'will add', mint: 'will mint', write: 'will write', keep: 'keep', blocked: 'BLOCKED' })[a] ?? a;
  return [
    `Serves several people (source ${r.source_id}):`,
    `  config     ${r.config.key} = ${r.config.value} (${verb(r.config.action)})`,
    ...r.members.map(m => `  member     ${m.id} (${verb(m.action)}${m.labelled_only ? `; labelled-only ${m.labelled_only === 'keep' ? 'kept' : r.applied ? 'set' : 'will set'}` : ''})${m.detail ? `: ${m.detail}` : ''}`),
    ...r.rules.map(x => `  rule       ${x.prefix} readable by ${x.readers.map(p => p.replace(/^member:/, '')).join(', ')} (${verb(x.action)})${x.detail ? `: ${x.detail}` : ''}`),
    ...(r.rule_write ? [`             ${r.rule_write.store} store, revision ${r.rule_write.revision ?? '-'} ${r.rule_write.state}${r.rule_write.git_commit ? `, committed ${r.rule_write.git_commit.slice(0, 12)}` : ''}`] : []),
    ...r.keys.map(k => `  key        ${k.member}: ${k.path} (${verb(k.action)}${k.action === 'blocked' ? '' : ', 0600'}; token ${k.token_name})${k.detail ? `: ${k.detail}` : ''}`),
    ...(ruleWritePending(r) ? [`  The rules are not enforced yet: finish with gbrain access resume --source ${r.source_id}`] : []),
    ...r.unlabeled.map(u => `  unlabeled  ${u.source}:${u.prefix} (${u.pages} page(s)) has no folder rule, so every member reads it: name its readers with gbrain access rule add --prefix ${u.prefix} --readers <list> --source ${u.source}, or add the person with --members`),
    ...openPagesLines(r, labelledOnlyCommand(r)),
    ...(r.error ? [`Stopped: ${r.error.message}`, `  Finished before it stopped: ${r.completed.join(', ') || 'nothing'}. Every step is idempotent: run the same command again to finish.`] : []),
    ...(r.applied ? [] : [blocked(r) ? 'Nothing written: fix each BLOCKED line, then run this again.' : 'Nothing written. Add --yes to apply.']),
  ];
}

/** The --labelled-only re-run for the members it would still change: never the owner, a BLOCKED member or one already labelled-only. */
function labelledOnlyCommand(r: ServesReceipt): { labelledOnly?: string } {
  const ids = r.members.filter(m => m.action !== 'blocked' && !m.labelled_only && m.id !== r.open_pages?.owner).map(m => m.id);
  return ids.length ? { labelledOnly: `gbrain access serves several --members ${ids.join(',')}${r.source_id === 'default' ? '' : ` --source ${r.source_id}`} --labelled-only --yes` } : {};
}

export const receiptOk = (r: ServesReceipt): boolean => !r.error && !blocked(r) && !ruleWritePending(r) && (!r.applied || r.unlabeled.length === 0);

export async function runAccessServes(engine: BrainEngine, mode: string | undefined, args: string[], json: boolean, flagValue: (args: string[], name: string) => string | undefined): Promise<void> {
  if (mode === undefined) {
    const s = await servesStatus(engine, { openPages: !args.includes('--no-open-pages') });
    console.log(json ? JSON.stringify(s, null, 2) : [
      `This brain serves ${s.serves === 'several' ? 'several people' : 'one person'} (${s.from === 'config' ? `config ${SERVES_KEY}` : `${s.enabled_members.length} enabled member(s)`}).`,
      `  Enabled members: ${s.enabled_members.join(', ') || 'none'}`,
      `  Owner: ${s.owner ?? 'none'}; stdio server reads as: ${s.stdio_member ?? 'nobody in particular (unbound)'}`,
      ...(s.serves === 'several' && s.open_pages !== undefined ? openPagesLines({ open_pages: s.open_pages ?? null, ...(s.open_pages_error ? { open_pages_error: s.open_pages_error } : {}) }) : [])].join('\n'));
    return;
  }
  if (mode !== 'several') throw usageError(`Unknown access serves mode: ${mode}.`, 'gbrain access serves (read-only), or gbrain access serves several --members <id,...>. A one-person brain needs no step.');
  const roster = readRoster(flagValue(args, '--members'), flagValue(args, '--members-file'));
  if (!roster.length) throw rosterEmpty('gbrain access serves several');
  const r = await labelSeveral(engine, roster, flagValue(args, '--source') ?? 'default', args.includes('--yes'), json, { labelledOnly: args.includes('--labelled-only') });
  console.log(json ? JSON.stringify(r, null, 2) : receiptLines(r).join('\n'));
  if (!receiptOk(r)) setCliExitVerdict(1);
}
