/**
 * GST-363 (PR 1): `gbrain access serves`, the labelling half of a brain that serves several people.
 *
 *   gbrain access serves [--json] [--no-open-pages]      Read-only: one or several, why, owner, stdio member, open pages
 *   gbrain access serves several --members a,b [--members-file f] [--source id] [--labelled-only] [--owner id] [--yes] [--json]
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
 * GBRA-585 D: --owner <id> names the brain owner when none is configured (the member is added when missing, then
 * `access owner set`); a configured owner is kept. No credential is rebound: the receipt lists the live credentials
 * bound to no member, each with the `gbrain auth rescope … --member <owner>` command that binds it on purpose.
 * GBRA-585 A: a key minted here gets a fixed source list (the federated grant kind): it writes to the run's source and
 * reads that source, `company` when it exists and every source federated at mint time (memberKeyReadSources). A
 * re-run adds sources to a key of this name that already holds a list for this source, and never removes one, but only
 * while that list is still the one setup last gave the key (permissions.setup_reads): a key changed by hand is skipped
 * and named with the rescope command, a source archived since is dropped from the list, and a key whose write source is
 * archived is BLOCKED (its write source never moves); any other kept key (today's default or scalar grant) is never changed. The preview names the list and what `company` holds.
 * GST-4043: without --source the run labels GBRAIN_SOURCE, then sources.default, not literal `default`; the directory it
 * runs from (a .gbrain-source file, a registered checkout) never decides where member keys write. A re-run on another source moves a list key setup minted (its list still the one setup gave it)
 * to write to that source, keeping what it read; any other key writing elsewhere is skipped with its rescope command.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { configDir } from '../core/config.ts';
import { hashToken } from '../core/utils.ts';
import { opError } from '../core/ops/contract.ts';
import { usageError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { normalizeRule, ruleIdForPrefix, type FolderRule } from '../core/access/folder-rules.ts';
import { addMember, assertAccessId, getMember, listMembers, parseIdList } from '../core/access/members.ts';
import { hintReaders, ownerMemberId, ownerView, setOwner } from '../core/access/owner.ts';
import { stdioMemberId } from '../core/access/caller.ts';
import { brainServes, SERVES_KEY, unlabeledPeopleFolders, type PeopleFolder, type ServesView } from '../core/access/serves.ts';
import { setMemberLabelledOnly } from '../core/access/labelled-only.ts';
import { COMPANY_SOURCE_ID, memberKeyReadSources, openPagesLines, readOpenPages, type OpenPagesError, type OpenPagesRead } from '../core/access/open-pages.ts';
import { rescopeLegacyToken } from '../core/grants/legacy-token.ts';
import { coerceLegacyPermissions } from '../core/legacy-token-scope.ts';
import type { OpenPages } from '../core/access/open-pages.ts';
import { resolveSourceId } from '../core/source-resolver.ts';
import { addFolderRules, currentFolderRules } from './access-rules.ts';
import { mintToken } from './auth-mint.ts';
import { rescopeArchiveAfter, rescopeArchiveBefore } from './archive-rescope.ts';

export const MEMBER_KEY_DIR = 'member-keys';
export const memberKeyName = (member: string): string => `member-${member}`;
export const memberKeyDir = (): string => join(configDir(), MEMBER_KEY_DIR);

type RuleWrite = { store: string; revision: number | null; state: string; git_commit?: string | null };

export interface ServesStatus extends ServesView { owner: string | null; stdio_member: string | null; open_pages?: OpenPages | null; open_pages_error?: OpenPagesError }

type Step = 'members' | 'owner' | 'labelled_only' | 'rules' | 'keys' | 'config';
export interface ServesReceipt {
  serves: 'several';
  source_id: string;
  applied: boolean;
  config: { key: string; value: 'several'; action: 'write' | 'keep' };
  members: Array<{ id: string; action: 'add' | 'keep' | 'blocked'; detail?: string; labelled_only?: 'set' | 'keep' }>;
  /** GBRA-585 D (--owner): the owner this run adds and names, names, or keeps (a configured owner always wins). */
  owner?: { id: string; action: 'add' | 'set' | 'keep' | 'blocked'; detail?: string };
  /** GBRA-585 D (--owner): live credentials bound to no member, each with the command that binds it to the owner. Never rebound here. */
  unbound?: Array<{ kind: 'token' | 'client'; name: string; command: string }>;
  rules: Array<{ id: string; prefix: string; readers: string[]; action: 'add' | 'keep' | 'blocked'; detail?: string }>;
  rule_write?: RuleWrite;
  /**
   * GBRA-585 C: on a --labelled-only run once the company source exists, one folder rule company/ in source company,
   * readable by the owner, this run's members and every enabled member who is not labelled-only (who read those pages
   * today), so labelled-only members still read the company pages. A re-run only adds readers.
   */
  company_rule?: { source: string; id: string; prefix: string; readers: string[]; adds?: string[]; action: 'add' | 'keep' | 'blocked'; detail?: string; write?: RuleWrite };
  /**
   * GBRA-585 A: reads = the source list a minted or list key holds once the run is done; adds = what a re-run adds to a kept list key.
   * GST-4043: moves = the write source a kept list key setup minted leaves for this run's source (the run's source writes first in reads).
   */
  keys: Array<{ member: string; token_name: string; path: string; action: 'mint' | 'keep' | 'skipped' | 'blocked'; detail?: string; reads?: string[]; adds?: string[]; moves?: string }>;
  /** GBRA-585 A: what the keys this run mints write and read, and what the company source holds when they read it. */
  reads?: { write: string; sources: string[]; company: { pages: number; calls: number } | null };
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
export function gitRootAbove(dir: string): string | null {
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

/** The owner for --owner: a configured owner (live or not) is kept; otherwise the requested member, added when missing. */
async function planOwner(engine: BrainEngine, requested: string): Promise<NonNullable<ServesReceipt['owner']>> {
  const view = await ownerView(engine);
  if (view.owner) return { id: view.owner, action: 'keep' };
  if (view.inactive) return { id: view.inactive.value, action: 'keep', detail: `configured as the owner but not usable (${view.inactive.reason}), so no caller reads as the owner; name an enabled member with gbrain access owner set <member>` };
  const m = await getMember(engine, requested);
  if (!m) return { id: requested, action: 'add' };
  if (m.status !== 'enabled') return { id: requested, action: 'blocked', detail: m.status === 'disabled' ? `member is disabled: enable it with gbrain access member enable ${requested}, or name another owner with --owner` : 'member id was removed and can never be reused; name another owner with --owner' };
  if (m.labelled_only) return { id: requested, action: 'blocked', detail: `${requested} is labelled-only, and the owner reads the whole brain: clear it (gbrain access member labelled-only ${requested} off) or name another owner with --owner` };
  return { id: requested, action: 'set' };
}

/** Live tokens and OAuth clients bound to no member, with the rescope command that binds each to `owner`. */
export async function unboundCredentials(engine: BrainEngine, owner: string): Promise<NonNullable<ServesReceipt['unbound']>> {
  const tokens = await engine.executeRaw<{ name: string }>('SELECT DISTINCT name FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NULL ORDER BY name');
  const clients = await engine.executeRaw<{ client_id: string }>('SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id');
  return [
    ...tokens.map(t => ({ kind: 'token' as const, name: t.name, command: `gbrain auth rescope --token ${t.name} --member ${owner}` })),
    ...clients.map(c => ({ kind: 'client' as const, name: c.client_id, command: `gbrain auth rescope --client ${c.client_id} --member ${owner}` })),
  ];
}

async function plan(engine: BrainEngine, roster: string[], sourceId: string, labelledOnly: boolean, requestedOwner?: string): Promise<ServesReceipt> {
  const keyDir = memberKeyDir();
  const gitRoot = gitRootAbove(keyDir);
  if (gitRoot) {
    throw opError('access_serves_key_dir_in_git', `Member keys go to ${keyDir}, which is inside the git work tree at ${gitRoot}; a key there could be committed, so nothing was written.`,
      'Point GBRAIN_HOME at a directory outside any git checkout (the default is your home directory), then run the command again.',
      { why: 'Key files hold live credentials and must never sit where a commit could pick them up.' });
  }
  const explicit = (await engine.getConfig(SERVES_KEY))?.trim();
  const ownerPlan = requestedOwner ? await planOwner(engine, requestedOwner) : undefined;
  const owner = ownerPlan && ownerPlan.action !== 'blocked' ? ownerPlan.id : await ownerMemberId(engine);
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
  const hinted = await Promise.all(roster.map(id => hintReaders(engine, [id])));
  const rules: ServesReceipt['rules'] = roster.map((id, i) => {
    const r = normalizeRule({ prefix: `people/${id}/`, readable_by: [id] });
    if ('problem' in r) return { id, prefix: `people/${id}/`, readers: [id], action: 'blocked', detail: r.problem };
    const clash = base.find(b => b.prefix === r.rule.prefix || b.id === r.rule.id);
    if (!clash) return { id: r.rule.id, prefix: r.rule.prefix, readers: r.rule.readable_by, action: 'add' };
    const hint = new Set(hinted[i]!.split(',').map(reader => `member:${reader}`));
    const settled = (clash.readable_by.length === 1 && clash.readable_by[0] === `member:${id}`)
      || (clash.readable_by.length === hint.size && clash.readable_by.every(p => hint.has(p)));
    if (clash.prefix === r.rule.prefix && settled) return { id: clash.id, prefix: clash.prefix, readers: clash.readable_by, action: 'keep' };
    const readers = clash.readable_by.map(p => p.replace(/^member:/, '')).join(', ');
    return { id: r.rule.id, prefix: r.rule.prefix, readers: r.rule.readable_by, action: 'blocked',
      detail: `rule "${clash.id}" on ${clash.prefix} already exists, readable by ${readers}, not by ${id} alone; change it with gbrain access rule add --id ${clash.id} --prefix ${clash.prefix} --readers ${hinted[i]} --source ${sourceId}` };
  });
  const desired = await memberKeyReadSources(engine, sourceId);
  const companyRule = labelledOnly && desired.includes(COMPANY_SOURCE_ID) ? await planCompanyRule(engine, members, owner) : undefined;
  const keys: ServesReceipt['keys'] = [];
  for (const id of roster) {
    const name = memberKeyName(id);
    const path = join(keyDir, `${id}.key`);
    const [token] = await engine.executeRaw<{ member_id: string | null; token_hash: string; source_grant: string | null; source_id: string | null; federated_read: unknown; permissions: unknown }>('SELECT member_id, token_hash, source_grant, source_id, federated_read, permissions FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]);
    if (members.find(m => m.id === id)?.action === 'blocked') keys.push({ member: id, token_name: name, path, action: 'blocked', detail: 'the member is not enabled' });
    else if (!token && existsSync(path)) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `a key file is already at ${path} but no live key is named ${name} (another brain's key, or one revoked by hand); move or delete the file, then run this again` });
    else if (!token) keys.push({ member: id, token_name: name, path, action: 'mint', reads: desired });
    else if (token.member_id !== id) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `a token named ${name} exists but is not bound to ${id}; revoke it (gbrain auth revoke ${name}) or bind it (gbrain auth rescope --token ${name} --member ${id})` });
    else if (!existsSync(path)) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `the key ${name} exists but its file is gone and a key is shown only once; revoke it (gbrain auth revoke ${name}) and run this again to mint a new one` });
    else if (hashToken(readFileSync(path, 'utf8').trim()) !== token.token_hash) keys.push({ member: id, token_name: name, path, action: 'blocked', detail: `the file does not hold the live key ${name} (it was revoked and made again, or another brain wrote it); revoke it (gbrain auth revoke ${name}), delete ${path} and run this again to mint a new one` });
    else if (token.source_grant !== 'federated' && (token.source_id ?? 'default') === sourceId) keys.push({ member: id, token_name: name, path, action: 'keep' });
    else if (token.source_grant !== 'federated') {
      keys.push({ member: id, token_name: name, path, action: 'skipped',
        detail: `it writes to ${token.source_id ?? 'default'} and setup did not mint it with a source list, so setup leaves it as it is; to move it to ${sourceId}, run gbrain auth rescope --token ${name} --sources ${desired.join(',')}` });
    } else {
      const held = textList(token.federated_read);
      const adds = desired.filter(s => !held.includes(s));
      const active = new Set((await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = ANY($1::text[]) AND archived IS NOT TRUE', [held])).map(r => r.id));
      const reads = [...held.filter(s => active.has(s)), ...adds];
      const minted = setupReads(token.permissions);
      if (token.source_id !== sourceId) {
        const moved = [...new Set([sourceId, ...reads])];
        if (minted && sameSet(minted, held)) keys.push({ member: id, token_name: name, path, action: 'keep', reads: moved, moves: token.source_id ?? 'default', adds });
        else keys.push({ member: id, token_name: name, path, action: 'skipped', reads: held,
          detail: `it writes to ${token.source_id} and its source list (${held.join(', ')}) is not the one setup gave it, so setup leaves it as it is; to move it to ${sourceId}, run gbrain auth rescope --token ${name} --sources ${moved.join(',')}` });
      } else if (!active.has(sourceId)) {
        keys.push({ member: id, token_name: name, path, action: 'blocked', reads: held,
          detail: `its write source ${sourceId} is archived, so setup leaves the key as it is and never moves where it writes; repoint it with gbrain auth rescope --token ${name} --sources <new write source>${reads.length ? `,${reads.join(',')}` : ''}, or revoke it with gbrain auth revoke ${name}` });
      } else if (adds.length && !(minted && sameSet(minted, held))) {
        keys.push({ member: id, token_name: name, path, action: 'skipped', reads: held,
          detail: `its source list (${held.join(', ')}) is not the one setup gave it${minted ? ` (${minted.join(', ')})` : ''}, so setup leaves it as it is and does not add ${adds.join(', ')}; to add them, run gbrain auth rescope --token ${name} --sources ${reads.join(',')}` });
      } else keys.push({ member: id, token_name: name, path, action: 'keep', reads: adds.length ? reads : held, ...(adds.length ? { adds } : {}) });
    }
  }
  return { serves: 'several', source_id: sourceId, applied: false, config: { key: SERVES_KEY, value: 'several', action: explicit === 'several' ? 'keep' : 'write' },
    members, ...(ownerPlan ? { owner: ownerPlan, unbound: ownerPlan.action === 'blocked' ? [] : await unboundCredentials(engine, ownerPlan.id) } : {}),
    rules, ...(companyRule ? { company_rule: companyRule } : {}), keys, reads: { write: sourceId, sources: desired, company: desired.includes(COMPANY_SOURCE_ID) ? await companyCounts(engine) : null }, key_dir: keyDir,
    unlabeled: await unlabeledOutside(engine, sourceId, rules), ...await openPagesFor(engine, sourceId, members, rules, labelledOnly, owner, companyRule), completed: [] };
}

/** GBRA-585 C: the company/ rule a --labelled-only run adds or widens (ServesReceipt.company_rule); it never removes a reader. */
async function planCompanyRule(engine: BrainEngine, members: ServesReceipt['members'], owner: string | null): Promise<NonNullable<ServesReceipt['company_rule']>> {
  const at = { source: COMPANY_SOURCE_ID, id: ruleIdForPrefix(`${COMPANY_SOURCE_ID}/`), prefix: `${COMPANY_SOURCE_ID}/` };
  if (!owner) return { ...at, readers: [], action: 'blocked', detail: "its readers start with the brain owner and this brain has none; run again with --owner and the owner's member id" };
  const base = await currentFolderRules(engine, COMPANY_SOURCE_ID);
  const existing = base.find(b => b.prefix === at.prefix);
  const clash = existing ? undefined : base.find(b => b.id === at.id);
  if (clash) return { ...at, readers: [], action: 'blocked', detail: `rule "${clash.id}" in source company already covers ${clash.prefix}; give it another id with gbrain access rule add --id <new id> --prefix ${clash.prefix} --source company, then run this again` };
  const open = (await listMembers(engine)).filter(m => m.status === 'enabled' && !m.labelled_only).map(m => m.id);
  const held = existing?.readable_by ?? [];
  const adds = [...new Set([owner, ...members.filter(m => m.action !== 'blocked').map(m => m.id), ...open].map(m => `member:${m}`))].filter(p => !held.includes(p)).sort();
  return { ...at, id: existing?.id ?? at.id, readers: [...held, ...adds].sort(), ...(existing && adds.length ? { adds } : {}), action: existing && !adds.length ? 'keep' : 'add' };
}

/** A text[] column value as a list (Postgres returns an array, PGLite may return the {a,b} literal). */
const textList = (v: unknown): string[] => Array.isArray(v) ? v.map(String) : String(v ?? '').replace(/^\{|\}$/g, '').split(',').map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean);

const sameSet = (a: string[], b: string[]): boolean => a.length === b.length && a.every(s => b.includes(s));

/** GBRA-585 A: the source list setup last gave a member key, kept in its permissions JSON, whose unrelated fields every grant write keeps. */
const setupReads = (permissions: unknown): string[] | undefined => {
  const v = coerceLegacyPermissions(permissions)?.setup_reads;
  return Array.isArray(v) && v.every(s => typeof s === 'string') ? v as string[] : undefined;
};

async function recordSetupReads(engine: BrainEngine, name: string, reads: string[]): Promise<void> {
  await engine.executeRaw(
    "UPDATE access_tokens SET permissions = COALESCE(permissions, '{}'::jsonb) || jsonb_build_object('setup_reads', $2::text[]) WHERE name = $1 AND revoked_at IS NULL AND (permissions IS NULL OR jsonb_typeof(permissions) = 'object')",
    [name, reads]);
}

/**
 * GBRA-585 A: live member-bound keys whose fixed read list still holds `sourceId` though it is not their write source,
 * each with the rescope command that drops it. Unfederating never narrows such a list, so `sources unfederate` names them.
 */
export async function keysStillReading(engine: BrainEngine, sourceId: string): Promise<Array<{ token: string; member: string; command: string }>> {
  const rows = await engine.executeRaw<{ name: string; member_id: string; federated_read: unknown }>(
    "SELECT name, member_id, federated_read FROM access_tokens WHERE revoked_at IS NULL AND member_id IS NOT NULL AND source_grant = 'federated' AND source_id <> $1 AND $1 = ANY(federated_read) ORDER BY name", [sourceId]);
  return rows.map(r => ({ token: r.name, member: r.member_id, command: `gbrain auth rescope --token ${r.name} --sources ${textList(r.federated_read).filter(s => s !== sourceId).join(',')}` }));
}

/** `sources unfederate`: names each key keysStillReading finds, through `say`, and returns them for --json. */
export async function keysStillReadingNotice(engine: BrainEngine, sourceId: string, say: (text: string) => void): Promise<Awaited<ReturnType<typeof keysStillReading>>> {
  const keys = await keysStillReading(engine, sourceId);
  if (keys.length) say([`${keys.length} member key${keys.length === 1 ? '' : 's'} still read source ${sourceId}: a key gbrain setup minted keeps the sources it was given, and unfederating does not narrow it. To take ${sourceId} away from a key:`, ...keys.map(k => `  ${k.command}`)].join('\n'));
  return keys;
}

/** The live pages in the company source, and how many are imported calls (company/calls/<date>-<title>). */
async function companyCounts(engine: BrainEngine): Promise<{ pages: number; calls: number }> {
  const [row] = await engine.executeRaw<{ pages: number | string; calls: number | string }>(
    "SELECT count(*)::int AS pages, count(*) FILTER (WHERE slug LIKE 'company/calls/%')::int AS calls FROM pages WHERE source_id = $1 AND deleted_at IS NULL", [COMPANY_SOURCE_ID]);
  return { pages: Number(row?.pages ?? 0), calls: Number(row?.calls ?? 0) };
}

/** The open pages once this run's members, keys and rules are in place (the preview counts what it is about to add). */
function openPagesFor(engine: BrainEngine, sourceId: string, members: ServesReceipt['members'], rules: ServesReceipt['rules'], labelledOnly: boolean, owner: string | null, companyRule?: ServesReceipt['company_rule']): Promise<OpenPagesRead> {
  return readOpenPages(engine, {
    planned: { members: members.filter(m => m.action !== 'blocked').map(m => m.id), source: sourceId, labelledOnly, owner },
    exclude: [...rules.filter(r => r.action !== 'blocked').map(r => ({ source: sourceId, prefix: r.prefix })),
      ...(companyRule && companyRule.action !== 'blocked' ? [{ source: companyRule.source, prefix: companyRule.prefix }] : [])],
  });
}

/** Unlabeled people folders, not counting the ones this run's rules cover. */
async function unlabeledOutside(engine: BrainEngine, sourceId: string, rules: ServesReceipt['rules']): Promise<PeopleFolder[]> {
  const covered = new Set(rules.filter(r => r.action !== 'blocked').map(r => r.prefix));
  return (await unlabeledPeopleFolders(engine)).filter(u => !(u.source === sourceId && covered.has(u.prefix)));
}

const blocked = (r: ServesReceipt): boolean => [...r.members, ...(r.owner ? [r.owner] : []), ...r.rules, ...(r.company_rule ? [r.company_rule] : []), ...r.keys].some(x => x.action === 'blocked');

export function writeKeyFile(path: string, token: string): void {
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
export async function labelSeveral(engine: BrainEngine, roster: string[], sourceId: string, apply: boolean, json: boolean, opts: { labelledOnly?: boolean; owner?: string } = {}): Promise<ServesReceipt> {
  const labelledOnly = opts.labelledOnly === true;
  const receipt = await plan(engine, roster, sourceId, labelledOnly, opts.owner);
  if (!apply || blocked(receipt)) return receipt;
  receipt.applied = true;
  try {
    for (const m of receipt.members.filter(x => x.action === 'add')) await addMember(engine, m.id, { beforeWrite: () => rescopeArchiveBefore(engine, m.id, 'add') });
    receipt.completed.push('members');
    abortAfter('serves-members');
    if (receipt.owner && receipt.owner.action !== 'keep') {
      if (!(await getMember(engine, receipt.owner.id))) await addMember(engine, receipt.owner.id, { beforeWrite: () => rescopeArchiveBefore(engine, receipt.owner!.id, 'add') });
      await setOwner(engine, receipt.owner.id);
      receipt.completed.push('owner');
    }
    if (labelledOnly) {
      for (const m of receipt.members.filter(x => x.labelled_only === 'set')) await setMemberLabelledOnly(engine, m.id, true, { remote: false });
      receipt.completed.push('labelled_only');
    }
    const added = receipt.rules.filter(r => r.action === 'add').map((r): FolderRule => ({ id: r.id, prefix: r.prefix, readable_by: r.readers }));
    if (added.length) {
      const { result } = await addFolderRules(engine, sourceId, added, { apply: true, json });
      if (result) receipt.rule_write = { store: result.store, revision: result.revision, state: result.state, ...(result.git ? { git_commit: result.git.commit ?? null } : {}) };
    }
    const cr = receipt.company_rule;
    if (cr?.action === 'add') {
      const prior = (await currentFolderRules(engine, cr.source)).find(b => b.id === cr.id);
      const { result } = await addFolderRules(engine, cr.source, [{ ...prior, id: cr.id, prefix: cr.prefix, readable_by: cr.readers }], { apply: true, json });
      if (result) cr.write = { store: result.store, revision: result.revision, state: result.state, ...(result.git ? { git_commit: result.git.commit ?? null } : {}) };
    }
    receipt.completed.push('rules');
    abortAfter('serves-rules');
    for (const k of receipt.keys.filter(x => x.action === 'mint')) {
      const minted = await mintToken(engine, k.token_name, { scopes: ['read', 'write'], binding: { member: k.member },
        sources: { kind: 'federated', writeSource: sourceId, readSources: k.reads! } });
      await recordSetupReads(engine, k.token_name, k.reads!);
      try {
        writeKeyFile(k.path, minted.token);
      } catch (e) {
        await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [minted.id]);
        throw e;
      }
      abortAfter('serves-key');
    }
    for (const k of receipt.keys.filter(x => x.action === 'keep' && (x.adds?.length || x.moves))) {
      await rescopeLegacyToken(engine, { target: { name: k.token_name }, sources: k.reads!, reset: [], refreshOperations: false, allNew: false, dryRun: false, json: true });
      await recordSetupReads(engine, k.token_name, k.reads!);
    }
    receipt.completed.push('keys');
    if (receipt.config.action === 'write') await engine.setConfig(SERVES_KEY, 'several');
    receipt.completed.push('config');
    receipt.unlabeled = await unlabeledOutside(engine, sourceId, receipt.rules);
    const { open_pages, open_pages_error } = await openPagesFor(engine, sourceId, receipt.members, receipt.rules, labelledOnly, await ownerMemberId(engine), receipt.company_rule);
    receipt.open_pages = open_pages;
    if (open_pages_error) receipt.open_pages_error = open_pages_error; else delete receipt.open_pages_error;
  } catch (e) {
    receipt.error = { code: (e as { code?: string }).code ?? 'internal_error', message: e instanceof Error ? e.message : String(e) };
  }
  return receipt;
}

const writePending = (w: RuleWrite | undefined): boolean => !!w && w.state !== 'applied' && w.state !== 'unchanged';
const companyHeld = (r: ServesReceipt): boolean => r.company_rule?.write?.state === 'recorded';
const ruleWritePending = (r: ServesReceipt): boolean => writePending(r.rule_write) || (writePending(r.company_rule?.write) && !companyHeld(r));
const writeLine = (w: RuleWrite) => `             ${w.store} store, revision ${w.revision ?? '-'} ${w.state}${w.git_commit ? `, committed ${w.git_commit.slice(0, 12)}` : ''}`;

export function receiptLines(r: ServesReceipt): string[] {
  const verb = (a: string) => (r.applied ? { add: 'added', mint: 'minted', write: 'written', keep: 'kept', skipped: 'skipped', blocked: 'BLOCKED' } : { add: 'will add', mint: 'will mint', write: 'will write', keep: 'keep', skipped: 'will skip', blocked: 'BLOCKED' })[a] ?? a;
  return [
    `Serves several people (source ${r.source_id}):`,
    `  config     ${r.config.key} = ${r.config.value} (${verb(r.config.action)})`,
    ...r.members.map(m => `  member     ${m.id} (${verb(m.action)}${m.labelled_only ? `; labelled-only ${m.labelled_only === 'keep' ? 'kept' : r.applied ? 'set' : 'will set'}` : ''})${m.detail ? `: ${m.detail}` : ''}`),
    ...(r.owner ? [`  owner      ${r.owner.id} (${ownerVerb(r.owner.action, r.applied)})${r.owner.detail ? `: ${r.owner.detail}` : ''}`] : []),
    ...(r.unbound ?? []).map(u => `  unbound    ${u.kind === 'token' ? 'token' : 'OAuth client'} ${u.name} is bound to no member, and setup binds none; if it is the owner's, bind it with ${u.command}`),
    ...r.rules.map(x => `  rule       ${x.prefix} readable by ${x.readers.map(p => p.replace(/^member:/, '')).join(', ')} (${verb(x.action)})${x.detail ? `: ${x.detail}` : ''}`),
    ...(r.rule_write ? [writeLine(r.rule_write)] : []),
    ...companyRuleLines(r),
    ...r.keys.map(k => `  key        ${k.member}: ${k.path} (${verb(k.action)}${k.action === 'blocked' ? '' : ', 0600'}; token ${k.token_name}${k.moves ? `; ${r.applied ? 'now writes to' : 'will write to'} ${r.source_id} instead of ${k.moves}` : ''}${k.adds?.length ? `; ${r.applied ? 'now also reads' : 'will also read'} ${k.adds.join(', ')}` : ''})${k.detail ? `: ${k.detail}` : ''}`),
    ...readsLines(r),
    ...(writePending(r.rule_write) ? [`  The rules are not enforced yet: finish with gbrain access resume --source ${r.source_id}`] : []),
    ...(writePending(r.company_rule?.write) && !companyHeld(r) ? [`  The company rule is not enforced yet: finish with gbrain access resume --source ${r.company_rule!.source}`] : []),
    ...r.unlabeled.map(u => `  unlabeled  ${u.source}:${u.prefix} (${u.pages} page(s)) has no folder rule, so every member reads it: name its readers with gbrain access rule add --prefix ${u.prefix} --readers <list> --source ${u.source}, or add the person with --members`),
    ...openPagesLines(r, labelledOnlyCommand(r)),
    ...(r.error ? [`Stopped: ${r.error.message}`, `  Finished before it stopped: ${r.completed.join(', ') || 'nothing'}. Every step is idempotent: run the same command again to finish.`] : []),
    ...(r.applied ? [] : [blocked(r) ? 'Nothing written: fix each BLOCKED line, then run this again.' : 'Nothing written. Add --yes to apply.']),
  ];
}

/** GBRA-585 C: the company/ rule a --labelled-only run adds, and that only keys bound to its readers read those pages. */
export function companyRuleLines(r: ServesReceipt): string[] {
  const c = r.company_rule;
  if (!c) return [];
  const names = (ps: string[]) => ps.map(p => p.replace(/^member:/, '')).join(', ');
  const verb = c.action === 'blocked' ? 'BLOCKED' : c.action === 'keep' ? 'kept' : `${r.applied ? 'added' : 'will add'}${c.adds?.length ? ` ${names(c.adds)} as reader(s)` : ''}`;
  return [
    `  rule       ${c.source}:${c.prefix} readable by ${names(c.readers)} (${verb})${c.detail ? `: ${c.detail}` : ''}`,
    ...(c.action === 'blocked' ? [] : [`             labelled-only members read the company pages through this rule; only keys bound to these members read pages under ${c.prefix}`]),
    ...(c.write ? [writeLine(c.write)] : []),
    ...(companyHeld(r) ? [`             the added readers wait for approval, as every widening does: preview with gbrain access apply --source ${c.source}, then approve with the --yes --expect line it prints`] : []),
  ];
}

/** GBRA-585 A: what the keys this run mints read, what the company source holds, and that a later-federated source waits for a re-run. */
export function readsLines(r: ServesReceipt): string[] {
  if (!r.reads) return [];
  const { write, sources, company } = r.reads;
  const lists = r.keys.some(k => k.reads);
  const kept = r.keys.filter(k => k.action === 'keep' && !k.reads).map(k => k.member);
  return [
    `  reads      keys this run mints write to ${write} and read ${sources.join(', ')}${lists ? '' : ' (this run mints none)'}. A source federated later does not reach these keys until you run setup again.`,
    ...(company ? [`             source company holds ${company.pages} page(s), ${company.calls} of them imported calls: every member whose key reads company reads all of them, including calls they did not attend, except pages a folder rule or readable_by keeps to others.`] : []),
    ...(kept.length ? [`             kept as they are: the keys of ${kept.join(', ')} keep their earlier grant${company ? ' and do not read company' : ''}; setup never changes a key it did not mint with a source list.`] : []),
  ];
}

function ownerVerb(action: NonNullable<ServesReceipt['owner']>['action'], applied: boolean): string {
  if (action === 'keep') return 'kept: the brain owner already';
  if (action === 'blocked') return 'BLOCKED';
  const add = action === 'add';
  return applied ? `${add ? 'added a member and named' : 'named'} it the brain owner` : `will ${add ? 'add a member and name' : 'name'} it the brain owner`;
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
  const owner = flagValue(args, '--owner');
  const source = await resolveSourceId(engine, flagValue(args, '--source') ?? (process.env.GBRAIN_SOURCE?.trim() || null), undefined, { skipLocalSignals: true });
  const r = await labelSeveral(engine, roster, source, args.includes('--yes'), json, { labelledOnly: args.includes('--labelled-only'), ...(owner !== undefined ? { owner: assertAccessId(owner) } : {}) });
  if (r.applied) await rescopeArchiveAfter(engine);
  console.log(json ? JSON.stringify(r, null, 2) : receiptLines(r).join('\n'));
  if (!receiptOk(r)) setCliExitVerdict(1);
}
