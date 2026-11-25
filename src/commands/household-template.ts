/**
 * Agent platform plan, H2: `gbrain household template`, the brain side of `gbrain setup <harness> --shape household`.
 *
 *   gbrain household template [--household-members role:id,...|none] [--owner <id>] [--source <id>] [--harness <h>] [--yes] [--json]
 *   gbrain household template --status [--receipt <id>] [--source <id>] [--harness <h>] [--json]
 *   gbrain household template --resume <receipt id> [--source <id>] [--harness <h>] --yes [--json]
 *
 * Preview first; --yes applies, in this order, every step idempotent:
 *   owner         the brain owner (a configured owner is kept; otherwise --owner, added as a member when missing)
 *   members       one member per roster entry: adults and helpers are people, a family chat is an audience member
 *   labelled_only helpers and family chats read only the pages labelled for them
 *   groups        household-adults (the owner and the adults), household-helpers, household-chats (template-namespaced)
 *   rules         one folder rule per placement-table folder (placementFolderRules), each naming the owner, written to
 *                 .gbrain/access.yml on a checkout source or the database on a repo-less one; a hand rule on the same
 *                 folder is never overwritten (BLOCKED, with the command that changes it)
 *   config        access.serves = several, once anyone besides the owner is in the roster
 *   replace       gbrain household replace: every record's readers recomputed from the table
 *   keys          last, once the rest is in place: one key per member besides the owner, granted this source only
 *                 (adults read and write, helpers and chats read), written to a 0600 file under <config>/member-keys/
 *                 and never printed
 * Children get no member and no key: a child is a subject page with household_role: child (gbrain household add --child).
 * The run's receipt (setup-template-receipt.ts) keeps issuance apart from delivery: a key issued but never written
 * to its file refuses on resume instead of being issued twice. --status reads the receipt and proves each member's key:
 * the household records it reads directly (get_page) and through household_due, against the set the table expects.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import type { AuthInfo } from '../core/ops/contract.ts';
import { opError } from '../core/ops/contract.ts';
import { hashToken } from '../core/utils.ts';
import { usageError } from '../cli/cli-error.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';
import { addGroup, addMember, assertAccessId, getMember, listGroups, type MemberKind } from '../core/access/members.ts';
import { ownerView, setOwner } from '../core/access/owner.ts';
import { setMemberLabelledOnly } from '../core/access/labelled-only.ts';
import { brainServes, SERVES_KEY } from '../core/access/serves.ts';
import { normalizeRule, type FolderRule } from '../core/access/folder-rules.ts';
import { aboutOf, classifySubjects, HOUSEHOLD_GROUPS, placementFolderRules, placeRecord, type HouseholdAudience } from '../core/household/placement.ts';
import { HOUSEHOLD_TYPE, readHouseholdRecord } from '../core/household/record.ts';
import { assertReceiptTarget, latestReceipt, loadReceipt, markStep, newReceipt, receiptDir, receiptKey, saveReceipt, stepState, type TemplateReceipt } from './setup-template-receipt.ts';
import { addFolderRules, currentFolderRules } from './access-rules.ts';
import { mintToken } from './auth-mint.ts';
import { gitRootAbove, memberKeyDir, memberKeyName, unboundCredentials, writeKeyFile } from './access-serves.ts';

export const TEMPLATE = 'household';
export type TemplateRole = 'owner' | 'adult' | 'helper' | 'chat';
export interface RosterEntry { id: string; role: TemplateRole; kind: MemberKind; labelled_only: boolean }

/** The household the template sets up when --household-members is not given: another adult, a helper and a family chat. */
export const DEFAULT_HOUSEHOLD_MEMBERS = 'adult:adult-b,helper:helper,chat:family-chat';
export const STEPS = ['owner', 'members', 'labelled_only', 'groups', 'rules', 'config', 'replace', 'keys'] as const;
export type StepId = typeof STEPS[number];

const ROLE_GROUP: Record<TemplateRole, string> = { owner: HOUSEHOLD_GROUPS.adults, adult: HOUSEHOLD_GROUPS.adults, helper: HOUSEHOLD_GROUPS.helpers, chat: HOUSEHOLD_GROUPS.chats };
const ROLE_AUDIENCES: Record<TemplateRole, HouseholdAudience[]> = { owner: ['adults', 'shared'], adult: ['adults', 'shared'], helper: ['shared'], chat: ['shared'] };

/**
 * The roster from --household-members: role:id pairs (adult, helper or chat), or none for a household of the owner alone.
 * The owner is always first; a child is never a member.
 */
export function parseHouseholdMembers(spec: string | undefined, owner: string): RosterEntry[] {
  const roster: RosterEntry[] = [{ id: owner, role: 'owner', kind: 'person', labelled_only: false }];
  const raw = (spec ?? DEFAULT_HOUSEHOLD_MEMBERS).trim();
  if (raw === 'none') return roster;
  for (const part of raw.split(',').map(p => p.trim()).filter(Boolean)) {
    const [role, id, extra] = part.split(':');
    if (role === 'child') {
      throw usageError(`--household-members names ${part}, and a child gets no member and no key.`,
        'Leave children out of --household-members; mark a child\'s page instead: gbrain household add <kind> --title <t> --about <slug> --child.');
    }
    if (extra !== undefined || !id || !['adult', 'helper', 'chat'].includes(role!)) {
      throw usageError(`--household-members takes role:id pairs (adult, helper or chat), or none; "${part}" is not one.`,
        `For example: --household-members ${DEFAULT_HOUSEHOLD_MEMBERS}`);
    }
    const memberId = assertAccessId(id);
    if (roster.some(r => r.id === memberId)) throw usageError(`--household-members names ${memberId} twice (or names the owner).`, 'Give each member one role; the owner is always in the household.');
    roster.push({ id: memberId, role: role as TemplateRole, kind: role === 'chat' ? 'audience' : 'person', labelled_only: role !== 'adult' });
  }
  return roster;
}

export interface TemplateAction { what: string; action: 'add' | 'set' | 'keep' | 'run' | 'mint' | 'blocked'; command: string; detail?: string }
export interface TemplateKey { member: string; token_name: string; path: string; scopes: string[]; action: 'mint' | 'keep' | 'blocked'; issued: string | null; delivered: string | null; detail?: string }
export interface TemplateResult {
  template: typeof TEMPLATE;
  applied: boolean;
  receipt_id: string | null;
  harness: string | null;
  source_id: string;
  owner: string | null;
  roster: RosterEntry[];
  steps: Array<{ id: StepId; state: 'done' | 'planned' | 'blocked' | 'failed' | 'skipped'; actions: TemplateAction[] }>;
  keys: TemplateKey[];
  key_dir: string;
  /** Live credentials bound to no member: the household folders' rules keep their pages from them. Never rebound here. */
  unbound: Array<{ kind: 'token' | 'client'; name: string; command: string }>;
  replaced?: { checked: number; replaced: number };
  error?: { code: string; message: string };
}

export interface TemplateOpts {
  source: string;
  harness?: string | null;
  owner?: string;
  members?: string;
  apply: boolean;
  resume?: string;
  keyDir?: string;
  receiptDir?: string;
}

const srcFlag = (source: string) => `--source ${source}`;
const readerArg = (readers: string[]) => [...readers.filter(r => !r.startsWith('group:')), ...readers.filter(r => r.startsWith('group:'))].map(r => r.replace(/^member:/, '')).join(',');
const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);
const keyScopes = (role: TemplateRole) => role === 'adult' ? ['read', 'write'] : ['read'];

/** The rules the template writes: one per placement-table folder, with its rule id. */
export function templateRules(owner: string): FolderRule[] {
  return placementFolderRules(owner).map(r => {
    const n = normalizeRule(r);
    if ('problem' in n) throw new Error(`placement rule ${r.prefix}: ${n.problem}`);
    return n.rule;
  });
}

async function plan(engine: BrainEngine, opts: TemplateOpts, roster: RosterEntry[] | null, receipt: TemplateReceipt | null): Promise<TemplateResult> {
  const keyDir = opts.keyDir ?? memberKeyDir();
  const gitRoot = gitRootAbove(keyDir);
  if (gitRoot) {
    throw opError('access_serves_key_dir_in_git', `Member keys go to ${keyDir}, which is inside the git work tree at ${gitRoot}; a key there could be committed, so nothing was written.`,
      'Point GBRAIN_HOME at a directory outside any git checkout (the default is your home directory), then run the command again.');
  }
  const source = opts.source;
  const view = await ownerView(engine);
  const ownerId = view.owner ?? (view.inactive ? null : opts.owner ?? null);
  const steps: TemplateResult['steps'] = [];
  const step = (id: StepId, actions: TemplateAction[]) => steps.push({ id, state: actions.some(a => a.action === 'blocked') ? 'blocked' : 'planned', actions });
  const base = { template: TEMPLATE, applied: false, receipt_id: receipt?.id ?? null, harness: opts.harness ?? receipt?.harness ?? null, source_id: source, key_dir: keyDir } as const;
  if (!ownerId) {
    const detail = view.inactive ? `the configured owner ${view.inactive.value} is not usable (${view.inactive.reason}); name an enabled member with gbrain access owner set <member>` : 'no owner is set; name one with --owner <member id>';
    return { ...base, owner: null, roster: [], steps: [{ id: 'owner', state: 'blocked', actions: [{ what: 'owner', action: 'blocked', command: 'gbrain access owner set <member>', detail }] }], keys: [], unbound: [] };
  }
  const members = roster ?? parseHouseholdMembers(opts.members, ownerId);
  if (members[0]!.id !== ownerId) members.splice(0, 1, { id: ownerId, role: 'owner', kind: 'person', labelled_only: false });

  const ownerMember = await getMember(engine, ownerId);
  step('owner', view.owner ? [{ what: ownerId, action: 'keep', command: `gbrain access owner set ${ownerId}` }]
    : !ownerMember ? [{ what: ownerId, action: 'add', command: `gbrain access member add ${ownerId} && gbrain access owner set ${ownerId}` }]
    : ownerMember.status !== 'enabled' ? [{ what: ownerId, action: 'blocked', command: `gbrain access member enable ${ownerId}`, detail: `${ownerId} is ${ownerMember.status}; enable it or name another owner with --owner` }]
    : ownerMember.labelled_only ? [{ what: ownerId, action: 'blocked', command: `gbrain access member labelled-only ${ownerId} off`, detail: `${ownerId} is labelled-only, and the owner reads the whole household` }]
    : [{ what: ownerId, action: 'set', command: `gbrain access owner set ${ownerId}` }]);

  const others = members.slice(1);
  const records = new Map(await Promise.all(others.map(async m => [m.id, await getMember(engine, m.id)] as const)));
  step('members', others.map((m): TemplateAction => {
    const rec = records.get(m.id);
    const command = `gbrain access member add ${m.id}${m.kind === 'audience' ? ' --kind audience' : ''}`;
    if (!rec) return { what: m.id, action: 'add', command };
    if (rec.status !== 'enabled') return { what: m.id, action: 'blocked', command: `gbrain access member enable ${m.id}`, detail: rec.status === 'disabled' ? 'member is disabled' : 'member id was removed and can never be reused; name another id in --household-members' };
    if (rec.kind !== m.kind) return { what: m.id, action: 'blocked', command: `gbrain access member kind ${m.id} ${m.kind}`, detail: `${m.id} is a ${rec.kind} member and the template makes a ${m.role} a${m.kind === 'audience' ? 'n audience' : ' person'}; change it, or name another id in --household-members` };
    return { what: m.id, action: 'keep', command };
  }));
  step('labelled_only', others.filter(m => m.labelled_only || records.get(m.id)?.labelled_only).map(m => ({
    what: m.id, action: records.get(m.id)?.labelled_only ? 'keep' : 'set', command: `gbrain access member labelled-only ${m.id} on`,
    ...(!m.labelled_only ? { detail: 'already labelled-only; the template leaves it so' } : {}) })));

  const groups = new Map((await listGroups(engine)).map(g => [g.id, g.members]));
  step('groups', Object.values(HOUSEHOLD_GROUPS).map((g): TemplateAction => {
    const want = members.filter(m => ROLE_GROUP[m.role] === g).map(m => m.id);
    const held = groups.get(g);
    const adds = want.filter(id => !held?.includes(id));
    const extra = (held ?? []).filter(id => !want.includes(id));
    const command = `gbrain access group add ${g}${want.length ? ` --members ${want.join(',')}` : ''}`;
    return { what: g, action: !held || adds.length ? 'add' : 'keep', command, ...(extra.length ? { detail: `also holds ${extra.join(', ')}, kept (the template never removes a group member)` } : {}) };
  }));

  const current = await currentFolderRules(engine, source);
  step('rules', templateRules(ownerId).map((rule): TemplateAction => {
    const command = `gbrain access rule add --id ${rule.id} --prefix ${rule.prefix} --readers ${readerArg(rule.readable_by)} ${srcFlag(source)} --yes`;
    const same = current.find(c => c.prefix === rule.prefix);
    if (same && sameSet(same.readable_by, rule.readable_by)) return { what: rule.prefix, action: 'keep', command };
    if (same) return { what: rule.prefix, action: 'blocked', command: `gbrain access rule add --id ${same.id} --prefix ${rule.prefix} --readers ${readerArg(rule.readable_by)} ${srcFlag(source)}`,
      detail: `rule "${same.id}" already covers ${rule.prefix}, readable by ${readerArg(same.readable_by)}; the template never overwrites a rule, so change it to the table's readers (preview first) or remove it, then run this again` };
    const clash = current.find(c => c.id === rule.id);
    if (clash) return { what: rule.prefix, action: 'blocked', command, detail: `rule id ${rule.id} is taken by a rule on ${clash.prefix}; give that rule another id, then run this again` };
    return { what: rule.prefix, action: 'add', command };
  }));

  const serves = await brainServes(engine);
  step('config', others.length ? [{ what: SERVES_KEY, action: (await engine.getConfig(SERVES_KEY))?.trim() === 'several' ? 'keep' : 'set', command: `gbrain config set ${SERVES_KEY} several`,
    ...(serves.serves === 'several' ? {} : { detail: 'household records then name their readers (the owner and the household groups)' }) }] : []);
  step('replace', [{ what: 'household records', action: 'run', command: `gbrain household replace ${srcFlag(source)}`, detail: 'recomputes every household record\'s readers from the placement table' }]);

  const keys: TemplateKey[] = [];
  for (const m of others) {
    const name = memberKeyName(m.id);
    const path = join(keyDir, `${m.id}.key`);
    const scopes = keyScopes(m.role);
    const r = receipt?.keys.find(k => k.member === m.id);
    const at = { issued: r?.issued?.at ?? null, delivered: r?.delivered?.at ?? null };
    const k = (action: TemplateKey['action'], detail?: string): TemplateKey => ({ member: m.id, token_name: name, path, scopes, action, ...at, ...(detail ? { detail } : {}) });
    const [token] = await engine.executeRaw<{ member_id: string | null; token_hash: string }>('SELECT member_id, token_hash FROM access_tokens WHERE name = $1 AND revoked_at IS NULL', [name]);
    const rec = records.get(m.id);
    if (rec && rec.status !== 'enabled') keys.push(k('blocked', 'the member is not enabled'));
    else if (!token && existsSync(path)) keys.push(k('blocked', `a key file is already at ${path} but no live key is named ${name} (another brain's key, or one revoked by hand); move or delete the file, then run this again`));
    else if (!token) keys.push(k('mint'));
    else if (token.member_id !== m.id) keys.push(k('blocked', `a token named ${name} exists but is not bound to ${m.id}; revoke it (gbrain auth revoke ${name}) or bind it (gbrain auth rescope --token ${name} --member ${m.id})`));
    else if (!existsSync(path)) {
      keys.push(k('blocked', r?.issued && !r.delivered
        ? `the key ${name} was issued at ${r.issued.at} but never written to ${path}, and a key is shown only once, so setup does not issue a second one on its own: revoke it (gbrain auth revoke ${name}), then run this again`
        : `the key ${name} exists but its file is gone and a key is shown only once; revoke it (gbrain auth revoke ${name}) and run this again to issue a new one`));
    } else if (hashToken(readFileSync(path, 'utf8').trim()) !== token.token_hash) {
      keys.push(k('blocked', `the file does not hold the live key ${name}; revoke it (gbrain auth revoke ${name}), delete ${path} and run this again`));
    } else keys.push(k('keep'));
  }
  step('keys', keys.map(k => ({ what: k.member, action: k.action === 'mint' ? 'mint' : k.action, command: `gbrain auth create ${k.token_name} --member ${k.member} --scopes ${k.scopes.join(',')} --sources ${source}`, ...(k.detail ? { detail: k.detail } : {}) })));
  return { ...base, owner: ownerId, roster: members, steps, keys, unbound: await unboundCredentials(engine, ownerId) };
}

const isBlocked = (r: TemplateResult) => r.steps.some(s => s.state === 'blocked');

function abortAfter(step: string): void {
  if (process.env.GBRAIN_SETUP_ABORT_AFTER === step) throw new Error(`GBRAIN_SETUP_ABORT_AFTER=${step}: stopped on purpose after ${step}.`);
}

/** Plans, and with `apply` writes, the household template; a failure is reported in the result and the receipt, never thrown. */
export async function householdTemplate(engine: BrainEngine, opts: TemplateOpts): Promise<TemplateResult> {
  const dir = opts.receiptDir ?? receiptDir();
  const prior = opts.resume ? loadReceipt(opts.resume, TEMPLATE, dir) : null;
  if (prior) assertReceiptTarget(prior, { source_id: opts.source, harness: opts.harness ?? null });
  const source = prior?.source_id ?? opts.source;
  const roster = prior ? (prior.params.roster as RosterEntry[]) : null;
  const result = await plan(engine, { ...opts, source, owner: prior ? String(prior.params.owner) : opts.owner }, roster, prior);
  const finished = (id: StepId) => prior !== null && stepState(prior, id) === 'done' && id !== 'keys';
  for (const s of result.steps) if (finished(s.id) && s.state !== 'blocked') s.state = 'done';
  if (!opts.apply || isBlocked(result)) return result;
  const receipt = prior ?? newReceipt(TEMPLATE, { harness: result.harness, source_id: source }, { owner: result.owner, roster: result.roster }, [...STEPS]);
  result.receipt_id = receipt.id;
  result.applied = true;
  delete receipt.error;
  saveReceipt(receipt, dir);
  const run = async (id: StepId, fn: () => Promise<void>) => {
    const s = result.steps.find(x => x.id === id)!;
    if (s.state === 'done') return;
    try { await fn(); } catch (e) { s.state = 'failed'; markStep(receipt, id, 'failed', e instanceof Error ? e.message : String(e)); saveReceipt(receipt, dir); throw e; }
    s.state = 'done';
    markStep(receipt, id, 'done');
    saveReceipt(receipt, dir);
    abortAfter(`household-${id}`);
  };
  const owner = result.owner!;
  const others = result.roster.slice(1);
  try {
    await run('owner', async () => {
      if (result.steps[0]!.actions[0]!.action === 'keep') return;
      if (!(await getMember(engine, owner))) await addMember(engine, owner, { remote: false });
      await setOwner(engine, owner);
    });
    await run('members', async () => {
      for (const m of others) if (!(await getMember(engine, m.id))) await addMember(engine, m.id, { kind: m.kind, remote: false });
    });
    await run('labelled_only', async () => {
      for (const m of others.filter(x => x.labelled_only)) await setMemberLabelledOnly(engine, m.id, true, { remote: false });
    });
    await run('groups', async () => {
      for (const g of Object.values(HOUSEHOLD_GROUPS)) await addGroup(engine, g, result.roster.filter(m => ROLE_GROUP[m.role] === g).map(m => m.id));
    });
    await run('rules', async () => {
      const add = templateRules(owner).filter(r => result.steps.find(s => s.id === 'rules')!.actions.some(a => a.what === r.prefix && a.action === 'add'));
      if (add.length) await addFolderRules(engine, source, add, { apply: true, json: true });
    });
    await run('config', async () => { if (others.length) await engine.setConfig(SERVES_KEY, 'several'); });
    await run('replace', async () => {
      const { handleToolCall } = await import('../mcp/server.ts');
      const r = await handleToolCall(engine, 'household_replace', { source_id: source }) as { checked: number; replaced: string[] };
      result.replaced = { checked: r.checked, replaced: r.replaced.length };
    });
    await run('keys', async () => {
      for (const k of result.keys.filter(x => x.action === 'mint')) {
        const entry = receiptKey(receipt, k.member, k.token_name, k.path);
        const minted = await mintToken(engine, k.token_name, { scopes: k.scopes, binding: { member: k.member }, sources: { kind: 'scalar', writeSource: source } });
        entry.issued = { at: new Date().toISOString() };
        entry.delivered = null;
        saveReceipt(receipt, dir);
        k.issued = entry.issued.at;
        abortAfter('household-key-issued');
        try {
          writeKeyFile(k.path, minted.token);
        } catch (e) {
          await engine.executeRaw('UPDATE access_tokens SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [minted.id]);
          entry.issued = null;
          saveReceipt(receipt, dir);
          throw e;
        }
        entry.delivered = { at: new Date().toISOString() };
        k.delivered = entry.delivered.at;
        k.action = 'keep';
        saveReceipt(receipt, dir);
      }
      for (const k of result.keys.filter(x => x.action === 'keep')) {
        const entry = receiptKey(receipt, k.member, k.token_name, k.path);
        if (!entry.delivered) { entry.delivered = { at: new Date().toISOString() }; entry.issued ??= { at: entry.delivered.at }; }
      }
    });
  } catch (e) { // capability-refusal-ok: the failure is reported in the result and the receipt, never swallowed; every step is idempotent
    result.error = { code: (e as { code?: string }).code ?? 'internal_error', message: e instanceof Error ? e.message : String(e) };
    receipt.error = result.error;
    saveReceipt(receipt, dir);
  }
  return result;
}

export interface RoleProof { member: string; role: TemplateRole; key: 'delivered' | 'missing' | 'unreadable' | 'none'; expected: number; read: number; missing: string[]; extra: string[]; due_extra: string[]; ok: boolean }
export interface TemplateStatus { receipt: Omit<TemplateReceipt, 'params'> & { roster: RosterEntry[] }; complete: boolean; proof: RoleProof[]; ok: boolean }

/** Who the table lets read each household record in the source: the roles of its audience, narrowed by a readers list its author wrote. */
async function expectedReaders(engine: BrainEngine, source: string, roster: RosterEntry[]): Promise<Map<string, Set<string>>> {
  const rows = await engine.listPages({ type: HOUSEHOLD_TYPE as never, sourceId: source, sort: 'slug', limit: 100_000, omitBodies: true });
  const groups = new Map((await listGroups(engine)).map(g => [g.id, g.members]));
  const classes = await classifySubjects(engine, source, [...new Set(rows.flatMap(r => aboutOf(r.frontmatter?.about)))]);
  const out = new Map<string, Set<string>>();
  for (const row of rows) {
    const fm = (row.frontmatter ?? {}) as Record<string, unknown>;
    const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : [];
    const parsed = readHouseholdRecord({ slug: row.slug, source_id: source, title: row.title, frontmatter: fm, tags });
    const kind = parsed.record?.kind ?? fm.kind;
    const audience = placeRecord({ kind, school: tags.map(t => t.toLowerCase()).includes('school'), subjects: aboutOf(fm.about).map(s => classes.get(s) ?? 'unclassified'), requested: fm.audience }).audience;
    const listed = Array.isArray(fm.readable_by) ? fm.readable_by.map(v => String(v).replace(/^member:/, '')) : null;
    const covers = (id: string) => !listed || listed.includes(id) || [...groups].some(([g, ms]) => ms.includes(id) && listed.includes(`group:${g}`));
    out.set(row.slug, new Set(roster.filter(m => ROLE_AUDIENCES[m.role].includes(audience) && (m.role === 'owner' || covers(m.id))).map(m => m.id)));
  }
  return out;
}

/** The redacted receipt and, per member, what its delivered key reads over the remote path against what the table expects. */
export async function householdTemplateStatus(engine: BrainEngine, opts: { receipt?: string; source?: string; harness?: string | null; receiptDir?: string }): Promise<TemplateStatus> {
  const dir = opts.receiptDir ?? receiptDir();
  const receipt = opts.receipt ? loadReceipt(opts.receipt, TEMPLATE, dir) : latestReceipt(TEMPLATE, { source_id: opts.source, harness: opts.harness ?? null }, dir);
  if (!receipt) {
    throw opError('setup_receipt_not_found', `No household setup receipt for this brain${opts.source ? ` and source ${opts.source}` : ''} is on this machine.`,
      'Preview the household template with gbrain household template, then apply it with --yes.');
  }
  assertReceiptTarget(receipt, { source_id: opts.source, harness: opts.harness ?? null });
  const roster = receipt.params.roster as RosterEntry[];
  const expected = await expectedReaders(engine, receipt.source_id, roster);
  const { dispatchToolCall } = await import('../mcp/dispatch.ts');
  const { GBrainOAuthProvider } = await import('../core/oauth-provider.ts');
  const { sqlQueryForEngine } = await import('../core/sql-query.ts');
  const provider = new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
  const proof: RoleProof[] = [];
  for (const m of roster.slice(1)) {
    const want = [...expected].filter(([, who]) => who.has(m.id)).map(([slug]) => slug).sort();
    const entry = receipt.keys.find(k => k.member === m.id);
    const p: RoleProof = { member: m.id, role: m.role, key: !entry ? 'none' : entry.delivered && existsSync(entry.path) ? 'delivered' : 'missing', expected: want.length, read: 0, missing: [], extra: [], due_extra: [], ok: false };
    if (p.key === 'delivered') {
      let auth: AuthInfo | null = null;
      try { auth = await provider.verifyAccessToken(readFileSync(entry!.path, 'utf8').trim()) as unknown as AuthInfo; } catch { p.key = 'unreadable'; }
      if (auth) {
        const call = async (op: string, params: Record<string, unknown>) => {
          const out = await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: receipt.source_id, takesHoldersAllowList: ['world'] } as never);
          return { isError: out.isError === true, text: out.content.map((c: { text: string }) => c.text).join('\n') };
        };
        const read: string[] = [];
        for (const slug of expected.keys()) if (!(await call('get_page', { slug })).isError) read.push(slug);
        const due = await call('household_due', { include: 'all', window_days: 366, limit: 100 });
        let items: string[] = [];
        try { items = ((JSON.parse(due.text) as { items?: Array<{ slug: string }> }).items ?? []).map(i => i.slug); } catch { /* an error answer reads nothing */ }
        p.read = read.length;
        p.missing = want.filter(s => !read.includes(s));
        p.extra = read.filter(s => !want.includes(s)).sort();
        p.due_extra = items.filter(s => !want.includes(s)).sort();
        p.ok = !p.missing.length && !p.extra.length && !p.due_extra.length;
      }
    }
    proof.push(p);
  }
  const { params: _params, ...rest } = receipt;
  const complete = receipt.steps.every(s => s.state === 'done') && !receipt.error;
  return { receipt: { ...rest, roster }, complete, proof, ok: complete && proof.every(p => p.ok) };
}

const VERB_PLANNED: Record<TemplateAction['action'], string> = { add: 'will add', set: 'will set', keep: 'keep', run: 'will run', mint: 'will issue', blocked: 'BLOCKED' };
const VERB_DONE: Record<TemplateAction['action'], string> = { add: 'added', set: 'set', keep: 'kept', run: 'ran', mint: 'issued', blocked: 'BLOCKED' };

export function templateLines(r: TemplateResult): string[] {
  const verbs = r.applied ? VERB_DONE : VERB_PLANNED;
  const lines = [`Household template (source ${r.source_id}${r.owner ? `, owner ${r.owner}` : ''}${r.receipt_id ? `, receipt ${r.receipt_id}` : ''}):`];
  for (const s of r.steps) {
    lines.push(`  ${s.id}${s.state === 'done' && !r.applied ? ' (done in the receipt)' : s.state === 'failed' ? ' (FAILED)' : ''}`);
    for (const a of s.actions) lines.push(`    ${verbs[a.action].padEnd(10)} ${a.what}: ${a.command}${a.detail ? `  (${a.detail})` : ''}`);
  }
  for (const k of r.keys.filter(x => x.action !== 'blocked')) lines.push(`  key ${k.member}: ${k.path} (0600, ${k.scopes.join('+')}, source ${r.source_id} only; the key is never printed)`);
  if (r.replaced) lines.push(`  replace: ${r.replaced.checked} record(s) checked, ${r.replaced.replaced} re-placed`);
  for (const u of r.unbound) lines.push(`  unbound ${u.kind} ${u.name}: bound to no member, so it no longer reads the household folders; if it is the owner's, bind it with ${u.command}`);
  lines.push('  Children get no member and no key. Moving a key off this machine is your own step, to a private place you choose; setup never sends one.');
  if (r.error) lines.push(`Stopped: ${r.error.message}`, `  Every step is idempotent: run gbrain setup ${r.harness ?? '<harness>'} --shape household --resume ${r.receipt_id} --yes to finish.`);
  else if (!r.applied) lines.push(isBlocked(r) ? 'Nothing written: fix each BLOCKED line, then run this again.' : 'Nothing written. Add --yes to apply.');
  return lines;
}

export function statusLines(s: TemplateStatus): string[] {
  const r = s.receipt;
  return [
    `Household setup receipt ${r.id} (harness ${r.harness ?? 'none'}, source ${r.source_id}, ${s.complete ? 'complete' : 'NOT complete'}):`,
    ...r.steps.map(x => `  ${x.id.padEnd(14)} ${x.state}${x.at ? ` ${x.at}` : ''}${x.detail ? `  (${x.detail})` : ''}`),
    ...r.keys.map(k => `  key ${k.member.padEnd(10)} issued ${k.issued?.at ?? 'no'}; delivered ${k.delivered ? `${k.delivered.at} to ${k.path}` : 'NO'}`),
    ...s.proof.map(p => `  proof ${p.member} (${p.role}): ${p.key !== 'delivered' ? `key ${p.key}` : `reads ${p.read} of the ${p.expected} household record(s) the table expects${p.missing.length ? `; missing ${p.missing.join(', ')}` : ''}${p.extra.length ? `; EXTRA ${p.extra.join(', ')}` : ''}${p.due_extra.length ? `; household_due EXTRA ${p.due_extra.join(', ')}` : ''}`} ${p.ok ? 'ok' : 'NOT ok'}`),
    ...(r.error ? [`  stopped: ${r.error.message}; finish with gbrain setup ${r.harness ?? '<harness>'} --shape household --resume ${r.id} --yes`] : []),
  ];
}

export async function runHouseholdTemplate(engine: BrainEngine, args: string[], json: boolean, value: (flag: string) => string | undefined): Promise<void> {
  const source = value('--source') ?? 'default';
  const harness = value('--harness') ?? null;
  if (args.includes('--status')) {
    const s = await householdTemplateStatus(engine, { receipt: value('--receipt'), source: value('--source'), harness });
    console.log(json ? JSON.stringify(s, null, 2) : statusLines(s).join('\n'));
    if (!s.ok) setCliExitVerdict(1);
    return;
  }
  const owner = value('--owner');
  const r = await householdTemplate(engine, { source, harness, apply: args.includes('--yes'), ...(owner !== undefined ? { owner: assertAccessId(owner) } : {}),
    ...(value('--household-members') !== undefined ? { members: value('--household-members') } : {}), ...(value('--resume') !== undefined ? { resume: value('--resume') } : {}) });
  console.log(json ? JSON.stringify(r, null, 2) : templateLines(r).join('\n'));
  if (r.error || isBlocked(r)) setCliExitVerdict(1);
}
