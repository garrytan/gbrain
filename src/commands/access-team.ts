/**
 * O1 v1 (GST-3989): `gbrain access team`, the brain side of `gbrain setup <harness> --template team`. It sets up a
 * brand-new brain for a team and refuses every other brain.
 *
 *   gbrain access team --members a,b[,c] [--groups name:a+b,...] [--owner <id>] [--source <id>] [--yes] [--json]
 *
 * Fresh brains only. Before anything is written it checks that the brain holds no pages (soft-deleted ones count),
 * no facts or page history, that no source folder holds files a sync would import, and that no member, group,
 * owner, folder rule, unbound token or unbound OAuth client exists beyond what this template itself writes (so a
 * re-run after a stopped run converges). Any one of these refuses with team_template_not_fresh, listing every
 * problem, and nothing is written. In-place conversion of a brain that already holds notes is not supported.
 *
 * Preview first; --yes applies, in this order, each step idempotent:
 *   owner         the brain owner (--owner, else the one configured), added as a member when missing
 *   members       one person member per --members id
 *   labelled_only every member besides the owner reads only the pages labelled for it (folder rules, readable_by);
 *                 a page a member writes is labelled for that member, so unlabelled pages stay the owner's
 *   groups        team (the owner and every member), and team-<name> per --groups entry
 *   rules         people/<id>/ read only by that person (owner included), team/ read by the owner and group:team,
 *                 and groups/<name>/ read by the owner and group:team-<name>. Repo-backed source: committed to
 *                 .gbrain/access.yml through the commit door; repo-less source: the database rule log
 *   config        access.serves = several
 *   keys          last, after the content check runs again: one read+write key per member besides the owner,
 *                 granted this source only, written to a 0600 file under <config>/member-keys/ and never printed
 * No member holds a credential until every rule is in place. Everything else lives in the database, so a repo-less
 * brain gets the same result.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isSyncable, SYNC_STRATEGIES } from '../core/sync.ts';
import type { BrainEngine } from '../core/engine.ts';
import { opError } from '../core/ops/contract.ts';
import { hashToken } from '../core/utils.ts';
import { bunSpawnSync } from '../core/spawn.ts';
import { usageError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { addGroup, addMember, assertAccessId, listGroups, listMembers, type MemberRecord } from '../core/access/members.ts';
import { ownerView, setOwner } from '../core/access/owner.ts';
import { setMemberLabelledOnly } from '../core/access/labelled-only.ts';
import { SERVES_KEY } from '../core/access/serves.ts';
import { normalizeRule, type FolderRule } from '../core/access/folder-rules.ts';
import { addFolderRules, currentFolderRules } from './access-rules.ts';
import { appliedRules } from '../core/access/policy.ts';
import { mintToken } from './auth-mint.ts';
import { gitRootAbove, memberKeyDir, memberKeyName, writeKeyFile } from './access-serves.ts';

export const TEMPLATE = 'team';
export const TEAM_GROUP = 'team';
export const TEAM_FOLDER = 'team/';
export const memberFolder = (id: string): string => `people/${id}/`;
export const groupFolder = (name: string): string => `groups/${name}/`;
export const teamGroupId = (name: string): string => `team-${name}`;
const KEY_SCOPES = ['read', 'write'];
/** The skillpack provenance gbrain init writes for the skill bundle it seeds into a new brain's folder. */
const SETUP_BUNDLE_SOURCE = 'src/core/shared-skills/setup-bundle.ts';
/** Tables whose rows mean the brain already holds notes or their history. */
const HISTORY_TABLES = ['facts', 'page_versions', 'files', 'raw_data', 'ingest_log'] as const;

export interface TeamRoster { owner: string; members: string[]; groups: Array<{ name: string; id: string; members: string[] }> }

/** The roster from --members and --groups; every refusal comes before the brain is opened for writing. */
export function parseTeamRoster(membersSpec: string | undefined, groupsSpec: string | undefined, owner: string): TeamRoster {
  const raw = (membersSpec ?? '').trim();
  if (!raw || raw === 'none') {
    throw usageError('A team brain needs --members with at least one person besides the owner.',
      'Name them: --members alice-example,bob-example. A brain for one person needs no template: run gbrain setup <harness> on its own.');
  }
  const members: string[] = [];
  for (const part of raw.split(',').map(p => p.trim()).filter(Boolean)) {
    const id = assertAccessId(part);
    if (id === owner) throw usageError(`--members names ${id}, the owner; the owner is always on the team.`, 'Leave the owner out of --members.');
    if (members.includes(id)) throw usageError(`--members names ${id} twice.`, 'Name each member once.');
    members.push(id);
  }
  if (!members.length) throw usageError('A team brain needs --members with at least one person besides the owner.', 'Name them: --members alice-example,bob-example.');
  const groups: TeamRoster['groups'] = [];
  for (const part of (groupsSpec ?? '').split(',').map(p => p.trim()).filter(Boolean)) {
    const [name, list, extra] = part.split(':');
    if (extra !== undefined || !name || !list) throw usageError(`--groups takes name:member+member entries; "${part}" is not one.`, 'For example: --groups eng:alice-example+bob-example,ops:carol-example');
    const id = assertAccessId(teamGroupId(assertAccessId(name, 'group')), 'group');
    if (groups.some(g => g.name === name)) throw usageError(`--groups names ${name} twice.`, 'Name each group once.');
    const who = list.split('+').map(m => assertAccessId(m.trim()));
    for (const m of who) if (m !== owner && !members.includes(m)) throw usageError(`--groups puts ${m} in ${name}, and ${m} is not in --members.`, 'Add them to --members first.');
    groups.push({ name, id, members: [...new Set(who)] });
  }
  return { owner, members, groups };
}

/** The rules the template writes, each with its rule id. */
export function teamRules(r: TeamRoster): FolderRule[] {
  const wanted: Array<{ prefix: string; readable_by: string[] }> = [
    ...[r.owner, ...r.members].map(id => ({ prefix: memberFolder(id), readable_by: [id] })),
    { prefix: TEAM_FOLDER, readable_by: [r.owner, `group:${TEAM_GROUP}`] },
    ...r.groups.map(g => ({ prefix: groupFolder(g.name), readable_by: [r.owner, `group:${g.id}`] })),
  ];
  return wanted.map(w => {
    const n = normalizeRule(w);
    if ('problem' in n) throw usageError(`The rule for ${w.prefix} is not valid: ${n.problem}.`, 'Pick shorter member or group ids.');
    return n.rule;
  });
}

export interface FreshProblem { what: string; detail: string; remedy: string }
export interface TeamAction { what: string; action: 'add' | 'set' | 'keep' | 'mint' | 'blocked'; command: string; detail?: string }
export interface TeamKey { member: string; token_name: string; path: string; action: 'mint' | 'keep' | 'blocked'; detail?: string }
export interface TeamResult {
  template: typeof TEMPLATE;
  applied: boolean;
  source_id: string;
  store: 'git' | 'database';
  roster: TeamRoster;
  fresh: { ok: boolean; problems: FreshProblem[] };
  steps: Array<{ id: string; actions: TeamAction[] }>;
  keys: TeamKey[];
  key_dir: string;
  /** Who reads what once applied, one line per person: the audit the owner checks with gbrain access check. */
  reads: Array<{ member: string; reads: string[] }>;
  next: string[];
  error?: { code: string; message: string };
}

export interface TeamOpts { source?: string; owner?: string; members?: string; groups?: string; apply: boolean; keyDir?: string }

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const readerArg = (readers: string[]) => readers.map(r => r.replace(/^member:/, '')).join(',');
const srcFlag = (s: string) => (s === 'default' ? '' : ` --source ${s}`);

/** The files gbrain init seeds into a new brain's folder (the setup skill bundle), by path and sha256, while unchanged. */
function seededFiles(root: string): Map<string, string> {
  try {
    const pack = JSON.parse(readFileSync(join(root, 'skillpack.json'), 'utf8')) as { provenance?: { source?: unknown; sha256?: Record<string, unknown> } };
    if (pack.provenance?.source !== SETUP_BUNDLE_SOURCE || typeof pack.provenance.sha256 !== 'object' || !pack.provenance.sha256) return new Map();
    return new Map(Object.entries(pack.provenance.sha256).map(([k, v]) => [k, String(v)]));
  } catch { return new Map(); } // silent-read-ok: no readable skillpack.json means nothing counts as seeded, so every note is checked
}

/** The first file under `root` a sync would import as a page and gbrain did not seed itself, or null. */
function firstNote(root: string): string | null {
  const seeded = seededFiles(root);
  const walk = (dir: string): string | null => {
    let names: string[];
    try { names = readdirSync(dir).sort(); } catch { return dir; } // silent-read-ok: a folder it cannot read counts as holding notes (fails closed)
    for (const name of names) {
      const p = join(dir, name);
      let st;
      try { st = lstatSync(p); } catch { return p; } // silent-read-ok: a file it cannot stat counts as a note (fails closed)
      if (st.isSymbolicLink()) continue;
      const rel = relative(root, p);
      if (st.isDirectory()) { if (!name.startsWith('.')) { const f = walk(p); if (f) return f; } continue; }
      if (!SYNC_STRATEGIES.some(strategy => isSyncable(rel, { strategy }))) continue;
      if (rel === 'skillpack.json' && seeded.size) continue;
      if (seeded.get(rel) === createHash('sha256').update(readFileSync(p)).digest('hex')) continue;
      return p;
    }
    return null;
  };
  return walk(root);
}

async function rowCount(engine: BrainEngine, table: string): Promise<number> {
  return Number((await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`))[0]?.n ?? 0);
}

/** Content checks: pages (soft-deleted too), facts and page history, and files waiting in a source folder. */
async function contentProblems(engine: BrainEngine): Promise<FreshProblem[]> {
  const out: FreshProblem[] = [];
  const pages = await rowCount(engine, 'pages');
  if (pages) out.push({ what: 'pages', detail: `the brain holds ${pages} page(s), soft-deleted ones included`, remedy: 'The team template sets up brand-new brains only; create a new brain for the team (a new GBRAIN_HOME), or share this one by hand with gbrain setup and --members instead' });
  for (const t of HISTORY_TABLES) {
    const n = await rowCount(engine, t);
    if (n) out.push({ what: t, detail: `the brain holds ${n} row(s) of ${t.replace(/_/g, ' ')}`, remedy: 'A brain with history is not fresh; create a new brain for the team (a new GBRAIN_HOME)' });
  }
  for (const s of await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources ORDER BY id')) {
    const file = s.local_path && existsSync(s.local_path) ? firstNote(s.local_path) : null;
    if (file) out.push({ what: `source ${s.id}`, detail: `its folder ${s.local_path} already holds notes a sync would import (first: ${file})`, remedy: `Point the team brain at an empty folder, or move those files out of ${s.local_path}` });
  }
  return out;
}

/** Access checks: anything beyond what this roster's template writes is a conflict. */
async function accessProblems(engine: BrainEngine, roster: TeamRoster, source: string, rules: FolderRule[]): Promise<FreshProblem[]> {
  const out: FreshProblem[] = [];
  const people = [roster.owner, ...roster.members];
  const view = await ownerView(engine);
  if (view.inactive) out.push({ what: 'owner', detail: `the configured owner ${view.inactive.value} is not usable (${view.inactive.reason})`, remedy: 'Use a new brain for the team' });
  else if (view.owner && view.owner !== roster.owner) out.push({ what: 'owner', detail: `the brain owner is already ${view.owner}`, remedy: `Run again with --owner ${view.owner}, or use a new brain for the team` });
  for (const m of await listMembers(engine, { includeRemoved: true })) {
    if (!people.includes(m.id)) { out.push({ what: `member ${m.id}`, detail: `${m.id} is already a member and is not in --members`, remedy: 'The team template sets up brand-new brains only; add them to --members, or use a new brain' }); continue; }
    const bad = memberMismatch(m, m.id === roster.owner);
    if (bad) out.push({ what: `member ${m.id}`, detail: bad, remedy: 'Use a new member id, or a new brain' });
  }
  const groupIds = [TEAM_GROUP, ...roster.groups.map(g => g.id)];
  for (const g of await listGroups(engine)) {
    if (!groupIds.includes(g.id)) { out.push({ what: `group ${g.id}`, detail: `group ${g.id} already exists`, remedy: 'Use a new brain for the team' }); continue; }
    const want = g.id === TEAM_GROUP ? people : roster.groups.find(x => x.id === g.id)!.members;
    const extra = g.members.filter(m => !want.includes(m));
    if (extra.length) out.push({ what: `group ${g.id}`, detail: `group ${g.id} already holds ${extra.join(', ')}, who this roster leaves out of it`, remedy: `Remove them (gbrain access group rm ${g.id} --members ${extra.join(',')}), or use a new brain` });
  }
  for (const s of await engine.executeRaw<{ id: string }>('SELECT id FROM sources ORDER BY id')) {
    for (const rule of await currentFolderRules(engine, s.id)) {
      const mine = s.id === source && rules.some(w => w.id === rule.id && w.prefix === rule.prefix && sameSet(w.readable_by, rule.readable_by));
      if (!mine) out.push({ what: `rule ${s.id}:${rule.id}`, detail: `source ${s.id} already has folder rule "${rule.id}" on ${rule.prefix} (readable by ${readerArg(rule.readable_by)})`, remedy: 'The team template writes its own rules on a brand-new brain only; use a new brain' });
    }
  }
  const tokens = await engine.executeRaw<{ name: string; member_id: string | null }>('SELECT DISTINCT name, member_id FROM access_tokens WHERE revoked_at IS NULL ORDER BY name');
  for (const t of tokens) {
    if (t.member_id === null) out.push({ what: `token ${t.name}`, detail: `live token ${t.name} is bound to no member, so it could read pages no rule keeps`, remedy: `Revoke it (gbrain auth revoke ${t.name}) or bind it to the owner (gbrain auth rescope --token ${t.name} --member ${roster.owner})` });
  }
  for (const c of await engine.executeRaw<{ client_id: string }>('SELECT client_id FROM oauth_clients WHERE deleted_at IS NULL AND member_id IS NULL ORDER BY client_id')) {
    out.push({ what: `client ${c.client_id}`, detail: `OAuth client ${c.client_id} is bound to no member`, remedy: `Bind it to the owner (gbrain auth rescope --client ${c.client_id} --member ${roster.owner}) or remove it` });
  }
  return out;
}

function memberMismatch(m: MemberRecord, owner: boolean): string | null {
  if (m.status !== 'enabled') return `${m.id} is ${m.status}`;
  if (m.kind !== 'person') return `${m.id} is a ${m.kind} member, not a person`;
  if (owner && m.labelled_only) return `${m.id} is labelled-only, and the owner reads every page no rule keeps to others`;
  return null;
}

async function plan(engine: BrainEngine, opts: TeamOpts): Promise<TeamResult> {
  const source = opts.source ?? 'default';
  const keyDir = opts.keyDir ?? memberKeyDir();
  const gitRoot = gitRootAbove(keyDir);
  if (gitRoot) {
    throw opError('access_serves_key_dir_in_git', `Member keys go to ${keyDir}, which is inside the git work tree at ${gitRoot}; a key there could be committed, so nothing was written.`,
      'Point GBRAIN_HOME at a directory outside any git checkout (the default is your home directory), then run the command again.');
  }
  const [src] = await engine.executeRaw<{ id: string; local_path: string | null }>('SELECT id, local_path FROM sources WHERE id = $1 AND archived IS NOT TRUE', [source]);
  if (!src) throw opError('unknown_source', `No live source "${source}" exists on this brain, so nothing was written.`, 'Pick an id from gbrain sources list, or leave --source out.');
  const view = await ownerView(engine);
  const owner = opts.owner ?? view.owner;
  if (!owner) throw usageError('The team template needs an owner, and this brain has none.', 'Name one with --owner <member id>.');
  const roster = parseTeamRoster(opts.members, opts.groups, assertAccessId(owner));
  const rules = teamRules(roster);
  const problems = [...await contentProblems(engine), ...await accessProblems(engine, roster, source, rules)];

  const members = new Map((await listMembers(engine)).map(m => [m.id, m]));
  const groups = new Map((await listGroups(engine)).map(g => [g.id, g.members]));
  const current = await currentFolderRules(engine, source);
  const steps: TeamResult['steps'] = [
    { id: 'owner', actions: [{ what: owner, action: view.owner === owner ? 'keep' : members.has(owner) ? 'set' : 'add', command: `gbrain access member add ${owner} && gbrain access owner set ${owner}` }] },
    { id: 'members', actions: roster.members.map(m => ({ what: m, action: members.has(m) ? 'keep' as const : 'add' as const, command: `gbrain access member add ${m}` })) },
    { id: 'labelled_only', actions: roster.members.map(m => ({ what: m, action: members.get(m)?.labelled_only ? 'keep' as const : 'set' as const, command: `gbrain access member labelled-only ${m} on` })) },
    { id: 'groups', actions: [{ id: TEAM_GROUP, members: [owner, ...roster.members] }, ...roster.groups].map(g => {
      const held = groups.get(g.id);
      return { what: g.id, action: held && g.members.every(m => held.includes(m)) ? 'keep' as const : 'add' as const, command: `gbrain access group add ${g.id} --members ${g.members.join(',')}` };
    }) },
    { id: 'rules', actions: rules.map(r => ({ what: r.prefix, action: current.some(c => c.id === r.id) ? 'keep' as const : 'add' as const,
      command: `gbrain access rule add --id ${r.id} --prefix ${r.prefix} --readers ${readerArg(r.readable_by)}${srcFlag(source)}${r.readable_by.includes(`member:${owner}`) ? '' : ' --allow-without-owner'} --yes` })) },
    { id: 'config', actions: [{ what: SERVES_KEY, action: (await engine.getConfig(SERVES_KEY))?.trim() === 'several' ? 'keep' : 'set', command: `gbrain config set ${SERVES_KEY} several` }] },
  ];
  const keys: TeamKey[] = [];
  for (const m of roster.members) {
    const name = memberKeyName(m);
    const path = join(keyDir, `${m}.key`);
    const k = (action: TeamKey['action'], detail?: string): TeamKey => ({ member: m, token_name: name, path, action, ...(detail ? { detail } : {}) });
    const [token] = await engine.executeRaw<{ member_id: string | null; token_hash: string; scopes: string[] | null; source_grant: string | null; source_id: string | null }>(
      'SELECT member_id, token_hash, scopes, source_grant, source_id FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]);
    if (!token && existsSync(path)) keys.push(k('blocked', `a key file is already at ${path} but no live key is named ${name}; move or delete the file, then run this again`));
    else if (!token) keys.push(k('mint'));
    else if (token.member_id !== m) keys.push(k('blocked', `a token named ${name} exists but is not bound to ${m}; revoke it (gbrain auth revoke ${name}), then run this again`));
    else if (!existsSync(path)) keys.push(k('blocked', `the key ${name} exists but its file is gone, and a key is shown only once; revoke it (gbrain auth revoke ${name}) and run this again to issue a new one`));
    else if (hashToken(readFileSync(path, 'utf8').trim()) !== token.token_hash) keys.push(k('blocked', `the file does not hold the live key ${name}; revoke it (gbrain auth revoke ${name}), delete ${path} and run this again`));
    else if (token.source_grant !== 'scalar' || token.source_id !== source || !token.scopes || !sameSet(token.scopes, KEY_SCOPES)) keys.push(k('blocked', `the key ${name} has another grant than read+write on source ${source} only; revoke it (gbrain auth revoke ${name}), delete ${path} and run this again`));
    else keys.push(k('keep'));
  }
  steps.push({ id: 'keys', actions: keys.map(x => ({ what: x.member, action: x.action, command: `gbrain auth create ${x.token_name} --member ${x.member} --scopes ${KEY_SCOPES.join(',')} --sources ${source}`, ...(x.detail ? { detail: x.detail } : {}) })) });

  const reads = [
    { member: owner, reads: [memberFolder(owner), TEAM_FOLDER, ...roster.groups.map(g => groupFolder(g.name)), 'every page no rule or readable_by keeps to someone else'] },
    ...roster.members.map(m => ({ member: m, reads: [memberFolder(m), TEAM_FOLDER, ...roster.groups.filter(g => g.members.includes(m)).map(g => groupFolder(g.name)), 'pages that name it in readable_by, its own new pages included'] })),
  ];
  const next = [
    `Serve the brain over HTTP for the team: gbrain serve --http (or publish it with gbrain mcp expose).`,
    ...roster.members.map(m => `Give ${join(keyDir, `${m}.key`)} to ${m} privately; on their machine: GBRAIN_REMOTE_TOKEN="$(cat ${m}.key)" gbrain connect https://<your brain>/mcp --agent claude-code --install`),
    `Check what each key reads: gbrain access check --token ${memberKeyName(roster.members[0]!)} (and gbrain access who-can-read <slug> for any page).`,
    `Add someone later: gbrain access member add <id> --groups ${TEAM_GROUP}, gbrain access member labelled-only <id> on, gbrain access rule add --prefix people/<id>/ --readers <id>${srcFlag(source)} --allow-without-owner --yes, then gbrain auth create member-<id> --member <id> --sources ${source}.`,
  ];
  return { template: TEMPLATE, applied: false, source_id: source, store: src.local_path && gitRootAbove(src.local_path) ? 'git' : 'database', roster, fresh: { ok: !problems.length, problems },
    steps, keys, key_dir: keyDir, reads, next };
}

export const teamBlocked = (r: TeamResult): boolean => !r.fresh.ok || r.keys.some(k => k.action === 'blocked');

/**
 * O1 v1: on a brain that already exists, setup runs the team template's preview before it writes anything, so a brain
 * that is not fresh (pages, history, access state of its own) refuses there with nothing written.
 */
export function teamPreflight(launcher: string, t: { members: string; groups?: string; owner?: string | null; source?: string | null }) {
  const argv = [launcher, 'access', 'team', '--members', t.members, ...(t.groups ? ['--groups', t.groups] : []), ...(t.owner ? ['--owner', t.owner] : []), ...(t.source ? ['--source', t.source] : []), '--json'];
  const child = bunSpawnSync(argv, { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: process.env });
  const said = `${child.stdout?.toString() ?? ''}\n${child.stderr?.toString() ?? ''}`;
  let r: TeamResult | null = null;
  try { const doc = JSON.parse(child.stdout?.toString() ?? ''); if (doc?.template === 'team') r = doc as TeamResult; } catch { r = null; }
  if (!r) {
    const message = said.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1] ?? said.trim().split('\n')[0]?.slice(0, 300) ?? 'no output';
    return opError('invalid_params', `The team template could not check this brain (${message}); nothing was written.`, `Run ${['gbrain', ...argv.slice(1)].join(' ')} to see why.`);
  }
  return r.fresh.ok ? null : notFreshError(r);
}

export function notFreshError(r: TeamResult) {
  return opError('team_template_not_fresh', `The team template sets up brand-new brains only, and this one is not fresh: ${r.fresh.problems.map(p => p.detail).join('; ')}. Nothing was written.`,
    r.fresh.problems[0]?.remedy ?? 'Use a new brain for the team.');
}

/** Plans, and with `apply` writes, the team template; a failure after the first write is reported in the result, never thrown. */
export async function teamTemplate(engine: BrainEngine, opts: TeamOpts): Promise<TeamResult> {
  const result = await plan(engine, opts);
  if (!opts.apply || teamBlocked(result)) return result;
  result.applied = true;
  const { roster, source_id: source } = result;
  const todo = (id: string, what: string) => result.steps.find(s => s.id === id)!.actions.find(a => a.what === what)!.action !== 'keep';
  try {
    if (todo('owner', roster.owner)) {
      if (!(await listMembers(engine)).some(m => m.id === roster.owner)) await addMember(engine, roster.owner, { remote: false });
      await setOwner(engine, roster.owner);
    }
    for (const m of roster.members) if (todo('members', m)) await addMember(engine, m, { remote: false });
    for (const m of roster.members) if (todo('labelled_only', m)) await setMemberLabelledOnly(engine, m, true, { remote: false });
    await addGroup(engine, TEAM_GROUP, [roster.owner, ...roster.members]);
    for (const g of roster.groups) await addGroup(engine, g.id, g.members);
    const add = teamRules(roster).filter(r => todo('rules', r.prefix));
    if (add.length) {
      const { result: written } = await addFolderRules(engine, source, add, { apply: true, json: true });
      if (written && written.state !== 'applied' && written.state !== 'unchanged') {
        throw opError('team_template_rules_pending', `The team rules were ${written.state}, not applied, so no member key was issued.`, `Finish with gbrain access resume --source ${source}, then run this again.`);
      }
    }
    await engine.setConfig(SERVES_KEY, 'several');
    const applied = await appliedRules(engine, source);
    const missing = teamRules(roster).filter(r => !applied.some(x => x.prefix === r.prefix && sameSet(x.readable_by, r.readable_by)));
    if (missing.length) throw opError('team_template_rules_pending', `The team rules for ${missing.map(r => r.prefix).join(', ')} are not in force yet, so no member key was issued.`, `Finish with gbrain access resume --source ${source}, then run this again.`);
    const late = await contentProblems(engine);
    if (late.length) throw opError('team_template_not_fresh', `Pages arrived while the team template ran (${late.map(p => p.detail).join('; ')}), so no member key was issued.`, 'Check who wrote the new pages (gbrain access who-can-read on each) before you run this again.');
    for (const k of result.keys.filter(x => x.action === 'mint')) {
      const minted = await mintToken(engine, k.token_name, { scopes: KEY_SCOPES, binding: { member: k.member }, sources: { kind: 'scalar', writeSource: source } });
      try { writeKeyFile(k.path, minted.token); } catch (e) {
        await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [minted.id]);
        throw e;
      }
      k.action = 'keep';
    }
  } catch (e) { // capability-refusal-ok: the failure is reported in the result; every step is idempotent and keys come last
    result.error = { code: (e as { code?: string }).code ?? 'internal_error', message: e instanceof Error ? e.message : String(e) };
  }
  return result;
}

const VERB: Record<TeamAction['action'], [string, string]> = { add: ['will add', 'added'], set: ['will set', 'set'], keep: ['keep', 'kept'], mint: ['will issue', 'issued'], blocked: ['BLOCKED', 'BLOCKED'] };

export function teamLines(r: TeamResult): string[] {
  const lines = [`Team template (source ${r.source_id}, owner ${r.roster.owner}; rules in the ${r.store === 'git' ? 'repo (.gbrain/access.yml)' : 'database (repo-less brain)'}):`];
  if (!r.fresh.ok) {
    lines.push('  NOT FRESH: the team template sets up brand-new brains only. Nothing was written.');
    for (const p of r.fresh.problems) lines.push(`    ${p.what}: ${p.detail}. ${p.remedy}.`);
    return lines;
  }
  lines.push('  fresh       ok: no pages, no history, no other members, groups, rules or unbound credentials');
  for (const s of r.steps) for (const a of s.actions) lines.push(`  ${s.id.padEnd(13)} ${VERB[a.action][r.applied && !r.error ? 1 : 0].padEnd(10)} ${a.what}${a.detail ? `  (${a.detail})` : ''}`);
  lines.push('Who reads what:');
  for (const x of r.reads) lines.push(`  ${x.member}${x.member === r.roster.owner ? ' (owner)' : ''}: ${x.reads.join(', ')}`);
  lines.push('  Nobody reads another person\'s people/<id>/ folder. The brain host\'s own CLI still reads every page.');
  for (const k of r.keys.filter(x => x.action !== 'blocked')) lines.push(`  key ${k.member}: ${k.path} (0600, read+write, source ${r.source_id} only; the key is never printed)`);
  if (r.error) lines.push(`Stopped: ${r.error.message}`, '  Every step is idempotent and member keys come last: fix the cause and run the same command again.');
  else if (!r.applied) lines.push(teamBlocked(r) ? 'Nothing written: fix each BLOCKED line, then run this again.' : 'Nothing written. Add --yes to apply.');
  else lines.push('Next:', ...r.next.map((n, i) => `  ${i + 1}. ${n}`));
  return lines;
}

export async function runTeamTemplate(engine: BrainEngine, args: string[], json: boolean, value: (args: string[], flag: string) => string | undefined): Promise<void> {
  for (const flag of ['--guests', '--transcripts', '--shape', '--history', '--open-history', '--labelled-only', '--resume', '--status']) {
    if (args.includes(flag)) throw usageError(`${flag} is not part of the team template.`, 'The team template sets up a brand-new brain for a team: --members, --groups, --owner and --source only.');
  }
  const owner = value(args, '--owner');
  const r = await teamTemplate(engine, { apply: args.includes('--yes'), source: value(args, '--source'), members: value(args, '--members'), groups: value(args, '--groups'),
    ...(owner !== undefined ? { owner: assertAccessId(owner) } : {}) });
  console.log(json ? JSON.stringify(r, null, 2) : teamLines(r).join('\n'));
  if (r.error || teamBlocked(r)) setCliExitVerdict(1);
}
