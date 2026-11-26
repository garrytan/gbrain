/**
 * Agent platform plan, lane 5 O1: `gbrain access template team`, the brain side of
 * `gbrain setup <harness> --template team --members a,b [--guests w]`.
 *
 *   gbrain access template team --members a,b [--guests <kind>:<id>,...] [--owner <id>] [--team-group <id>] [--source <id>]
 *                               [--harness <h>] [--yes] [--json]
 *   gbrain access template team --status [--receipt <id>] [--source <id>] [--harness <h>] [--json]
 *   gbrain access template team --resume <receipt id> [--source <id>] [--harness <h>] --yes [--json]
 *
 * Preview first; --yes applies, in this order, every step idempotent:
 *   guests        with --guests: the guest source (gbrain guests init), database-only, writable only by the named writers
 *   serves        gbrain access serves several for the members: each member, the owner, a people/<member>/ folder only
 *                 that member reads, access.serves = several, and one key per member in a 0600 file, never printed
 *   group         the team group (team-members unless --team-group names another), holding the owner and the members
 *   rules         company/ in the company source and rules/team/ in the run's source, each readable by the owner and the
 *                 team group; a hand rule on the same folder is never overwritten (BLOCKED, with the command that changes it)
 *   owner_clients with --guests: every credential bound to the owner reads the guest source (gbrain guests grant-owner-clients)
 * d17: the template only ever makes or adds to a group it made itself. A group of that name it did not make (the brain's
 * marker of the group it made does not match the live group), or one holding anyone outside the roster, is BLOCKED before anything is written,
 * so an existing group and every page it opens stay exactly as they were; --team-group names another group for the team.
 * d8: the run's receipt is H2's (setup-template-receipt.ts): steps, and per key its issuance apart from its delivery.
 * --status reads the receipt and proves each member's key over the remote path: what it reads against what the rules expect.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { AuthInfo } from '../core/ops/contract.ts';
import { opError } from '../core/ops/contract.ts';
import { hashToken } from '../core/utils.ts';
import { usageError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { assertAccessId, listGroups, addGroup, pagesNaming, parseIdList } from '../core/access/members.ts';
import { ownerView } from '../core/access/owner.ts';
import { normalizeRule, type FolderRule } from '../core/access/folder-rules.ts';
import { COMPANY_SOURCE_ID, readOpenPages } from '../core/access/open-pages.ts';
import { appliedRules, policyStatus, resumePolicy } from '../core/access/policy.ts';
import { readBrainRef } from '../core/brain-ref.ts';
import { GUEST_WRITER_FORMAT, initGuestSource, isGuestWriter, planGuestSource, unregisteredClientWriters } from '../core/guests/sources.ts';
import { grantOwnerCredentials, ownerCredentials } from '../core/guests/owner-credentials.ts';
import { RULE_PREFIX } from '../core/rules/record.ts';
import { assertReceiptTarget, latestReceipt, loadReceipt, markStep, newReceipt, receiptDir, receiptKey, saveReceipt, stepState, type TemplateReceipt } from './setup-template-receipt.ts';
import { addFolderRules, currentFolderRules } from './access-rules.ts';
import { labelSeveral, memberKeyDir, type ServesReceipt } from './access-serves.ts';
import { whoCanRead } from './access.ts';

export const TEMPLATE = 'team';
export const DEFAULT_TEAM_GROUP = 'team-members';
export const GUEST_SOURCE = 'guests';
export const TEAM_RULES_PREFIX = `${RULE_PREFIX}team/`;
export const COMPANY_PREFIX = `${COMPANY_SOURCE_ID}/`;
export const STEPS = ['guests', 'serves', 'group', 'rules', 'owner_clients'] as const;
export type StepId = typeof STEPS[number];

export interface TemplateAction { what: string; action: 'add' | 'set' | 'keep' | 'run' | 'mint' | 'blocked'; command: string; detail?: string }
export interface TemplateKey { member: string; token_name: string; path: string; action: 'mint' | 'keep' | 'skipped' | 'blocked'; reads: string[]; issued: string | null; delivered: string | null; detail?: string }
export interface TeamResult {
  template: typeof TEMPLATE;
  applied: boolean;
  receipt_id: string | null;
  harness: string | null;
  source_id: string;
  owner: string | null;
  members: string[];
  guests: string[];
  group: string;
  steps: Array<{ id: StepId; state: 'done' | 'planned' | 'blocked' | 'failed' | 'skipped'; actions: TemplateAction[] }>;
  keys: TemplateKey[];
  key_dir: string;
  /** Live credentials bound to no member, from the serves step. Never rebound here. */
  unbound: Array<{ kind: 'token' | 'client'; name: string; command: string }>;
  error?: { code: string; message: string };
}

export interface TeamOpts {
  /** Unset: a resume uses its receipt's source, and a new run uses default. */
  source?: string;
  harness?: string | null;
  owner?: string;
  members?: string;
  guests?: string;
  group?: string;
  apply: boolean;
  resume?: string;
  receiptDir?: string;
  /** A brain that serves one person and holds pages no rule restricts: private keeps them from the members (labelled-only), open lets them read them. */
  history?: 'private' | 'open';
}

/** The member ids of --members: at least one, never the owner. */
export function parseTeamMembers(spec: string | undefined, owner: string | null): string[] {
  const ids = parseIdList(spec ?? '', 'member');
  if (!ids.length) throw usageError('--template team needs the people of the team: --members <id,...>.', 'For example: --members bob-example,carol-example (the owner is in the team already).');
  if (owner && ids.includes(owner)) throw usageError(`--members names ${owner}, the brain owner, who is in the team already.`, 'Leave the owner out of --members.');
  return ids;
}

/** The writers of --guests, each a principal the guest source lets save notes (`<kind>:<id>`). */
export function parseGuestWriters(spec: string | undefined): string[] {
  const writers = [...new Set((spec ?? '').split(',').map(w => w.trim()).filter(Boolean))].sort();
  const bad = writers.filter(w => !isGuestWriter(w));
  if (bad.length) throw usageError(`--guests names ${bad.join(', ')}, which is not a writer principal.`, `Name each writer as ${GUEST_WRITER_FORMAT}, for example oauth_client:<client id>.`);
  return writers;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const readerArg = (readers: string[]) => [...readers.filter(r => !r.startsWith('group:')), ...readers.filter(r => r.startsWith('group:'))].map(r => r.replace(/^member:/, '')).join(',');

/** The two rules the template writes, with the source each lives in. */
export function teamRules(owner: string, group: string, source: string): Array<{ source: string; rule: FolderRule }> {
  return [[COMPANY_SOURCE_ID, COMPANY_PREFIX], [source, TEAM_RULES_PREFIX]].map(([src, prefix]) => {
    const n = normalizeRule({ prefix, readable_by: [owner, `group:${group}`] });
    if ('problem' in n) throw new Error(`team rule ${prefix}: ${n.problem}`);
    return { source: src!, rule: n.rule };
  });
}

/** The history choice the newest team receipt on this brain (its brain_ref) records, or null. */
function historyOnBrain(dir: string, brainRef: string | null): 'private' | 'open' | null {
  if (!brainRef) return null;
  const r = latestReceipt(TEMPLATE, { where: x => x.params.brain_ref === brainRef && (x.params.history === 'private' || x.params.history === 'open') }, dir);
  return (r?.params.history as 'private' | 'open' | undefined) ?? null;
}

/** The config key holding the creation time of the group this template made, written in the transaction that made it. */
const groupMarker = (group: string) => `access.team_template.group.${group}`;

/** Whether the live group named `group` is the one this template made; one made by anyone else, or removed and made again, is not. */
async function madeByTemplate(engine: BrainEngine, group: string): Promise<boolean> {
  const [row] = await engine.executeRaw<{ at: string }>('SELECT created_at::text AS at FROM access_groups WHERE id = $1', [group]);
  return !!row && (await engine.getConfig(groupMarker(group))) === row.at;
}

/** Folder rules in any source that name group:<group>, in force or wanted (a removal waiting for approval is still in force), and the sources whose wanted rules this host cannot read. */
async function rulesNaming(engine: BrainEngine, group: string): Promise<{ hits: string[]; unreadable: string[] }> {
  const sources = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE archived IS NOT TRUE ORDER BY id');
  const hits = new Set<string>();
  const unreadable: string[] = [];
  for (const { id } of sources) {
    const name = (rules: FolderRule[]) => { for (const r of rules) if (r.readable_by.includes(`group:${group}`)) hits.add(`${id}:${r.prefix}`); };
    name(await appliedRules(engine, id));
    try { name(await currentFolderRules(engine, id)); } catch (e) { unreadable.push(`${id} (${(e as { code?: string }).code ?? 'unreadable'})`); } // silent-read-ok: an unreadable rulebook BLOCKS making the group
  }
  return { hits: [...hits].sort(), unreadable };
}

/** A receipt names the brain it ran on (its brain_ref); one from another brain behind the same config directory is refused. */
function assertSameBrain(r: TemplateReceipt, brainRef: string | null): void {
  if (brainRef && r.params.brain_ref === brainRef) return;
  throw opError('setup_receipt_target_mismatch', `Receipt ${r.id} was written on another brain than the one this config directory now opens; nothing was written.`,
    'Open the brain it was written on, or preview a new run with gbrain access template team --members <id,...>.');
}

const sourceExists = async (engine: BrainEngine, id: string) =>
  (await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1 AND archived IS NOT TRUE', [id])).length > 0;

async function plan(engine: BrainEngine, opts: TeamOpts & { source: string; dir: string; brainRef: string | null }, prior: TemplateReceipt | null): Promise<TeamResult & { serves: ServesReceipt | null; groupHeld: string[] | null; history: 'private' | 'open' | null }> {
  const source = opts.source;
  const group = assertAccessId(opts.group ?? DEFAULT_TEAM_GROUP, 'group');
  const view = await ownerView(engine);
  const owner = view.owner ?? (view.inactive ? null : opts.owner ?? null);
  const steps: TeamResult['steps'] = [];
  const step = (id: StepId, actions: TemplateAction[]) => steps.push({ id, state: actions.some(a => a.action === 'blocked') ? 'blocked' : actions.length ? 'planned' : 'skipped', actions });
  const keyDir = memberKeyDir();
  const base = { template: TEMPLATE, applied: false, receipt_id: prior?.id ?? null, harness: opts.harness ?? prior?.harness ?? null, source_id: source, group, key_dir: keyDir } as const;
  if (!owner) {
    const detail = view.inactive ? `the configured owner ${view.inactive.value} is not usable (${view.inactive.reason}); name an enabled member with gbrain access owner set <member>` : 'no owner is set; name one with --owner <member id>';
    return { ...base, owner: null, members: [], guests: [], steps: [{ id: 'serves', state: 'blocked', actions: [{ what: 'owner', action: 'blocked', command: 'gbrain access owner set <member>', detail }] }], keys: [], unbound: [], serves: null, groupHeld: null, history: null };
  }
  const members = prior ? (prior.params.members as string[]) : parseTeamMembers(opts.members, owner);
  const guests = prior ? (prior.params.guests as string[]) : parseGuestWriters(opts.guests);
  const history = (prior ? prior.params.history as 'private' | 'open' | null | undefined : opts.history ?? historyOnBrain(opts.dir, opts.brainRef)) ?? null;
  const srcFlag = `--source ${source}`;

  const guestActions: TemplateAction[] = [];
  if (guests.length) {
    const command = `gbrain guests init --source ${GUEST_SOURCE} ${guests.map(w => `--writer ${w}`).join(' ')} --yes`;
    const g = await planGuestSource(engine, GUEST_SOURCE, guests);
    const unregistered = await unregisteredClientWriters(engine, guests);
    if (unregistered) guestActions.push({ what: GUEST_SOURCE, action: 'blocked', command, detail: unregistered.message });
    else if (g.localPath) guestActions.push({ what: GUEST_SOURCE, action: 'blocked', command, detail: `source ${GUEST_SOURCE} has a local path (${g.localPath}), and a guest source is database-only; the template leaves it as it is` });
    else if (g.pages > 0) guestActions.push({ what: GUEST_SOURCE, action: 'blocked', command, detail: `source ${GUEST_SOURCE} already holds ${g.pages} page(s) that are not guest notes, so the template does not make it a guest source` });
    else if (g.guest && guests.every(w => g.guest!.writers.includes(w))) guestActions.push({ what: GUEST_SOURCE, action: 'keep', command });
    else guestActions.push({ what: GUEST_SOURCE, action: g.exists ? 'set' : 'add', command, detail: `writers ${g.writers.join(', ')}; trust ceiling external_untrusted` });
  }
  step('guests', guestActions);

  const serves = await labelSeveral(engine, members, source, false, true, { owner, labelledOnly: history === 'private', companyRule: false });
  const servesCommand = `gbrain access serves several --members ${members.join(',')} --owner ${owner} ${srcFlag}${history === 'private' ? ' --labelled-only' : ''} --yes`;
  const servesActions: TemplateAction[] = [
    ...(serves.owner ? [{ what: `owner ${serves.owner.id}`, action: serves.owner.action === 'blocked' ? 'blocked' as const : serves.owner.action === 'keep' ? 'keep' as const : 'set' as const, command: servesCommand, ...(serves.owner.detail ? { detail: serves.owner.detail } : {}) }] : []),
    ...serves.members.map((m): TemplateAction => ({ what: `member ${m.id}`, action: m.action, command: `gbrain access member add ${m.id}`, ...(m.detail ? { detail: m.detail } : {}) })),
    ...serves.rules.map((r): TemplateAction => ({ what: r.prefix, action: r.action, command: `gbrain access rule add --id ${r.id} --prefix ${r.prefix} --readers ${readerArg(r.readers)} ${srcFlag} --yes`, ...(r.detail ? { detail: r.detail } : {}) })),
    { what: serves.config.key, action: serves.config.action === 'keep' ? 'keep' : 'set', command: `gbrain config set ${serves.config.key} several` },
    ...serves.keys.map((k): TemplateAction => ({ what: `key ${k.member}`, action: k.action === 'skipped' ? 'keep' : k.action, command: `gbrain auth create ${k.token_name} --member ${k.member}`, ...(k.detail ? { detail: k.detail } : {}) })),
  ];
  const again = `gbrain setup <harness> --template team --members ${members.join(',')}`;
  if (!history && serves.config.action === 'keep' && !prior) {
    servesActions.push({ what: 'history', action: 'blocked', command: `${again} --labelled-only`,
      detail: 'this brain already serves several people, and no team setup receipt on this machine records whether the members read the pages no rule or readable_by restricts; run it again with --labelled-only to keep those pages from the members (they read the team folders and their own), or with --open-history to let every member read them' });
  }
  if (!history && serves.config.action !== 'keep') {
    const open = await readOpenPages(engine, { planned: { members, source, labelledOnly: false, owner },
      exclude: [...serves.rules.filter(r => r.action !== 'blocked').map(r => ({ source, prefix: r.prefix })), ...teamRules(owner, group, source).map(t => ({ source: t.source, prefix: t.rule.prefix }))] });
    if (!open.open_pages || open.open_pages.total) {
      const holds = open.open_pages ? `${open.open_pages.total} page(s) no rule or readable_by restricts${open.open_pages.sensitive ? ` (${open.open_pages.sensitive} of them DMs, chat or mail)` : ''}` : `pages setup could not count (${open.open_pages_error?.code ?? 'open_pages_failed'})`;
      servesActions.push({ what: 'history', action: 'blocked', command: `${again} --labelled-only`,
        detail: `this brain serves one person and holds ${holds}; turned shared, every member's key would read them. Run it again with --labelled-only to keep that history private (members read the team folders and their own), or with --open-history to let every member read it` });
    }
  }
  step('serves', servesActions);

  const want = [owner, ...members];
  const held = (await listGroups(engine)).find(g => g.id === group)?.members;
  const groupCommand = `gbrain access group add ${group} --members ${want.join(',')}`;
  const extra = (held ?? []).filter(id => !want.includes(id));
  const naming = held ? null : { pages: await pagesNaming(engine, `group:${group}`), ...await rulesNaming(engine, group) };
  const ours = held ? await madeByTemplate(engine, group) : false;
  step('group', [naming && naming.unreadable.length ? { what: group, action: 'blocked', command: `gbrain setup <harness> --template team --team-group <another id>`,
      detail: `the folder rules of ${naming.unreadable.join(', ')} cannot be read on this host, so setup cannot tell whether they name group:${group} as a reader; run this where those rules can be read, or name another group with --team-group <id>` }
    : naming && (naming.pages.pages.length || naming.hits.length) ? { what: group, action: 'blocked', command: `gbrain setup <harness> --template team --team-group <another id>`,
      detail: `no group ${group} exists, but ${[naming.pages.pages.length ? `${naming.pages.pages.length}${naming.pages.truncated ? '+' : ''} page(s) (${naming.pages.pages.slice(0, 3).map(x => `${x.source_id}:${x.slug}`).join(', ')})` : '', naming.hits.length ? `folder rule(s) on ${naming.hits.join(', ')}, in force or waiting to be,` : ''].filter(Boolean).join(' and ')} already name group:${group} as a reader; making the group would let the whole team read them, so name another group with --team-group <id>, or remove those readers first` }
    : !held ? { what: group, action: 'add', command: groupCommand }
    : !ours ? { what: group, action: 'blocked', command: `gbrain setup <harness> --template team --team-group <another id>`,
      detail: `a group named ${group} already exists (${held.join(', ') || 'no members'}) and this template did not make it; the template never changes a group it did not make, so that group and every page it opens stay as they are: name another group for the team with --team-group <id>, then run this again` }
    : extra.length ? { what: group, action: 'blocked', command: `gbrain access group rm ${group} --members ${extra.join(',')}`,
      detail: `also holds ${extra.join(', ')}, who ${extra.length === 1 ? 'is' : 'are'} not in --members and would keep reading the team's pages; the template never removes a group member, so remove them (or add them to --members), then run this again` }
    : sameSet(held, want) ? { what: group, action: 'keep', command: groupCommand }
    : { what: group, action: 'add', command: groupCommand, detail: `adds ${want.filter(id => !held.includes(id)).join(', ')}` }]);

  const ruleActions: TemplateAction[] = [];
  for (const { source: src, rule } of teamRules(owner, group, source)) {
    const command = `gbrain access rule add --id ${rule.id} --prefix ${rule.prefix} --readers ${readerArg(rule.readable_by)} --source ${src} --yes`;
    if (!(await sourceExists(engine, src))) {
      ruleActions.push(opts.apply ? { what: `${src}:${rule.prefix}`, action: 'blocked', command, detail: `the ${src} source does not exist; gbrain setup <harness> --template team creates it (or add one with gbrain sources add ${src} --path <folder>), then run this again` }
        : { what: `${src}:${rule.prefix}`, action: 'add', command, detail: `the ${src} source does not exist yet; gbrain setup <harness> --template team creates it before this step` });
      continue;
    }
    const current = await currentFolderRules(engine, src);
    const same = current.find(c => c.prefix === rule.prefix);
    if (same && sameSet(same.readable_by, rule.readable_by)) { ruleActions.push({ what: `${src}:${rule.prefix}`, action: 'keep', command }); continue; }
    if (same) {
      ruleActions.push({ what: `${src}:${rule.prefix}`, action: 'blocked', command: `gbrain access rule add --id ${same.id} --prefix ${rule.prefix} --readers ${readerArg(rule.readable_by)} --source ${src}`,
        detail: `rule "${same.id}" already covers ${rule.prefix}, readable by ${readerArg(same.readable_by)}; the template never overwrites a rule, so change it to the team's readers (preview first) or remove it, then run this again` });
      continue;
    }
    const clash = current.find(c => c.id === rule.id);
    ruleActions.push(clash ? { what: `${src}:${rule.prefix}`, action: 'blocked', command, detail: `rule id ${rule.id} is taken by a rule on ${clash.prefix}; give that rule another id, then run this again` }
      : { what: `${src}:${rule.prefix}`, action: 'add', command });
  }
  step('rules', ruleActions);
  step('owner_clients', guests.length ? [{ what: `credentials of ${owner}`, action: 'run', command: `gbrain guests grant-owner-clients --source ${GUEST_SOURCE} --yes`, detail: 'each credential bound to the owner reads the guest source; every source it reads already stays' }] : []);

  const keys = serves.keys.map((k): TemplateKey => {
    const r = prior?.keys.find(x => x.member === k.member);
    return { member: k.member, token_name: k.token_name, path: k.path, action: k.action, reads: k.reads ?? serves.reads?.sources ?? [], issued: r?.issued?.at ?? null, delivered: r?.delivered?.at ?? null, ...(k.detail ? { detail: k.detail } : {}) };
  });
  return { ...base, owner, members, guests, steps, keys, unbound: serves.unbound ?? [], serves, groupHeld: held ?? null, history: history ?? (serves.config.action === 'keep' ? null : 'open') };
}

const isBlocked = (r: TeamResult) => r.steps.some(s => s.state === 'blocked');

/** The error for a members step that its own apply-time plan refused (it wrote nothing), or null when it applied. */
export function servesRefusal(done: Pick<ServesReceipt, 'applied' | 'owner' | 'members' | 'rules' | 'keys'>): Error | null {
  if (done.applied) return null;
  const refused = [...(done.owner?.action === 'blocked' ? [`owner ${done.owner.id}`] : []), ...done.members.filter(m => m.action === 'blocked').map(m => `member ${m.id}`), ...done.rules.filter(r => r.action === 'blocked').map(r => r.prefix), ...done.keys.filter(k => k.action === 'blocked').map(k => `key ${k.member}`)];
  return new Error(`the members step changed since the preview and was refused (${refused.join(', ') || 'BLOCKED'}); nothing more was written, so run this again to preview it`);
}

function abortAfter(step: string): void {
  if (process.env.GBRAIN_SETUP_ABORT_AFTER === step) throw new Error(`GBRAIN_SETUP_ABORT_AFTER=${step}: stopped on purpose after ${step}.`);
}

/** Plans, and with `apply` writes, the team template; a failure is reported in the result and the receipt, never thrown. */
export async function teamTemplate(engine: BrainEngine, opts: TeamOpts): Promise<TeamResult> {
  const dir = opts.receiptDir ?? receiptDir();
  const prior = opts.resume ? loadReceipt(opts.resume, TEMPLATE, dir) : null;
  if (prior) assertReceiptTarget(prior, { source_id: opts.source, harness: opts.harness ?? null });
  const brainRef = await readBrainRef(engine);
  if (prior) assertSameBrain(prior, brainRef);
  const source = prior?.source_id ?? opts.source ?? 'default';
  const planned = await plan(engine, { ...opts, source, dir, brainRef, owner: prior ? String(prior.params.owner) : opts.owner, group: prior ? String(prior.params.group) : opts.group }, prior);
  const { serves: _serves, groupHeld, history, ...result } = planned;
  for (const s of result.steps) if (prior && stepState(prior, s.id) === 'done' && s.state === 'planned' && s.actions.every(a => a.action === 'keep')) s.state = 'done';
  if (!opts.apply || isBlocked(result)) return result;
  const receipt = prior ?? newReceipt(TEMPLATE, { harness: result.harness, source_id: source }, { owner: result.owner, members: result.members, guests: result.guests, group: result.group, history, brain_ref: brainRef }, [...STEPS]);
  result.receipt_id = receipt.id;
  result.applied = true;
  delete receipt.error;
  saveReceipt(receipt, dir);
  const run = async (id: StepId, fn: () => Promise<void>) => {
    const s = result.steps.find(x => x.id === id)!;
    if (s.state === 'done') return;
    if (s.state === 'skipped') { markStep(receipt, id, 'done', 'nothing to do'); saveReceipt(receipt, dir); return; }
    try { await fn(); } catch (e) { s.state = 'failed'; markStep(receipt, id, 'failed', e instanceof Error ? e.message : String(e)); saveReceipt(receipt, dir); throw e; }
    s.state = 'done';
    markStep(receipt, id, 'done');
    saveReceipt(receipt, dir);
    abortAfter(`team-${id}`);
  };
  const owner = result.owner!;
  try {
    await run('guests', async () => { await initGuestSource(engine, GUEST_SOURCE, result.guests); });
    await run('serves', async () => {
      for (const k of result.keys.filter(x => x.action === 'mint')) { receiptKey(receipt, k.member, k.token_name, k.path); }
      saveReceipt(receipt, dir);
      const done = await labelSeveral(engine, result.members, source, true, true, { owner, labelledOnly: history === 'private', companyRule: false });
      for (const k of done.keys) {
        const [token] = await engine.executeRaw<{ token_hash: string; created_at: unknown }>('SELECT token_hash, created_at FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [k.token_name]);
        const entry = receiptKey(receipt, k.member, k.token_name, k.path);
        const now = new Date().toISOString();
        if (token) entry.issued ??= { at: token.created_at ? new Date(String(token.created_at)).toISOString() : now };
        if (token && existsSync(k.path) && hashToken(readFileSync(k.path, 'utf8').trim()) === token.token_hash) entry.delivered ??= { at: now };
        const r = result.keys.find(x => x.member === k.member);
        if (r) Object.assign(r, { issued: entry.issued?.at ?? null, delivered: entry.delivered?.at ?? null, ...(r.action === 'mint' && entry.delivered ? { action: 'keep' } : {}) });
      }
      saveReceipt(receipt, dir);
      if (done.error) throw Object.assign(new Error(done.error.message), { code: done.error.code });
      const refused = servesRefusal(done);
      if (refused) throw refused;
    });
    await run('group', async () => {
      await engine.transaction(async tx => {
        await tx.executeRaw('SELECT pg_advisory_xact_lock(hashtext($1))', [`gbrain-team-group:${result.group}`]);
        const now = (await listGroups(tx)).find(g => g.id === result.group)?.members ?? null;
        if (!now !== !groupHeld || (now && !sameSet(now, groupHeld!))) {
          throw new Error(`group ${result.group} changed since the preview (${now ? `it now holds ${now.join(', ') || 'no members'}` : 'it is gone'}); nothing was added to it, so run this again to preview it`);
        }
        if (!now) {
          const [made] = await tx.executeRaw<{ at: string }>('INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING RETURNING created_at::text AS at', [result.group]);
          if (!made) throw new Error(`another writer made a group named ${result.group} while this run was writing; nothing was added to it, so run this again to preview it`);
          await tx.setConfig(groupMarker(result.group), made.at);
        } else if (!(await madeByTemplate(tx, result.group))) {
          throw new Error(`group ${result.group} is no longer the group this template made; nothing was added to it, so run this again to preview it`);
        }
        await addGroup(tx, result.group, [owner, ...result.members]);
      });
      abortAfter('team-group-written');
    });
    await run('rules', async () => {
      const adds = result.steps.find(s => s.id === 'rules')!.actions.filter(a => a.action === 'add').map(a => a.what);
      for (const { source: src, rule } of teamRules(owner, result.group, source)) {
        if (adds.includes(`${src}:${rule.prefix}`)) await addFolderRules(engine, src, [rule], { apply: true, json: true, insertOnly: true });
        if (!(await sourceExists(engine, src))) continue;
        let st = await policyStatus(engine, src);
        if (st.pending.length) { await resumePolicy(engine, src); st = await policyStatus(engine, src); }
        if (st.pending.length) throw new Error(`the folder rules of source ${src} are still being applied (${st.pending.map(c => c.prefix).join(', ')}); finish with gbrain access resume --source ${src}`);
        if (st.held.some(h => h.prefix === rule.prefix)) throw new Error(`the ${rule.prefix} rule in source ${src} waits for approval; preview it with gbrain access apply --source ${src}`);
      }
    });
    await run('owner_clients', async () => {
      const { credentials } = await ownerCredentials(engine, GUEST_SOURCE);
      const outcomes = await grantOwnerCredentials(engine, GUEST_SOURCE, credentials.filter(c => !c.readsGuest));
      const bad = outcomes.filter(o => o.outcome === 'conflict' || o.outcome === 'failed');
      if (bad.length) throw new Error(`${bad.map(o => `${o.kind} ${o.name}: ${o.outcome}${o.detail ? ` (${o.detail})` : ''}`).join('; ')}; run gbrain guests grant-owner-clients --source ${GUEST_SOURCE} to see each one`);
    });
  } catch (e) { // capability-refusal-ok: the failure is reported in the result and the receipt, never swallowed; every step is idempotent
    result.error = { code: (e as { code?: string }).code ?? 'internal_error', message: e instanceof Error ? e.message : String(e) };
    receipt.error = result.error;
    saveReceipt(receipt, dir);
  }
  return result;
}

export interface RoleProof { member: string; role: 'member'; key: 'delivered' | 'missing' | 'unreadable' | 'mismatch' | 'none'; check: string; expected: number; read: number; missing: string[]; extra: string[]; inconclusive: string[]; truncated: boolean; ok: boolean }
export interface TeamStatus { receipt: Omit<TemplateReceipt, 'params'> & { owner: string; members: string[]; guests: string[]; group: string }; complete: boolean; proof: RoleProof[]; drift: string[]; ok: boolean }

/** The pages the proof reads, at most this many per folder. */
export const PROOF_PAGES_PER_FOLDER = 100;

interface Probe { source: string; slug: string; readers: string[] | 'every_source_reader'; private: boolean }

/** The pages the team rules and the people folders cover, each with the members the access rules let read it (gbrain access who-can-read). */
async function probes(engine: BrainEngine, source: string, members: string[]): Promise<{ pages: Probe[]; truncated: boolean }> {
  let truncated = false;
  const folder = async (src: string, prefix: string): Promise<Probe[]> => {
    const rows = await engine.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id = $1 AND deleted_at IS NULL AND slug LIKE $2 ORDER BY slug LIMIT $3',
      [src, `${prefix.replace(/[\\%_]/g, c => `\\${c}`)}%`, PROOF_PAGES_PER_FOLDER + 1]);
    if (rows.length > PROOF_PAGES_PER_FOLDER) truncated = true;
    const out: Probe[] = [];
    for (const r of rows.slice(0, PROOF_PAGES_PER_FOLDER)) {
      const [entry] = await whoCanRead(engine, r.slug, src);
      out.push({ source: src, slug: r.slug, readers: entry?.members ?? [], private: entry?.private ?? false });
    }
    return out;
  };
  const pages = [
    ...(await sourceExists(engine, COMPANY_SOURCE_ID) ? await folder(COMPANY_SOURCE_ID, COMPANY_PREFIX) : []),
    ...await folder(source, TEAM_RULES_PREFIX),
    ...(await Promise.all(members.map(m => folder(source, `people/${m}/`)))).flat(),
  ];
  return { pages, truncated };
}

/** The redacted receipt and, per member, what its delivered key reads over the remote path against what the rules expect. */
export async function teamTemplateStatus(engine: BrainEngine, opts: { receipt?: string; source?: string; harness?: string | null; receiptDir?: string }): Promise<TeamStatus> {
  const dir = opts.receiptDir ?? receiptDir();
  const receipt = opts.receipt ? loadReceipt(opts.receipt, TEMPLATE, dir) : latestReceipt(TEMPLATE, { source_id: opts.source, harness: opts.harness ?? null }, dir);
  if (!receipt) {
    throw opError('setup_receipt_not_found', `No team setup receipt for this brain${opts.source ? ` and source ${opts.source}` : ''} is on this machine.`,
      'Preview the team template with gbrain access template team --members <id,...>, then apply it with --yes.');
  }
  assertReceiptTarget(receipt, { source_id: opts.source, harness: opts.harness ?? null });
  assertSameBrain(receipt, await readBrainRef(engine));
  const p = receipt.params as { owner: string; members: string[]; guests: string[]; group: string };
  const { pages, truncated } = await probes(engine, receipt.source_id, p.members);
  const drift = await teamDrift(engine, receipt.source_id, p);
  const { dispatchToolCall } = await import('../mcp/dispatch.ts');
  const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
  const { sqlQueryForEngine } = await import('../core/sql-query.ts');
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const proof: RoleProof[] = [];
  for (const m of p.members) {
    const entry = receipt.keys.find(k => k.member === m);
    const expects = (privateSources: string[]) => pages.filter(x => (x.readers === 'every_source_reader' || x.readers.includes(m)) && (!x.private || privateSources.includes(x.source))).map(x => `${x.source}:${x.slug}`);
    let want = expects([]);
    const r: RoleProof = { member: m, role: 'member', key: !entry ? 'none' : entry.delivered && existsSync(entry.path) ? 'delivered' : 'missing',
      check: `gbrain access check --token ${entry?.token_name ?? `member-${m}`}`, expected: want.length, read: 0, missing: [], extra: [], inconclusive: [], truncated, ok: false };
    if (r.key === 'delivered') {
      let auth: AuthInfo | null = null;
      const secret = readFileSync(entry!.path, 'utf8').trim();
      try { auth = await provider.verifyAccessToken(secret, { touch: false }) as unknown as AuthInfo; } catch { r.key = 'unreadable'; } // silent-read-ok: an unreadable or revoked key is reported as key unreadable
      const [row] = auth ? await engine.executeRaw<{ token_hash: string }>('SELECT token_hash FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [entry!.token_name]) : [];
      if (auth && (auth.member?.id !== m || row?.token_hash !== hashToken(secret))) { r.key = 'mismatch'; auth = null; }
      if (auth) {
        const scope = auth as AuthInfo & { sourceId?: string; hasSourceGrant?: boolean; privatePages?: { sources: string[] } };
        want = expects(scope.privatePages?.sources ?? []);
        r.expected = want.length;
        const sourceId = scope.sourceId ?? 'default';
        const localFederated = scope.hasSourceGrant === false ? await (await import('../core/source-resolver.ts')).localFederatedSourceIds(engine, sourceId, 'seed_default') : undefined;
        const read: string[] = [];
        for (const x of pages) {
          const out = await dispatchToolCall(engine, 'get_page', { slug: x.slug, source_id: x.source }, { remote: true, transport: 'http', auth, sourceId, ...(localFederated ? { localFederatedSourceIds: localFederated } : {}), takesHoldersAllowList: ['world'], readLog: false } as never);
          if (out.isError !== true) { read.push(`${x.source}:${x.slug}`); continue; }
          let code: string | undefined;
          try { code = (JSON.parse(String((out.content as Array<{ text?: string }> | undefined)?.[0]?.text ?? '{}')) as { code?: string }).code; } catch { code = undefined; } // silent-read-ok: an unreadable error body counts as inconclusive below
          if (code !== 'page_not_found') r.inconclusive.push(`${x.source}:${x.slug} (${code ?? 'unknown error'})`);
        }
        r.read = read.length;
        r.missing = want.filter(s => !read.includes(s));
        r.extra = read.filter(s => !want.includes(s)).sort();
        r.ok = !r.missing.length && !r.extra.length && !r.inconclusive.length && !truncated;
      }
    }
    proof.push(r);
  }
  const { params: _params, ...rest } = receipt;
  const complete = receipt.steps.every(s => s.state === 'done') && !receipt.error;
  return { receipt: { ...rest, owner: p.owner, members: p.members, guests: p.guests, group: p.group }, complete, proof, drift, ok: complete && !drift.length && proof.every(x => x.ok) };
}

/**
 * What the receipt's access no longer has, from the rules in force and the group: the proof compares each key with what
 * the rules now expect, so a removed rule would move the expectation with it; this keeps the template's own shape fixed.
 */
async function teamDrift(engine: BrainEngine, source: string, p: { owner: string; members: string[]; group: string }): Promise<string[]> {
  const drift: string[] = [];
  const team = [`member:${p.owner}`, `group:${p.group}`];
  const inForce = new Map<string, FolderRule[]>();
  const rulesOf = async (src: string) => inForce.get(src) ?? inForce.set(src, await sourceExists(engine, src) ? await appliedRules(engine, src) : []).get(src)!;
  for (const { source: src, rule } of teamRules(p.owner, p.group, source)) {
    const r = (await rulesOf(src)).find(x => x.prefix === rule.prefix);
    if (!r || !sameSet(r.readable_by, team)) drift.push(`rule ${src}:${rule.prefix} ${r ? `is readable by ${readerArg(r.readable_by)}` : 'is not in force'}, not by ${readerArg(team)}`);
  }
  for (const m of p.members) {
    const r = (await rulesOf(source)).find(x => x.prefix === `people/${m}/`);
    const others = r ? r.readable_by.filter(x => x !== `member:${m}` && (x.startsWith('group:') || p.members.includes(x.replace(/^member:/, '')))) : [];
    if (!r || !r.readable_by.includes(`member:${m}`) || others.length) drift.push(`rule ${source}:people/${m}/ ${r ? `is readable by ${readerArg(r.readable_by)}` : 'is not in force'}, not by ${m} alone`);
  }
  const held = (await listGroups(engine)).find(g => g.id === p.group)?.members ?? null;
  const roster = [p.owner, ...p.members];
  if (!held) drift.push(`group ${p.group} is gone`);
  else if (!sameSet(held, roster)) drift.push(`group ${p.group} holds ${held.join(', ') || 'no members'}, not ${roster.join(', ')}`);
  return drift;
}

const VERB_PLANNED: Record<TemplateAction['action'], string> = { add: 'will add', set: 'will set', keep: 'keep', run: 'will run', mint: 'will issue', blocked: 'BLOCKED' };
const VERB_DONE: Record<TemplateAction['action'], string> = { add: 'added', set: 'set', keep: 'kept', run: 'ran', mint: 'issued', blocked: 'BLOCKED' };

export function templateLines(r: TeamResult): string[] {
  const verbs = r.applied ? VERB_DONE : VERB_PLANNED;
  const lines = [`Team template (source ${r.source_id}${r.owner ? `, owner ${r.owner}` : ''}, group ${r.group}${r.receipt_id ? `, receipt ${r.receipt_id}` : ''}):`];
  for (const s of r.steps) {
    if (s.state === 'skipped') continue;
    lines.push(`  ${s.id}${s.state === 'done' && !r.applied ? ' (done in the receipt)' : s.state === 'failed' ? ' (FAILED)' : ''}`);
    for (const a of s.actions) lines.push(`    ${verbs[a.action].padEnd(10)} ${a.what}: ${a.command}${a.detail ? `  (${a.detail})` : ''}`);
  }
  for (const k of r.keys.filter(x => x.action !== 'blocked')) lines.push(`  key ${k.member}: ${k.path} (0600; reads ${k.reads.join(', ') || 'its sources'}, writes ${r.source_id}; the key is never printed)`);
  for (const u of r.unbound) lines.push(`  unbound ${u.kind} ${u.name}: bound to no member; if it is the owner's, bind it with ${u.command}`);
  lines.push('  Member notes stay private: people/<member>/ is read by that member alone. Moving a key off this machine is your own step, to a private place you choose; setup never sends one.');
  if (r.error) lines.push(`Stopped: ${r.error.message}`, `  Every step is idempotent: run gbrain setup ${r.harness ?? '<harness>'} --template team --resume ${r.receipt_id} --yes to finish.`);
  else if (!r.applied) lines.push(isBlocked(r) ? 'Nothing written: fix each BLOCKED line, then run this again.' : 'Nothing written. Add --yes to apply.');
  return lines;
}

export function statusLines(s: TeamStatus): string[] {
  const r = s.receipt;
  return [
    `Team setup receipt ${r.id} (harness ${r.harness ?? 'none'}, source ${r.source_id}, group ${r.group}, ${s.complete ? 'complete' : 'NOT complete'}):`,
    ...r.steps.map(x => `  ${x.id.padEnd(14)} ${x.state}${x.at ? ` ${x.at}` : ''}${x.detail ? `  (${x.detail})` : ''}`),
    `  owner ${r.owner} reads the whole brain${r.guests.length ? `, the guest source ${GUEST_SOURCE} included` : ''}`,
    ...r.keys.map(k => `  key ${k.member.padEnd(10)} issued ${k.issued?.at ?? 'no'}; delivered ${k.delivered ? `${k.delivered.at} to ${k.path}` : 'NO'}`),
    ...s.proof.map(p => `  proof ${p.member} (member): ${p.key !== 'delivered' ? `key ${p.key}` : `reads ${p.read} of the ${p.expected} team and own-folder page(s) the rules expect${p.missing.length ? `; missing ${p.missing.join(', ')}` : ''}${p.extra.length ? `; EXTRA ${p.extra.join(', ')}` : ''}${p.inconclusive.length ? `; the read failed (not a denial) for ${p.inconclusive.join(', ')}` : ''}${p.truncated ? `; a folder holds more than ${PROOF_PAGES_PER_FOLDER} pages, so only the first ${PROOF_PAGES_PER_FOLDER} were compared` : ''}`} ${p.ok ? 'ok' : 'NOT ok'}; check it yourself: ${p.check}`),
    ...s.drift.map(d => `  DRIFT ${d}`),
    ...(r.error ? [`  stopped: ${r.error.message}; finish with gbrain setup ${r.harness ?? '<harness>'} --template team --resume ${r.id} --yes`] : []),
  ];
}

export async function runTeamTemplate(engine: BrainEngine, args: string[], json: boolean, value: (flag: string) => string | undefined): Promise<void> {
  const harness = value('--harness') ?? null;
  if (args.includes('--status')) {
    const s = await teamTemplateStatus(engine, { receipt: value('--receipt'), source: value('--source'), harness });
    console.log(json ? JSON.stringify(s, null, 2) : statusLines(s).join('\n'));
    if (!s.ok) setCliExitVerdict(1);
    return;
  }
  if (args.includes('--dry-run') && args.includes('--yes')) throw usageError('Pass --dry-run (preview) or --yes (apply), not both; nothing was written.', 'gbrain access template team --members a,b previews; add --yes to apply.');
  const owner = value('--owner');
  const r = await teamTemplate(engine, { source: value('--source'), harness, apply: args.includes('--yes'), ...(owner !== undefined ? { owner: assertAccessId(owner) } : {}),
    members: value('--members'), guests: value('--guests'), group: value('--team-group'),
    ...(args.includes('--labelled-only') ? { history: 'private' as const } : args.includes('--open-history') ? { history: 'open' as const } : {}), ...(value('--resume') !== undefined ? { resume: value('--resume') } : {}) });
  console.log(json ? JSON.stringify(r, null, 2) : templateLines(r).join('\n'));
  if (r.error || isBlocked(r)) setCliExitVerdict(1);
}
